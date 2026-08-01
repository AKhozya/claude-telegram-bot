/**
 * Voice and audio handler.
 *
 * The transcript is sent on as if the user had typed it: session.ts reads the thinking
 * keywords out of that text, so a spoken "ultrathink about X" behaves like the typed form.
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
import {
  transcribeMedia,
  NoAudioTrackError,
  TranscriptionUnavailableError,
} from "../transcribe";

// How much of the transcript the status message shows back. The whole thing still goes to
// Claude; this is only so the user can see what was heard.
// How much of the transcript the status message echoes back, in code points.
const TRANSCRIPT_PREVIEW_CHARS = 4000;
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TRANSCRIPT_PREFIX = "🎤 ";

/**
 * The longest prefix of `transcript` that still fits one Telegram message.
 *
 * Two limits, and they are not the same unit. The readability cap above counts code points;
 * Telegram counts UTF-16 units, so a transcript of astral characters is cut at roughly half
 * the code-point cap. Cutting on a code-point boundary keeps surrogate pairs whole — a lone
 * surrogate is not text Telegram reliably accepts, and a rejected edit throws past the
 * hand-off to Claude, costing the query for a cosmetic preview.
 *
 * Exported so the boundaries can be pinned directly — reaching them through the handler costs
 * a full ctx and a stubbed pipeline per case.
 */
export function transcriptPreview(transcript: string): string {
  const points = Array.from(transcript);
  // -1 for the ellipsis that truncation appends.
  const budget = TELEGRAM_MESSAGE_LIMIT - TRANSCRIPT_PREFIX.length - 1;
  let units = 0;
  let taken = 0;
  while (taken < points.length && taken < TRANSCRIPT_PREVIEW_CHARS) {
    const next = units + points[taken]!.length;
    if (next > budget) break;
    units = next;
    taken += 1;
  }
  return taken === points.length
    ? transcript
    : `${points.slice(0, taken).join("")}…`;
}

export async function handleAudio(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const media = ctx.message?.voice || ctx.message?.audio;

  if (!userId || !chatId || !media) {
    return;
  }

  await markReceived(ctx);

  // Checked before the download: transcription costs ~4.9s per audio-minute, and file size
  // does not bound that — 20 MB of opus is about two hours of speech.
  if (media.duration > TRANSCRIBE_MAX_DURATION_S) {
    await markFailed(ctx);
    // Seconds, not minutes: the cap is configurable, and flooring it to whole minutes
    // reports "1 minutes" for a 90-second setting that in fact allows 90 seconds.
    await ctx.reply(
      `❌ Too long to transcribe. Maximum is ${TRANSCRIBE_MAX_DURATION_S} seconds.`
    );
    return;
  }

  if (await rateLimitOrReply(ctx, userId, username)) return;

  console.log(`Received ${ctx.message?.voice ? "voice" : "audio"} from @${username}`);

  // ⏳ rather than 🎤, which prefixes the transcript this is later edited into. Sharing the
  // emoji would let a transcript of "Transcribing..." produce an identical edit, and
  // Telegram rejects an unmodified edit with a 400 that would cost the whole query.
  const statusMsg = await ctx.reply("⏳ Transcribing...");

  // Marked busy before the transcription, not after: whisper can run for the better part of
  // a minute, and `session.isRunning` is what /status reads. Left until after, /status would
  // report an idle bot while it is plainly working. This does not make the transcription
  // interruptible — /stop marks a cancellation that `stopAndSettle` clears 100 ms later,
  // long before any query exists to consume it.
  const stopProcessing = session.startProcessing();
  const typing = startTypingIndicator(ctx);

  // Declared outside the try so the catch can still reach the tool messages the status
  // callback posted.
  const state = new StreamingState();

  try {
    // No extension: ffmpeg identifies inputs by content, and Telegram audio arrives as
    // anything from opus to flac. uniqueTempDir, not a bare timestamp — two chats can
    // send in the same millisecond, and the loser's cleanup would delete the winner's file.
    let mediaPath: string;
    try {
      mediaPath = await downloadTelegramFile(ctx, uniqueTempDir("audio"));
    } catch (error) {
      console.error("Failed to download audio:", error);
      await markFailed(ctx);
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        "❌ Failed to download audio."
      );
      return;
    }

    let transcript: string;
    try {
      transcript = await transcribeMedia(mediaPath);
    } catch (error) {
      console.error("Transcription failed:", error);
      await markFailed(ctx);
      const message =
        error instanceof TranscriptionUnavailableError
          ? "❌ Transcription isn't available on this host."
          : error instanceof NoAudioTrackError
            ? "❌ That file has no audio track."
            : "❌ Couldn't transcribe that.";
      await ctx.api.editMessageText(chatId, statusMsg.message_id, message);
      return;
    }

    await ctx.api.editMessageText(
      chatId,
      statusMsg.message_id,
      `${TRANSCRIPT_PREFIX}${transcriptPreview(transcript)}`
    );

    session.lastMessage = transcript; // consumed by /retry
    session.setTitleIfNew(transcript);

    const statusCallback = createStatusCallback(ctx, state);

    const response = await session.sendMessageStreaming(
      transcript,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );

    await auditLog(userId, username, "VOICE", transcript, response);
    await markDone(ctx);
  } catch (error) {
    await handleProcessingError(ctx, error, state);
  } finally {
    stopProcessing();
    typing.stop();
  }
}
