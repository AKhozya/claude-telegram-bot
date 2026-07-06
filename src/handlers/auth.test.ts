import { test, expect } from "bun:test";

// config.ts (pulled in transitively) reads these at eval time. id 1 is the only allowed user.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { authGate } = await import("./auth");

function makeCtx(fromId: number | undefined, opts: { callback?: boolean } = {}) {
  const calls = { next: 0, answered: 0, replied: 0 };
  const ctx: any = {
    from: fromId === undefined ? undefined : { id: fromId },
    callbackQuery: opts.callback ? { data: "x" } : undefined,
    answerCallbackQuery: async () => {
      calls.answered++;
    },
    reply: async () => {
      calls.replied++;
    },
  };
  const next = async () => {
    calls.next++;
  };
  return { ctx, next, calls };
}

test("authGate calls next for an allowed user", async () => {
  const { ctx, next, calls } = makeCtx(1);
  await authGate(ctx, next);
  expect(calls.next).toBe(1);
  expect(calls.replied).toBe(0);
});

test("authGate silently drops an unauthorized message (no next, no reply)", async () => {
  const { ctx, next, calls } = makeCtx(999);
  await authGate(ctx, next);
  expect(calls.next).toBe(0);
  expect(calls.replied).toBe(0);
  expect(calls.answered).toBe(0);
});

test("authGate acks an unauthorized callback query but does not call next", async () => {
  const { ctx, next, calls } = makeCtx(999, { callback: true });
  await authGate(ctx, next);
  expect(calls.next).toBe(0);
  expect(calls.answered).toBe(1);
});

test("authGate drops an update with no from id", async () => {
  const { ctx, next, calls } = makeCtx(undefined);
  await authGate(ctx, next);
  expect(calls.next).toBe(0);
});
