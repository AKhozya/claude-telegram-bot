/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize, dirname, basename, join } from "path";
import { realpathSync, lstatSync, readlinkSync } from "fs";
import { lookup } from "dns/promises";
import type { RateLimitBucket } from "./types";
import {
  ALLOWED_PATHS,
  AUDIT_LOG_PATH,
  BLOCKED_PATTERNS,
  RATE_LIMIT_ENABLED,
  RATE_LIMIT_REQUESTS,
  RATE_LIMIT_WINDOW,
  RESTART_FILE,
  SESSION_FILE,
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

/**
 * Deny any OUTPUT redirect (`>f` `>>f` `2>f`, force-clobber `>|f` folded to `>f`) whose
 * target is outside ALLOWED_PATHS — a write/overwrite primitive that rides past per-tool
 * path checks (`echo x >/etc/passwd`). Returns a deny reason, or null if every target is
 * a std sink, fd-dup, process substitution `>(cmd)`, or in-tree.
 * The target is captured as a full shell word (quoted span, `\`-escaped char, or a run of
 * non-space/non-`<>` chars): a plain `\S+` stopped at the first space, so a quoted target
 * whose internal space hid `../../` passed as its in-tree prefix; stopping at `<>` also
 * splits a glued `>/in/a>/etc/x` rather than swallowing the second redirect.
 * Over-blocks a literal `>` in quotes / `[[ a > b ]]` / a heredoc body line (fail-closed);
 * the unbounded write surface is #12.
 */
function checkRedirectTargets(segment: string): string | null {
  for (const red of segment.matchAll(
    /[0-9]*&?>>?\s*((?:"[^"]*"|'[^']*'|\\.|[^\s<>])+)/g
  )) {
    const tgtRaw = red[1]!;
    if (/^&?[0-9]+$/.test(tgtRaw)) continue; // fd dup: 2>&1, >&2
    if (tgtRaw.startsWith("(")) continue; // process substitution >(cmd)
    const tgt = tgtRaw.replace(/['"]/g, "");
    if (/^\/dev\/(null|stdout|stderr)$/.test(tgt)) continue; // std sinks
    if (/[$`{}]/.test(tgt)) {
      return `redirect to unresolved target: ${tgtRaw}`;
    }
    const target =
      tgt.startsWith("/") || tgt.startsWith("~") ? tgt : resolve(WORKING_DIR, tgt);
    if (!isPathAllowed(target)) {
      return `redirect target outside allowed paths: ${tgt}`;
    }
  }
  return null;
}

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

  // Best-effort static parse: validate output-redirect targets on every command (#10)
  // and rm targets (#2) against ALLOWED_PATHS. A speed-bump against prompt-injected
  // writes/deletes, not a sandbox — it does NOT catch interpreter indirection (`sh -c`,
  // `eval`, `python -c`), arg-taking wrappers (`timeout 5 rm`), or non-rm/non-redirect
  // writers (`tee`, `dd of=`, `cp`/`mv`, `find -delete`). OS-level containment
  // (restricted user / read-only mounts outside ALLOWED_PATHS) is #12.
  try {
    // Fold the `>|` force-clobber redirect to a plain `>` so its `|` is not taken as a
    // pipe by the operator split below (`rm ok >|/etc/x`, `echo x >|/etc/x`).
    const normalized = command.replace(/>\|/g, ">");
    // Pull command-substitution / backtick BODIES out as their own segments — a write
    // inside `$(...)` or `` `...` `` runs as a real subshell regardless of what consumes
    // the output (`ls \`rm /etc/x\``, `x=$(echo p >/etc/x)`). Non-nested spans only
    // (deeper nesting is part of the documented ceiling). Then split everything on shell
    // operators so a chained/piped write (`rm ok; rm /etc/x`) is scanned too.
    const substBodies = [
      ...normalized.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g),
    ].map((m) => m[1] ?? m[2] ?? "");
    const segments = [normalized, ...substBodies].join("\n").split(/[;&|\n]+/);
    for (const segment of segments) {
      // /proc/<pid|self|thread-self>/environ exposes a process's secret env — `cat
      // /proc/1/environ` reads the parent bot's full env (secrets), bypassing the sanitizeEnv
      // scrub of Bash's OWN env. Speed-bump only: fail-open like the rest of this parser
      // (`/proc/$$/environ`, head/xxd, $(...) evade it). Real close is OS-level (#12 ceiling:
      // run Bash under a different uid than the bot, or unset secrets post-config-load).
      // `\/+` tolerates extra slashes (`/proc//1/environ`) and `(?:[^\s/]+\/+)*` tolerates
      // intermediate segments (`/proc/1/./environ`, `/proc/self/../1/environ`, the thread
      // form `/proc/1/task/2/environ`) that the kernel still resolves to the real file.
      if (/\/+proc\/+(?:\d+|self|thread-self)\/+(?:[^\s/]+\/+)*environ\b/i.test(segment)) {
        return [false, "read of /proc/<pid>/environ (process env) blocked"];
      }

      // #10: output-redirect targets — a write-anywhere primitive on any command.
      const redirectReason = checkRedirectTargets(segment);
      if (redirectReason) return [false, redirectReason];

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

      // Drop redirect constructs anywhere in the arg list (fd?, optional &, one/two
      // <>, then the target token) — NOT just trailing ones. A leading redirect like
      // `>/dev/null /etc/x` must not swallow the real targets after it. (Redirect
      // TARGETS were already containment-checked by checkRedirectTargets above.)
      const argStr = rmMatch[1]!.replace(/\s*[0-9]*&?[<>]{1,2}\s*\S*/g, " ");
      for (const raw of argStr.split(/\s+/)) {
        // The shell removes quotes before rm sees the path, so strip them here too —
        // otherwise `"/etc/passwd"` reads as a relative (in-tree) token and escapes.
        const arg = raw.replace(/['"]/g, "");
        if (!arg || arg.startsWith("-")) continue; // flags / empty tokens

        // Unresolvable shell expansion ($VAR, `cmd`, $(cmd), ${..}, brace list) can
        // produce `..`, so DENY. Also denies a literal filename containing $/`/{} —
        // fail-closed is the correct side for a delete gate.
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
    return [false, "Could not parse command for safety check"];
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
  "ClaudeDesign", // opaque {operation, arguments} dispatcher over claude.ai design
  //                surface — open-ended, server-validated, another publish/exfil
  //                channel with no legit phone-session use (SDK 0.3.200, audit 2026-07-10)
  "CronCreate", // schedule future prompts — persistence
  "CronDelete",
  "CronList",
  "ScheduleWakeup", // self-paced re-entry
  "RemoteTrigger", // trigger remote actions
  "PushNotification", // external push
  "EnterWorktree", // switches active workspace (path never gated)
  "ExitWorktree",
  "SendFeedback", // publishes conversation-derived reports to Anthropic — external
  //                publish channel, no phone-session use (SDK 0.3.212, audit 2026-07-17)
  "ProposeSkills", // injects SKILL.md drafts for adoption — skills execute in later
  //                 sessions (persistence); bot skills are chezmoi-managed, not
  //                 session-proposed (SDK 0.3.212, audit 2026-07-17)
]);

/** Loopback / this-host / RFC1918-private / link-local IPv4 (a.b are the top octets). */
function isPrivateV4(a: number, b: number): boolean {
  if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, private
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  return false;
}

/** Loopback / unspecified / link-local / unique-local IPv6, incl. IPv4-mapped forms. */
function isBlockedV6(addr: string): boolean {
  const h = addr.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (/^fe[89ab]/.test(h)) return true; // link-local fe80::/10
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped IPv6, either dotted (::ffff:127.0.0.1) or hex-compressed
  // (::ffff:7f00:1 — how the WHATWG URL parser and some resolvers emit it).
  const dotted = h.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (dotted) return isPrivateV4(Number(dotted[1]), Number(dotted[2]));
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    return isPrivateV4(hi >> 8, hi & 0xff);
  }
  return false;
}

/**
 * SSRF guard for WebFetch: block non-http(s) schemes and loopback/private/link-local
 * targets (metadata 169.254.169.254, the bot's own trigger port, LAN panels). For a
 * domain name, resolve it and re-check the IPs so a DNS record pointing at a private
 * address (`evil.example.com A 169.254.169.254`) can't slip past the literal check (#11).
 * Closes static malicious DNS; ACTIVE rebinding (flip between this lookup and WebFetch's
 * own) needs IP-pinning the SDK doesn't expose → egress policy / #12.
 */
async function isBlockedFetchTarget(rawUrl: string): Promise<boolean> {
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

  // IPv6 literal (contains ":"). Gate on ":" so hostnames like "fd.io" or
  // "fc-barcelona.com" aren't misread as IPv6.
  if (host.includes(":")) return isBlockedV6(host);

  // IPv4 literal
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) return isPrivateV4(Number(m[1]), Number(m[2]));

  // Domain name — resolve and re-check every address. Fail CLOSED if resolution
  // fails (nothing legit to fetch at a name that doesn't resolve anyway).
  try {
    const addrs = await lookup(host, { all: true });
    for (const { address, family } of addrs) {
      if (family === 4) {
        const parts = address.split(".").map(Number);
        if (isPrivateV4(parts[0]!, parts[1]!)) return true;
      } else if (family === 6 && isBlockedV6(address)) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}

/** Resolve ~ and symlinks to where a read/write would ACTUALLY land, tolerant of a not-yet-existing
 *  tail. CRITICAL: never lexically pre-collapse `..` — `resolve`/`normalize` cancel `..` against a
 *  preceding *symlink* segment as if it were a real dir, so `<allowed>/link/../x` would be approved
 *  while the OS follows `link` and writes elsewhere. `..` must apply to the already-RESOLVED physical
 *  path, exactly as realpath(3)/openat do. */
function canonicalize(path: string): string {
  const expanded = path.replace(/^~/, process.env.HOME || "");
  const abs = expanded.startsWith("/") ? expanded : `${process.cwd()}/${expanded}`;
  try {
    return realpathSync(abs); // fully exists — the kernel resolves symlinks + `..` correctly
  } catch {
    return resolvePhysical(abs.split("/"), 0); // missing tail / dangling symlink — resolve by hand
  }
}

/** realpath(3) semantics with a missing-tail tolerance: walk segments left-to-right, apply `..` to the
 *  resolved-so-far physical path, follow symlinks as encountered, and append a non-existent tail only
 *  once a component is confirmed missing (symlinks can't traverse a path that doesn't exist). */
function resolvePhysical(segments: string[], depth: number): string {
  // Symlink cycle (or pathological nesting): fail CLOSED. Returning a textual path here could hand back
  // an approvable path with unresolved `..` for something the kernel would ELOOP on. Callers deny on throw.
  if (depth > 64) throw new Error("canonicalize: too many symlink levels");
  const stack: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined || seg === "" || seg === ".") continue;
    if (seg === "..") {
      stack.pop();
      continue;
    }
    const cur = "/" + [...stack, seg].join("/");
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      // cur is missing → nothing deeper exists; append remaining segments textually (honoring ./..).
      stack.push(seg);
      for (let j = i + 1; j < segments.length; j++) {
        const s = segments[j];
        if (s === undefined || s === "" || s === ".") continue;
        if (s === "..") stack.pop();
        else stack.push(s);
      }
      return "/" + stack.join("/");
    }
    if (st.isSymbolicLink()) {
      const link = readlinkSync(cur);
      const linkAbs = link.startsWith("/") ? link : "/" + [...stack, link].join("/");
      const resolvedLink = resolvePhysical(linkAbs.split("/"), depth + 1);
      return resolvePhysical([...resolvedLink.split("/"), ...segments.slice(i + 1)], depth + 1);
    }
    stack.push(seg);
  }
  return "/" + stack.join("/");
}

/**
 * Single gate for tool safety — used by the SDK PreToolUse hook and stream checks.
 * Async because the WebFetch SSRF check resolves DNS (audit #11); every other branch
 * is synchronous and returns without hitting an await.
 */
// Files whose CONTENT executes outside the Bash sandbox when Claude Code (re)loads project/user
// config: project `.mcp.json` (its command is spawned from the parent process), and Claude
// settings/hooks (define hooks that run on tool use). The sandbox denyWrite only binds Bash, so the
// native Write/Edit tools must be gated here too — else injected content writes one inside
// ALLOWED_PATHS and gains unsandboxed code execution on the next session.
export function isProtectedControlFile(canonicalPath: string): boolean {
  // Case-insensitive: macOS/APFS is case-insensitive, so a native Write to `.CLAUDE/settings.json`
  // creates the same file the CLI loads as `.claude/settings.json` — a case-sensitive match misses it.
  const p = canonicalPath.toLowerCase();
  const base = p.split("/").pop() ?? "";
  if (base === ".mcp.json") return true;
  if (/(?:^|\/)\.claude\/settings[^/]*\.json$/.test(p)) return true;
  if (/(?:^|\/)\.claude\/hooks\//.test(p)) return true;
  return false;
}

// Credential stores the native file tools must never read/write, even inside an ALLOWED_PATH. The
// Bash sandbox denyRead only binds Bash — without this, injected Claude reads a secret via the native
// Read tool instead, defeating the whole read blocklist. Mirrors READ_DENY in sandbox.ts.
export function isCredentialPath(canonicalPath: string): boolean {
  const p = canonicalPath.toLowerCase(); // case-insensitive: APFS resolves .KUBE/.Docker to .kube/.docker
  const base = basename(p);
  if (
    base === ".env" ||
    base === ".git-credentials" ||
    base === ".npmrc" ||
    base === ".pypirc" ||
    base === ".pgpass" ||
    base === ".netrc" ||
    base.startsWith(".credentials")
  ) {
    return true;
  }
  // /proc/<pid>/environ = a process's secret env. canonicalize (realpath) resolves
  // /proc/self → numeric and /proc/thread-self → /proc/<pid>/task/<tid>, so match both the
  // plain and the thread form. isPathAllowed already blocks /proc outside ALLOWED_PATHS;
  // this makes the secret-denial explicit, not emergent from the allowlist.
  if (/^\/proc\/\d+(?:\/task\/\d+)?\/environ$/.test(p)) return true;
  const home = (process.env.HOME || "").toLowerCase();
  if (!home) return false;
  const under = (dir: string) => p === dir || p.startsWith(`${dir}/`);
  return (
    under(`${home}/.ssh`) ||
    under(`${home}/.aws`) ||
    under(`${home}/.gnupg`) ||
    under(`${home}/.kube`) ||
    under(`${home}/.docker`) ||
    under(`${home}/.config`) // gh, op, gcloud, and any other credential store under XDG config
  );
}

// The bot's own runtime files live in /tmp (native-tool-accessible). Reading the audit log exfils past
// conversation content; writing session/restart files is a DoS. Canonicalized once at load.
const BOT_RUNTIME_FILES = new Set(
  [AUDIT_LOG_PATH, SESSION_FILE, RESTART_FILE].map((p) => canonicalize(p))
);

export async function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolVerdict> {
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
    if (url && (await isBlockedFetchTarget(url))) {
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
      let canonical: string;
      try {
        canonical = canonicalize(filePath);
      } catch {
        return { allowed: false, reason: `Unresolvable path (symlink loop?): ${filePath}` };
      }
      // Writing a code-execution control file runs OUTSIDE the Bash sandbox on next load; the
      // sandbox denyWrite only binds Bash, so block the native write tools here regardless of path.
      if (toolName !== "Read" && isProtectedControlFile(canonical)) {
        return { allowed: false, reason: `Write to code-execution control file blocked: ${filePath}` };
      }
      // Credential stores: deny native read AND write, even inside an ALLOWED_PATH (~/.claude is one).
      if (isCredentialPath(canonical)) {
        return { allowed: false, reason: `Access to credential store blocked: ${filePath}` };
      }
      // The bot's own audit log / session state (in /tmp) — reading exfils conversations, writing is DoS.
      if (BOT_RUNTIME_FILES.has(canonical)) {
        return { allowed: false, reason: `Access to bot runtime file blocked: ${filePath}` };
      }
      // NotebookEdit is a write — no .claude read exemption. Scope the exemption to
      // the user's OWN ~/.claude (config/skills), not any path with "/.claude/" in it
      // (`.includes` matched `/tmp/x/.claude/secret` and let it be read).
      // Fail CLOSED if HOME is unset (minimal launchd/systemd env): otherwise
      // claudeHome collapses to "/.claude/" and a real /.claude/secret would satisfy
      // startsWith and bypass isPathAllowed.
      const home = process.env.HOME || "";
      const isClaudeDirRead =
        toolName === "Read" && home !== "" && canonical.startsWith(`${home}/.claude/`);
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
    // isPathAllowed canonicalizes internally and denies on a resolver throw (symlink loop) — fail-closed.
    if (searchPath && !isPathAllowed(searchPath)) {
      return { allowed: false, reason: `Search outside allowed paths: ${searchPath}` };
    }
  }

  return { allowed: true };
}
