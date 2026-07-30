import { test, expect } from "bun:test";

// Read config's RESOLVED ALLOWED_USERS rather than hardcoding the id: that is exactly the
// list authGate checks, so a change to how config parses TELEGRAM_ALLOWED_USERS cannot
// leave this asserting against a value config never produces. A negative id is never a
// valid Telegram id, so it is always the denied case.
const { authGate } = await import("./auth");
const { ALLOWED_USERS } = await import("../config");
const ALLOWED = ALLOWED_USERS[0]!;
const DENIED = -1;

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
  const { ctx, next, calls } = makeCtx(ALLOWED);
  await authGate(ctx, next);
  expect(calls.next).toBe(1);
  expect(calls.replied).toBe(0);
});

test("authGate silently drops an unauthorized message (no next, no reply)", async () => {
  const { ctx, next, calls } = makeCtx(DENIED);
  await authGate(ctx, next);
  expect(calls.next).toBe(0);
  expect(calls.replied).toBe(0);
  expect(calls.answered).toBe(0);
});

test("authGate acks an unauthorized callback query but does not call next", async () => {
  const { ctx, next, calls } = makeCtx(DENIED, { callback: true });
  await authGate(ctx, next);
  expect(calls.next).toBe(0);
  expect(calls.answered).toBe(1);
});

test("authGate drops an update with no from id", async () => {
  const { ctx, next, calls } = makeCtx(undefined);
  await authGate(ctx, next);
  expect(calls.next).toBe(0);
});
