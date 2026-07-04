import { describe, expect, mock, test } from "bun:test";

// config.ts (pulled in transitively) reads these at module-eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { secretMatches } = await import("./trigger");

describe("secretMatches", () => {
  test("rejects wrong secret", () => {
    expect(secretMatches("wrong", "right-secret")).toBe(false);
  });
  test("rejects different-length secret without throwing", () => {
    expect(secretMatches("x", "right-secret")).toBe(false);
    expect(secretMatches("", "right-secret")).toBe(false);
  });
  test("accepts exact match", () => {
    expect(secretMatches("right-secret", "right-secret")).toBe(true);
  });
  test("rejects same-length wrong secret", () => {
    expect(secretMatches("wrong-secret", "right-secret")).toBe(false);
  });
});

describe("startTriggerServer", () => {
  test("delivers to defaultUserId regardless of caller-supplied chat_id", async () => {
    // config.ts is a cached module singleton; mock it for this consumer and
    // re-import trigger.ts via a cache-busting query string so the test is
    // order-independent (other files may have imported config first).
    mock.module("../config", () => ({
      ALLOWED_USERS: [12345],
      TRIGGER_ENABLED: true,
      TRIGGER_HOST: "127.0.0.1",
      TRIGGER_PORT: 18099,
      TRIGGER_SECRET: "test-secret-xyz",
    }));

    let captured: any = null;
    const bot = {
      handleUpdate: async (u: unknown) => {
        captured = u;
      },
    } as any;

    try {
      // Non-literal specifier: tsc can't statically resolve a query-stringed
      // path, so build it in a variable rather than typing the import error away.
      const cacheBustedTriggerPath = "./trigger?mock-config-test";
      const { startTriggerServer: freshStartTriggerServer } = await import(
        cacheBustedTriggerPath
      );
      const server = freshStartTriggerServer(bot);
      expect(server).not.toBeNull();

      try {
        const res = await fetch("http://127.0.0.1:18099/trigger", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-trigger-secret": "test-secret-xyz",
          },
          body: JSON.stringify({ prompt: "hi", chat_id: 99999 }),
        });
        expect(res.status).toBe(202);

        // trigger.ts calls bot.handleUpdate() without awaiting it — poll
        // instead of assuming it landed synchronously.
        const deadline = Date.now() + 2000;
        while (!captured && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10));
        }

        expect(captured).not.toBeNull();
        // Regression guard: a caller-supplied chat_id must never reach the
        // reply destination — it's always the first allowed user.
        expect(captured.message.chat.id).toBe(12345);
        expect(captured.message.from.id).toBe(12345);
      } finally {
        server?.stop();
      }
    } finally {
      mock.restore();
    }
  });
});
