/**
 * Video handler for Claude Telegram Bot.
 *
 * Downloads the video, transcribes its audio track with whisper.cpp, and passes the
 * transcript plus the file path to Claude. Frames are not analysed — there is no video tool,
 * and the path is passed so Claude can reach the file itself if it needs to.
 */

import type { BotContext } from "../types";
import { session } from "../session";
import { TRANSCRIBE_MAX_DURATION_S } from "../config";
import { auditLog, startTypingIndicator, uniqueTempDir } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { handleProcessingError } from "./media-group";
import { downloadTelegramFile } from "./download";
import { markReceived, markDone, markFailed } from "./reactions";
import { rateLimitOrReply } from "./rate-limit";
import { transcribeMedia, NoAudioTrackError } from "../transcribe";

// Local cap, not Telegram's. Checked against `file_size` before download so an
// oversized clip is rejected without spending the transfer.
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

async function downloadVideo(ctx: BotContext): Promise<string> {
  const video = ctx.message?.video || ctx.message?.video_note;
  if (!video) {
    throw new Error("No video in message");
  }

  // Telegram delivers both regular videos and video notes as mp4. The random suffix in
  // uniqueTempDir is load-bearing now that a .wav is derived from this path.
  const videoPath = `${uniqueTempDir("video")}.mp4`;

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

  // Size does not bound transcription time, so duration is guarded separately. Size is
  // checked first because it is the one that costs a transfer.
  if (video.duration > TRANSCRIBE_MAX_DURATION_S) {
    await markFailed(ctx);
    // Seconds, not minutes, matching the audio handler: the cap is configurable, and
    // flooring it reports "1 minutes" for a 90-second setting that allows 90 seconds.
    await ctx.reply(
      `❌ Too long to transcribe. Maximum is ${TRANSCRIBE_MAX_DURATION_S} seconds.`
    );
    return;
  }

  if (await rateLimitOrReply(ctx, userId, username)) return;

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

  // Declared outside the try so the catch can still reach the tool messages the
  // status callback posted — inside, a mid-query failure leaked every one of them.
  const state = new StreamingState();

  try {
    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      "📹 Processing video..."
    );

    // A video with no audio track is normal, not an error — a screen recording, say. Any
    // other failure is reported in the prompt rather than aborting, because the file path
    // is still useful to Claude.
    let transcript = "";
    try {
      transcript = await transcribeMedia(videoPath);
    } catch (error) {
      transcript =
        error instanceof NoAudioTrackError
          ? "[no audio track]"
          : "[audio could not be transcribed]";
      console.error("Video transcription failed:", error);
    }

    const prompt = caption
      ? `Here's a video file at path: ${videoPath}\n\nTranscript of its audio:\n${transcript}\n\nUser says: ${caption}`
      : `I've received a video file at path: ${videoPath}\n\nTranscript of its audio:\n${transcript}`;

    session.setTitleIfNew(caption || "[Video]");

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

    await handleProcessingError(ctx, error, state);
  } finally {
    stopProcessing();
    typing.stop();

    // Deliberately not removed — the path went into the prompt, so Claude may still read
    // the file during the query above. The temp reaper collects it once it ages past
    // TEMP_RETENTION_HOURS — which also backs up the derived .wav, since transcribeMedia
    // unlinks that on a best-effort basis and swallows the failure.
  }
}
