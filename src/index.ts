/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot, Api, Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles, type FileFlavor, type FileApiFlavor } from "@grammyjs/files";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "./config";
import { unlinkSync, readFileSync, existsSync } from "fs";
import { startTempReaper } from "./utils";
import {
  authGate,
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleResume,
  handleRestart,
  handleRetry,
  handleText,
  handlePhoto,
  handleDocument,
  handleUnsupportedMedia,
  handleVideo,
  handleCallback,
  startTriggerServer,
} from "./handlers";

// Create bot instance. TELEGRAM_API_ROOT (unset by default) points every
// api/ctx.api call at a self-hosted Bot API server — needed for >20MB files.
const bot = new Bot<FileFlavor<Context>, FileApiFlavor<Api>>(TELEGRAM_TOKEN, {
  client: { apiRoot: process.env.TELEGRAM_API_ROOT },
});

// API transformers — cover EVERY api/ctx.api call (incl. streaming edits & raw).
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
bot.api.config.use(hydrateFiles(bot.token, { apiRoot: process.env.TELEGRAM_API_ROOT }));

// Authorization: single choke point for the user allowlist. Runs before sequentialize so
// unauthorized updates are dropped before entering any per-chat queue.
bot.use(authGate);

// Serializes messages within one chat. Note this does NOT protect the process-wide
// ClaudeSession: separate chats get separate queues. The allowlist bounds who, not how
// many chats, so one allowed user posting from a private chat and a group still overlaps.
// Anything returning undefined skips the queue and runs immediately.
bot.use(
  sequentialize((ctx) => {
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // ! is an interrupt: queued behind the query it cancels, it would only run
    // once that query finished on its own, which defeats the point.
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    if (ctx.callbackQuery) {
      return undefined;
    }
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

bot.command("start", handleStart);
bot.command("new", handleNew);
bot.command("stop", handleStop);
bot.command("status", handleStatus);
bot.command("resume", handleResume);
bot.command("restart", handleRestart);
bot.command("retry", handleRetry);

// ============== Message Handlers ==============

bot.on("message:text", handleText);

// No speech-to-text in this build; these reply with an "unsupported" notice
// rather than falling through to the text handler with an empty body.
bot.on("message:voice", handleUnsupportedMedia);
bot.on("message:audio", handleUnsupportedMedia);

bot.on("message:photo", handlePhoto);

bot.on("message:document", handleDocument);

bot.on("message:video", handleVideo);
bot.on("message:video_note", handleVideo);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Register the command menu shown in Telegram's "/" picker
await bot.api.setMyCommands([
  { command: "new", description: "Start a new Claude session" },
  { command: "stop", description: "Stop the current query" },
  { command: "status", description: "Show session status" },
  { command: "resume", description: "Resume a saved session" },
  { command: "retry", description: "Retry the last message" },
  { command: "restart", description: "Restart the bot process" },
]);

if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Staleness bound only. The ids still point at the right message, but a file
    // this old means some earlier restart never cleaned up, so the "✅ Bot restarted"
    // edit would land long after the user stopped waiting for it.
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(
        data.chat_id,
        data.message_id,
        "✅ Bot restarted"
      );
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try { unlinkSync(RESTART_FILE); } catch {}
  }
}

const runner = run(bot);

// Optional HTTP trigger (no-op when TRIGGER_SECRET unset)
const triggerServer = startTriggerServer(bot);

const tempReaper = startTempReaper();

// Graceful shutdown
const stopRunner = () => {
  if (runner.isRunning()) {
    console.log("Stopping bot...");
    runner.stop();
  }
  triggerServer?.stop();
  tempReaper.stop();
};

process.on("SIGINT", () => {
  console.log("Received SIGINT");
  stopRunner();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM");
  stopRunner();
  process.exit(0);
});
