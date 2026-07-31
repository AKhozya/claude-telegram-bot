import { test, expect, mock, afterAll } from "bun:test";

/**
 * When the bot looks for an MCP request file, which is the whole defect.
 *
 * Both MCP servers `await Bun.write` their request file and only then return, so that
 * write has completed by the time a successful tool_result is streamed — and has not begun
 * when the tool_use block is. The SDK streams tool_use as part of the assistant message and dispatches the tool
 * after that message completes, so a read on tool_use raced the write and lost every time.
 * Live, that meant an `ask_user` question surfaced one call late and `send_file` told the
 * user "Sent." for a file it never sent.
 *
 * The checkers are mocked rather than driven for real: `session.ts` calls them without a
 * `dir`, so they would scan the live `/tmp` and reap another bot's requests — the defect
 * fixed in `ab8101c`. What is under test is *when* they run, and a flag flipped between the
 * two events models the write with no filesystem at all.
 */
const realSdk = { ...(await import("@anthropic-ai/claude-agent-sdk")) };
const realStreaming = { ...(await import("./handlers/streaming")) };

let streamEvents: unknown[] = [];
let requestFileWritten = false;
let checks: string[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  ...realSdk,
  query: () =>
    (async function* () {
      for (const e of streamEvents) {
        // A function stands for the MCP server doing its write between two events.
        if (typeof e === "function") {
          (e as () => void)();
          continue;
        }
        yield e;
      }
    })(),
}));

mock.module("./handlers/streaming", () => ({
  ...realStreaming,
  // The flag is recorded at call time, not just the call: asserting only that a checker
  // ran passes under the defect too, since the old code also ran it — just too early.
  checkPendingAskUserRequests: async () => {
    checks.push(`ask:${requestFileWritten}`);
    return requestFileWritten;
  },
  checkPendingSendFileRequests: async () => {
    checks.push(`send:${requestFileWritten}`);
    return requestFileWritten;
  },
}));

afterAll(() => {
  mock.module("@anthropic-ai/claude-agent-sdk", () => realSdk);
  mock.module("./handlers/streaming", () => realStreaming);
  session.sessionId = null;
});

const { session } = await import("./session");

const ctx = { chat: { id: 42 } } as any;

const toolUse = (id: string, name: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input: {} }] },
});
const toolResult = (id: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
});
const toolResultError = (id: string) => ({
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: id, content: "Error: no such file", is_error: true },
    ],
  },
});
const writeRequestFile = () => {
  requestFileWritten = true;
};

const run = async (events: unknown[]) => {
  streamEvents = events;
  requestFileWritten = false;
  checks = [];
  session.sessionId = null;
  const s = session as any;
  const origSave = s.saveSession;
  s.saveSession = async () => {};
  try {
    return await session.sendMessageStreaming(
      "hi",
      "tester",
      1,
      async () => {},
      42,
      ctx
    );
  } finally {
    s.saveSession = origSave;
  }
};

// The defect, exactly. Pre-fix the only read happened on the tool_use, before
// `writeRequestFile`, so it found nothing and the turn ended with no buttons.
test("an ask_user request written after its tool_use is still found", async () => {
  const reply = await run([
    toolUse("tu_1", "mcp__ask-user__ask_user"),
    writeRequestFile,
    toolResult("tu_1"),
  ]);
  expect(checks).toEqual(["ask:true"]);
  expect(reply).toBe("[Waiting for user selection]");
});

test("a send_file request written after its tool_use is still found", async () => {
  await run([
    toolUse("tu_2", "mcp__send-file__send_file"),
    writeRequestFile,
    toolResult("tu_2"),
  ]);
  expect(checks).toEqual(["send:true"]);
});

// The ordering itself, independent of what the check returns: reading at tool_use time is
// what was wrong, so nothing may read before the result arrives.
test("nothing is read while only the tool_use has been seen", async () => {
  await run([toolUse("tu_3", "mcp__ask-user__ask_user")]);
  expect(checks).toEqual([]);
});

// A result is matched to its own tool_use. Keying on anything looser would let an
// unrelated tool's result trigger a read, or the wrong checker run.
test("an unrelated tool's result triggers nothing", async () => {
  await run([
    toolUse("tu_4", "mcp__ask-user__ask_user"),
    writeRequestFile,
    toolResult("someone-else"),
  ]);
  expect(checks).toEqual([]);
});

test("a non-MCP tool is never tracked", async () => {
  await run([toolUse("tu_5", "Read"), writeRequestFile, toolResult("tu_5")]);
  expect(checks).toEqual([]);
});

// Each result fires its own kind, and only once.
test("two MCP calls in one turn each fire their own checker once", async () => {
  await run([
    toolUse("tu_6", "mcp__send-file__send_file"),
    toolUse("tu_7", "mcp__send-file__send_file"),
    writeRequestFile,
    toolResult("tu_6"),
    toolResult("tu_7"),
  ]);
  expect(checks).toEqual(["send:true", "send:true"]);
});

// One result, one read. A second read for the same call would scan the directory again and
// could pick up an unrelated request that happens to be pending.
test("a repeated result for the same tool_use is ignored", async () => {
  await run([
    toolUse("tu_8", "mcp__send-file__send_file"),
    writeRequestFile,
    toolResult("tu_8"),
    toolResult("tu_8"),
  ]);
  expect(checks).toEqual(["send:true"]);
});

/**
 * The one result carrying no guarantee that a whole request was written. Both servers
 * refuse outright for a missing or oversized file or no chat to send to, and a write that
 * threw part-way arrives the same way, so reading here would find only whatever older
 * request is still pending and deliver it against a call that failed.
 *
 * `writeRequestFile` runs anyway to stand for exactly that: something else's request
 * sitting there. A read would see it.
 */
test("an error result reads nothing", async () => {
  await run([
    toolUse("tu_9", "mcp__send-file__send_file"),
    writeRequestFile,
    toolResultError("tu_9"),
  ]);
  expect(checks).toEqual([]);
});
