import { statSync, unlinkSync } from "fs";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard, InputFile } from "grammy";
import type { StatusCallback } from "../types";
import { isPathAllowed } from "../security";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  TELEGRAM_RICH_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
  TELEGRAM_CAPTION_LIMIT,
  TEMP_RETENTION_MS,
  IPC_PENDING_TTL_MS,
} from "../config";

/**
 * Where the MCP servers write their request files. Not configuration: the servers hardcode
 * the same path in their own source, and `callback.ts` hardcodes it a third time, so this
 * is one copy of a protocol convention rather than a symbol the three sides import.
 *
 * The pollers take it as a parameter anyway, because the reap deletes by age across every
 * chat and runs *before* the chat filter. A test that drives a poller against the real
 * `/tmp` therefore deletes the pending prompts of any bot running on the same host. Tests
 * pass a scratch directory; nothing in production overrides it.
 */
const IPC_DIR = "/tmp";

/**
 * Age by mtime, or `NaN` when it cannot be measured.
 *
 * Not `Infinity`: that reads as "older than any threshold" and would delete a live
 * request whenever `stat` failed for a reason that has nothing to do with the file being
 * stale — `EIO`, or `EMFILE` once the process is out of descriptors, which is exactly
 * when a busy bot has requests in flight. `NaN` loses every comparison in
 * `reapIfOlderThan`, so an unmeasurable file is left for the next poll.
 *
 * mtime, not the `created_at` the servers write into the JSON: the retention reap runs
 * before the parse on purpose, and a clock that has to be parsed cannot reap a truncated
 * file. The cost is that flipping an ask-user request to `sent` rewrites it and restarts
 * its retention. That rewrite happens at delivery, and a pending file is delivered only
 * while a poll still samples its age under IPC_PENDING_TTL_MS, so the restart is minutes
 * in, against a default 24 h. A send-file request is never rewritten.
 *
 * Exported for the test that pins this, because `Bun.Glob` skips a dangling symlink and
 * there is no other way to drive a failing `stat` through the pollers.
 */
export function fileAgeMs(filepath: string): number {
  try {
    return Date.now() - statSync(filepath).mtimeMs;
  } catch {
    return NaN;
  }
}

function discard(filepath: string): void {
  try {
    unlinkSync(filepath);
  } catch {
    /* ignore */
  }
}

/**
 * Delete this request file if it is older than `ttlMs`, reporting whether it went.
 *
 * Nothing else reaps these. `reapTempDir` sweeps TEMP_DIR, and an `ask-user-*.json` is
 * otherwise removed only when its button is tapped — so an untapped prompt leaves a file
 * behind for good, and a `pending` one left by a crash is re-delivered on the next poll
 * for that chat, which is what the five-minute window below bounds. Every `continue` in
 * the loops below skips without deleting, which is the other way these accumulate.
 *
 * Both windows are traffic-driven, not timed. The loops below run only from the
 * `mcp__ask-user` and `mcp__send-file` branches of `session.ts`, and each scans its own
 * glob, so an idle bot reaps nothing and a stranded file waits for the next call of its
 * own kind. TEMP_RETENTION_MS is the age at which one becomes eligible, not a bound on
 * how long it survives. A timer is deliberately not here: it would sweep a shared `/tmp`
 * while this bot is idle, taking a second bot's live requests with it.
 *
 * Called twice per file, and the order is load-bearing. Retention runs BEFORE the parse,
 * because an unparseable file is still a file: it throws, gets logged, and would otherwise
 * be re-read and re-logged on every poll for the life of the host. The shorter pending
 * window can only run after the parse, since it needs the status.
 *
 * Both operands are checked for finiteness outright rather than leaning on `NaN` losing
 * its comparisons: the failure mode here is deletion, and `ageMs <= ttlMs` reads false for
 * a `NaN` age, which would delete the very file whose age could not be measured. An
 * unmeasurable age (see `fileAgeMs`) and a misconfigured threshold must both reap nothing.
 * The threshold half is reachable rather than defensive: `positiveNumberEnv` vets
 * TEMP_RETENTION_HOURS and not what is derived from it, so 1e302 hours passes and then
 * overflows to Infinity in milliseconds.
 *
 * Exported alongside `fileAgeMs` for the test that pins that, since neither a failing
 * `stat` nor a non-finite retention can be driven through the pollers.
 */
export function reapIfOlderThan(filepath: string, ageMs: number, ttlMs: number): boolean {
  if (!Number.isFinite(ageMs) || !Number.isFinite(ttlMs)) return false;
  if (ageMs <= ttlMs) return false;
  discard(filepath);
  return true;
}

/**
 * A fragment fit to interpolate into a reply: cut to `max` UTF-16 units, with any
 * unpaired surrogate replaced.
 *
 * The unit is not the one Telegram counts, and does not need to be — these bounds keep a
 * reply sendable rather than meeting an API limit, unlike the caption above. What matters
 * is that a cut here cannot emit half a character: the replacement covers both the half a
 * cut through an astral character leaves and one the input already carried, which a file
 * in a world-writable directory can supply through `JSON.parse` of a `\ud800` escape.
 */
function clip(text: string, max: number): string {
  return text.slice(0, max).replace(/[\uD800-\uDFFF]/gu, "�");
}

/**
 * A short reason for a failed send, fit to put in a chat message.
 *
 * grammY wraps an upload failure in `HttpError` and, unless `sensitiveLogs` is on, leaves
 * the thrown error's own message out of the text — deliberately, because it can carry the
 * request URL and the URL carries the bot token. This bot never sets that option, so the
 * wrapper alone reads `Network request for 'sendDocument' failed!` and names no cause.
 * The errno is lifted off `.error` by name; the nested message never is.
 *
 * A Telegram rejection needs none of that. `GrammyError` builds its own message as
 * `... (error_code: description)`, so the reason is already in the text.
 *
 * Total, and every part bounded. The error is whatever the send threw, so a hostile shape
 * has to degrade to a worse message rather than to a throw — `String()` throws on a
 * null-prototype object, and any property read here can be a getter that throws. An
 * exception escaping would cost the report; the request is consumed either way.
 */
function sendFailureReason(error: unknown): string {
  try {
    const text = clip(String(error), 200);
    const code = (error as { error?: { code?: unknown } })?.error?.code;
    // Skipped when the text already carries it, which is the unwrapped case.
    return typeof code === "string" && !text.includes(code) ? `${text} (${clip(code, 32)})` : text;
  } catch {
    return "unreportable error";
  }
}

export function createAskUserKeyboard(requestId: string, options: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let idx = 0; idx < options.length; idx++) {
    const option = options[idx]!;
    const display =
      option.length > BUTTON_LABEL_MAX_LENGTH
        ? option.slice(0, BUTTON_LABEL_MAX_LENGTH) + "..."
        : option;
    keyboard.text(display, `askuser:${requestId}:${idx}`).primary().row();
  }
  return keyboard;
}

export async function checkPendingAskUserRequests(
  ctx: Context,
  chatId: number,
  dir: string = IPC_DIR,
): Promise<boolean> {
  const glob = new Bun.Glob("ask-user-*.json");
  let buttonsSent = false;

  for await (const filename of glob.scan({ cwd: dir, absolute: false })) {
    const filepath = `${dir}/${filename}`;
    const ageMs = fileAgeMs(filepath);
    // Before the parse — see reapIfOlderThan: a file too broken to read is exactly the
    // one that would otherwise be re-read forever.
    if (reapIfOlderThan(filepath, ageMs, TEMP_RETENTION_MS)) continue;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      const isPending = data.status === "pending";
      // Ahead of the chat filter, which skips without deleting — otherwise another
      // session's orphan is passed over on every poll and never reaped.
      if (isPending && reapIfOlderThan(filepath, ageMs, IPC_PENDING_TTL_MS)) continue;
      if (!isPending) continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const question = data.question || "Please choose:";
      const options = data.options || [];
      const requestId = data.request_id || "";

      if (options.length > 0 && requestId) {
        const keyboard = createAskUserKeyboard(requestId, options);
        await ctx.reply(`❓ ${question}`, { reply_markup: keyboard });
        buttonsSent = true;

        data.status = "sent";
        await Bun.write(filepath, JSON.stringify(data));
      }
    } catch (error) {
      console.warn(`Failed to process ask-user file ${filepath}:`, error);
    }
  }

  return buttonsSent;
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".webm", ".mkv"]);
const PHOTO_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".flac", ".m4a"]);

export async function checkPendingSendFileRequests(
  ctx: Context,
  chatId: number,
  dir: string = IPC_DIR,
): Promise<boolean> {
  const glob = new Bun.Glob("send-file-*.json");
  let fileSent = false;

  for await (const filename of glob.scan({ cwd: dir, absolute: false })) {
    const filepath = `${dir}/${filename}`;
    const ageMs = fileAgeMs(filepath);
    // Before the parse — see reapIfOlderThan: a file too broken to read is exactly the
    // one that would otherwise be re-read forever.
    if (reapIfOlderThan(filepath, ageMs, TEMP_RETENTION_MS)) continue;
    try {
      const file = Bun.file(filepath);
      const text = await file.text();
      const data = JSON.parse(text);

      const isPending = data.status === "pending";
      // Ahead of the chat filter, which skips without deleting — otherwise another
      // session's orphan is passed over on every poll and never reaped.
      if (isPending && reapIfOlderThan(filepath, ageMs, IPC_PENDING_TTL_MS)) continue;
      if (!isPending) continue;
      if (String(data.chat_id) !== String(chatId)) continue;

      const filePath: string = data.file_path || "";
      // Clipped, not dropped: Telegram rejects the whole send when the caption is over
      // the limit, so the file goes with it. Nothing upstream bounds this — the MCP
      // schema takes any string and the model is told no limit.
      //
      // Counted in CODE POINTS, which is the unit the limit is enforced in:
      // tdlib's `utf8_length` in `MessageContent.cpp` counts UTF-8 lead bytes, and
      // tdlib keeps a separate `utf8_utf16_length` for entity offsets. Using JS
      // `.length` would score an astral character 2 and clip a caption Telegram accepts,
      // and slicing by it can cut a surrogate pair into a replacement character.
      //
      // `typeof`, not a truthiness test: this JSON is parsed from a world-writable
      // directory, and `.slice` on a non-string throws out to the outer catch, which
      // leaves the request file in place to fail again on every poll until the pending
      // window reaps it.
      const rawCaption = typeof data.caption === "string" ? data.caption : "";
      const points = Array.from(rawCaption);
      const caption =
        points.length > TELEGRAM_CAPTION_LIMIT
          ? points.slice(0, TELEGRAM_CAPTION_LIMIT - 3).join("") + "..."
          : rawCaption || undefined;

      if (!filePath) {
        try {
          unlinkSync(filepath);
        } catch {
          /* ignore */
        }
        continue;
      }

      if (!isPathAllowed(filePath)) {
        console.warn(`send-file BLOCKED (outside allowed paths): ${filePath}`);
        try {
          unlinkSync(filepath);
        } catch {
          /* ignore */
        }
        continue;
      }

      try {
        const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
        const inputFile = new InputFile(filePath);

        const action = VIDEO_EXTENSIONS.has(ext)
          ? "upload_video"
          : PHOTO_EXTENSIONS.has(ext)
            ? "upload_photo"
            : AUDIO_EXTENSIONS.has(ext)
              ? "upload_voice"
              : "upload_document";
        await ctx.replyWithChatAction(action);

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
        // With the reason, because this message is the only place it can appear: the
        // tool is fire-and-forget, so the model was told "queued" and never learns the
        // send failed.
        //
        // The basename is bounded on the same argument as the reason: it comes out of a
        // file in a world-writable directory, `isPathAllowed` does not require the path
        // to exist, and a reply over the message limit is refused whole — which would
        // cost the report this line exists to make. 255 because that is the usual
        // NAME_MAX, in bytes, and a name never has more UTF-16 units than UTF-8 bytes —
        // so on a filesystem with that limit only a crafted value is ever cut.
        const name = clip(filePath.split("/").pop() || "unknown", 255);
        await ctx.reply(`Failed to send file: ${name} (${sendFailureReason(sendError)})`);
      } finally {
        // In the finally, not after it: `ctx.reply` above can itself reject, and the
        // request would then be left for the next poll to try again. Delivered, failed,
        // or failed with the failure unreportable, one pass is all a request gets. The
        // unlink itself can still fail, and a request whose file cannot be removed does
        // come round again.
        try {
          unlinkSync(filepath);
        } catch {
          /* ignore */
        }
      }
    } catch (error) {
      console.warn(`Failed to process send-file request ${filepath}:`, error);
    }
  }

  return fileSent;
}

export class StreamingState {
  textMessages = new Map<number, Message>(); // segment_id -> telegram message
  toolMessages: Message[] = []; // ephemeral tool status messages
  lastEditTimes = new Map<number, number>(); // segment_id -> last edit time
  lastContent = new Map<number, string>(); // segment_id -> last sent content

  /**
   * Clear the ephemeral tool chatter. Every message is attempted: Telegram rejects a
   * delete for a message already gone or older than 48 h, and one such rejection must
   * not strand the rest on screen.
   */
  async deleteToolMessages(ctx: Context): Promise<void> {
    for (const toolMsg of this.toolMessages) {
      try {
        await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
      } catch (error) {
        console.debug("Failed to delete tool message:", error);
      }
    }
  }
}

function formatWithinLimit(content: string, safeLimit: number = TELEGRAM_SAFE_LIMIT): string {
  let display = content.length > safeLimit ? content.slice(0, safeLimit) + "..." : content;
  let formatted = convertMarkdownToHtml(display);

  // HTML tags can inflate content beyond the limit - shrink until it fits
  if (formatted.length > TELEGRAM_MESSAGE_LIMIT) {
    const ratio = TELEGRAM_MESSAGE_LIMIT / formatted.length;
    display = content.slice(0, Math.floor(safeLimit * ratio * 0.95)) + "...";
    formatted = convertMarkdownToHtml(display);
  }

  return formatted;
}

const FENCE_CLOSER = "\n```";

const FENCE_LINE = /^\s*```/;

/**
 * Splits before conversion, so each chunk converts to valid HTML on its own. Slicing
 * converted HTML instead cuts tags in half, Telegram rejects the chunk, and the
 * plain-text fallback then shows the user a literal `<b>`.
 *
 * A fence spanning a boundary is closed and reopened. Every chunk is <= limit with that
 * closer counted. Exported for test.
 */
export function splitMarkdownForTelegram(
  markdown: string,
  maxLength: number = TELEGRAM_SAFE_LIMIT,
): string[] {
  // Slice offsets below step by whole characters, so a fractional cap would be overshot.
  const limit = Math.max(1, Math.floor(maxLength));
  const out: string[] = [];
  let cur = "";
  // Not `cur !== ""` — a run of blank lines is content that leaves `cur` empty.
  let started = false;
  // The bounded marker to REOPEN with, not necessarily the line that opened the fence.
  // Without it the closer desyncs and reads as a third delimiter.
  let openFence: string | null = null;

  // curAppended: any input line went into cur after the last reseed, blank ones included.
  // curContent: cur holds a line that renders something. A fence line renders nothing on
  // its own, so it never sets this; it still counts as input and is passed through.
  let curAppended = false;
  let curContent = false;
  // A fence line the INPUT sent, as opposed to the reopen we synthesize. Keeps a lone
  // "```" from being swallowed while still dropping a pure-scaffold chunk.
  let curInputFence = false;

  // Unreachable if the accounting below is right; a cut here means it missed a case.
  const emit = (chunk: string) => {
    if (chunk.length <= limit) {
      out.push(chunk);
      return;
    }
    for (let i = 0; i < chunk.length; i += limit) out.push(chunk.slice(i, i + limit));
  };

  // Returns whether anything was sent, so the caller can carry a held-back chunk forward.
  const flush = (): boolean => {
    if (!curAppended) return false;
    // Telegram rejects a message with no text, so whitespace alone is not sendable. This
    // only discards the indentation of a delimiter line — a space run cut out of indented
    // code travels with the fence markers around it, which keeps trim() non-empty.
    if (cur.trim() === "") return false;
    // Nothing to render and no marker the user wrote: a reopened fence over blank lines.
    // Held back rather than sent, and carried into the next chunk by the caller.
    if (!curContent && !curInputFence) return false;
    // Only close a block that has payload, and only when the closer fits — slicing a
    // chunk through its own delimiter is worse than leaving the block open.
    const closable = curContent && openFence && cur.length + FENCE_CLOSER.length <= limit;
    emit(closable ? cur + FENCE_CLOSER : cur);
    return true;
  };

  for (const rawLine of markdown.split("\n")) {
    // An over-long line has no boundary to break on — cut it, leaving room for whatever
    // will wrap it: the reopened fence above and the closer below. A line that OPENS a
    // fence needs the closer reserved too, or the closer pushes its chunk over. A line
    // that CLOSES one needs nothing: budgeting it as if it were wrapped split the closer
    // itself, turning a balanced "```\n```" into two unbalanced halves.
    const rawIsFence = FENCE_LINE.test(rawLine);
    const overhead = rawIsFence
      ? openFence
        ? 0
        : FENCE_CLOSER.length
      : openFence
        ? openFence.length + 1 + FENCE_CLOSER.length
        : 0;
    const maxPiece = Math.max(1, limit - overhead);
    const pieces =
      rawLine.length > maxPiece
        ? (rawLine.match(new RegExp(`[\\s\\S]{1,${maxPiece}}`, "g")) ?? [rawLine])
        : [rawLine];

    // Per raw line, inherited by its pieces: judging a piece alone drops the leading run
    // of an indented code line, which is all spaces. A fence line renders nothing of its
    // own — unless it is too long to be a marker at all, in which case its info string is
    // the payload. Same threshold as the reopen decision below, so the two agree.
    const markerSized = rawLine.length + 1 + FENCE_CLOSER.length <= limit / 2;
    const rawPayload = rawLine.trim() !== "" && !(rawIsFence && markerSized);

    for (const line of pieces) {
      const isFence = FENCE_LINE.test(line);
      // The state this line LEAVES, not the one it found: a line that opens a fence
      // commits its own chunk to a closer, so budget it before the line goes in.
      let fenceAfter: string | null;
      if (!isFence) {
        fenceAfter = openFence;
      } else if (openFence) {
        fenceAfter = null; // closes it, so no wrapper is needed
      } else {
        // Track every fence, or its closer reads as a fresh opener. Reopen with the line
        // itself when repeating it is cheap; otherwise fall back to a plain "```", since
        // repeating a long one per chunk blew a 235-char input up to 66 messages.
        const wrapper = line.length + 1 + FENCE_CLOSER.length;
        fenceAfter = wrapper <= limit / 2 ? line : "```";
      }
      const budget = limit - (fenceAfter ? FENCE_CLOSER.length : 0);

      if (started && cur.length + 1 + line.length > budget) {
        const sent = flush();
        const reopen = openFence ?? "";
        // Blank lines from a chunk we did not send are still input, and a message break
        // does not stand in for them: inside a YAML literal or a diff the blank IS data.
        // Carry them into the next chunk, but only while they leave room for the line.
        let carry = sent ? "" : cur.slice(reopen.length);
        if (reopen.length + carry.length + 1 + line.length > budget) carry = "";
        cur = reopen + carry;
        started = cur !== "";
        curAppended = false;
        curContent = false;
        curInputFence = false;
      }
      cur = started ? cur + "\n" + line : line;
      started = true;
      curAppended = true;
      curContent = curContent || rawPayload;
      curInputFence = curInputFence || isFence;
      openFence = fenceAfter;
    }
  }

  if (started) flush();
  return out;
}

async function sendChunkedMessages(ctx: Context, markdown: string): Promise<void> {
  for (const chunk of splitMarkdownForTelegram(markdown)) {
    try {
      await ctx.reply(convertMarkdownToHtml(chunk), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (htmlError) {
      console.debug("Chunk HTML send failed, falling back to plain:", htmlError);
      // Retry with the source markdown, not the converted HTML. The failure can be
      // transport (429, timeout) or the markup; re-sending HTML as plain text would show
      // raw tags whenever it was the markup.
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
async function sendRichWithFallback(ctx: Context, content: string): Promise<Message | null> {
  const chatId = ctx.chatId;
  if (chatId === undefined) return null;

  // Rich path: pass Claude's GFM straight through (headings/tables/lists/code).
  if (content.length <= TELEGRAM_RICH_LIMIT) {
    try {
      return await ctx.api.sendRichMessage(chatId, {
        markdown: content,
        skip_entity_detection: true,
      });
    } catch (richError) {
      console.debug("Rich send failed, falling back to HTML:", richError);
    }
  }
  // Fallback: HTML conversion (truncates), then plain text.
  const formatted = formatWithinLimit(content);
  try {
    return await ctx.reply(formatted, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
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
async function editRichWithFallback(ctx: Context, msg: Message, content: string): Promise<void> {
  if (content.length > TELEGRAM_RICH_LIMIT) {
    throw new Error("CONTENT_TOO_LONG");
  }
  try {
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, {
      markdown: content,
      skip_entity_detection: true,
    });
    return;
  } catch (richError) {
    console.debug("Rich edit failed, falling back to HTML:", richError);
  }
  const formatted = formatWithinLimit(content);
  try {
    await ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
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

export function createStatusCallback(ctx: Context, state: StreamingState): StatusCallback {
  return async (statusType: string, content: string, segmentId?: number) => {
    try {
      if (statusType === "thinking") {
        const preview = content.length > 500 ? content.slice(0, 500) + "..." : content;
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
          // lastContent caches the RAW markdown, not what was sent — the edit
          // path below re-converts, so caching HTML would never compare equal.
          const msg = await sendRichWithFallback(ctx, content);
          if (msg) {
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, content);
          }
          state.lastEditTimes.set(segmentId, now);
        } else if (now - lastEdit > STREAMING_THROTTLE_MS) {
          const msg = state.textMessages.get(segmentId)!;
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

        // A reply under 20 characters emits no "text" event at all — session.ts gates that
        // event on the throttle AND that minimum — so no message exists yet. Create one
        // directly (#12 fix).
        if (!state.textMessages.has(segmentId)) {
          if (content.length > TELEGRAM_RICH_LIMIT) {
            await sendChunkedMessages(ctx, content);
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
        if (content === state.lastContent.get(segmentId)) {
          return;
        }

        try {
          await editRichWithFallback(ctx, msg, content);
          state.lastContent.set(segmentId, content);
        } catch {
          try {
            await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
          } catch (delError) {
            console.debug("Failed to delete for chunking:", delError);
          }
          await sendChunkedMessages(ctx, content);
        }
      } else if (statusType === "done") {
        // Only the ephemeral tool/thinking chatter is cleaned up; text segments stay.
        await state.deleteToolMessages(ctx);
      }
    } catch (error) {
      console.error("Status callback error:", error);
    }
  };
}
