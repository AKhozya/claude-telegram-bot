import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The only test in the repo that speaks the real protocol: the server is spawned as a
// child over stdio, exactly as the Agent SDK spawns it. `bun test` reaches nothing else
// here — this file and its send_file sibling are the whole oracle for both MCP servers.
const SERVER = new URL("./server.ts", import.meta.url).pathname;

// Distinct from any real Telegram chat, so a running bot ignores what these tests write
// and the cleanup below can tell its own files apart from the bot's.
const CHAT_ID = "99000000001";

let client: Client;

async function connect(env: Record<string, string>): Promise<Client> {
  const c = new Client({ name: "server-test", version: "1.0.0" });
  await c.connect(
    new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: { PATH: process.env.PATH ?? "", ...env },
    })
  );
  return c;
}

/** The request files the server drops for the bot to poll. */
async function writtenRequests(): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const name of new Bun.Glob("ask-user-*.json").scan("/tmp")) {
    const data = await Bun.file(`/tmp/${name}`).json().catch(() => null);
    if (data && String(data.chat_id) === CHAT_ID) out.push(data);
  }
  return out;
}

/**
 * Every request file on disk, by name and stamp. `writtenRequests()` identifies ours by
 * chat_id, so it cannot see a malformed or blank-chat file — which is exactly what a
 * broken server that writes before refusing would leave. Size and mtime come along
 * because a name-only comparison misses a write that lands on an existing name.
 */
async function requestFileState(): Promise<Map<string, string>> {
  const state = new Map<string, string>();
  for await (const name of new Bun.Glob("ask-user-*.json").scan("/tmp")) {
    const s = statSync(`/tmp/${name}`);
    state.set(name, `${s.size}:${s.mtimeMs}`);
  }
  return state;
}

/**
 * Nothing was written while the call ran. The one way this can flake: a live Claude
 * session calling ask_user on this machine inside the same few milliseconds.
 */
async function expectNothingQueued(before: Map<string, string>): Promise<void> {
  const after = await requestFileState();
  // The union, so a deletion counts too — iterating `after` alone cannot see one.
  const names = new Set([...before.keys(), ...after.keys()]);
  expect([...names].filter((n) => before.get(n) !== after.get(n))).toEqual([]);
}

async function cleanup(): Promise<void> {
  for await (const name of new Bun.Glob("ask-user-*.json").scan("/tmp")) {
    const data = await Bun.file(`/tmp/${name}`).json().catch(() => null);
    if (data && String(data.chat_id) === CHAT_ID) await Bun.file(`/tmp/${name}`).delete();
  }
}

const call = (args: Record<string, unknown>) =>
  client.callTool({ name: "ask_user", arguments: args }) as Promise<{
    isError?: boolean;
    content: { type: string; text: string }[];
  }>;

beforeAll(async () => {
  // A killed run leaves its request files behind. One of those, matching a case below,
  // would satisfy the shape assertions for a server that had stopped writing at all.
  await cleanup();
  client = await connect({ TELEGRAM_CHAT_ID: CHAT_ID });
});

afterAll(async () => {
  await client.close();
  await cleanup();
});

afterEach(cleanup);

describe("ask_user advertised schema", () => {
  test("the description Claude reads is unchanged, word for word", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("ask_user");
    // Exact, not a substring: this text is the whole contract with the model, and the
    // instruction that matters is a negative one. "Do not present tappable inline buttons
    // in Telegram; do not STOP and wait" contains every keyword worth grepping for and
    // means the opposite. Changing it should mean changing this line too.
    expect(tools[0]!.description).toBe(
      "Present options to the user as tappable inline buttons in Telegram. IMPORTANT: After calling this tool, STOP and wait. Do NOT add any text after calling this tool - the user will tap a button and their choice becomes their next message. Just call the tool and end your turn."
    );
  });

  test("the argument schema is exactly what it was before zod generated it", async () => {
    const { tools } = await client.listTools();
    const { $schema, required, ...schema } = tools[0]!.inputSchema as Record<
      string,
      unknown
    > & { required?: string[] };

    // Held loosely: the draft URI is the SDK's choice, not this tool's contract, and an
    // SDK bump that moves it would otherwise fail a test about our own arguments.
    expect(String($schema)).toMatch(/^https?:\/\/json-schema\.org\//);
    // `required` is an unordered set in JSON Schema, so compare it as one.
    expect([...required!].sort()).toEqual(["options", "question"]);

    // The rest exactly, not toMatchObject: every narrowing defect this file has had came
    // from an added keyword — an enum, a maxLength, a startsWith — that toMatchObject
    // ignores and that the dynamic inputs below happen to satisfy.
    expect(schema).toEqual({
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          description: "The question to ask the user",
        },
        options: {
          type: "array",
          items: {
            type: "string",
            minLength: 1,
            // The character class the server publishes, verbatim. Asserted here so a
            // narrowing or a widening of it has to be a deliberate edit in two places.
            pattern: "[^\\s\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u115F-\\u1160\\u17B4-\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u2800\\u3164\\uFE00-\\uFE0F\\uFFA0\\uFFF0-\\uFFF8\\uFFFC]"
          },
          minItems: 2,
          maxItems: 10,
          description:
            "List of options for the user to choose from (2-6 options recommended)",
        },
      },
    });
  });

});

describe("ask_user against Unicode's own default-ignorable list", () => {
  /**
   * Every BMP Default_Ignorable code point, transcribed from Unicode 17.0.0's
   * `DerivedCoreProperties.txt` — one row per line of that file, in its order, so a
   * newer version diffs against this by eye. Regenerate with:
   *
   *   grep '; Default_Ignorable_Code_Point' DerivedCoreProperties.txt
   *
   * The class in `server.ts` names these ranges by hand, and the rejection table below
   * reaches six of the 66. That leaves most of a range provable only by reading it:
   * dropping the last half of the word-joiner range passes every other test here.
   */
  const BMP_DEFAULT_IGNORABLE: [number, number][] = [
    [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
    [0x17b4, 0x17b5], [0x180b, 0x180d], [0x180e, 0x180e], [0x180f, 0x180f],
    [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2065, 0x2065],
    [0x2066, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
    [0xffa0, 0xffa0], [0xfff0, 0xfff8],
  ];

  // Against the published `pattern`, not a copy of the class. This is the advertised half
  // only: `listTools` serializes the zod schema, while a call is validated against the zod
  // object itself, so the two are separate code paths from one source. The test below
  // drives the enforced half.
  test("the published pattern rejects every BMP default-ignorable character", async () => {
    const { tools } = await client.listTools();
    const options = tools[0]!.inputSchema.properties!.options as {
      items: { pattern: string };
    };
    const renders = new RegExp(options.items.pattern);

    const missed: string[] = [];
    let checked = 0;
    for (const [lo, hi] of BMP_DEFAULT_IGNORABLE) {
      for (let c = lo; c <= hi; c++) {
        checked++;
        if (renders.test(String.fromCharCode(c)))
          missed.push("U+" + c.toString(16).toUpperCase().padStart(4, "0"));
      }
    }
    expect(missed).toEqual([]);
    // Guards the fixture rather than the class: a range dropped from the list above would
    // otherwise shrink this test in silence.
    expect(checked).toBe(66);
  });

  // The enforced half, over the wire. The second call is what stops this passing
  // vacuously: a refusal for any other reason — a length cap, a shape mismatch, a server
  // that has stopped accepting anything — would refuse the visible label too.
  test("a label of nothing but those 66 is refused on the call path", async () => {
    const blank = BMP_DEFAULT_IGNORABLE.flatMap(([lo, hi]) =>
      Array.from({ length: hi - lo + 1 }, (_, i) => String.fromCharCode(lo + i))
    ).join("");
    expect(blank).toHaveLength(66);

    const refused = await call({ question: "q", options: [blank, "Cancel"] });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("-32602");

    const accepted = await call({ question: "q", options: [`x${blank}`, "Cancel"] });
    expect(accepted.isError).toBeFalsy();
  });
});

describe("ask_user request file", () => {
  test("a valid call writes the shape callback.ts reads back", async () => {
    // Labels no schema could enumerate — the point of `items: {type: string}`.
    const result = await call({
      question: "Pick one",
      options: ["Deploy to prod", "Cancel"],
    });

    expect(result.isError).toBeFalsy();
    // The whole array: a second content item saying anything at all would undo the "output
    // nothing more" instruction that is the point of this tool.
    expect(result.content).toEqual([
      {
        type: "text",
        text: "[Buttons sent to user. STOP HERE - do not output any more text. Wait for user to tap a button.]",
      },
    ]);

    const written = await writtenRequests();
    expect(written).toHaveLength(1);
    const req = written[0]!;
    // Every key the bot reads: streaming.ts checks status/chat_id/question/options/
    // request_id, and callback.ts finds the file again by request_id.
    expect(req.question).toBe("Pick one");
    expect(req.options).toEqual(["Deploy to prod", "Cancel"]);
    expect(req.status).toBe("pending");
    expect(req.chat_id).toBe(CHAT_ID);
    // A whole UUID, not a prefix: `callback.ts` resolves a tap by this id alone, so a
    // collision answers an old prompt with a newer one's option.
    expect(String(req.request_id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Bounded on both sides: a hardcoded 1970 passes a parse check, and a hardcoded 2099
    // passes an upper bound alone.
    const age = Date.now() - Date.parse(String(req.created_at));
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);
  });

  // The guard asks for one visible character, it does not trim: padding is the caller's
  // business, and the option text is echoed back as the user's own message on tap. The
  // emoji and CJK cases are here because a class this broad is one typo away from
  // rejecting ordinary labels.
  // The known hole, pinned so it stays a decision rather than a surprise. A JSON Schema
  // `pattern` carries no flags, so no `u` flag, so an astral code point reaches the class
  // only as its surrogate halves — both of which are ordinary characters. Closing it means
  // giving up the guarantee that what is advertised is what is enforced.
  test("an astral variation selector still slips through, and that is the trade", async () => {
    const label = "\u{E0100}";
    const result = await call({ question: "q", options: [label, "Cancel"] });
    expect(result.isError).toBeFalsy();
    expect((await writtenRequests())[0]!.options).toEqual([label, "Cancel"]);
  });

  test.each([
    [" Deploy now ", "padding is preserved"],
    ["\u2705", "an emoji-only label"],
    ["\u65E5\u672C\u8A9E", "a CJK label"],
    ["\u2192 Go", "a label opening with an arrow"],
    ["\u2192", "an arrow and nothing else — no letter to fall back on"],
    ["\u2800\u2801", "braille that carries dots, blank cell and all"],
    ["\uFFFD", "the replacement character is visible, and sits beside the excluded block"],
    ["a\u200B", "a real character followed by a zero-width one"],
  ])("%j is accepted verbatim (%s)", async (label) => {
    await call({ question: "q", options: [label, "Cancel"] });
    expect((await writtenRequests())[0]!.options).toEqual([label, "Cancel"]);
  });

  test("each request gets its own id, in one server and across two", async () => {
    // Two calls on the running server, then the FIRST call of each of two fresh ones. The
    // fresh pair is what matters: an id derived from process-local state — a counter — is
    // unique within a run and hands both new servers the same id, so one request file
    // overwrites the other and a pending question is lost. Reusing the server above
    // cannot show that, because its counter has already moved on.
    // Concurrent, not sequential: an id cut from the clock is distinct across awaited
    // calls most of the time, and collides only for two requests in the same millisecond.
    await Promise.all([
      call({ question: "first", options: ["a", "b"] }),
      call({ question: "second", options: ["a", "b"] }),
    ]);

    const fresh = await Promise.all([
      connect({ TELEGRAM_CHAT_ID: CHAT_ID }),
      connect({ TELEGRAM_CHAT_ID: CHAT_ID }),
    ]);
    try {
      await Promise.all(
        fresh.map((c) =>
          c.callTool({
            name: "ask_user",
            arguments: { question: "fresh", options: ["a", "b"] },
          })
        )
      );
    } finally {
      await Promise.all(fresh.map((c) => c.close()));
    }

    const ids = (await writtenRequests()).map((r) => r.request_id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  test("the file is named for the request_id callback.ts interpolates", async () => {
    await call({ question: "q", options: ["a", "b"] });
    const req = (await writtenRequests())[0]!;
    expect(await Bun.file(`/tmp/ask-user-${req.request_id}.json`).exists()).toBe(true);
  });
});

describe("ask_user rejects what it cannot render", () => {
  // Each of these wrote a request file before the schema was declared to the SDK — a
  // question the bot renders as "Please choose:", or a keyboard of numbers.
  test.each([
    ["a missing question", { options: ["a", "b"] }],
    ["an empty question", { question: "", options: ["a", "b"] }],
    ["a non-string question", { question: 7, options: ["a", "b"] }],
    ["missing options", { question: "q" }],
    ["a single option", { question: "q", options: ["a"] }],
    ["non-string options", { question: "q", options: [1, 2] }],
    // grammy passes a label straight through, and `streaming.ts` swallows the resulting
    // send failure, so a rejected keyboard loses the whole prompt with no message to the
    // user — not just the one bad button. tdlib refuses an empty label ("Inline keyboard
    // button text must be non-empty"); the whitespace ones it ACCEPTS, and they arrive as
    // a blank button, which is why the schema has to catch them here.
    ["an empty option label", { question: "q", options: ["", "Cancel"] }],
    ["a whitespace-only option label", { question: "q", options: ["   ", "Cancel"] }],
    ["a tab as an option label", { question: "q", options: ["\t", "Cancel"] }],
    // Not whitespace by any definition, yet all of these arrive blank: clean_input_string
    // maps NUL to a space, and the rest occupy no pixels. `\\S` alone let every one through.
    ["a NUL as an option label", { question: "q", options: ["\u0000", "Cancel"] }],
    ["a zero-width space as an option label", { question: "q", options: ["\u200B", "Cancel"] }],
    ["a byte-order mark as an option label", { question: "q", options: ["\uFEFF", "Cancel"] }],
    ["a variation selector as an option label", { question: "q", options: ["\uFE0F", "Cancel"] }],
    ["a left-to-right mark as an option label", { question: "q", options: ["\u200E", "Cancel"] }],
    ["a combining grapheme joiner as a label", { question: "q", options: ["\u034F", "Cancel"] }],
    ["a Hangul filler as a label", { question: "q", options: ["\u3164", "Cancel"] }],
    ["a C1 control as a label", { question: "q", options: ["\u0085", "Cancel"] }],
    ["a braille blank as a label", { question: "q", options: ["\u2800", "Cancel"] }],
    ["an object replacement character as a label", { question: "q", options: ["\uFFFC", "Cancel"] }],
    ["more options than the schema allows", {
      question: "q",
      options: Array.from({ length: 11 }, (_, i) => `o${i}`),
    }],
  ])("%s is refused", async (_name, args) => {
    const before = await requestFileState();
    const result = await call(args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("-32602");
    // The refusal must not leave a half-formed request for the bot to render.
    await expectNothingQueued(before);
  });

  test("an unknown tool name is refused rather than silently accepted", async () => {
    const result = (await client.callTool({ name: "nope", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not found");
  });
});
