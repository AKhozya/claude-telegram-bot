import { unlinkSync } from "fs";
import type { BotContext } from "../types";
import { session } from "../session";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { handleProcessingError } from "./errors";

export async function handleCallback(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const callbackData = ctx.callbackQuery?.data;

  if (!userId || !chatId || !callbackData) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (callbackData.startsWith("resume:")) {
    await handleResumeCallback(ctx, callbackData);
    return;
  }

  // askuser:{request_id}:{option_index}
  if (!callbackData.startsWith("askuser:")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const parts = callbackData.split(":");
  if (parts.length !== 3) {
    await ctx.answerCallbackQuery({ text: "Invalid callback data" });
    return;
  }

  const requestId = parts[1]!;
  // request_id is interpolated into a /tmp path below — restrict to a safe charset so
  // a crafted value can't traverse (`../`) to read/unlink files outside the ask-user set.
  if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
    await ctx.answerCallbackQuery({ text: "Invalid request id" });
    return;
  }
  const optionIndex = parseInt(parts[2]!, 10);

  const requestFile = `/tmp/ask-user-${requestId}.json`;
  let requestData: {
    question: string;
    options: string[];
    status: string;
  };

  try {
    const file = Bun.file(requestFile);
    const text = await file.text();
    requestData = JSON.parse(text);
  } catch (error) {
    console.error(`Failed to load ask-user request ${requestId}:`, error);
    await ctx.answerCallbackQuery({ text: "Request expired or invalid" });
    return;
  }

  if (optionIndex < 0 || optionIndex >= requestData.options.length) {
    await ctx.answerCallbackQuery({ text: "Invalid option" });
    return;
  }

  const selectedOption = requestData.options[optionIndex]!;

  try {
    await ctx.editMessageText(`✓ ${selectedOption}`);
  } catch (error) {
    console.debug("Failed to edit callback message:", error);
  }

  await ctx.answerCallbackQuery({
    text: `Selected: ${selectedOption.slice(0, 50)}`,
  });

  try {
    unlinkSync(requestFile);
  } catch (error) {
    console.debug("Failed to delete request file:", error);
  }

  // Interrupt any running query - button responses are always immediate.
  // Shared dance: mark interrupt (silence the old query) + clear stopRequested
  // (so this button message is not cancelled at query start).
  if (session.isRunning) {
    console.log("Interrupting current query for button response");
    await session.interruptForNewMessage();
  }

  // Must follow the interrupt check above — it reads isRunning, which this sets.
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      selectedOption,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
    );

    await auditLog(userId, username, "CALLBACK", selectedOption, response);
  } catch (error) {
    await handleProcessingError(ctx, error, state);
  } finally {
    stopProcessing();
    typing.stop();
  }
}

/** resume:{session_id} */
async function handleResumeCallback(ctx: BotContext, callbackData: string): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const sessionId = callbackData.replace("resume:", "");

  if (!sessionId || !userId || !chatId) {
    await ctx.answerCallbackQuery({ text: "Invalid session ID" });
    return;
  }

  if (session.isActive) {
    await ctx.answerCallbackQuery({ text: "Session already active" });
    return;
  }

  const [success, message] = session.resumeSession(sessionId);

  if (!success) {
    await ctx.answerCallbackQuery({ text: message, show_alert: true });
    return;
  }

  try {
    await ctx.editMessageText(`✅ ${message}`);
  } catch (error) {
    console.debug("Failed to edit resume message:", error);
  }
  await ctx.answerCallbackQuery({ text: "Session resumed!" });

  // Hidden prompt: the user sees only the recap, never this instruction.
  const recapPrompt =
    "Please write a very concise recap of where we are in this conversation, to refresh my memory. Max 2-3 sentences.";

  // After answerCallbackQuery, not before: that call is outside the try below, so an
  // exception there would skip stopProcessing() and strand isRunning true for good.
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    await session.sendMessageStreaming(recapPrompt, username, userId, statusCallback, chatId, ctx);
  } catch (error) {
    console.error("Error getting recap:", error);
    // Don't show error to user - session is still resumed, recap just failed
  } finally {
    stopProcessing();
    typing.stop();
  }
}
