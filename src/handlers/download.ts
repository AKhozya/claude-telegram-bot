/**
 * Shared file download helper. Routes through the files plugin's .download(),
 * which honours TELEGRAM_API_ROOT — a hand-built api.telegram.org URL would not.
 */

import type { BotContext } from "../types";

export async function downloadTelegramFile(
  ctx: BotContext,
  destPath: string
): Promise<string> {
  const file = await ctx.getFile();
  return await file.download(destPath);
}
