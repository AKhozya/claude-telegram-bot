/**
 * Shared media group handling for Claude Telegram Bot.
 *
 * Provides a generic buffer for handling Telegram media groups (albums)
 * with configurable processing callbacks.
 */

import type { Message } from "grammy/types";
import type { BotContext } from "../types";
import { MEDIA_GROUP_TIMEOUT } from "../config";
import { rateLimiter } from "../security";
import { auditLogRateLimit } from "../utils";
import { session } from "../session";
import { markFailed } from "./reactions";
import { describeError } from "../formatting";

interface PendingMediaGroup {
  items: string[];
  ctx: BotContext;
  caption?: string;
  statusMsg?: Message;
  timeout: Timer;
}

export interface MediaGroupConfig {
  /** Emoji for status messages (e.g., "📷" or "📄") */
  emoji: string;
  /** Label for items (e.g., "photo" or "document") */
  itemLabel: string;
  /** Plural label for items (e.g., "photos" or "documents") */
  itemLabelPlural: string;
}

export type ProcessGroupCallback = (
  ctx: BotContext,
  items: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number
) => Promise<void>;

// Each call owns its own pendingGroups map, so photo and document albums
// arriving at the same time cannot collide on a shared media_group_id.
export function createMediaGroupBuffer(config: MediaGroupConfig) {
  const pendingGroups = new Map<string, PendingMediaGroup>();

  async function processGroup(
    groupId: string,
    processCallback: ProcessGroupCallback
  ): Promise<void> {
    const group = pendingGroups.get(groupId);
    if (!group) return;

    pendingGroups.delete(groupId);

    const userId = group.ctx.from?.id;
    const username = group.ctx.from?.username || "unknown";
    const chatId = group.ctx.chat?.id;

    if (!userId || !chatId) return;

    console.log(
      `Processing ${group.items.length} ${config.itemLabelPlural} from @${username}`
    );

    if (group.statusMsg) {
      try {
        await group.ctx.api.editMessageText(
          group.statusMsg.chat.id,
          group.statusMsg.message_id,
          `${config.emoji} Processing ${group.items.length} ${config.itemLabelPlural}...`
        );
      } catch (error) {
        console.debug("Failed to update status message:", error);
      }
    }

    await processCallback(
      group.ctx,
      group.items,
      group.caption,
      userId,
      username,
      chatId
    );

    if (group.statusMsg) {
      try {
        await group.ctx.api.deleteMessage(
          group.statusMsg.chat.id,
          group.statusMsg.message_id
        );
      } catch (error) {
        console.debug("Failed to delete status message:", error);
      }
    }
  }

  async function addToGroup(
    mediaGroupId: string,
    itemPath: string,
    ctx: BotContext,
    userId: number,
    username: string,
    processCallback: ProcessGroupCallback
  ): Promise<void> {
    if (!pendingGroups.has(mediaGroupId)) {
      // Rate limit on first item only
      const [allowed, retryAfter] = rateLimiter.check(userId);
      if (!allowed) {
        await auditLogRateLimit(userId, username, retryAfter!);
        await ctx.reply(
          `⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`
        );
        await markFailed(ctx);
        return;
      }

      console.log(`Receiving ${config.itemLabel} album from @${username}`);
      const statusMsg = await ctx.reply(
        `${config.emoji} Receiving ${config.itemLabelPlural}...`
      );

      pendingGroups.set(mediaGroupId, {
        items: [itemPath],
        ctx,
        caption: ctx.message?.caption,
        statusMsg,
        timeout: setTimeout(
          () => processGroup(mediaGroupId, processCallback),
          MEDIA_GROUP_TIMEOUT
        ),
      });
    } else {
      const group = pendingGroups.get(mediaGroupId)!;
      group.items.push(itemPath);

      // First caption wins. Telegram puts the album's caption on one member, not
      // necessarily the one that opened the group above.
      if (ctx.message?.caption && !group.caption) {
        group.caption = ctx.message.caption;
      }

      // Debounce: the album is only complete once MEDIA_GROUP_TIMEOUT passes with
      // no further parts, since Telegram delivers them as separate updates.
      clearTimeout(group.timeout);
      group.timeout = setTimeout(
        () => processGroup(mediaGroupId, processCallback),
        MEDIA_GROUP_TIMEOUT
      );
    }
  }

  return { addToGroup };
}

export async function handleProcessingError(
  ctx: BotContext,
  error: unknown,
  toolMessages: Message[]
): Promise<void> {
  console.error("Error processing media:", error);
  await markFailed(ctx);

  for (const toolMsg of toolMessages) {
    try {
      await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
    } catch (cleanupError) {
      console.debug("Failed to delete tool message:", cleanupError);
    }
  }

  const errorStr = String(error);
  if (errorStr.includes("abort") || errorStr.includes("cancel")) {
    // Only show "Query stopped" if it was an explicit stop, not an interrupt from a new message
    const wasInterrupt = session.consumeInterruptFlag();
    if (!wasInterrupt) {
      await ctx.reply("🛑 Query stopped.");
    }
  } else {
    await ctx.reply(`❌ Error: ${describeError(error)}`);
  }
}
