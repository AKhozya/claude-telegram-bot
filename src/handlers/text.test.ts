import { describe, expect, test } from "bun:test";

const { session } = await import("../session");
const { rateLimiter } = await import("../security");
const { handleText, checkInterrupt } = await import("./text");

// No mock.module: it survives mock.restore() in Bun 1.3.14 and leaks into whichever
// files happen to run after this one. Assigning over the singleton's own methods and
// deleting the assignment restores the prototype version exactly.
interface Recorded {
  replies: string[];
  reactions: string[];
  deleted: number[];
}

const record = (): Recorded => ({ replies: [], reactions: [], deleted: [] });

const makeCtx = (text: string, rec: Recorded, failDeleteOf?: number): any => ({
  from: { id: 1, username: "tester" },
  chat: { id: 100 },
  msg: { message_id: 5 },
  message: { text },
  reply: async (t: string) => {
    rec.replies.push(t);
    return { chat: { id: 100 }, message_id: 900 + rec.replies.length };
  },
  replyWithChatAction: async () => {},
  api: {
    setMessageReaction: async (_c: number, _m: number, r: any[]) => {
      rec.reactions.push(r[0].emoji);
    },
    deleteMessage: async (_c: number, id: number) => {
      // Recorded before the throw: recording only successes lets a handler that never
      // attempted the failing id produce the same array as one that attempted them all.
      rec.deleted.push(id);
      if (id === failDeleteOf) throw new Error("message to delete not found");
    },
  },
});

/** Restores every field it touched, including the ones the handler itself writes. */
const withSession = async (
  stubs: Record<string, unknown>,
  body: () => Promise<void>,
): Promise<void> => {
  const s = session as any;
  const saved = {
    sessionId: s.sessionId,
    conversationTitle: s.conversationTitle,
    lastMessage: s.lastMessage,
  };
  for (const [k, v] of Object.entries(stubs)) s[k] = v;
  try {
    await body();
  } finally {
    for (const k of Object.keys(stubs)) delete s[k];
    Object.assign(s, saved);
  }
};

const withRateLimit = async (
  result: [boolean, number?],
  body: () => Promise<void>,
): Promise<void> => {
  const r = rateLimiter as any;
  r.check = () => result;
  try {
    await body();
  } finally {
    delete r.check;
  }
};

describe("handleText rate limiting", () => {
  test("over the limit: replies, reacts 👎, and never starts a query", async () => {
    const rec = record();
    let queried = false;
    await withRateLimit([false, 1.5], () =>
      withSession(
        {
          sendMessageStreaming: async () => {
            queried = true;
            return "";
          },
        },
        async () => {
          await handleText(makeCtx("hello", rec));
        },
      ),
    );

    expect(queried).toBe(false);
    expect(rec.replies).toEqual(["⏳ Rate limited. Please wait 1.5 seconds."]);
    expect(rec.reactions).toEqual(["👀", "👎"]);
  });
});

describe("handleText conversation title", () => {
  const failingQuery = {
    sendMessageStreaming: async () => {
      throw new Error("boom");
    },
  };

  test("a first message over 50 characters is truncated to 47 plus an ellipsis", async () => {
    const long = "x".repeat(80);
    await withRateLimit([true], () =>
      withSession({ ...failingQuery, sessionId: null }, async () => {
        await handleText(makeCtx(long, record()));
        expect(session.conversationTitle).toBe("x".repeat(47) + "...");
      }),
    );
  });

  test("a first message of 50 characters is kept whole", async () => {
    const exact = "y".repeat(50);
    await withRateLimit([true], () =>
      withSession({ ...failingQuery, sessionId: null }, async () => {
        await handleText(makeCtx(exact, record()));
        expect(session.conversationTitle).toBe(exact);
      }),
    );
  });

  test("an already-active session keeps the title it has", async () => {
    await withRateLimit([true], () =>
      withSession(
        { ...failingQuery, sessionId: "live-session", conversationTitle: "first prompt" },
        async () => {
          await handleText(makeCtx("a totally different follow-up", record()));
          expect(session.conversationTitle).toBe("first prompt");
        },
      ),
    );
  });
});

describe("handleText tool-message cleanup", () => {
  // The swallow is the point: one 400 from Telegram (message already gone, too old to
  // delete) must not strand the tool messages after it.
  test("every tool message is attempted even when one delete throws", async () => {
    const rec = record();
    await withRateLimit([true], () =>
      withSession(
        {
          sessionId: "live-session",
          sendMessageStreaming: async (
            _m: string,
            _u: string,
            _i: number,
            statusCallback: (t: string, c: string) => Promise<void>,
          ) => {
            await statusCallback("tool", "🔧 Read");
            await statusCallback("tool", "🔧 Bash");
            await statusCallback("tool", "🔧 Edit");
            throw new Error("boom");
          },
        },
        async () => {
          // 902 is the second tool message: replies are 901, 902, 903.
          await handleText(makeCtx("go", rec, 902));
        },
      ),
    );

    expect(rec.deleted).toEqual([901, 902, 903]);
    expect(rec.replies.slice(-1)).toEqual(["❌ Error: Error: boom"]);
    expect(rec.reactions).toEqual(["👀", "👎"]);
  });
});

// ── `!` interrupt prefix ──────────────────────────────────────────────────────
// text.ts routes every incoming message through this before doing anything else, so its
// three outcomes (passthrough, strip-and-forward, swallow) decide what Claude ever sees.

/**
 * Assign over the singleton's own methods and delete the assignment afterwards. No
 * mock.module: it survives mock.restore() in Bun 1.3.14 and leaks into whichever files
 * run after this one. delete, not assign-back — assigning the prototype method onto the
 * instance leaves an own property shadowing it.
 */
const withRunningSession = async (
  isRunning: boolean,
  body: (interrupts: number[]) => Promise<void>,
): Promise<void> => {
  const s = session as any;
  const interrupts: number[] = [];
  const savedIsRunning = Object.getOwnPropertyDescriptor(s, "isRunning");
  Object.defineProperty(s, "isRunning", { value: isRunning, configurable: true });
  s.interruptForNewMessage = async () => {
    interrupts.push(1);
  };
  try {
    await body(interrupts);
  } finally {
    delete s.interruptForNewMessage;
    delete (s as any).isRunning;
    if (savedIsRunning) Object.defineProperty(s, "isRunning", savedIsRunning);
  }
};

describe("checkInterrupt", () => {
  test("text without a ! prefix passes through untouched and interrupts nothing", async () => {
    await withRunningSession(true, async (interrupts) => {
      expect(await checkInterrupt("hello world")).toBe("hello world");
      expect(interrupts).toEqual([]);
    });
  });

  test("empty text passes through", async () => {
    await withRunningSession(true, async (interrupts) => {
      expect(await checkInterrupt("")).toBe("");
      expect(interrupts).toEqual([]);
    });
  });

  test("a ! prefix strips the marker and forwards the rest", async () => {
    await withRunningSession(true, async (interrupts) => {
      expect(await checkInterrupt("!  do the thing")).toBe("do the thing");
      expect(interrupts).toEqual([1]); // the interrupt is the point of the prefix
    });
  });

  // !stop is a /stop alias: cancel, and do NOT forward "stop" as a new prompt.
  test.each(["!stop", "!/stop", "! STOP ", "!/StOp"])(
    "%s cancels and forwards nothing",
    async (input) => {
      await withRunningSession(true, async (interrupts) => {
        expect(await checkInterrupt(input)).toBe("");
        expect(interrupts).toEqual([1]);
      });
    },
  );

  // The strip still happens with nothing running — only the interrupt is conditional.
  test("with no query running the text is still stripped, but nothing is interrupted", async () => {
    await withRunningSession(false, async (interrupts) => {
      expect(await checkInterrupt("!next prompt")).toBe("next prompt");
      expect(interrupts).toEqual([]);
    });
  });
});
