import { test, expect, mock, afterAll } from "bun:test";

// config.ts (pulled in transitively via session.ts) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

// The reset branch lives inside the stream loop, so the only honest test drives the real
// loop with a fake stream. Keep every other export real — formatting.ts reads the SDK's
// usage-limit prefix tables at import time.
//
// This must be a COPY, not the live namespace. `mock.module` mutates the namespace object
// in place, so a reference captured here would itself turn fake and could not restore
// anything. `mock.restore()` does not undo `mock.module` at all (Bun 1.3.14) — re-mocking
// from this snapshot is the only thing that works. The last test below guards that claim.
const realSdk = { ...(await import("@anthropic-ai/claude-agent-sdk")) };

let streamEvents: unknown[] = [];
const installFakeQuery = () =>
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    ...realSdk,
    query: () =>
      (async function* () {
        for (const e of streamEvents) yield e;
      })(),
  }));
installFakeQuery();

// Bun's test-file order is not lexicographic and not settable, so a leaked mock would hit an
// arbitrary, changing set of later files. Hand the real SDK back rather than rely on ordering.
afterAll(() => {
  mock.module("@anthropic-ai/claude-agent-sdk", () => realSdk);
  session.sessionId = null;
});

const { session } = await import("./session");

const run = async (events: unknown[], startingId: string | null) => {
  streamEvents = events;
  session.sessionId = startingId;
  const s = session as any;
  const origSave = s.saveSession;
  s.saveSession = async () => {}; // never touch the real /tmp session history
  try {
    await session.sendMessageStreaming("hi", "tester", 1, async () => {});
  } finally {
    s.saveSession = origSave;
  }
  return session.sessionId;
};

const reset = { type: "conversation_reset", session_id: "old-session-id", new_conversation_id: "unused" };
const init = { type: "system", subtype: "init", session_id: "new-session-id" };

// The trap: conversation_reset still carries the PRE-reset id. Dropping the `continue` lets
// the capture below re-adopt "old-session-id" on this very event, after which the guard
// (`!this.sessionId`) blocks the real id — the fix would look right and change nothing.
test("a reset mid-stream adopts the post-reset id, not the one the reset event carries", async () => {
  expect(await run([reset, init], "old-session-id")).toBe("new-session-id");
});

test("a reset with no following init leaves no id, so the next message starts fresh", async () => {
  expect(await run([reset], "old-session-id")).toBeNull();
});

test("without a reset the first id still wins and is never replaced mid-stream", async () => {
  expect(await run([init, { type: "system", session_id: "later-id" }], null)).toBe(
    "new-session-id"
  );
});

// Guards the afterAll above. If a Bun upgrade makes re-mocking stop restoring, this fails
// here rather than as an inexplicable failure in whichever file happens to run next.
test("re-mocking from the snapshot hands the real query back", async () => {
  mock.module("@anthropic-ai/claude-agent-sdk", () => realSdk);
  const restored = (await import("@anthropic-ai/claude-agent-sdk")).query;
  expect(String(restored)).not.toContain("streamEvents");
  installFakeQuery(); // leave the file as it found it; afterAll does the real restore
});
