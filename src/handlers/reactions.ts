/**
 * Glanceable message reactions for Claude Telegram Bot.
 *
 * Best-effort: a reaction failure must never break message handling.
 */

import type { BotContext } from "../types";

// Emoji MUST be from Telegram's fixed reaction set — ✅/❌ are invalid.
async function react(ctx: BotContext, emoji: "👀" | "👌" | "👎"): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.msg?.message_id;
  if (chatId === undefined || messageId === undefined) return;
  try {
    await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
  } catch (err) {
    console.debug("setMessageReaction failed:", err); // best-effort, never throw
  }
}

export const markReceived = (ctx: BotContext) => react(ctx, "👀");
export const markDone = (ctx: BotContext) => react(ctx, "👌");
export const markFailed = (ctx: BotContext) => react(ctx, "👎");
