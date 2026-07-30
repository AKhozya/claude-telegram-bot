#!/usr/bin/env bun
/**
 * Ask User MCP Server - Presents options as Telegram inline keyboard buttons.
 *
 * When Claude calls ask_user(), this server writes a request file that the
 * Telegram bot monitors. The bot then displays inline keyboard buttons.
 * When the user clicks, their choice is injected back to Claude.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "ask-user",
  version: "1.0.0",
});

server.registerTool(
  "ask_user",
  {
    description:
      "Present options to the user as tappable inline buttons in Telegram. IMPORTANT: After calling this tool, STOP and wait. Do NOT add any text after calling this tool - the user will tap a button and their choice becomes their next message. Just call the tool and end your turn.",
    inputSchema: {
      question: z.string().min(1).describe("The question to ask the user"),
      options: z
        .array(z.string())
        .min(2)
        .max(10)
        .describe(
          "List of options for the user to choose from (2-6 options recommended)"
        ),
    },
  },
  async ({ question, options }) => {
    const requestUuid = crypto.randomUUID().slice(0, 8);

    // The bot polls /tmp for these; `callback.ts` reads the same shape back by
    // request_id when the user taps a button.
    const requestFile = `/tmp/ask-user-${requestUuid}.json`;
    await Bun.write(
      requestFile,
      JSON.stringify(
        {
          request_id: requestUuid,
          question,
          options,
          status: "pending",
          chat_id: process.env.TELEGRAM_CHAT_ID || "",
          created_at: new Date().toISOString(),
        },
        null,
        2
      )
    );

    return {
      content: [
        {
          type: "text" as const,
          text: "[Buttons sent to user. STOP HERE - do not output any more text. Wait for user to tap a button.]",
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Ask User MCP server running on stdio");
}

main().catch(console.error);
