import { test, expect } from "bun:test";

test("markDone reacts 👌 on the user's message; failure is swallowed", async () => {
  const calls: any[] = [];
  const ctx: any = {
    chat: { id: 1 },
    msg: { message_id: 9 },
    api: { setMessageReaction: async (...a: any[]) => { calls.push(a); } },
  };
  const { markDone } = await import("./reactions");
  await markDone(ctx);
  expect(calls[0][0]).toBe(1);
  expect(calls[0][1]).toBe(9);
  expect(calls[0][2]).toEqual([{ type: "emoji", emoji: "👌" }]);

  const boom: any = { chat: { id: 1 }, msg: { message_id: 9 }, api: { setMessageReaction: async () => { throw new Error("x"); } } };
  await expect(markDone(boom)).resolves.toBeUndefined(); // swallowed
});

test("markReceived reacts 👀; markFailed reacts 👎", async () => {
  const calls: any[] = [];
  const ctx: any = {
    chat: { id: 5 },
    msg: { message_id: 3 },
    api: { setMessageReaction: async (...a: any[]) => { calls.push(a); } },
  };
  const { markReceived, markFailed } = await import("./reactions");
  await markReceived(ctx);
  await markFailed(ctx);
  expect(calls[0][2]).toEqual([{ type: "emoji", emoji: "👀" }]);
  expect(calls[1][2]).toEqual([{ type: "emoji", emoji: "👎" }]);
});

test("react is a no-op when chat or message id is missing", async () => {
  const ctx: any = {
    chat: undefined,
    msg: { message_id: 9 },
    api: { setMessageReaction: async () => { throw new Error("should not be called"); } },
  };
  const { markReceived } = await import("./reactions");
  await expect(markReceived(ctx)).resolves.toBeUndefined();
});
