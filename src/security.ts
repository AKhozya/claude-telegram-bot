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
