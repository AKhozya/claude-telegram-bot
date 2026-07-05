/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize, dirname } from "path";
import { realpathSync } from "fs";
import type { RateLimitBucket } from "./types";
import {
  ALLOWED_PATHS,
  BLOCKED_PATTERNS,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW,
  TEMP_PATHS,
  WORKING_DIR,
} from "./config";

// ============== Rate Limiter ==============

class RateLimiter {
  private buckets = new Map<number, RateLimitBucket>();
  private maxTokens: number;
  private refillRate: number; // tokens per second

  constructor() {
    this.maxTokens = RATE_LIMIT_REQUESTS;
    this.refillRate = RATE_LIMIT_REQUESTS / RATE_LIMIT_WINDOW;
  }

  check(userId: number): [allowed: boolean, retryAfter?: number] {
    if (!RATE_LIMIT_ENABLED) {
      return [true];
    }

    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastUpdate: now };
      this.buckets.set(userId, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastUpdate) / 1000;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsed * this.refillRate
    );
    bucket.lastUpdate = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return [true];
    }

    // Calculate time until next token
    const retryAfter = (1 - bucket.tokens) / this.refillRate;
    return [false, retryAfter];
  }

  getStatus(userId: number): {
    tokens: number;
    max: number;
    refillRate: number;
  } {
    const bucket = this.buckets.get(userId);
    return {
      tokens: bucket?.tokens ?? this.maxTokens,
      max: this.maxTokens,
      refillRate: this.refillRate,
    };
  }
}

export const rateLimiter = new RateLimiter();

// ============== Path Validation ==============

export function isPathAllowed(path: string): boolean {
  try {
    const resolved = canonicalize(path);

    // Always allow temp paths (for bot's own files)
    for (const tempPath of TEMP_PATHS) {
      if (resolved.startsWith(tempPath)) {
        return true;
      }
    }

    // Check against allowed paths using proper containment
    for (const allowed of ALLOWED_PATHS) {
      const allowedResolved = resolve(allowed);
      if (
        resolved === allowedResolved ||
        resolved.startsWith(allowedResolved + "/")
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

// ============== Command Safety ==============

export function checkCommandSafety(
  command: string
): [safe: boolean, reason: string] {
  const lowerCommand = command.toLowerCase();

  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (lowerCommand.includes(pattern.toLowerCase())) {
      return [false, `Blocked pattern: ${pattern}`];
    }
  }

  // Special handling for rm — validate EVERY rm in the command, not just the first,
  // and fail CLOSED on any target we cannot statically resolve to an allowed path.
  // ponytail: best-effort static parse — a speed-bump against prompt-injected deletion,
  //   NOT a sandbox. Known ceiling it does NOT catch: interpreter indirection
  //   (`sh -c '...'`, `eval`, `python -c`), wrappers that take args before the command
  //   (`timeout 5 rm`), non-rm deleters (`find -delete`, `truncate`, `: >f`, `mv`),
  //   base64-decoded payloads, and mid-word-quoted command words (`r"m"`). The real
  //   control is OS-level containment (Claude's Bash as a restricted user / read-only
  //   mounts outside ALLOWED_PATHS) — audit item #12. This guard just raises the bar.
  if (/\brm\b/.test(lowerCommand)) {
    try {
      // Fold the `>|` force-clobber redirect to a plain `>` so its `|` is not taken as a
      // pipe by the operator split below (`rm ok >|/etc/x`).
      const normalized = command.replace(/>\|/g, ">");
      // Pull command-substitution / backtick BODIES out as their own segments — an rm
      // inside `$(...)` or `` `...` `` runs as a real subshell regardless of what
      // consumes the output (`ls \`rm /etc/x\``, `x=$(rm /etc/x)`). Non-nested spans
      // only (deeper nesting is part of the documented ceiling). Then split everything
      // on shell operators so a chained/piped rm (`rm ok; rm /etc/x`) is scanned too.
      const substBodies = [
        ...normalized.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g),
      ].map((m) => m[1] ?? m[2] ?? "");
      const segments = [normalized, ...substBodies].join("\n").split(/[;&|\n]+/);
      for (const segment of segments) {
        // rm reached via xargs takes its paths from stdin (`... | xargs rm`), which we
        // cannot see — fail closed rather than validate an empty arg list and pass.
        if (
          /^[\s({\\'"]*(?:\w+=\S*\s+)*xargs\b/i.test(segment) &&
          /\brm\b/.test(segment)
        ) {
          return [false, "rm via xargs: stdin-fed targets cannot be verified"];
        }
        // Match rm as the segment's COMMAND WORD, after the shell-strippable leading
        // chars (grouping `( {`, a backslash `\rm`, quotes `''rm`) and any leading
        // VAR=val assignments or bare exec-wrappers (`env rm`, `nice rm`). `rm\b` (not
        // `rm\s`) so a glued redirect `rm>/dev/null` is still caught. Not a path
        // substring (`cat /tmp/rm x`).
        const rmMatch = segment.match(
          /^[\s({\\'"]*(?:(?:\w+=\S*|env|command|builtin|exec|nice|nohup|setsid|stdbuf|time|ionice)\s+)*rm\b(.*)$/i
        );
        if (!rmMatch) continue;

        // An output redirect (`>FILE` / `>>FILE`) on the rm is a write-anywhere
        // primitive that would otherwise ride past the path check — `rm ok >/etc/passwd`
        // truncates /etc/passwd. Validate every redirect TARGET like an rm target
        // instead of discarding it. Allow the standard sinks and fd-dups (2>&1).
        // ponytail: input redirects and process substitution `<(cmd)`/`>(cmd)` are NOT
        //   containment-checked here — a subshell (`rm x <(curl e|sh)`) runs regardless,
        //   which is the same accepted shell-execution ceiling as a bare `curl e|sh`.
        for (const red of rmMatch[1]!.matchAll(/[0-9]*&?>>?\s*(\S+)/g)) {
          const tgtRaw = red[1]!;
          if (/^&?[0-9]+$/.test(tgtRaw)) continue; // fd dup: 2>&1, >&2
          const tgt = tgtRaw.replace(/['"]/g, "");
          if (/^\/dev\/(null|stdout|stderr)$/.test(tgt)) continue; // std sinks
          if (/[$`{}]/.test(tgt)) {
            return [false, `rm redirect to unresolved target: ${tgtRaw}`];
          }
          const redTarget =
            tgt.startsWith("/") || tgt.startsWith("~")
              ? tgt
              : resolve(WORKING_DIR, tgt);
          if (!isPathAllowed(redTarget)) {
            return [false, `rm redirect target outside allowed paths: ${tgt}`];
          }
        }

        // Drop redirect constructs anywhere in the arg list (fd?, optional &, one/two
        // <>, then the target token) — NOT just trailing ones. A leading redirect like
        // `>/dev/null /etc/x` must not swallow the real targets after it.
        const argStr = rmMatch[1]!.replace(
          /\s*[0-9]*&?[<>]{1,2}\s*\S*/g,
          " "
        );
        for (const raw of argStr.split(/\s+/)) {
          // The shell removes quotes before rm sees the path, so strip them here too —
          // otherwise `"/etc/passwd"` reads as a relative (in-tree) token and escapes.
          const arg = raw.replace(/['"]/g, "");
          if (!arg || arg.startsWith("-")) continue; // flags / empty tokens

          // Unresolvable shell expansion ($VAR, `cmd`, $(cmd), ${..}, brace lists):
          // cannot prove the expansion stays in-tree (it can produce `..`), so DENY.
          // ponytail: also denies a literal filename that really contains $/`/{}` (e.g.
          //   a single-quoted `'$x'`). Fail-closed is the correct side for a delete gate;
          //   allowing these chars back would reopen the variable-expansion bypass.
          if (/[$`{}]/.test(arg)) {
            return [false, `rm arg with unresolved shell expansion: ${raw}`];
          }

          // Globs (* ? [): a glob only matches entries under its fixed directory prefix,
          // so validate that prefix is in-tree instead of skipping the arg entirely.
          const globIdx = arg.search(/[*?[]/);
          if (globIdx !== -1) {
            // A `..` segment AFTER the glob can climb out of the validated prefix
            // (`/in/tree/x*/../../etc/passwd`), voiding the fixed-prefix guarantee — DENY.
            if (/(^|\/)\.\.(\/|$)/.test(arg.slice(globIdx))) {
              return [false, `rm glob with .. escape: ${raw}`];
            }
            const prefix = arg.slice(0, globIdx);
            const dir = prefix.endsWith("/") ? prefix : dirname(prefix);
            const dirTarget =
              dir.startsWith("/") || dir.startsWith("~")
                ? dir
                : resolve(WORKING_DIR, dir || ".");
            if (!isPathAllowed(dirTarget)) {
              return [false, `rm glob outside allowed paths: ${raw}`];
            }
            continue;
          }

          // Plain path — resolve relative to WORKING_DIR (where Claude runs).
          const target =
            arg.startsWith("/") || arg.startsWith("~")
              ? arg
              : resolve(WORKING_DIR, arg);
          if (!isPathAllowed(target)) {
            return [false, `rm target outside allowed paths: ${target}`];
          }
        }
      }
    } catch {
      // If parsing fails, be cautious
      return [false, "Could not parse rm command for safety check"];
    }
  }

  return [true, ""];
}

// ============== Authorization ==============

export function isAuthorized(
  userId: number | undefined,
  allowedUsers: number[]
): boolean {
  if (!userId) return false;
  if (allowedUsers.length === 0) return false;
  return allowedUsers.includes(userId);
}

// ============== Tool Use Gate ==============

export type ToolVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * Built-in SDK tools that grant code/command execution, external publish, or
 * scheduled re-entry — with no legitimate use in a phone-controlled Claude Code
 * session. Denied outright.
 *
 * The gate is a blocklist, so an SDK bump can introduce a new dangerous tool that
 * falls through default-allow (this happened when the SDK grew from 0.2.x → 0.3.x,
 * audit 2026-07-05). The `SDK tool-surface tripwire` test in security.test.ts fails
 * on any new unreviewed tool schema — update this set (and that snapshot) together.
 * Exported so session.ts can also pass it as SDK `disallowedTools` (defense in depth).
 */
export const DENIED_TOOLS = new Set<string>([
  "REPL", // arbitrary JavaScript execution
  "Monitor", // background shell command
  "Agent", // spawns a subagent with its OWN Bash/file tools — a second exec surface
  //          this process's PreToolUse hook never reaches; isolation:"remote" runs
  //          off-host entirely. checkCommandSafety/isPathAllowed/SSRF gate can't span it.
  "Workflow", // script/agent orchestration (scriptPath never path-checked)
  "Artifact", // publishes a file to claude.ai — exfil channel
  "Projects", // project_write/project_delete — external claude.ai mutation/exfil
  "CronCreate", // schedule future prompts — persistence
  "CronDelete",
  "CronList",
  "ScheduleWakeup", // self-paced re-entry
  "RemoteTrigger", // trigger remote actions
  "PushNotification", // external push
  "EnterWorktree", // switches active workspace (path never gated)
  "ExitWorktree",
]);

/** Loopback / this-host / RFC1918-private / link-local IPv4 (a.b are the top octets). */
function isPrivateV4(a: number, b: number): boolean {
  if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, private
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  return false;
}

/**
 * Best-effort SSRF guard for WebFetch: block loopback / private / link-local
 * targets (cloud-metadata 169.254.169.254, the bot's own trigger port, LAN admin
 * panels) and non-http(s) schemes.
 * ponytail: literal-host + IPv4-range check only. DNS rebinding to a private IP is
 * NOT caught (would need resolve-then-check). Covers the concrete metadata/localhost
 * cases that matter under bypassPermissions; upgrade to resolve-first if it proves thin.
 */
function isBlockedFetchTarget(rawUrl: string): boolean {
  let host: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return true; // file:, gopher:, ...
    // Strip IPv6 brackets and a trailing dot (`localhost.` / FQDN-root form).
    // The WHATWG URL parser already folds decimal/octal/hex IPv4 to dotted form.
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return true; // unparseable ⇒ block
  }

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }

  // IPv6 literals (contain ":"). Gate on ":" so hostnames like "fd.io" or
  // "fc-barcelona.com" aren't misread as IPv6.
  if (host.includes(":")) {
    if (host === "::1") return true; // loopback
    if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
    if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local fc00::/7
    // IPv4-mapped IPv6 — the parser compresses the embedded v4 to hex groups,
    // e.g. ::ffff:127.0.0.1 → ::ffff:7f00:1, ::ffff:169.254.169.254 → ::ffff:a9fe:a9fe.
    const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const hi = parseInt(mapped[1]!, 16);
      if (isPrivateV4(hi >> 8, hi & 0xff)) return true;
    }
    return false;
  }

  // IPv4 literal
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return isPrivateV4(Number(m[1]), Number(m[2]));

  return false;
}

/** Resolve ~ and symlinks; fall back to lexical resolve for non-existent paths. */
function canonicalize(path: string): string {
  const expanded = path.replace(/^~/, process.env.HOME || "");
  try {
    return realpathSync(normalize(expanded));
  } catch {
    return resolve(normalize(expanded));
  }
}

/** Single gate for tool safety — used by the SDK PreToolUse hook and stream checks. */
export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>
): ToolVerdict {
  // Dangerous exec/publish/scheduling tools — no place in this bot.
  if (DENIED_TOOLS.has(toolName)) {
    return { allowed: false, reason: `Tool not permitted in bot context: ${toolName}` };
  }

  // WebFetch is legit but SSRF-dangerous under bypassPermissions.
  if (toolName === "WebFetch") {
    const rawUrl = input.url;
    if (rawUrl !== undefined && typeof rawUrl !== "string") {
      return { allowed: false, reason: "non-string WebFetch url" };
    }
    const url = String(rawUrl || "");
    if (url && isBlockedFetchTarget(url)) {
      return { allowed: false, reason: `WebFetch to non-public host blocked: ${url}` };
    }
  }

  if (toolName === "Bash") {
    const rawCommand = input.command;
    if (rawCommand !== undefined && typeof rawCommand !== "string") {
      return { allowed: false, reason: "non-string Bash command" };
    }
    const command = String(rawCommand || "");
    const [isSafe, reason] = checkCommandSafety(command);
    if (!isSafe) return { allowed: false, reason: reason ?? "unsafe command" };
  }

  if (["Read", "Write", "Edit", "NotebookEdit"].includes(toolName)) {
    const rawPath =
      toolName === "NotebookEdit" ? input.notebook_path : input.file_path;
    if (rawPath !== undefined && typeof rawPath !== "string") {
      return { allowed: false, reason: "non-string file path" };
    }
    const filePath = String(rawPath || "");
    if (filePath) {
      const canonical = canonicalize(filePath);
      // NotebookEdit is a write — no .claude read exemption.
      const isClaudeDirRead =
        toolName === "Read" && canonical.includes("/.claude/");
      if (!isClaudeDirRead && !isPathAllowed(canonical)) {
        return { allowed: false, reason: `File access outside allowed paths: ${filePath}` };
      }
    }
  }

  // Grep/Glob take an optional search dir; a present path outside the allowlist
  // lets Grep output_mode:"content" read files outside ALLOWED_PATHS. Absent = cwd.
  if (["Grep", "Glob"].includes(toolName)) {
    const rawPath = input.path;
    if (rawPath !== undefined && typeof rawPath !== "string") {
      return { allowed: false, reason: "non-string search path" };
    }
    const searchPath = String(rawPath || "");
    if (searchPath && !isPathAllowed(canonicalize(searchPath))) {
      return { allowed: false, reason: `Search outside allowed paths: ${searchPath}` };
    }
  }

  return { allowed: true };
}
