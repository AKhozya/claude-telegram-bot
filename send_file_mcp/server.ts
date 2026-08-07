#!/usr/bin/env bun
/**
 * Send File MCP Server - Sends files back to the user via Telegram.
 *
 * When Claude calls send_file(), this server writes a request file that the
 * Telegram bot monitors. The bot then sends the file using the appropriate
 * Telegram API method (video, photo, audio, or document).
 *
 * Fire-and-forget: Claude continues generating after calling this tool.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB Telegram limit

/**
 * A refusal the model can read and act on, not a protocol error. Everything the
 * schema cannot express — the file missing, too big, or no chat to send it to —
 * comes back this way, as it did before.
 */
const fail = (text: string) => ({
  content: [{ type: "text" as const, text: `Error: ${text}` }],
  isError: true,
});

const server = new McpServer({
  name: "send-file",
  version: "1.0.0",
});

server.registerTool(
  "send_file",
  {
    description:
      "Send a file to the user via Telegram. Supports images (png, jpg, gif, webp), videos (mp4, mov, avi, webm, mkv), audio (mp3, wav, ogg, flac, m4a), and any other file type. The file is delivered automatically based on its extension. This is fire-and-forget — you can continue generating after calling this tool.",
    inputSchema: {
      file_path: z
        .string()
        .min(1)
        .describe("Absolute path to the file to send (e.g. /tmp/preview.mp4)"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption to display with the file in Telegram"),
    },
  },
  async ({ file_path: filePath, caption }) => {
    // Bun.file() never throws for a missing path and reports size 0, so absence and
    // emptiness are indistinguishable here — hence the combined message below.
    try {
      const size = Bun.file(filePath).size;

      if (size === 0) {
        return fail(`File not found or empty: ${filePath}`);
      }

      if (size > MAX_FILE_SIZE) {
        const sizeMB = (size / (1024 * 1024)).toFixed(1);
        return fail(`File too large (${sizeMB}MB). Telegram limit is 50MB.`);
      }
    } catch {
      return fail(`Cannot access file: ${filePath}`);
    }

    const chatId = process.env.TELEGRAM_CHAT_ID || "";
    if (!chatId) {
      return fail("TELEGRAM_CHAT_ID not set. Cannot determine recipient.");
    }

    const requestUuid = crypto.randomUUID();

    // The bot polls /tmp for these; `streaming.ts` reads the same shape back.
    const requestFile = `/tmp/send-file-${requestUuid}.json`;
    await Bun.write(
      requestFile,
      JSON.stringify(
        {
          request_id: requestUuid,
          file_path: filePath,
          caption: caption ?? "",
          status: "pending",
          chat_id: chatId,
          created_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `File queued for delivery: ${filePath.split("/").pop() || "file"}`,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Send File MCP server running on stdio");
}

main().catch(console.error);
