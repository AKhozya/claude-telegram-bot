/**
 * Unsupported-media handler.
 *
 * No speech-to-text in this build. Replies once so voice/audio isn't met with
 * silence; auth-gated like the other handlers.
 */

import type { BotContext } from "../types";

export async function handleUnsupportedMedia(ctx: BotContext): Promise<void> {
  await ctx.reply("🎤 Voice and audio aren't supported — please send text.");
}
