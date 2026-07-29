/**
 * Text message handler for Claude Telegram Bot.
 */

import type { BotContext } from "../types";
import { session } from "../session";
import { rateLimiter } from "../security";
import {
  auditLog,
  auditLogRateLimit,
  checkInterrupt,
  startTypingIndicator,
} from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { markReceived, markDone, markFailed } from "./reactions";
import { describeError } from "../formatting";

export async function handleText(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  let message = ctx.message?.text;

  if (!userId || !message || !chatId) {
    return;
  }

  // A bare "!stop"/empty interrupt is a pure stop alias — no reaction.
  // Only real follow-up prompts get 👀.
  message = await checkInterrupt(message);
  if (!message.trim()) {
    return;
  }
  await markReceived(ctx);

  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    await markFailed(ctx);
    return;
  }

  session.lastMessage = message; // consumed by /retry

  if (!session.isActive) {
    const title =
      message.length > 50 ? message.slice(0, 47) + "..." : message;
    session.conversationTitle = title;
  }

  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  let state = new StreamingState();
  let statusCallback = createStatusCallback(ctx, state);

  const MAX_RETRIES = 1;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await session.sendMessageStreaming(
        message,
        username,
        userId,
        statusCallback,
        chatId,
        ctx
      );

      await auditLog(userId, username, "TEXT", message, response);
      await markDone(ctx);
      break;
    } catch (error) {
      const errorStr = String(error);
      const isClaudeCodeCrash = errorStr.includes("exited with code");

      for (const toolMsg of state.toolMessages) {
        try {
          await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Crash only — a user cancellation must not be retried behind their back.
      if (isClaudeCodeCrash && attempt < MAX_RETRIES) {
        console.log(
          `Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await session.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state);
        continue;
      }

      console.error("Error processing message:", error);

      if (errorStr.includes("abort") || errorStr.includes("cancel")) {
        // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
        const wasInterrupt = session.consumeInterruptFlag();
        if (!wasInterrupt) {
          await ctx.reply("🛑 Query stopped.");
        }
      } else {
        await ctx.reply(`❌ Error: ${describeError(error)}`);
      }
      await markFailed(ctx);
      break;
    }
  }

  stopProcessing();
  typing.stop();
}
