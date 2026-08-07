/**
 * Video handler for Claude Telegram Bot.
 *
 * Downloads the video, transcribes its audio track with whisper.cpp, extracts stills at the
 * scene changes, and passes the transcript plus both sets of paths to Claude. There is no
 * video tool, so the frames are how the picture reaches it at all — Claude reads them as
 * images, the same way photo.ts hands over a photo.
 */

import type { BotContext } from "../types";
import { session } from "../session";
import { TRANSCRIBE_MAX_DURATION_S } from "../config";
import { auditLog, startTypingIndicator, uniqueTempDir } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { handleProcessingError } from "./errors";
import { downloadTelegramFile } from "./download";
import { markReceived, markDone, markFailed } from "./reactions";
import { rateLimitOrReply } from "./rate-limit";
import {
  transcribeMedia,
  probeDuration,
  extractSceneFrames,
  NoAudioTrackError,
  SilentAudioError,
} from "../transcribe";

// Local cap, not Telegram's. Checked against `file_size` before download so an
// oversized clip is rejected without spending the transfer.
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

/** What this handler needs from a message, whichever shape the video arrived in. */
interface VideoSource {
  file_id: string;
  file_size?: number;
  /** Absent on documents — Telegram reports it only for video and video_note. */
  duration?: number;
  file_name?: string;
}

/**
 * The video in this message, including one attached as a file.
 *
 * Telegram picks `video` or `document` at send time: the gallery picker gives the first,
 * "attach file" the second, and desktop drag-and-drop routinely gives the second for the
 * same clip. Rejecting that shape reads as the bot being broken.
 */
export function videoSource(ctx: BotContext): VideoSource | undefined {
  const doc = ctx.message?.document;
  return (
    ctx.message?.video ||
    ctx.message?.video_note ||
    (doc?.mime_type?.startsWith("video/") ? doc : undefined)
  );
}

async function downloadVideo(ctx: BotContext): Promise<string> {
  const video = videoSource(ctx);
  if (!video) {
    throw new Error("No video in message");
  }

  // Telegram delivers both regular videos and video notes as mp4; a file keeps its own
  // extension, which ffmpeg ignores anyway since it identifies inputs by content. The random
  // suffix in uniqueTempDir is load-bearing now that a .wav is derived from this path.
  const extension = extensionOf(video.file_name) || ".mp4";
  const videoPath = `${uniqueTempDir("video")}${extension}`;

  return await downloadTelegramFile(ctx, videoPath);
}

/**
 * Lower-cased extension including the dot, or "" when the name has no usable one.
 *
 * `file_name` is sender-controlled: a 255-byte name ending in a long run of dot-free text
 * would push the generated path past the filesystem's limit, and one containing a separator
 * would aim it at a directory that does not exist. Both fail the download, so only a short
 * alphanumeric suffix is accepted and anything else falls back to the default.
 */
function extensionOf(fileName?: string): string {
  const dot = fileName?.lastIndexOf(".") ?? -1;
  if (dot <= 0) return "";
  const extension = fileName!.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : "";
}

export async function handleVideo(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const video = videoSource(ctx);
  const caption = ctx.message?.caption;

  if (!userId || !chatId || !video) {
    return;
  }

  await markReceived(ctx);

  if (video.file_size && video.file_size > MAX_VIDEO_SIZE) {
    await markFailed(ctx);
    await ctx.reply(`❌ Video too large. Maximum size is ${MAX_VIDEO_SIZE / 1024 / 1024}MB.`);
    return;
  }

  // Size does not bound transcription time, so duration is guarded separately. Size is
  // checked first because it is the one that costs a transfer. A file-attached video has no
  // duration here at all; that case is measured after the download instead.
  if (video.duration !== undefined && video.duration > TRANSCRIBE_MAX_DURATION_S) {
    await markFailed(ctx);
    // Seconds, not minutes, matching the audio handler: the cap is configurable, and
    // flooring it reports "1 minutes" for a 90-second setting that allows 90 seconds.
    await ctx.reply(`❌ Too long to transcribe. Maximum is ${TRANSCRIBE_MAX_DURATION_S} seconds.`);
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
    await ctx.api.editMessageText(chatId, statusMsg.message_id, "❌ Failed to download video.");
    return;
  }

  // Kept for the frame extraction below, which falls back to evenly spaced stills when a clip
  // has no detectable cut and needs a length to space them across.
  let durationSeconds: number | null = video.duration ?? null;

  // The cap the pre-download check could not apply, for a video that arrived as a file. The
  // transfer is already spent by here — measuring first would mean downloading anyway.
  if (video.duration === undefined) {
    const seconds = await probeDuration(videoPath);
    durationSeconds = seconds;
    // Unmeasurable is refused, not waved through: this is the only duration cap this shape
    // gets, and a file ffprobe cannot read at all is one ffmpeg is unlikely to transcode.
    if (seconds === null || seconds > TRANSCRIBE_MAX_DURATION_S) {
      await markFailed(ctx);
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        seconds === null
          ? "❌ Couldn't read how long that video is."
          : `❌ Too long to transcribe. Maximum is ${TRANSCRIBE_MAX_DURATION_S} seconds.`,
      );
      return;
    }
  }

  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  // Declared outside the try so the catch can still reach the tool messages the
  // status callback posted — inside, a mid-query failure leaked every one of them.
  const state = new StreamingState();

  try {
    await ctx.api.editMessageText(chatId, statusMsg.message_id, "📹 Processing video...");

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
          : error instanceof SilentAudioError
            ? "[silent audio]"
            : "[audio could not be transcribed]";
      console.error("Video transcription failed:", error);
    }

    // Stills from the cuts, listed by path like photo.ts does — Claude reads images itself,
    // so nothing is embedded here. Failure is not fatal: the transcript and the path are
    // still worth sending, and a video whose frames cannot be read is usually one Claude
    // could not have used anyway.
    let frames: string[] = [];
    try {
      frames = await extractSceneFrames(videoPath, durationSeconds);
    } catch (error) {
      console.error("Frame extraction failed:", error);
    }
    const frameList =
      frames.length > 0
        ? `\n\nFrames from the video, in order:\n${frames
            .map((path, i) => `${i + 1}. ${path}`)
            .join("\n")}`
        : "";

    const prompt = caption
      ? `Here's a video file at path: ${videoPath}\n\nTranscript of its audio:\n${transcript}${frameList}\n\nUser says: ${caption}`
      : `I've received a video file at path: ${videoPath}\n\nTranscript of its audio:\n${transcript}${frameList}`;

    session.setTitleIfNew(caption || "[Video]");

    const statusCallback = createStatusCallback(ctx, state);

    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
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
