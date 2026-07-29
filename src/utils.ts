/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, typing indicator.
 */

import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import {
  AUDIT_LOG_PATH,
  AUDIT_LOG_JSON,
  TEMP_DIR,
  TEMP_REAP_INTERVAL_MS,
  TEMP_RETENTION_MS,
} from "./config";

// ============== Audit Logging ==============

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      const lines = ["\n" + "=".repeat(60)];
      for (const [key, value] of Object.entries(event)) {
        let displayValue = value;
        if (
          (key === "content" || key === "response") &&
          String(value).length > 500
        ) {
          displayValue = String(value).slice(0, 500) + "...";
        }
        lines.push(`${key}: ${displayValue}`);
      }
      content = lines.join("\n") + "\n";
    }

    const fs = await import("fs/promises");
    await fs.appendFile(AUDIT_LOG_PATH, content);
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}

export async function auditLog(
  userId: number,
  username: string,
  messageType: string,
  content: string,
  response = ""
): Promise<void> {
  const event: AuditEvent = {
    timestamp: new Date().toISOString(),
    event: "message",
    user_id: userId,
    username,
    message_type: messageType,
    content,
  };
  if (response) {
    event.response = response;
  }
  await writeAuditLog(event);
}


export async function auditLogRateLimit(
  userId: number,
  username: string,
  retryAfter: number
): Promise<void> {
  await writeAuditLog({
    timestamp: new Date().toISOString(),
    event: "rate_limit",
    user_id: userId,
    username,
    retry_after: retryAfter,
  });
}

// ============== Typing Indicator ==============

export interface TypingController {
  stop: () => void;
}

export function startTypingIndicator(ctx: Context): TypingController {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (error) {
        console.debug("Typing indicator failed:", error);
      }
      await Bun.sleep(4000);
    }
  };

  loop();

  return {
    stop: () => {
      running = false;
    },
  };
}

// ============== Temp Reaper ==============

/**
 * `lstat`, not `stat`: a symlink must be aged by the link itself, or one pointing at a
 * fresh file keeps a stale entry alive forever. `rm` on a symlink unlinks the link,
 * never the target.
 *
 * dir/age/clock are injectable so the test does not have to wait an hour.
 */
export async function reapTempDir(
  dir: string = TEMP_DIR,
  maxAgeMs: number = TEMP_RETENTION_MS,
  now: number = Date.now()
): Promise<number> {
  const fs = await import("fs/promises");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    console.warn(`Temp reaper: cannot read ${dir}:`, error);
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (name === ".keep") continue; // the marker that makes TEMP_DIR exist
    const path = `${dir}/${name}`;
    try {
      const info = await fs.lstat(path);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await fs.rm(path, { recursive: true, force: true });
      removed++;
    } catch (error) {
      console.debug(`Temp reaper: skipped ${path}:`, error);
    }
  }
  if (removed > 0) {
    console.log(`Temp reaper: removed ${removed} stale entries from ${dir}`);
  }
  return removed;
}

export function startTempReaper(
  intervalMs: number = TEMP_REAP_INTERVAL_MS
): { stop: () => void } {
  // Sweep once at boot too: a pod that restarts more often than the interval would
  // otherwise never reach a tick, and restarts are exactly when /tmp is already dirty.
  void reapTempDir();
  const timer = setInterval(() => void reapTempDir(), intervalMs);
  timer.unref?.(); // a pending sweep must never hold the process open on shutdown
  return { stop: () => clearInterval(timer) };
}

// ============== Message Interrupt ==============

// Import session lazily to avoid circular dependency
let sessionModule: {
  session: {
    isRunning: boolean;
    interruptForNewMessage: () => Promise<void>;
  };
} | null = null;

export async function checkInterrupt(text: string): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  if (!sessionModule) {
    sessionModule = await import("./session");
  }

  const strippedText = text.slice(1).trimStart();
  const normalizedInterrupt = strippedText.trim().toLowerCase();

  if (sessionModule.session.isRunning) {
    console.log("! prefix - interrupting current query");
    await sessionModule.session.interruptForNewMessage();
  }

  // Treat !stop as a pure stop alias (same behavior as /stop):
  // cancel current work and do not forward "stop" as a new prompt.
  if (normalizedInterrupt === "stop" || normalizedInterrupt === "/stop") {
    return "";
  }

  return strippedText;
}
