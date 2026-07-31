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

/**
 * One character Telegram will actually draw.
 *
 * A length check is not enough. tdlib refuses an empty label outright — "Inline keyboard
 * button text must be non-empty" — but never trims: `clean_input_string` maps the C0
 * controls, tab included, to a space and leaves them there, where `clean_name` in the same
 * file finishes with `trim`. Button text does not go through `clean_name`.
 *
 * An empty label is the expensive one — Telegram rejects the whole keyboard and
 * `streaming.ts` swallows the failure, so the prompt is lost with no message to the user.
 * A label that is merely invisible is accepted and costs one blank button, which is why
 * this excludes whitespace, the control blocks, and the BMP half of Unicode's
 * Default_Ignorable_Code_Point set rather than an ad-hoc list, plus the two entries of
 * tdlib's own `strip_empty_characters` list that none of those groups already covers:
 * U+2800 and U+FFFC. Only U+2800 of the braille block — U+2801 upward carry dots, and
 * braille text has to keep working.
 *
 * Unicode grants Default_Ignorable no stability guarantee, so a later version can add a
 * BMP code point this class misses. `server.test.ts` enumerates the 17.0.0 set against
 * the published pattern; regenerate that list from a newer DerivedCoreProperties.txt
 * rather than trusting this transcription to have kept up.
 *
 * `strip_empty_characters` is not what rejects these — tdlib never applies it to button
 * text. `get_inline_keyboard_button` runs `clean_input_string`, which normalizes some
 * controls to spaces without trimming, then rejects only a fully empty string. A label of
 * nothing but blanks reaches the wire and renders as an unlabelled button, which is why
 * this guard exists at all.
 *
 * Astral default-ignorables (U+E0100 and friends) are NOT covered and cannot be: a JSON
 * Schema `pattern` carries no flags, so no `u` flag, so a supplementary code point is only
 * reachable as its surrogate halves. A pattern rather than a refinement precisely so the
 * published schema and the enforced rule stay the same object.
 *
 * Spelled with escapes because the characters it excludes are, by definition, ones no
 * reader can see in a diff:
 *   \s                    JS whitespace: space, tab, newline, nbsp, U+2000-200A, U+2028/9, U+3000, BOM
 *   \u0000-\u001F         C0 controls; clean_input_string maps these to a space
 *   \u007F-\u009F         DEL and the C1 controls
 *   \u00AD                soft hyphen
 *   \u034F                combining grapheme joiner
 *   \u061C                Arabic letter mark
 *   \u115F-\u1160         Hangul choseong and jungseong fillers
 *   \u17B4-\u17B5         Khmer inherent vowels
 *   \u180B-\u180F         Mongolian free variation selectors and vowel separator
 *   \u200B-\u200F         zero-width space/non-joiner/joiner, LRM, RLM
 *   \u202A-\u202E         bidi embedding and override controls
 *   \u2060-\u206F         word joiner, invisible operators, bidi isolates, deprecated formats
 *   \u2800                braille pattern blank — not default-ignorable; tdlib counts it as blank
 *   \u3164                Hangul filler
 *   \uFE00-\uFE0F         variation selectors
 *   \uFFA0                halfwidth Hangul filler
 *   \uFFF0-\uFFF8         the unassigned default-ignorable block
 *   \uFFFC                object replacement character — tdlib counts it as blank
 */
const RENDERS_SOMETHING =
  /[^\s\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFFA0\uFFF0-\uFFF8\uFFFC]/;

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
        .array(z.string().min(1).regex(RENDERS_SOMETHING))
        .min(2)
        .max(10)
        .describe(
          "List of options for the user to choose from (2-6 options recommended)"
        ),
    },
  },
  async ({ question, options }) => {
    // Whole UUID, not a prefix. `callback.ts` resolves a tap by this id alone — no message
    // binding, no age check — so two requests sharing an id means a tap on the older
    // prompt silently answers with the newer one's option. The budget allows it:
    // `askuser:<uuid>:<index>` is 47 of the 64 bytes Telegram gives callback_data.
    const requestUuid = crypto.randomUUID();

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
