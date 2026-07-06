/**
 * Utility functions for Claude Telegram Bot.
 *
 * Audit logging, typing indicator.
 */

import type { Chat } from "grammy/types";
import type { Context } from "grammy";
import type { AuditEvent } from "./types";
import { AUDIT_LOG_PATH, AUDIT_LOG_JSON } from "./config";

// ============== Audit Logging ==============

async function writeAuditLog(event: AuditEvent): Promise<void> {
  try {
    let content: string;
    if (AUDIT_LOG_JSON) {
      content = JSON.stringify(event) + "\n";
    } else {
      // Plain text format for readability
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

    // Append to audit log file
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

  // Start the loop
  loop();

  return {
    stop: () => {
      running = false;
    },
  };
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

  // Lazy import to avoid circular dependency
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
