import { test, expect } from "bun:test";

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

// The deployment pins effortLevel "xhigh" (homelab cdce0adf). The API rejects that with
// thinking disabled — "400 output_config.effort 'xhigh' is not supported when thinking is
// disabled on this model" — which took down every message without a thinking keyword until
// 2026-07-28. Probe-verified that day: xhigh+adaptive and xhigh+enabled are both accepted.
// So the invariant is not "the default is adaptive", it is "never emit disabled".
test("thinking config is never 'disabled' — xhigh effort 400s on that pairing", async () => {
  const { getThinkingConfig } = await import("./session");
  for (const msg of [
    "list the pods",
    "",
    "think about this",
    "ultrathink about this",
    "DEPLOY IT",
  ]) {
    expect(getThinkingConfig(msg).type).not.toBe("disabled");
  }
});

test("thinking keywords still pin a fixed budget, plain messages stay adaptive", async () => {
  const { getThinkingConfig } = await import("./session");
  expect(getThinkingConfig("list the pods")).toEqual({ type: "adaptive" });
  expect(getThinkingConfig("think about it")).toEqual({ type: "enabled", budgetTokens: 10000 });
  expect(getThinkingConfig("ultrathink about it")).toEqual({ type: "enabled", budgetTokens: 50000 });
});
