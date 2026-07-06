/**
 * Unsupported-media handler.
 *
 * Voice/audio transcription was removed along with the OpenAI dependency. Reply once so
 * the bot isn't silent on voice/audio messages; auth-gated like the other handlers.
 */

import type { BotContext } from "../types";

export async function handleUnsupportedMedia(ctx: BotContext): Promise<void> {
  await ctx.reply("🎤 Voice and audio aren't supported — please send text.");
}
