/**
 * Shared per-message rate-limit guard for Claude Telegram Bot.
 */

import type { BotContext } from "../types";
import { rateLimiter } from "../security";
import { auditLogRateLimit } from "../utils";
import { markFailed } from "./reactions";

/**
 * Charges the caller one token. When the bucket is empty it audits, replies and reacts,
 * and returns true — every call site answers that with a bare `return`.
 *
 * Not middleware: albums are charged once per album in `media-group.ts`, and each caller
 * sits behind its own guard (archive vs single document vs album). Hoisting the call out
 * of those guards charges every album item individually.
 */
export async function rateLimitOrReply(
  ctx: BotContext,
  userId: number,
  username: string,
): Promise<boolean> {
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (allowed) return false;

  await auditLogRateLimit(userId, username, retryAfter!);
  await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
  await markFailed(ctx);
  return true;
}
