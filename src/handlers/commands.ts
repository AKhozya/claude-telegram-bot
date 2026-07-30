/**
 * Command handlers for Claude Telegram Bot.
 *
 * One exported handler per slash command; registration lives in index.ts.
 */

import type { Context } from "grammy";
import type { BotContext } from "../types";
import { session } from "../session";
import { WORKING_DIR, RESTART_FILE } from "../config";

/** /start - Show welcome message and status. */
export async function handleStart(ctx: Context): Promise<void> {
  const status = session.isActive ? "Active session" : "No active session";
  const workDir = WORKING_DIR;

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Working directory: <code>${workDir}</code>\n\n` +
      `<b>Commands:</b>\n` +
      `/new - Start fresh session\n` +
      `/stop - Stop current query\n` +
      `/status - Show detailed status\n` +
      `/resume - Resume last session\n` +
      `/retry - Retry last message\n` +
      `/restart - Restart the bot\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Use "think" keyword for extended reasoning\n` +
      `• Send photos or documents`,
    { parse_mode: "HTML" }
  );
}

/**
 * Stop, wait for the abort to propagate, then clear stopRequested so the next message is
 * not cancelled at query start. `session.ts` records that this pairing has already been
 * dropped once by a hand-copy.
 *
 * Not folded into `ClaudeSession.stop()`: the settle is for whatever the caller does
 * next, not for the stop itself, and `interruptForNewMessage` owns the variant that also
 * marks the stop as an interrupt.
 */
async function stopAndSettle(): Promise<void> {
  if (!session.isRunning) return;
  const result = await session.stop();
  if (result) {
    await Bun.sleep(100);
    session.clearStopRequested();
  }
}

/** /new - Start a fresh session. */
export async function handleNew(ctx: Context): Promise<void> {
  await stopAndSettle();
  await session.kill();

  await ctx.reply("🆕 Session cleared. Next message starts fresh.");
}

/** /stop - Stop the current query. Silent either way, running or not. */
export async function handleStop(_ctx: Context): Promise<void> {
  await stopAndSettle();
}

/** /status - Show detailed status. */
export async function handleStatus(ctx: Context): Promise<void> {
  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  // Session status
  if (session.isActive) {
    lines.push(`✅ Session: Active (${session.sessionId?.slice(0, 8)}...)`);
  } else {
    lines.push("⚪ Session: None");
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Query: Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ ${session.currentTool}`);
    }
  } else {
    lines.push("⚪ Query: Idle");
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000
    );
    lines.push(`\n⏱️ Last activity: ${ago}s ago`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 Last query usage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
  }

  // Error status
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${session.lastError}`);
  }

  // Working directory
  lines.push(`\n📁 Working dir: <code>${WORKING_DIR}</code>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/** /resume - Show list of sessions to resume with inline keyboard. */
export async function handleResume(ctx: Context): Promise<void> {
  if (session.isActive) {
    await ctx.reply("Session already active. Use /new to start over.");
    return;
  }

  const sessions = session.getSessionList();

  if (sessions.length === 0) {
    await ctx.reply("❌ No saved session.");
    return;
  }

  const buttons = sessions.map((s) => {
    const date = new Date(s.saved_at);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "2-digit",
    });
    const timeStr = date.toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Telegram clips button labels, so trim here to keep the date prefix visible.
    const titlePreview =
      s.title.length > 35 ? s.title.slice(0, 32) + "..." : s.title;

    return [
      {
        text: `📅 ${dateStr} ${timeStr} - "${titlePreview}"`,
        callback_data: `resume:${s.session_id}`,
      },
    ];
  });

  await ctx.reply("📋 <b>Saved sessions</b>\n\nSelect a session to resume:", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/** /restart - Restart the bot process. */
export async function handleRestart(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Not "time for the message to send" — the reply and the write above are both awaited.
  // What is outstanding is the runner: this path skips the runner.stop() that the SIGINT
  // and SIGTERM handlers call, so polling is live at process.exit. Whether 500 ms is what
  // stops a redelivered /restart from looping is untested — do not drop it blind.
  await Bun.sleep(500);

  // The supervisor restarts us (launchd on macOS, Kubernetes in the cluster).
  process.exit(0);
}

/** /retry - Retry the last message (resume session and re-send). */
export async function handleRetry(ctx: Context): Promise<void> {
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  const { handleText } = await import("./text");
  await handleText(withMessageText(ctx as BotContext, message));
}

/**
 * Clone a grammy context with its message text swapped. `chat`/`from`/`msg`/
 * `message`/`reply` are prototype getters/methods reading `update.message.*`,
 * so a plain `{...ctx}` spread drops them and handleText silently no-op'd on the
 * `!chatId` guard (broken since 7498057). Object.create keeps the prototype
 * live; Object.assign copies own props (api/me/update); the last source swaps
 * the text. Exported for the retry regression test.
 */
export function withMessageText(ctx: BotContext, text: string): BotContext {
  return Object.assign(
    Object.create(Object.getPrototypeOf(ctx)),
    ctx,
    { update: { ...ctx.update, message: { ...ctx.message, text } } }
  ) as BotContext;
}
