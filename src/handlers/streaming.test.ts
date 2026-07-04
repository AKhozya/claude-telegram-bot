import { describe, expect, test } from "bun:test";
import { symlinkSync, mkdirSync, rmSync } from "node:fs";

// config.ts (pulled in transitively) reads these at module-eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { isPathAllowed } = await import("../security");

describe("send-file path gate (isPathAllowed)", () => {
  test("rejects paths outside ALLOWED_PATHS and temp", () => {
    expect(isPathAllowed("/etc/passwd")).toBe(false);
    expect(isPathAllowed("/Users/other/secret.key")).toBe(false);
  });
  test("accepts bot temp dir", () => {
    expect(isPathAllowed("/tmp/telegram-bot/out.png")).toBe(true);
  });
  test("rejects traversal", () => {
    expect(isPathAllowed("/tmp/telegram-bot/../../etc/passwd")).toBe(false);
  });
  test("rejects /tmp symlink escaping to disallowed target", () => {
    const dir = "/tmp/telegram-bot-test";
    mkdirSync(dir, { recursive: true });
    const link = `${dir}/evil-link`;
    try { rmSync(link, { force: true }); } catch {}
    symlinkSync("/etc/passwd", link);
    try {
      expect(isPathAllowed(link)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rich message send via typed grammy api", () => {
  test("sendRichWithFallback uses typed ctx.api.sendRichMessage with markdown payload", async () => {
    const calls: any[] = [];
    const ctx: any = {
      chatId: 42,
      api: { sendRichMessage: (...a: any[]) => { calls.push(a); return { chat: { id: 42 }, message_id: 1 }; } },
      reply: () => { throw new Error("should not fall back"); },
    };
    const { createStatusCallback, StreamingState } = await import("./streaming");
    const cb = createStatusCallback(ctx, new StreamingState());
    await cb("text", "# Title\n\nbody", 0);
    expect(calls[0][0]).toBe(42);
    expect(calls[0][1]).toEqual({ markdown: "# Title\n\nbody", skip_entity_detection: true });
  });

  test("editRichWithFallback edits via typed ctx.api.editMessageText with markdown payload", async () => {
    const editCalls: any[] = [];
    const ctx: any = {
      chatId: 42,
      api: {
        sendRichMessage: () => ({ chat: { id: 42 }, message_id: 7 }),
        editMessageText: (...a: any[]) => { editCalls.push(a); },
      },
      reply: () => { throw new Error("should not fall back"); },
    };
    const { createStatusCallback, StreamingState } = await import("./streaming");
    const cb = createStatusCallback(ctx, new StreamingState());
    await cb("text", "initial", 0); // creates the segment message via sendRichMessage
    await cb("segment_end", "final content", 0); // edits it -> editRichWithFallback
    expect(editCalls[0][0]).toBe(42);
    expect(editCalls[0][1]).toBe(7);
    expect(editCalls[0][2]).toEqual({ markdown: "final content", skip_entity_detection: true });
  });
});

describe("ask_user keyboard styling", () => {
  test("ask_user keyboard applies a style to each button", async () => {
    const { createAskUserKeyboard } = await import("./streaming");
    const kb = createAskUserKeyboard("req1", ["Yes", "No"]);
    const rows = kb.inline_keyboard;
    expect(rows[0]![0]).toMatchObject({ text: "Yes", style: "primary" });
  });
});
