/**
 * One choke point for the user allowlist. It drops an unauthorized update silently — a
 * private bot must not advertise itself to strangers. Register this before the message
 * handlers, so no path can forget the check.
 */

import type { NextFunction } from "grammy";
import type { BotContext } from "../types";
import { ALLOWED_USERS } from "../config";
import { isAuthorized } from "../security";

export async function authGate(ctx: BotContext, next: NextFunction): Promise<void> {
  if (!isAuthorized(ctx.from?.id, ALLOWED_USERS)) {
    // Ack callback queries so Telegram clears the button's loading spinner without
    // revealing anything; everything else is dropped with no reply.
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    return;
  }
  await next();
}
