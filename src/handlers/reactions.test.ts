import { test, expect } from "bun:test";

test("markDone reacts 👌 on the user's message; failure is swallowed", async () => {
  const calls: any[] = [];
  const ctx: any = {
    chat: { id: 1 },
    msg: { message_id: 9 },
    api: {
      setMessageReaction: async (...a: any[]) => {
        calls.push(a);
      },
    },
  };
  const { markDone } = await import("./reactions");
  await markDone(ctx);
  expect(calls[0][0]).toBe(1);
  expect(calls[0][1]).toBe(9);
  expect(calls[0][2]).toEqual([{ type: "emoji", emoji: "👌" }]);

  const boom: any = {
    chat: { id: 1 },
    msg: { message_id: 9 },
    api: {
      setMessageReaction: async () => {
        throw new Error("x");
      },
    },
  };
  await expect(markDone(boom)).resolves.toBeUndefined(); // swallowed
});

test("markReceived reacts 👀; markFailed reacts 👎", async () => {
  const calls: any[] = [];
  const ctx: any = {
    chat: { id: 5 },
    msg: { message_id: 3 },
    api: {
      setMessageReaction: async (...a: any[]) => {
        calls.push(a);
      },
    },
  };
  const { markReceived, markFailed } = await import("./reactions");
  await markReceived(ctx);
  await markFailed(ctx);
  expect(calls[0][2]).toEqual([{ type: "emoji", emoji: "👀" }]);
  expect(calls[1][2]).toEqual([{ type: "emoji", emoji: "👎" }]);
});

// Use a call counter: react() catches stub errors, so a throwing stub cannot prove the
// guard runs.
test("react is a no-op when chat or message id is missing", async () => {
  let calls = 0;
  const api = {
    setMessageReaction: async () => {
      calls++;
    },
  };
  const { markReceived } = await import("./reactions");
  await expect(
    markReceived({ chat: undefined, msg: { message_id: 9 }, api } as any),
  ).resolves.toBeUndefined();
  await expect(
    markReceived({ chat: { id: 1 }, msg: undefined, api } as any),
  ).resolves.toBeUndefined();
  expect(calls).toBe(0);
});

// startTriggerServer uses a non-positive message_id for its synthetic update, so Telegram
// answers 400 "message to react not found". 0 is in the set: the id can round to -0.
test("react is a no-op on the trigger's non-positive message id", async () => {
  let calls = 0;
  const api = {
    setMessageReaction: async () => {
      calls++;
    },
  };
  const { markReceived, markDone, markFailed } = await import("./reactions");
  for (const message_id of [-44189, -0, 0]) {
    const ctx: any = { chat: { id: 113452686 }, msg: { message_id }, api };
    await markReceived(ctx);
    await markDone(ctx);
    await markFailed(ctx);
  }
  expect(calls).toBe(0);
});
