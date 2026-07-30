/**
 * Shared TypeScript types for the Claude Telegram Bot.
 */

import type { Context, Api } from "grammy";
import type { FileFlavor, FileApiFlavor } from "@grammyjs/files";

export type StatusCallback = (
  type: "thinking" | "tool" | "text" | "segment_end" | "done",
  content: string,
  segmentId?: number
) => Promise<void>;

// Session persistence
export interface SavedSession {
  session_id: string;
  saved_at: string;
  working_dir: string;
  title: string; // First message truncated (max ~50 chars)
}

export interface SessionHistory {
  sessions: SavedSession[];
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export type AuditEventType =
  | "message"
  | "auth"
  | "tool_use"
  | "error"
  | "rate_limit";

export interface AuditEvent {
  timestamp: string;
  event: AuditEventType;
  user_id: number;
  username?: string;
  [key: string]: unknown;
}

// Flavored with the files plugin so ctx.getFile().download() exists on the context.
export type BotContext = FileFlavor<Context>;
export type BotApi = FileApiFlavor<Api>;
