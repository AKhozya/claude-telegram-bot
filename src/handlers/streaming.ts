/**
 * Shared streaming callback for Claude Telegram Bot handlers.
 *
 * Provides a reusable status callback for streaming Claude responses.
 */

import { unlinkSync } from "fs";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard, InputFile } from "grammy";
import type { StatusCallback } from "../types";
import { isPathAllowed } from "../security";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  sendRichMessage,
  editRichMessage,
  TELEGRAM_RICH_LIMIT,
} from "../rich-message";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
} from "../config";

/**
 * Create inline keyboard for ask_user options.
 */
export function createAskUserKeyboard(
  requestId: string,
  options: string[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    // Truncate long options for button display
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    const callbackData = `askuser:${requestId}:${idx}`;
    keyboard.text(display, callbackData).row();
  }
  return keyboard;
}

/**
 * Check for pending ask-user requests and send inline keyboards.
 */
export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const glob = new Bun.Glob("ask-user-*.json");
  let buttonsSent = false;

  for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
    const filepath = `/tmp/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const question = data.question || "Please choose:";
      const options = data.options || [];
      const requestId = data.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;

        // Mark as sent
        data.status = "sent";
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      console.warn(`Failed to process ask-user file ${filepath}:`, error);
    }
  }

  return buttonsSent;
}

// File extensions grouped by Telegram send method
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".webm", ".mkv"]);
const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a"]);

/**
 * Check for pending send-file requests and deliver files via Telegram.
 */
export async function checkPendingSendFileRequests(
  ctx: Context,
  chatId: number
): Promise<boolean> {
  const glob = new Bun.Glob("send-file-*.json");
  let fileSent = false;

  for await (const filename of glob.scan({ cwd: "/tmp", absolute: false })) {
    const filepath = `/tmp/${filename}`;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      // Only process pending requests for this chat
      if (data.status !== "pending") continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const filePath: string = data.file_path || "";
      const caption: string | undefined = data.caption || undefined;

      if (!filePath) {
        try { unlinkSync(filepath); } catch { /* ignore */ }
        continue;
      }

      if (!isPathAllowed(filePath)) {
        console.warn(`send-file BLOCKED (outside allowed paths): ${filePath}`);
        try { unlinkSync(filepath); } catch { /* ignore */ }
        continue;
      }

      try {
        const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
        const inputFile = new InputFile(filePath);

        if (VIDEO_EXTENSIONS.has(ext)) {
          await ctx.replyWithVideo(inputFile, { caption });
        } else if (PHOTO_EXTENSIONS.has(ext)) {
          await ctx.replyWithPhoto(inputFile, { caption });
        } else if (AUDIO_EXTENSIONS.has(ext)) {
          await ctx.replyWithAudio(inputFile, { caption });
        } else {
          await ctx.replyWithDocument(inputFile, { caption });
        }

        fileSent = true;
      } catch (sendError) {
        console.error(`Failed to send file ${filePath}:`, sendError);
        await ctx.reply(
          `Failed to send file: ${filePath.split("/").pop() || "unknown"}`
        );
      }

      // Always clean up the request file
      try { unlinkSync(filepath); } catch { /* ignore */ }
    } catch (error) {
      console.warn(`Failed to process send-file request ${filepath}:`, error);
    }
  }

  return fileSent;
}

/**
 * Tracks state for streaming message updates.
 */
export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content
}

/**
 * Format content for Telegram, ensuring it fits within the message limit.
 * Truncates raw content and re-converts if HTML output exceeds the limit.
 */
function formatWithinLimit(
  content: string,
  safeLimit: number = TELEGRAM_SAFE_LIMIT
): string {
  let display =
    content.length > safeLimit ? content.slice(0, safeLimit) + "..." : content;
  let formatted = convertMarkdownToHtml(display);

  // HTML tags can inflate content beyond the limit - shrink until it fits
  if (formatted.length > TELEGRAM_MESSAGE_LIMIT) {
    const ratio = TELEGRAM_MESSAGE_LIMIT / formatted.length;
    display = content.slice(0, Math.floor(safeLimit * ratio * 0.95)) + "...";
    formatted = convertMarkdownToHtml(display);
  }

  return formatted;
}

/**
 * Split long formatted content into chunks and send as separate messages.
 */
async function sendChunkedMessages(
  ctx: Context,
  content: string
): Promise<void> {
  // Split on markdown content first, then format each chunk
  for (let i = 0; i < content.length; i += TELEGRAM_SAFE_LIMIT) {
    const chunk = content.slice(i, i + TELEGRAM_SAFE_LIMIT);
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      // HTML failed (possibly broken tags from split) - try plain text
      try {
        await ctx.reply(chunk);
      } catch (plainError) {
        console.debug("Failed to send chunk:", plainError);
      }
    }
  }
}

/**
 * Send Claude markdown as a Bot API 10.1 rich message, degrading on failure:
 * rich -> HTML -> plain text. Returns the created message, or null if all fail.
 */
async function sendRichWithFallback(
  ctx: Context,
  content: string
): Promise<Message | null> {
  const chatId = ctx.chatId;
  if (chatId === undefined) return null;

  // Rich path: pass Claude's GFM straight through (headings/tables/lists/code).
  if (content.length <= TELEGRAM_RICH_LIMIT) {
    try {
      return await sendRichMessage(chatId, content);
    } catch (richError) {
      console.debug("Rich send failed, falling back to HTML:", richError);
    }
  }
  // Fallback: HTML conversion (truncates), then plain text.
  const formatted = formatWithinLimit(content);
  try {
    return await ctx.reply(formatted, { parse_mode: "HTML" });
  } catch {
    try {
      return await ctx.reply(formatted);
    } catch (plainError) {
      console.debug("Plain reply failed:", plainError);
      return null;
    }
  }
}

/**
 * Edit a message in place to rich markdown, degrading rich -> HTML -> plain.
 * Throws "CONTENT_TOO_LONG"/MESSAGE_TOO_LONG so callers can delete + chunk.
 */
async function editRichWithFallback(
  ctx: Context,
  msg: Message,
  content: string
): Promise<void> {
  // Too long for a single rich message — signal caller to chunk full content.
  if (content.length > TELEGRAM_RICH_LIMIT) {
    throw new Error("CONTENT_TOO_LONG");
  }
  try {
    await editRichMessage(msg.chat.id, msg.message_id, content);
    return;
  } catch (richError) {
    console.debug("Rich edit failed, falling back to HTML:", richError);
  }
  // Fallback: HTML, then plain. Re-throw too-long so the caller can chunk.
  const formatted = formatWithinLimit(content);
  try {
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
      parse_mode: "HTML",
    });
  } catch (error) {
    if (String(error).includes("MESSAGE_TOO_LONG")) throw error;
    try {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted);
    } catch (editError) {
      // Total failure — propagate so the caller defers/chunks and does NOT
      // cache this content as delivered (which would skip a later retry).
      console.debug("Edit message failed:", editError);
      throw editError;
    }
  }
}

/**
 * Create a status callback for streaming updates.
 */
export function createStatusCallback(
  ctx: Context,
  state: StreamingState
): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        // Show thinking inline, compact (first 500 chars)
        const preview =
          content.length > 500 ? content.slice(0, 500) + "..." : content;
        const escaped = escapeHtml(preview);
        const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.toolMessages.push(thinkingMsg);
      } else if (statusType === "tool") {
        const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
      } else if (statusType === "text" && segmentId !== undefined) {
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;

        if (!state.textMessages.has(segmentId)) {
          // New segment - create rich message (lastContent tracks raw markdown)
          const msg = await sendRichWithFallback(ctx, content);
          if (msg) {
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, content);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          // Update existing segment message (throttled)
          const msg = state.textMessages.get(segmentId)!;
          // Skip if content unchanged
          if (content === state.lastContent.get(segmentId)) {
            return;
          }
          try {
            await editRichWithFallback(ctx, msg, content);
            state.lastContent.set(segmentId, content);
          } catch {
            // Too long for an intermediate edit - segment_end will chunk it
            console.debug("Streaming edit too long, deferring to segment_end");
          }
          state.lastEditTimes.set(segmentId, now);
        }
      } else if (statusType === "segment_end" && segmentId !== undefined) {
        if (!content) return;

        // Short responses may skip the "text" event (throttle threshold),
        // so no message exists yet — create one directly (#12 fix).
        if (!state.textMessages.has(segmentId)) {
          if (content.length > TELEGRAM_RICH_LIMIT) {
            // Too long for one rich message - chunk the full content as HTML
            await sendChunkedMessages(ctx, convertMarkdownToHtml(content));
            return;
          }
          const msg = await sendRichWithFallback(ctx, content);
          if (msg) {
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, content);
          }
          return;
        }

        const msg = state.textMessages.get(segmentId)!;
        // Skip if content unchanged
        if (content === state.lastContent.get(segmentId)) {
          return;
        }

        try {
          await editRichWithFallback(ctx, msg, content);
          state.lastContent.set(segmentId, content);
        } catch {
          // Too long for one message - delete the partial and chunk full content
          try {
            await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
          } catch (delError) {
            console.debug("Failed to delete for chunking:", delError);
          }
          await sendChunkedMessages(ctx, convertMarkdownToHtml(content));
        }
      } else if (statusType === "done") {
        // Delete tool messages - text messages stay
        for (const toolMsg of state.toolMessages) {
          try {
            await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
          } catch (error) {
            console.debug("Failed to delete tool message:", error);
          }
        }
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
