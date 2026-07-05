/**
 * Security module for Claude Telegram Bot.
 *
 * Rate limiting, path validation, command safety.
 */

import { resolve, normalize } from "path";
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

  // Special handling for rm commands - validate paths
  // Match rm as a standalone command (not substring like "perform")
  if (/\brm\s/.test(lowerCommand)) {
    try {
      // Extract arguments after rm, stopping at shell operators
      const rmMatch = command.match(/\brm\s+(.+)/i);
      if (rmMatch) {
        // Strip trailing shell redirects/operators before splitting
        const rawArgs = rmMatch[1]!
          .replace(/\s*[12]?>.*$/, "") // redirects: 2>&1, >/dev/null, etc.
          .replace(/\s*[;|&].*$/, "") // operators: ; | && ||
          .split(/\s+/);
        for (const arg of rawArgs) {
          // Skip flags and empty tokens
          if (arg.startsWith("-") || arg.length <= 1) continue;
          // Skip shell globs/variables that can't be resolved
          if (/[*?$`]/.test(arg)) continue;

          // Resolve relative paths against WORKING_DIR (where Claude runs)
          const target = arg.startsWith("/") || arg.startsWith("~")
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
