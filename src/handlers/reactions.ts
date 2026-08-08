/** Best-effort: a reaction failure must never break message handling. */

import type { BotContext } from "../types";

// Emoji MUST be from Telegram's fixed reaction set — ✅/❌ are invalid.
async function react(ctx: BotContext, emoji: "👀" | "👌" | "👎"): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.msg?.message_id;
  // startTriggerServer gives its synthetic update a non-positive message_id. No Telegram
  // message matches, so setMessageReaction answers 400 and the catch below logs it on
  // every triggered run. `<= 0` not `< 0`: the id can round to -0, which serialises as 0.
  if (chatId === undefined || messageId === undefined || messageId <= 0) return;
  try {
    await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
  } catch (err) {
    console.debug("setMessageReaction failed:", err);
  }
}

export const markReceived = (ctx: BotContext) => react(ctx, "👀");
export const markDone = (ctx: BotContext) => react(ctx, "👌");
export const markFailed = (ctx: BotContext) => react(ctx, "👎");
