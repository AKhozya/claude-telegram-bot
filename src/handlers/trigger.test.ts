import { describe, expect, mock, test } from "bun:test";

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
    // Port 0: the OS picks a free one and `startTriggerServer` reports it back. A fixed port
    // fails this test outright whenever anything else on the machine holds it — including a
    // second copy of this suite.
    mock.module("../config", () => ({
      ALLOWED_USERS: [12345],
      TRIGGER_ENABLED: true,
      TRIGGER_HOST: "127.0.0.1",
      TRIGGER_PORT: 0,
      TRIGGER_SECRET: "test-secret-xyz",
    }));

    // `trigger.ts` does not await `handleUpdate`, so the update arrives after the response.
    // The stub resolves this promise instead of the test polling a wall clock: a deadline
    // long enough to be safe on an idle machine is still short enough to lose under load.
    let deliver: (update: any) => void;
    const delivered = new Promise<any>((resolve) => {
      deliver = resolve;
    });
    const bot = {
      handleUpdate: async (u: unknown) => {
        deliver(u);
      },
    } as any;

    try {
      // Non-literal specifier: tsc can't statically resolve a query-stringed
      // path, so build it in a variable rather than typing the import error away.
      const cacheBustedTriggerPath = "./trigger?mock-config-test";
      const { startTriggerServer: freshStartTriggerServer } = await import(cacheBustedTriggerPath);
      const server = freshStartTriggerServer(bot);
      expect(server).not.toBeNull();

      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/trigger`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-trigger-secret": "test-secret-xyz",
          },
          body: JSON.stringify({ prompt: "hi", chat_id: 99999 }),
        });
        expect(res.status).toBe(202);

        const captured = await delivered;
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
