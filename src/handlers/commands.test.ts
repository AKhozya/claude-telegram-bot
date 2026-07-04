import { test, expect } from "bun:test";

// config.ts (pulled in transitively via commands.ts) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { withMessageText } = await import("./commands");

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
