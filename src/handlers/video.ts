/**
 * Video handler for Claude Telegram Bot.
 *
 * Downloads video files and passes them to video-processing skill for transcription.
 */

import type { BotContext } from "../types";
import { session } from "../session";
import { TEMP_DIR } from "../config";
import { rateLimiter } from "../security";
import { auditLog, auditLogRateLimit, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { handleProcessingError } from "./media-group";
import { downloadTelegramFile } from "./download";
import { markReceived, markDone, markFailed } from "./reactions";

// Local cap, not Telegram's. Checked against `file_size` before download so an
// oversized clip is rejected without spending the transfer.
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

async function downloadVideo(ctx: BotContext): Promise<string> {
  const video = ctx.message?.video || ctx.message?.video_note;
  if (!video) {
    throw new Error("No video in message");
  }

  const timestamp = Date.now();

  // Telegram delivers both regular videos and video notes as mp4.
  const videoPath = `${TEMP_DIR}/video_${timestamp}.mp4`;

  return await downloadTelegramFile(ctx, videoPath);
}

export async function handleVideo(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const video = ctx.message?.video || ctx.message?.video_note;
  const caption = ctx.message?.caption;

  if (!userId || !chatId || !video) {
    return;
  }

  await markReceived(ctx);

  if (video.file_size && video.file_size > MAX_VIDEO_SIZE) {
    await markFailed(ctx);
    await ctx.reply(
      `❌ Video too large. Maximum size is ${MAX_VIDEO_SIZE / 1024 / 1024}MB.`
    );
    return;
  }

  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(
      `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
    );
    await markFailed(ctx);
    return;
  }

  console.log(`Received video from @${username}`);

  let videoPath: string;
  const statusMsg = await ctx.reply("📹 Downloading video...");

  try {
    videoPath = await downloadVideo(ctx);
  } catch (error) {
    console.error("Failed to download video:", error);
    await markFailed(ctx);
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      "❌ Failed to download video."
    );
    return;
  }

  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  try {
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      "📹 Processing video..."
    );

    const prompt = caption
      ? `Here's a video file at path: ${videoPath}\n\nUser says: ${caption}`
      : `I've received a video file at path: ${videoPath}\n\nPlease transcribe it for me.`;

    if (!session.isActive) {
      const rawTitle = caption || "[Video]";
      const title =
        rawTitle.length > 50 ? rawTitle.slice(0, 47) + "..." : rawTitle;
      session.conversationTitle = title;
    }

    const state = new StreamingState();
    const statusCallback = createStatusCallback(ctx, state);

    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(userId, username, "VIDEO", caption || "[video]", response);
    await markDone(ctx);

    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore deletion errors
    }
  } catch (error) {
    console.error("Video processing error:", error);

    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {
      // Ignore
    }

    await handleProcessingError(ctx, error, []);
  } finally {
    stopProcessing();
    typing.stop();

    // The video file deliberately outlives this handler: the video-processing
    // skill reads it after the turn ends. TEMP_DIR cleanup is the only reaper.
  }
}
