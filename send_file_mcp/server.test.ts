import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { closeSync, ftruncateSync, openSync, rmSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Spawned as a child over stdio, exactly as the Agent SDK spawns it. Nothing else in the
// suite reaches this server — `streaming.ts` only reads the files it leaves behind.
const SERVER = new URL("./server.ts", import.meta.url).pathname;

// Distinct from any real Telegram chat, so a running bot ignores what these tests write.
const CHAT_ID = "99000000002";

const FIXTURE = "/tmp/send-file-test-fixture.txt";
const BIG = "/tmp/send-file-test-oversize.bin";
const EXACTLY_50MB = "/tmp/send-file-test-atlimit.bin";

let client: Client;
let noChatClient: Client;

async function connect(env: Record<string, string>): Promise<Client> {
  const c = new Client({ name: "server-test", version: "1.0.0" });
  await c.connect(
    new StdioClientTransport({
      command: "bun",
      args: [SERVER],
      env: { PATH: process.env.PATH ?? "", ...env },
    }),
  );
  return c;
}

/** The request files the server drops for `streaming.ts` to poll. */
async function writtenRequests(): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const name of new Bun.Glob("send-file-*.json").scan("/tmp")) {
    const data = await Bun.file(`/tmp/${name}`)
      .json()
      .catch(() => null);
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
  for await (const name of new Bun.Glob("send-file-*.json").scan("/tmp")) {
    const s = statSync(`/tmp/${name}`);
    state.set(name, `${s.size}:${s.mtimeMs}`);
  }
  return state;
}

/**
 * Nothing was written while the call ran. The one way this can flake: a live Claude
 * session calling send_file on this machine inside the same few milliseconds.
 */
async function expectNothingQueued(before: Map<string, string>): Promise<void> {
  const after = await requestFileState();
  // The union, so a deletion counts too — iterating `after` alone cannot see one.
  const names = new Set([...before.keys(), ...after.keys()]);
  expect([...names].filter((n) => before.get(n) !== after.get(n))).toEqual([]);
}

/** A refusal is one text item and nothing else — an extra item is a mixed message. */
function expectRefusal(
  result: { isError?: boolean; content: { type: string; text: string }[] },
  text: string,
): void {
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text }]);
}

async function cleanup(): Promise<void> {
  for await (const name of new Bun.Glob("send-file-*.json").scan("/tmp")) {
    const data = await Bun.file(`/tmp/${name}`)
      .json()
      .catch(() => null);
    if (data && String(data.chat_id) === CHAT_ID) await Bun.file(`/tmp/${name}`).delete();
  }
}

const call = (args: Record<string, unknown>, c: Client = client) =>
  c.callTool({ name: "send_file", arguments: args }) as Promise<{
    isError?: boolean;
    content: { type: string; text: string }[];
  }>;

beforeAll(async () => {
  // A killed run leaves its request files behind, and one matching a case below would
  // satisfy the shape assertions for a server that had stopped writing at all.
  await cleanup();
  await Bun.write(FIXTURE, "fixture\n");
  // Sparse: only the size matters, and Bun.file().size reads it from stat. Neither file
  // occupies a block on disk.
  for (const [path, size] of [
    [BIG, 51 * 1024 * 1024],
    [EXACTLY_50MB, 50 * 1024 * 1024],
  ] as const) {
    const fd = openSync(path, "w");
    ftruncateSync(fd, size);
    closeSync(fd);
  }

  client = await connect({ TELEGRAM_CHAT_ID: CHAT_ID });
  noChatClient = await connect({});
});

afterAll(async () => {
  // Optional: if beforeAll fails, these are undefined and an unguarded close throws a
  // TypeError here that masks the real cause.
  await client?.close();
  await noChatClient?.close();
  await cleanup();
  rmSync(FIXTURE, { force: true });
  rmSync(BIG, { force: true });
  rmSync(EXACTLY_50MB, { force: true });
});

afterEach(cleanup);

describe("send_file advertised schema", () => {
  test("the description Claude reads is unchanged, word for word", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("send_file");
    // Exact, not a substring: "This is not fire-and-forget" contains the keyword and
    // reverses the contract. Changing this text should mean changing this line too.
    expect(tools[0]!.description).toBe(
      "Send a file to the user via Telegram. Supports images (png, jpg, gif, webp), videos (mp4, mov, avi, webm, mkv), audio (mp3, wav, ogg, flac, m4a), and any other file type. The file is delivered automatically based on its extension. This is fire-and-forget — you can continue generating after calling this tool.",
    );
  });

  test("the argument schema is exactly what it was before zod generated it", async () => {
    const { tools } = await client.listTools();
    const { $schema, required, ...schema } = tools[0]!.inputSchema as Record<string, unknown> & {
      required?: string[];
    };

    // Held loosely: the draft URI is the SDK's choice, not this tool's contract.
    expect(String($schema)).toMatch(/^https?:\/\/json-schema\.org\//);
    expect(required).toEqual(["file_path"]);

    // The rest exactly, not toMatchObject: an added keyword — a maxLength, a startsWith —
    // narrows what the tool accepts, and toMatchObject would ignore it while the fixture
    // path below happened to satisfy it.
    expect(schema).toEqual({
      type: "object",
      properties: {
        file_path: {
          type: "string",
          minLength: 1,
          description: "Absolute path to the file to send (e.g. /tmp/preview.mp4)",
        },
        caption: {
          type: "string",
          description: "Optional caption to display with the file in Telegram",
        },
      },
    });
  });
});

describe("send_file request file", () => {
  test("a valid call writes the shape streaming.ts reads back", async () => {
    const result = await call({ file_path: FIXTURE, caption: "a caption" });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: "File queued for delivery: send-file-test-fixture.txt" },
    ]);

    const written = await writtenRequests();
    expect(written).toHaveLength(1);
    const req = written[0]!;
    expect(req.file_path).toBe(FIXTURE);
    expect(req.caption).toBe("a caption");
    expect(req.status).toBe("pending");
    expect(req.chat_id).toBe(CHAT_ID);
    // A whole UUID, not a prefix: `callback.ts` resolves a tap by this id alone, so a
    // collision answers an old prompt with a newer one's option.
    expect(String(req.request_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // Bounded on both sides: a hardcoded 1970 passes a parse check, and a hardcoded 2099
    // passes an upper bound alone.
    const age = Date.now() - Date.parse(String(req.created_at));
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);
  });

  test("each request gets its own id, in one server and across two", async () => {
    // Two calls on the running server, then the FIRST call of each of two fresh ones. The
    // fresh pair is what matters: an id derived from process-local state — a counter — is
    // unique within a run and hands both new servers the same id, so one request file
    // overwrites the other and a queued file is never sent. Reusing the server above
    // cannot show that, because its counter has already moved on.
    // Concurrent, not sequential: an id cut from the clock is distinct across awaited
    // calls most of the time, and collides only for two requests in the same millisecond.
    await Promise.all([
      call({ file_path: FIXTURE, caption: "one" }),
      call({ file_path: FIXTURE, caption: "two" }),
    ]);

    const fresh = await Promise.all([
      connect({ TELEGRAM_CHAT_ID: CHAT_ID }),
      connect({ TELEGRAM_CHAT_ID: CHAT_ID }),
    ]);
    try {
      await Promise.all(
        fresh.map((c) => c.callTool({ name: "send_file", arguments: { file_path: FIXTURE } })),
      );
    } finally {
      await Promise.all(fresh.map((c) => c.close()));
    }

    const ids = (await writtenRequests()).map((r) => r.request_id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  test("an omitted caption is written as an empty string, not undefined", async () => {
    await call({ file_path: FIXTURE });
    const req = (await writtenRequests())[0]!;
    // `streaming.ts` does `data.caption || undefined`, so a missing key would also work
    // — but JSON.stringify drops undefined, and the key has always been present.
    expect(req).toHaveProperty("caption", "");
  });

  test("an explicitly empty caption is accepted, not treated as malformed", async () => {
    // Reachable and previously valid: `caption: ""` differs from omitting the key only in
    // the schema, and a `.min(1)` added there would reject a call that has always worked.
    const result = await call({ file_path: FIXTURE, caption: "" });
    expect(result.isError).toBeFalsy();
    expect((await writtenRequests())[0]).toHaveProperty("caption", "");
  });
});

describe("send_file refuses what Telegram would reject", () => {
  test("a file that is not there is refused, and nothing is queued", async () => {
    const before = await requestFileState();
    const result = await call({ file_path: "/tmp/no-such-file-2601a4.bin" });
    expectRefusal(result, "Error: File not found or empty: /tmp/no-such-file-2601a4.bin");
    await expectNothingQueued(before);
  });

  test("a file over the 50MB Telegram limit is refused with its size", async () => {
    const before = await requestFileState();
    const result = await call({ file_path: BIG });
    expectRefusal(result, "Error: File too large (51.0MB). Telegram limit is 50MB.");
    await expectNothingQueued(before);
  });

  test("a file of exactly 50MB is still sent — the check is >, not >=", async () => {
    const result = await call({ file_path: EXACTLY_50MB });
    expect(result.isError).toBeFalsy();
    const written = await writtenRequests();
    expect(written).toHaveLength(1);
    // The file that was asked for, not merely some file.
    expect(written[0]!.file_path).toBe(EXACTLY_50MB);
  });

  test("with no TELEGRAM_CHAT_ID there is no recipient, so nothing is queued", async () => {
    // session.ts sets TELEGRAM_CHAT_ID on the child; absent means the server was started
    // outside a chat, and a queued file would have no chat_id for streaming.ts to match.
    const before = await requestFileState();
    const result = await call({ file_path: FIXTURE }, noChatClient);

    expectRefusal(result, "Error: TELEGRAM_CHAT_ID not set. Cannot determine recipient.");
    // Moving the guard below the write would leave a file with `chat_id: ""` and still
    // return this refusal, and no chat-id filter can see such a file.
    await expectNothingQueued(before);
  });

  test.each([
    ["a missing file_path", {}],
    ["an empty file_path", { file_path: "" }],
    ["a non-string file_path", { file_path: 7 }],
  ])("%s is refused by the schema", async (_name, args) => {
    const before = await requestFileState();
    const result = await call(args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("-32602");
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
