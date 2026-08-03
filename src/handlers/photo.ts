/**
 * Photo message handler for Claude Telegram Bot.
 *
 * Supports single photos and media groups (albums) with 1s buffering.
 */

import type { BotContext } from "../types";
import { uniqueTempDir } from "../utils";
import { createMediaGroupBuffer } from "./media-group";
import { downloadTelegramFile } from "./download";
import { markReceived, markFailed } from "./reactions";
import { rateLimitOrReply } from "./rate-limit";
import { runPrompt } from "./run-prompt";

const photoBuffer = createMediaGroupBuffer({
  emoji: "📷",
  itemLabel: "photo",
  itemLabelPlural: "photos",
});

async function downloadPhoto(ctx: BotContext): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) {
    throw new Error("No photo in message");
  }

  const photoPath = `${uniqueTempDir("photo")}.jpg`;

  return await downloadTelegramFile(ctx, photoPath);
}

/**
 * Process photos with Claude. Exported so the PDF handler can route rendered
 * page images (image/scanned PDFs) through the same vision flow.
 */
export async function processPhotos(
  ctx: BotContext,
  photoPaths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
): Promise<void> {
  let prompt: string;
  if (photoPaths.length === 1) {
    prompt = caption
      ? `[Photo: ${photoPaths[0]}]\n\n${caption}`
      : `Please analyze this image: ${photoPaths[0]}`;
  } else {
    const pathsList = photoPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
    prompt = caption
      ? `[Photos:\n${pathsList}]\n\n${caption}`
      : `Please analyze these ${photoPaths.length} images:\n${pathsList}`;
  }

  // The prompt is the audit input here: it is a caption plus file paths, which is exactly
  // the record of what was analysed. Documents cannot do this — see runPrompt.
  await runPrompt(ctx, userId, username, chatId, {
    prompt,
    titleSeed: caption || "[Foto]",
    auditAction: "PHOTO",
    auditInput: prompt,
  });
}

export async function handlePhoto(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const mediaGroupId = ctx.message?.media_group_id;

  if (!userId || !chatId) {
    return;
  }

  await markReceived(ctx);

  // Albums are rate-limited once in media-group.ts, not per photo — charging
  // each frame of a 10-photo album would reject the album mid-upload.
  let statusMsg: Awaited<ReturnType<typeof ctx.reply>> | null = null;
  if (!mediaGroupId) {
    console.log(`Received photo from @${username}`);
    if (await rateLimitOrReply(ctx, userId, username)) return;

    statusMsg = await ctx.reply("📷 Processing image...");
  }

  let photoPath: string;
  try {
    photoPath = await downloadPhoto(ctx);
  } catch (error) {
    console.error("Failed to download photo:", error);
    await markFailed(ctx);
    if (statusMsg) {
      try {
        await ctx.api.editMessageText(
          statusMsg.chat.id,
          statusMsg.message_id,
          "❌ Failed to download photo."
        );
      } catch (editError) {
        console.debug("Failed to edit status message:", editError);
        await ctx.reply("❌ Failed to download photo.");
      }
    } else {
      await ctx.reply("❌ Failed to download photo.");
    }
    return;
  }

  if (!mediaGroupId && statusMsg) {
    await processPhotos(
      ctx,
      [photoPath],
      ctx.message?.caption,
      userId,
      username,
      chatId
    );

    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch (error) {
      console.debug("Failed to delete status message:", error);
    }
    return;
  }

  if (!mediaGroupId) return; // narrows the type; unreachable given the branch above

  await photoBuffer.addToGroup(
    mediaGroupId,
    photoPath,
    ctx,
    userId,
    username,
    processPhotos
  );
}
