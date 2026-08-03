/**
 * Text message handler for Claude Telegram Bot.
 */

import type { BotContext } from "../types";
import { session } from "../session";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { handleProcessingError } from "./media-group";
import { markReceived, markDone } from "./reactions";
import { rateLimitOrReply } from "./rate-limit";

/**
 * Resolve a leading `!`: cancel whatever is running, then return what should be sent on.
 * `!stop` and `!/stop` return "" — a pure stop, forwarding nothing. Anything else keeps
 * its text and rides the same interrupt.
 *
 * Exported for test. Lived in utils.ts behind a lazy import to dodge a cycle that does
 * not exist — nothing session.ts reaches imports utils.ts.
 */
export async function checkInterrupt(text: string): Promise<string> {
  if (!text || !text.startsWith("!")) {
    return text;
  }

  const strippedText = text.slice(1).trimStart();
  const normalizedInterrupt = strippedText.trim().toLowerCase();

  if (session.isRunning) {
    console.log("! prefix - interrupting current query");
    await session.interruptForNewMessage();
  }

  if (normalizedInterrupt === "stop" || normalizedInterrupt === "/stop") {
    return "";
  }

  return strippedText;
}

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

  if (await rateLimitOrReply(ctx, userId, username)) return;

  session.lastMessage = message; // consumed by /retry

  session.setTitleIfNew(message);

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
      // Crash only — a user cancellation must not be retried behind their back.
      if (String(error).includes("exited with code") && attempt < MAX_RETRIES) {
        console.log(
          `Claude Code crashed, retrying (attempt ${attempt + 2}/${MAX_RETRIES + 1})...`
        );
        await state.deleteToolMessages(ctx);
        await session.kill(); // Clear corrupted session
        await ctx.reply(`⚠️ Claude crashed, retrying...`);
        state = new StreamingState();
        statusCallback = createStatusCallback(ctx, state);
        continue;
      }

      await handleProcessingError(ctx, error, state);
      break;
    }
  }

  stopProcessing();
  typing.stop();
}
