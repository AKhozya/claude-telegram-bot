import { expect, test } from "bun:test";
import { writeFileSync } from "fs";

const { rateLimiter } = await import("../security");
const { session } = await import("../session");
const { runner } = await import("../transcribe");
const { handleVideo, videoSource } = await import("./video");

interface Recorded {
  replies: string[];
  reactions: string[];
  edits: string[];
}

const rec = (): Recorded => ({ replies: [], reactions: [], edits: [] });

// No `ctx.getFile` — `downloadTelegramFile` calls it on the context, not on `api`. Its absence
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
  await handleVideo(makeCtx({ file_id: "v4", file_size: 51 * 1024 * 1024, duration: 601 }, r));
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

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Pins the rate limiter, the subprocesses, and the session in one place.
 *
 * `runs` is consumed in call order. That is ffmpeg then whisper for a video Telegram already
 * measured, and ffprobe first for one attached as a file, which carries no duration.
 */
async function withVideoPipeline(
  runs: Run[],
  body: (sent: string[]) => Promise<void>,
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
  const queue = [...runs];
  (runner as any).spawn = (cmd: string[]) => {
    const next = queue.shift() ?? { code: 0, stdout: "", stderr: "" };
    // Frame paths are stat-checked, so the fake has to write what real ffmpeg would.
    const out = cmd[cmd.indexOf("-y") + 1];
    if (next.code === 0 && cmd.includes("-y") && out?.endsWith(".jpg")) {
      writeFileSync(out, "jpeg-bytes");
    }
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
    [OK, { code: 0, stdout: "the meeting is at noon", stderr: "" }],
    async (sent) => {
      await handleVideo(makeDownloadableCtx({ file_id: "v5", file_size: 1024, duration: 30 }, r));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("the meeting is at noon");
      // The random suffix, not just the timestamp: a bare Date.now() name collides on
      // same-millisecond uploads, and now that a .wav hangs off this path the loser's
      // cleanup deletes the winner's working file. `+`, not `*` — an empty suffix is a
      // name that still collides, and asserting two paths merely differ would not catch
      // it either, since two sequential calls usually land in different milliseconds.
      expect(sent[0]).toMatch(/video_\d+_[a-z0-9]+\.mp4/);
    },
  );
});

// A caption is the branch a user actually hits — "what does he say here?" over a clip. It
// builds a different prompt string, so a transcript dropped from this one alone is invisible
// to the test above.
test("a captioned video carries both the caption and the transcript", async () => {
  const r = rec();
  await withVideoPipeline(
    [OK, { code: 0, stdout: "the meeting is at noon", stderr: "" }],
    async (sent) => {
      const ctx = makeDownloadableCtx({ file_id: "v6", file_size: 1024, duration: 30 }, r);
      ctx.message.caption = "what did he say?";
      await handleVideo(ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("what did he say?");
      expect(sent[0]).toContain("the meeting is at noon");
    },
  );
});

// A silent screen recording is ordinary input, not an error: Claude still gets the path.
test("a video with no audio track still reaches Claude, marked as silent", async () => {
  const r = rec();
  await withVideoPipeline(
    [
      {
        code: 234,
        stdout: "",
        stderr: "[out#0/wav] Output file does not contain any stream\n",
      },
      OK,
    ],
    async (sent) => {
      await handleVideo(makeDownloadableCtx({ file_id: "v7", file_size: 1024, duration: 30 }, r));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("[no audio track]");
    },
  );
});

// There is no video tool, so the frames are the only way the picture reaches Claude at all.
// Listed by path, like photo.ts hands over a photo — nothing is embedded in the prompt.
test("scene frames are listed in the prompt alongside the transcript", async () => {
  const r = rec();
  await withVideoPipeline(
    [
      OK, // ffmpeg: wav extraction
      { code: 0, stdout: "what the speaker said", stderr: "" }, // whisper
      { code: 0, stdout: "", stderr: "pts_time:3.0\npts_time:11.0" }, // scene detection
      OK, // frame 1
      OK, // frame 2
    ],
    async (sent) => {
      await handleVideo(makeDownloadableCtx({ file_id: "v20", file_size: 1024, duration: 20 }, r));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("what the speaker said");
      expect(sent[0]).toContain("Frames from the video, in order:");
      expect(sent[0]).toMatch(/1\. .*\.frame-1\.jpg/);
      expect(sent[0]).toMatch(/2\. .*\.frame-2\.jpg/);
    },
  );
});

// Frames are a bonus, not a precondition. A clip whose stills cannot be written must still
// reach Claude with its transcript, and the prompt must not carry an empty frame heading.
test("a video whose frames cannot be extracted still reaches Claude", async () => {
  const r = rec();
  await withVideoPipeline(
    [
      OK,
      { code: 0, stdout: "still worth hearing", stderr: "" },
      { code: 1, stdout: "", stderr: "" }, // detection fails
      { code: 1, stdout: "", stderr: "" }, // and so does every fallback still
      { code: 1, stdout: "", stderr: "" },
      { code: 1, stdout: "", stderr: "" },
    ],
    async (sent) => {
      await handleVideo(makeDownloadableCtx({ file_id: "v21", file_size: 1024, duration: 20 }, r));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("still worth hearing");
      expect(sent[0]).not.toContain("Frames from the video");
      expect(r.reactions).toEqual(["👀", "👌"]);
    },
  );
});

// Telegram decides `video` vs `document` from how the sender attached the file, not from what
// it contains — desktop drag-and-drop sends a document for the same clip the gallery picker
// sends as a video. Before this, that shape reached the document handler and was refused as an
// unsupported type.
test("videoSource accepts a video attached as a file", () => {
  const doc = (mime?: string) =>
    ({ message: { document: { file_id: "d", mime_type: mime } } }) as any;
  expect(videoSource(doc("video/mp4"))?.file_id).toBe("d");
  expect(videoSource(doc("video/quicktime"))?.file_id).toBe("d");
  // Not media: still the document handler's business.
  expect(videoSource(doc("application/pdf"))).toBeUndefined();
  expect(videoSource(doc(undefined))).toBeUndefined();
  // An audio document belongs to the audio handler, not this one.
  expect(videoSource(doc("audio/mpeg"))).toBeUndefined();
  // A real video still wins, and is preferred over any document on the same message.
  expect(videoSource({ message: { video: { file_id: "v" } } } as any)?.file_id).toBe("v");
  expect(videoSource({ message: { video_note: { file_id: "n" } } } as any)?.file_id).toBe("n");
  expect(videoSource({ message: {} } as any)).toBeUndefined();
});

/** A ctx whose video arrived as a file attachment rather than through the gallery picker. */
const makeDocumentCtx = (document: unknown, r: Recorded): any => ({
  ...makeCtx(undefined, r),
  message: { document },
  getFile: async () => ({ download: async (p: string) => p }),
});

// A document carries no duration, so the pre-download guard cannot fire and ffprobe measures
// it after the transfer. That inserts a third subprocess ahead of the usual two.
test("a video attached as a file is transcribed like any other video", async () => {
  const r = rec();
  await withVideoPipeline(
    [
      { code: 0, stdout: "12.5\n", stderr: "" }, // ffprobe: header
      OK, // ffprobe: streams, nothing to add
      OK, // ffmpeg
      { code: 0, stdout: "spoken words here", stderr: "" }, // whisper
    ],
    async (sent) => {
      await handleVideo(
        makeDocumentCtx(
          { file_id: "d1", file_size: 1024, mime_type: "video/mp4", file_name: "clip.mkv" },
          r,
        ),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("spoken words here");
      // The file's own extension is kept: ffmpeg reads by content, but a .mkv named .mp4
      // misleads anyone reading the path in the prompt.
      expect(sent[0]).toMatch(/video_\d+_[a-z0-9]+\.mkv/);
    },
  );
});

// The cap still applies, just later — the transfer is already spent, so the refusal has to
// come after it. Deleting the post-download probe leaves an unbounded clip reaching whisper.
test("a file-attached video over the cap is refused after the download", async () => {
  const r = rec();
  await withVideoPipeline(
    [{ code: 0, stdout: "605.0\n", stderr: "" }, OK, OK], // ffprobe over the 600s cap
    async (sent) => {
      await handleVideo(
        makeDocumentCtx({ file_id: "d2", file_size: 1024, mime_type: "video/mp4" }, r),
      );
      // Never reached Claude.
      expect(sent).toEqual([]);
      expect(r.edits).toContain("❌ Too long to transcribe. Maximum is 600 seconds.");
      expect(r.reactions).toEqual(["👀", "👎"]);
    },
  );
});

// `file_name` is sender-controlled. A long dot-free tail would push the generated path past
// the filesystem's name limit and a separator would aim it at a directory that does not exist
// — both fail the download, so only a short alphanumeric suffix is taken.
test("a hostile file name does not reach the download path", async () => {
  const r = rec();
  await withVideoPipeline(
    [{ code: 0, stdout: "5.0\n", stderr: "" }, OK, OK, { code: 0, stdout: "hi", stderr: "" }],
    async (sent) => {
      await handleVideo(
        makeDocumentCtx(
          {
            file_id: "d3",
            file_size: 1024,
            mime_type: "video/mp4",
            file_name: `clip.${"z".repeat(250)}`,
          },
          r,
        ),
      );
      expect(sent).toHaveLength(1);
      // Fell back to the default rather than carrying the 250-character suffix.
      expect(sent[0]).toMatch(/video_\d+_[a-z0-9]+\.mp4/);
      expect(sent[0]).not.toContain("zzz");
    },
  );
});

// Same guard, the separator case: an extension carrying a slash would name a directory that
// was never created.
test("a file name with a separator in its extension falls back", async () => {
  const r = rec();
  await withVideoPipeline(
    [{ code: 0, stdout: "5.0\n", stderr: "" }, OK, OK, { code: 0, stdout: "hi", stderr: "" }],
    async (sent) => {
      await handleVideo(
        makeDocumentCtx(
          { file_id: "d4", file_size: 1024, mime_type: "video/mp4", file_name: "a.b/c" },
          r,
        ),
      );
      expect(sent[0]).toMatch(/video_\d+_[a-z0-9]+\.mp4/);
      expect(sent[0]).not.toContain("b/c");
    },
  );
});

// A silent screen recording sent as a file has no audio stream to measure. Probing only the
// audio stream would return nothing and refuse it, while the identical clip sent from the
// gallery is accepted as [no audio track] — the same file, two answers, decided by how it was
// attached. What the cap bounds is the length of the file, not of its audio.
test("a silent video attached as a file is measured by its video stream", async () => {
  const r = rec();
  await withVideoPipeline(
    [
      { code: 0, stdout: "N/A\n", stderr: "" }, // no duration in the header
      { code: 0, stdout: "\n12.4\n", stderr: "" }, // video stream only, blank audio line
      {
        code: 234,
        stdout: "",
        stderr: "[out#0/wav] Output file does not contain any stream\n",
      },
      OK,
    ],
    async (sent) => {
      await handleVideo(
        makeDocumentCtx({ file_id: "d6", file_size: 1024, mime_type: "video/mp4" }, r),
      );
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("[no audio track]");
    },
  );
});

// The longest stream decides. A container whose audio runs shorter than its video must still
// be measured by the video, or a clip over the cap slips through on its audio length.
test("the longest stream decides the measured duration", async () => {
  const r = rec();
  await withVideoPipeline(
    [
      { code: 0, stdout: "N/A\n", stderr: "" },
      { code: 0, stdout: "30.0\n605.0\n", stderr: "" }, // short audio, long video
      OK,
    ],
    async (sent) => {
      await handleVideo(
        makeDocumentCtx({ file_id: "d7", file_size: 1024, mime_type: "video/mp4" }, r),
      );
      expect(sent).toEqual([]);
      expect(r.edits).toContain("❌ Too long to transcribe. Maximum is 600 seconds.");
    },
  );
});

// Unmeasurable fails closed — see the audio handler for the reasoning.
test("a file-attached video whose duration cannot be read is refused", async () => {
  const r = rec();
  await withVideoPipeline(
    [
      { code: 1, stdout: "", stderr: "Invalid data found" },
      { code: 0, stdout: "N/A\n", stderr: "" },
      OK,
    ],
    async (sent) => {
      await handleVideo(
        makeDocumentCtx({ file_id: "d5", file_size: 1024, mime_type: "video/mp4" }, r),
      );
      expect(sent).toEqual([]);
      expect(r.edits).toContain("❌ Couldn't read how long that video is.");
    },
  );
});

// Unlike the audio handler, a transcription failure here does not abort: the path alone is
// still worth sending, since Claude can read the file. Without this test the whole catch
// could be deleted and the throw would propagate into the query.
test("a transcription failure still reaches Claude, marked as such", async () => {
  const r = rec();
  await withVideoPipeline(
    [{ code: 1, stdout: "", stderr: "Invalid data found when processing input\n" }, OK],
    async (sent) => {
      await handleVideo(makeDownloadableCtx({ file_id: "v8", file_size: 1024, duration: 30 }, r));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("[audio could not be transcribed]");
      // Marked done, not failed: the query ran.
      expect(r.reactions).toEqual(["👀", "👌"]);
    },
  );
});
