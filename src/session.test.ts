import { test, expect } from "bun:test";

// config.ts (pulled in transitively via session.ts) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { session } = await import("./session");

// interruptForNewMessage is the single canonical "a new user message is preempting
// the running query" dance. callback.ts used to inline this and had drifted from
// utils.ts checkInterrupt, dropping markInterrupt() + clearStopRequested() — which
// dropped the button selection (stopRequested left true → sendMessageStreaming threw
// "Query cancelled") and showed a spurious "🛑 Query stopped." on the old query.

test("interruptForNewMessage is a no-op when nothing is running", async () => {
  const calls: string[] = [];
  const s = session as any;
  const orig = { m: s.markInterrupt, st: s.stop, c: s.clearStopRequested };
  s.markInterrupt = () => calls.push("mark");
  s.stop = async () => {
    calls.push("stop");
    return false;
  };
  s.clearStopRequested = () => calls.push("clear");
  try {
    await session.interruptForNewMessage(); // isRunning === false
    expect(calls).toEqual([]);
  } finally {
    s.markInterrupt = orig.m;
    s.stop = orig.st;
    s.clearStopRequested = orig.c;
  }
});

test("interruptForNewMessage marks interrupt, stops, then clears — in that order", async () => {
  const calls: string[] = [];
  const s = session as any;
  const orig = { m: s.markInterrupt, st: s.stop, c: s.clearStopRequested };
  s.markInterrupt = () => calls.push("mark");
  s.stop = async () => {
    calls.push("stop");
    return "stopped" as const;
  };
  s.clearStopRequested = () => calls.push("clear");
  const done = session.startProcessing(); // isRunning === true
  try {
    await session.interruptForNewMessage();
    // Regression guard: the buggy callback.ts kept only "stop" — no mark (spurious
    // "stopped"), no clear (dropped the incoming button message).
    expect(calls).toEqual(["mark", "stop", "clear"]);
  } finally {
    done();
    s.markInterrupt = orig.m;
    s.stop = orig.st;
    s.clearStopRequested = orig.c;
  }
});
