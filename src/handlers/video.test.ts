import { expect, test } from "bun:test";

const { rateLimiter } = await import("../security");
const { session } = await import("../session");
const { runner } = await import("../transcribe");
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

// Videos are capped by duration as well as size now: file size does not bound how long
// whisper runs, and a small, heavily compressed clip can still be an hour of speech.
test("an over-long video is refused before it is downloaded", async () => {
  const r = rec();
  await handleVideo(makeCtx({ file_id: "v3", file_size: 1024, duration: 601 }, r));
  expect(r.replies).toEqual(["❌ Too long to transcribe. Maximum is 600 seconds."]);
  expect(r.reactions).toEqual(["👀", "👎"]);
  expect(r.edits).toEqual([]);
});

// The cap is `>`, so exactly at it is allowed through. Pins the boundary only — it reads
// the same with the guard deleted, which the over-long test above is what covers.
test("a video exactly at the duration cap is not treated as too long", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  limiter.check = () => [true];
  try {
    await handleVideo(makeCtx({ file_id: "v3b", file_size: 1024, duration: 600 }, r));
  } finally {
    delete limiter.check;
  }
  expect(r.replies).toEqual(["📹 Downloading video..."]);
  expect(r.edits).toEqual(["❌ Failed to download video."]);
});

// Which guard runs first is a real choice, not an accident: the size check is the one that
// saves a transfer, so a clip violating both must be refused on size. Reordering them
// silently passes every other test in this file.
test("a video breaking both caps is refused on size, the cheaper guard", async () => {
  const r = rec();
  await handleVideo(
    makeCtx({ file_id: "v4", file_size: 51 * 1024 * 1024, duration: 601 }, r)
  );
  expect(r.replies).toEqual(["❌ Video too large. Maximum size is 50MB."]);
});

// Everything above stops at a guard or at the download, so none of it would notice if the
// transcription were deleted outright. The tests below are the ones that would.

/** A ctx whose download succeeds, returning the path it was asked to write. */
const makeDownloadableCtx = (video: unknown, r: Recorded): any => ({
  ...makeCtx(video, r),
  getFile: async () => ({ download: async (p: string) => p }),
});

const realSpawn = runner.spawn;

/** Pins the rate limiter, the two subprocesses, and the session in one place. */
async function withVideoPipeline(
  ffmpeg: { code: number; stdout: string; stderr: string },
  whisper: { code: number; stdout: string; stderr: string },
  body: (sent: string[]) => Promise<void>
): Promise<void> {
  const sent: string[] = [];
  const limiter = rateLimiter as any;
  const s = session as any;
  const saved = {
    sessionId: s.sessionId,
    conversationTitle: s.conversationTitle,
    lastMessage: s.lastMessage,
  };
  limiter.check = () => [true];
  // Shifted in call order: ffmpeg extracts the wav first, then whisper reads it.
  const runs = [ffmpeg, whisper];
  (runner as any).spawn = () => {
    const next = runs.shift() ?? { code: 0, stdout: "", stderr: "" };
    return { stdout: next.stdout, stderr: next.stderr, exited: Promise.resolve(next.code) };
  };
  s.sendMessageStreaming = async (prompt: string) => {
    sent.push(prompt);
    return "ok";
  };
  try {
    await body(sent);
  } finally {
    delete limiter.check;
    runner.spawn = realSpawn;
    delete s.sendMessageStreaming;
    Object.assign(s, saved);
  }
}

const OK = { code: 0, stdout: "", stderr: "" };

test("the video prompt carries the transcript and the file path", async () => {
  const r = rec();
  await withVideoPipeline(
    OK,
    { code: 0, stdout: "the meeting is at noon", stderr: "" },
    async (sent) => {
      await handleVideo(
        makeDownloadableCtx({ file_id: "v5", file_size: 1024, duration: 30 }, r)
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("the meeting is at noon");
      // The random suffix, not just the timestamp: a bare Date.now() name collides on
      // same-millisecond uploads, and now that a .wav hangs off this path the loser's
      // cleanup deletes the winner's working file. `+`, not `*` — an empty suffix is a
      // name that still collides, and asserting two paths merely differ would not catch
      // it either, since two sequential calls usually land in different milliseconds.
      expect(sent[0]).toMatch(/video_\d+_[a-z0-9]+\.mp4/);
    }
  );
});

// A caption is the branch a user actually hits — "what does he say here?" over a clip. It
// builds a different prompt string, so a transcript dropped from this one alone is invisible
// to the test above.
test("a captioned video carries both the caption and the transcript", async () => {
  const r = rec();
  await withVideoPipeline(
    OK,
    { code: 0, stdout: "the meeting is at noon", stderr: "" },
    async (sent) => {
      const ctx = makeDownloadableCtx(
        { file_id: "v6", file_size: 1024, duration: 30 },
        r
      );
      ctx.message.caption = "what did he say?";
      await handleVideo(ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("what did he say?");
      expect(sent[0]).toContain("the meeting is at noon");
    }
  );
});

// A silent screen recording is ordinary input, not an error: Claude still gets the path.
test("a video with no audio track still reaches Claude, marked as silent", async () => {
  const r = rec();
  await withVideoPipeline(
    {
      code: 234,
      stdout: "",
      stderr: "[out#0/wav] Output file does not contain any stream\n",
    },
    OK,
    async (sent) => {
      await handleVideo(
        makeDownloadableCtx({ file_id: "v7", file_size: 1024, duration: 30 }, r)
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("[no audio track]");
    }
  );
});

// Unlike the audio handler, a transcription failure here does not abort: the path alone is
// still worth sending, since Claude can read the file. Without this test the whole catch
// could be deleted and the throw would propagate into the query.
test("a transcription failure still reaches Claude, marked as such", async () => {
  const r = rec();
  await withVideoPipeline(
    { code: 1, stdout: "", stderr: "Invalid data found when processing input\n" },
    OK,
    async (sent) => {
      await handleVideo(
        makeDownloadableCtx({ file_id: "v8", file_size: 1024, duration: 30 }, r)
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("[audio could not be transcribed]");
      // Marked done, not failed: the query ran.
      expect(r.reactions).toEqual(["👀", "👌"]);
    }
  );
});
