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
  expect(getThinkingConfig("ultrathink about it")).toEqual({
    type: "enabled",
    budgetTokens: 50000,
  });
});

// The second layer used to live inline in the options object, where deleting it left
// every test green. These drive the exported gate so that deletion goes red.
test("preToolUseGate runs the external safety hook for Bash and denies on exit 2", async () => {
  const { preToolUseGate } = await import("./session");
  const { runner } = await import("./safety-hook");
  const real = runner.spawn;
  const saved = process.env.SAFETY_HOOK;
  const path = `${require("os").tmpdir()}/gate-block-${process.pid}.sh`;
  require("fs").writeFileSync(path, '#!/bin/bash\necho "BLOCKED: nope" >&2\nexit 2\n');
  require("fs").chmodSync(path, 0o755);
  process.env.SAFETY_HOOK = path;
  try {
    const out: any = await preToolUseGate(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as any,
      undefined,
      {} as any,
    );
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe("BLOCKED: nope");
  } finally {
    runner.spawn = real;
    if (saved === undefined) delete process.env.SAFETY_HOOK;
    else process.env.SAFETY_HOOK = saved;
    require("fs").rmSync(path, { force: true });
  }
});

test("preToolUseGate does not run the external safety hook for non-Bash tools", async () => {
  const { preToolUseGate } = await import("./session");
  const { runner } = await import("./safety-hook");
  const real = runner.spawn;
  const saved = process.env.SAFETY_HOOK;
  process.env.SAFETY_HOOK = "/nonexistent/would-deny.sh";
  let spawned = 0;
  runner.spawn = ((...args: any[]) => {
    spawned++;
    return (real as any)(...args);
  }) as typeof runner.spawn;
  try {
    const out: any = await preToolUseGate(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: `${process.env.HOME}/notes.txt` },
      } as any,
      undefined,
      {} as any,
    );
    expect(spawned).toBe(0);
    expect(out.hookSpecificOutput).toBeUndefined();
  } finally {
    runner.spawn = real;
    if (saved === undefined) delete process.env.SAFETY_HOOK;
    else process.env.SAFETY_HOOK = saved;
  }
});
