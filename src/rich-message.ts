/**
 * Bot API 10.1 Rich Messages.
 *
 * Telegram renders GitHub-Flavored Markdown (headings, tables, lists, code
 * fences, blockquotes, collapsibles) sent via sendRichMessage / editMessageText
 * with a rich_message payload. grammy 1.43 has no typed bindings for these yet,
 * so we call the HTTP Bot API directly. Swap to typed grammy once it ships 10.1.
 */
import type { Message } from "grammy/types";
import { TELEGRAM_TOKEN } from "./config";

const API_ROOT = process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";

// Rich messages allow up to 32768 UTF-8 chars (plain messages cap at 4096).
export const TELEGRAM_RICH_LIMIT = 32768;

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

/** Strip the bot token from any string before it reaches a log or error. */
function redactToken(s: string): string {
  return TELEGRAM_TOKEN ? s.split(TELEGRAM_TOKEN).join("<token>") : s;
}

async function callTelegram<T>(
  method: string,
  payload: Record<string, unknown>
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_ROOT}/bot${TELEGRAM_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network errors can embed the token-bearing URL — redact before surfacing.
    throw new Error(
      `Telegram ${method} request failed: ${redactToken(String(err))}`
    );
  }
  const data = (await res.json()) as TelegramResponse<T>;
  if (!data.ok) {
    throw new Error(
      `Telegram ${method} failed: ${data.error_code} ${data.description}`
    );
  }
  return data.result as T;
}

/**
 * Send Claude's GFM markdown as a rich message. Returns the created Message.
 */
export async function sendRichMessage(
  chatId: number | string,
  markdown: string
): Promise<Message> {
  return callTelegram<Message>("sendRichMessage", {
    chat_id: chatId,
    rich_message: { markdown, skip_entity_detection: true },
  });
}

/**
 * Edit an existing message in place to rich markdown content.
 */
export async function editRichMessage(
  chatId: number | string,
  messageId: number,
  markdown: string
): Promise<void> {
  await callTelegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    rich_message: { markdown, skip_entity_detection: true },
  });
}
