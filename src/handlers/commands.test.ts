import { test, expect } from "bun:test";

// config.ts (pulled in transitively via commands.ts) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { withMessageText, handleNew, handleStop } = await import("./commands");
const { session } = await import("../session");

test("withMessageText swaps text while preserving grammy prototype getters + own props", () => {
  // Fake grammy Context: message/chat/from are prototype getters over update.message.
  const proto = {
    get message() {
      return (this as any).update.message;
    },
    get chat() {
      return (this as any).update.message?.chat;
    },
    get from() {
      return (this as any).update.message?.from;
    },
    reply() {
      return "ok";
    },
  };
  const api = { config: {} };
  const ctx: any = Object.assign(Object.create(proto), {
    update: { message: { text: "/retry", chat: { id: 42 }, from: { id: 7 } } },
    api,
    me: { id: 1 },
  });

  const next: any = withMessageText(ctx, "hello world");

  expect(next.message.text).toBe("hello world"); // text swapped
  expect(next.chat.id).toBe(42); // prototype getter still live
  expect(next.from.id).toBe(7);
  expect(next.api).toBe(api); // own prop preserved
  expect(next.reply()).toBe("ok"); // prototype method preserved

  // Regression guard: the old `{...ctx}` spread dropped the prototype getters,
  // so handleText saw no chat and silently no-op'd. This is the bug fixed here.
  expect(({ ...ctx } as any).chat).toBeUndefined();
});

test("withMessageText does not mutate the original context", () => {
  const proto = {
    get message() {
      return (this as any).update.message;
    },
  };
  const ctx: any = Object.assign(Object.create(proto), {
    update: { message: { text: "original" } },
    api: {},
  });
  withMessageText(ctx, "changed");
  expect(ctx.update.message.text).toBe("original"); // original untouched
});

// /new and /stop both run stop -> settle -> clearStopRequested. session.ts:158-174 records
// that this sequence has already been dropped once by a hand-copy, in callback.ts.
const withStoppedSession = async (
  stopResult: "stopped" | "pending" | false,
  body: (calls: string[]) => Promise<void>
): Promise<void> => {
  const s = session as any;
  const calls: string[] = [];
  s.stop = async () => {
    calls.push("stop");
    return stopResult;
  };
  s.clearStopRequested = () => calls.push("clear");
  s.kill = async () => calls.push("kill");
  try {
    await body(calls);
  } finally {
    // delete, not assign-back: assigning the prototype method onto the instance leaves an
    // own property shadowing it for every later test file in this process.
    delete s.stop;
    delete s.clearStopRequested;
    delete s.kill;
  }
};

const replyCtx = (): any => ({ reply: async () => ({}) });

test("/stop stops the query, then clears the stop flag", async () => {
  await withStoppedSession("stopped", async (calls) => {
    const done = session.startProcessing(); // isRunning === true
    try {
      await handleStop(replyCtx());
    } finally {
      done();
    }
    expect(calls).toEqual(["stop", "clear"]);
  });
});

test("/new runs the same dance, then kills the session", async () => {
  await withStoppedSession("stopped", async (calls) => {
    const done = session.startProcessing();
    try {
      await handleNew(replyCtx());
    } finally {
      done();
    }
    expect(calls).toEqual(["stop", "clear", "kill"]);
  });
});

// stop() returns false when there was nothing to abort; clearing then would drop a stop
// another handler had just requested.
test("neither command clears the stop flag when stop() reports nothing to stop", async () => {
  await withStoppedSession(false, async (calls) => {
    const done = session.startProcessing();
    try {
      await handleStop(replyCtx());
    } finally {
      done();
    }
    expect(calls).toEqual(["stop"]);
  });
});

test("/stop is a no-op when nothing is running", async () => {
  await withStoppedSession("stopped", async (calls) => {
    await handleStop(replyCtx()); // isRunning === false
    expect(calls).toEqual([]);
  });
});
