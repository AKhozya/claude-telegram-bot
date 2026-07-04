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
