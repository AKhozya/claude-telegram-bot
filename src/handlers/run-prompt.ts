import type { BotContext } from "../types";
import { session } from "../session";
import { auditLog, startTypingIndicator } from "../utils";
import { StreamingState, createStatusCallback } from "./streaming";
import { handleProcessingError } from "./errors";
import { markDone } from "./reactions";

export interface RunPromptOptions {
  prompt: string;
  /** Names the conversation, if this is its first message. */
  titleSeed: string;
  auditAction: string;
  /**
   * Written to the audit log. Independent of `prompt` and never derived from it:
   * `document.ts` sends whole file bodies and audits only a summary, and the log is
   * written unredacted under `AUDIT_LOG_JSON`.
   */
  auditInput: string;
}

/**
 * Run one prompt end to end: lifecycle flag, title, typing indicator, streaming, audit,
 * reaction, cleanup.
 *
 * `video.ts` and `callback.ts` stay out. Video edits and deletes a status message around
 * the query and logs its own catch; the callback path posts no 👌 on success, so routing
 * it here would add a 👎 on failure and nothing on success.
 */
export async function runPrompt(
  ctx: BotContext,
  userId: number,
  username: string,
  chatId: number,
  { prompt, titleSeed, auditAction, auditInput }: RunPromptOptions,
): Promise<void> {
  const stopProcessing = session.startProcessing();
  session.setTitleIfNew(titleSeed);

  const typing = startTypingIndicator(ctx);

  const state = new StreamingState();
  const statusCallback = createStatusCallback(ctx, state);

  try {
    const response = await session.sendMessageStreaming(
      prompt,
      username,
      userId,
      statusCallback,
      chatId,
      ctx,
    );

    await auditLog(userId, username, auditAction, auditInput, response);
    await markDone(ctx);
  } catch (error) {
    await handleProcessingError(ctx, error, state);
  } finally {
    stopProcessing();
    typing.stop();
  }
}
