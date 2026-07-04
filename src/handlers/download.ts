/**
 * Shared file download helper for Claude Telegram Bot handlers.
 *
 * Replaces the hand-built api.telegram.org URL + fetch + Bun.write pattern
 * with the files plugin's typed .download().
 */

import type { BotContext } from "../types";

/**
 * Download the current message's file to destPath via the files plugin.
 */
export async function downloadTelegramFile(
  ctx: BotContext,
  destPath: string
): Promise<string> {
  const file = await ctx.getFile();
  return await file.download(destPath);
}
