import { describe, expect, test } from "bun:test";

const { rateLimiter } = await import("../security");
const { createMediaGroupBuffer } = await import("./media-group");
const { MEDIA_GROUP_TIMEOUT } = await import("../config");

interface Recorded {
  replies: string[];
  reactions: string[];
  deleted: number[];
  edits: string[];
}

const record = (): Recorded => ({ replies: [], reactions: [], deleted: [], edits: [] });

const makeCtx = (rec: Recorded, caption?: string, failDeleteOf?: number): any => ({
  from: { id: 1, username: "tester" },
  chat: { id: 100 },
  msg: { message_id: 5 },
  message: { caption },
  reply: async (t: string) => {
    rec.replies.push(t);
    return { chat: { id: 100 }, message_id: 900 + rec.replies.length };
  },
  api: {
    setMessageReaction: async (_c: number, _m: number, r: any[]) => {
      rec.reactions.push(r[0].emoji);
    },
    deleteMessage: async (_c: number, id: number) => {
      // Recorded before the throw — see text.test.ts.
      rec.deleted.push(id);
      if (id === failDeleteOf) throw new Error("message to delete not found");
    },
    editMessageText: async (_c: number, _m: number, t: string) => {
      rec.edits.push(t);
    },
  },
});

const withRateLimit = async (
  result: [boolean, number?],
  body: (checks: number[]) => Promise<void>
): Promise<void> => {
  const r = rateLimiter as any;
  const checks: number[] = [];
  r.check = (userId: number) => {
    checks.push(userId);
    return result;
  };
  try {
    await body(checks);
  } finally {
    delete r.check;
  }
};

const config = { emoji: "📷", itemLabel: "photo", itemLabelPlural: "photos" };

describe("media group rate limiting", () => {
  // The whole reason albums do not reuse the per-message check: Telegram delivers a
  // 10-photo album as 10 updates, and charging each one rejects the album mid-upload.
  test("an album is charged once, not once per item", async () => {
    await withRateLimit([true], async (checks) => {
      const rec = record();
      const buffer = createMediaGroupBuffer(config);
      let processed: string[] = [];

      await buffer.addToGroup("g1", "/tmp/a.jpg", makeCtx(rec), 1, "tester", async (_c, items) => {
        processed = items;
      });
      await buffer.addToGroup("g1", "/tmp/b.jpg", makeCtx(rec), 1, "tester", async (_c, items) => {
        processed = items;
      });
      await buffer.addToGroup("g1", "/tmp/c.jpg", makeCtx(rec), 1, "tester", async (_c, items) => {
        processed = items;
      });

      expect(checks).toEqual([1]);

      // Let the debounce fire so the buffer is drained before the test ends.
      await Bun.sleep(MEDIA_GROUP_TIMEOUT + 150);
      expect(processed).toEqual(["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"]);
    });
  });

  test("a rate-limited album replies, reacts 👎, and opens no group", async () => {
    await withRateLimit([false, 2.5], async () => {
      const rec = record();
      const buffer = createMediaGroupBuffer(config);
      let processed = false;

      await buffer.addToGroup("g2", "/tmp/a.jpg", makeCtx(rec), 1, "tester", async () => {
        processed = true;
      });

      expect(rec.replies).toEqual(["⏳ Rate limited. Please wait 2.5 seconds."]);
      expect(rec.reactions).toEqual(["👎"]);

      await Bun.sleep(MEDIA_GROUP_TIMEOUT + 150);
      expect(processed).toBe(false);
    });
  });

  test("the first caption in an album wins, whichever item carries it", async () => {
    await withRateLimit([true], async () => {
      const rec = record();
      const buffer = createMediaGroupBuffer(config);
      let seen: string | undefined = "unset";

      await buffer.addToGroup("g3", "/tmp/a.jpg", makeCtx(rec), 1, "tester", async (_c, _i, cap) => {
        seen = cap;
      });
      await buffer.addToGroup(
        "g3",
        "/tmp/b.jpg",
        makeCtx(rec, "the album caption"),
        1,
        "tester",
        async (_c, _i, cap) => {
          seen = cap;
        }
      );

      await Bun.sleep(MEDIA_GROUP_TIMEOUT + 150);
      expect(seen).toBe("the album caption");
    });
  });
});
