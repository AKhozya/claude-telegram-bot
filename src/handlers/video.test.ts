import { expect, test } from "bun:test";

const { rateLimiter } = await import("../security");
const { handleVideo } = await import("./video");

interface Recorded {
  replies: string[];
  reactions: string[];
  edits: string[];
}

const rec = (): Recorded => ({ replies: [], reactions: [], edits: [] });

// No `ctx.getFile` — download.ts:12 calls it on the context, not on `api`. Its absence
// makes downloadTelegramFile throw, which is the download-failure path the handler
// already catches, and the cheapest way to prove a call got past the size guard
// without stubbing a module.
const makeCtx = (video: unknown, r: Recorded): any => ({
  from: { id: 1, username: "tester" },
  chat: { id: 100 },
  msg: { message_id: 5 },
  message: video === undefined ? {} : { video },
  reply: async (t: string) => {
    r.replies.push(t);
    return { chat: { id: 100 }, message_id: 901 };
  },
  replyWithChatAction: async () => {},
  api: {
    setMessageReaction: async (_c: number, _m: number, e: any[]) => {
      r.reactions.push(e[0].emoji);
    },
    editMessageText: async (_c: number, _m: number, t: string) => {
      r.edits.push(t);
    },
    deleteMessage: async () => {},
  },
});

// Unreachable through routing — src/index.ts registers this handler on `message:video`
// and `message:video_note`. The guard also covers `!userId` and `!chatId`, and pins the
// behaviour if the registration is ever widened.
test("a message with no video returns before spending a reaction", async () => {
  const r = rec();
  await handleVideo(makeCtx(undefined, r));
  expect(r.replies).toEqual([]);
  expect(r.reactions).toEqual([]);
});

// file_size is checked BEFORE the download so an oversized clip costs no transfer.
// This is the test that fails if the guard is deleted outright.
test("an oversized video is acknowledged, then refused before it is downloaded", async () => {
  const r = rec();
  await handleVideo(makeCtx({ file_id: "v1", file_size: 51 * 1024 * 1024 }, r));
  expect(r.replies).toEqual(["❌ Video too large. Maximum size is 50MB."]);
  // 👀 then 👎: received, then failed. Seeing only 👎 would not prove the handler
  // acknowledged the message first.
  expect(r.reactions).toEqual(["👀", "👎"]);
  // Nothing was downloaded, so the download-failure edit never happened.
  expect(r.edits).toEqual([]);
});

// The check is `>`, not `>=`, so exactly at the cap is allowed through. This pins the
// boundary only — it reads the same with the guard deleted entirely, which is what the
// oversized test above is for. What it shows is where execution stops instead: the
// "Downloading" reply, then the download-failure edit.
test("a video exactly at the cap is not treated as oversized", async () => {
  const r = rec();
  // Past the size guard the handler charges a rate-limit token. Pinned so the
  // assertions read the size boundary and not whatever the shared bucket held;
  // the same assign-and-delete idiom as text.test.ts, which explains why
  // mock.module is avoided here.
  const limiter = rateLimiter as any;
  limiter.check = () => [true];
  try {
    await handleVideo(makeCtx({ file_id: "v2", file_size: 50 * 1024 * 1024 }, r));
  } finally {
    delete limiter.check;
  }
  expect(r.replies).toEqual(["📹 Downloading video..."]);
  expect(r.edits).toEqual(["❌ Failed to download video."]);
});
