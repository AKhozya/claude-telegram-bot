/**
 * Shared error handler for per-update processing failures.
 *
 * Not in streaming.ts, its callers' other shared module: session.ts imports the
 * IPC pollers from there, and this handler needs session, which would close an
 * import cycle.
 */

import type { BotContext } from "../types";
import type { StreamingState } from "./streaming";
import { session } from "../session";
import { markFailed } from "./reactions";
import { describeError } from "../formatting";

export async function handleProcessingError(
  ctx: BotContext,
  error: unknown,
  state: StreamingState
): Promise<void> {
  console.error("Error processing update:", error);
  await markFailed(ctx);

  await state.deleteToolMessages(ctx);

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
