import { afterEach, describe, expect, it } from "bun:test";

// config.ts (pulled in transitively) reads these at module-eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { sendRichMessage, editRichMessage, TELEGRAM_RICH_LIMIT } = await import(
  "./rich-message"
);

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/** Swap in a fetch stub; returns the array it records calls into. */
function mockFetch(response: unknown, opts?: { reject?: Error }): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (opts?.reject) throw opts.reject;
    return { ok: true, json: async () => response } as Response;
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("rich-message", () => {
  it("exposes the Bot API 10.1 rich length cap", () => {
    expect(TELEGRAM_RICH_LIMIT).toBe(32768);
  });

  it("sendRichMessage posts GFM markdown with skip_entity_detection", async () => {
    const calls = mockFetch({
      ok: true,
      result: { message_id: 7, chat: { id: 5 } },
    });
    const msg = await sendRichMessage(5, "# Heading\n| a | b |");

    expect(msg.message_id).toBe(7);
    expect(calls[0]!.url).toBe(
      "https://api.telegram.org/botTESTTOKEN:abc123/sendRichMessage"
    );
    expect(calls[0]!.body).toEqual({
      chat_id: 5,
      rich_message: {
        markdown: "# Heading\n| a | b |",
        skip_entity_detection: true,
      },
    });
  });

  it("editRichMessage edits in place via editMessageText + rich_message", async () => {
    const calls = mockFetch({ ok: true, result: {} });
    await editRichMessage(5, 7, "updated **bold**");

    expect(calls[0]!.url).toContain("/editMessageText");
    expect(calls[0]!.body).toEqual({
      chat_id: 5,
      message_id: 7,
      rich_message: {
        markdown: "updated **bold**",
        skip_entity_detection: true,
      },
    });
  });

  it("throws a token-free error on a Bot API error response", async () => {
    mockFetch({
      ok: false,
      error_code: 400,
      description: "BAD_REQUEST: bad markdown",
    });

    let err: Error | undefined;
    try {
      await sendRichMessage(5, "x");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain("BAD_REQUEST");
    expect(err!.message).not.toContain("TESTTOKEN:abc123");
  });

  it("redacts the bot token from network-error messages", async () => {
    mockFetch(null, {
      reject: new Error(
        "connect ECONNREFUSED https://api.telegram.org/botTESTTOKEN:abc123/sendRichMessage"
      ),
    });

    let err: Error | undefined;
    try {
      await sendRichMessage(5, "x");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).not.toContain("TESTTOKEN:abc123");
    expect(err!.message).toContain("<token>");
  });

  it("callTelegram retries once after 429 with retry_after", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_url: string, _init: RequestInit) => {
      calls++;
      if (calls === 1)
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 0 },
          }),
          { status: 429 }
        );
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    }) as typeof fetch;
    try {
      const msg = await sendRichMessage(123, "hi");
      expect(calls).toBe(2);
      expect((msg as any).message_id).toBe(7);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
