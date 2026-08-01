import { expect, test } from "bun:test";
import { readFileSync } from "fs";

const { AUDIT_LOG_PATH } = await import("../config");
const { rateLimiter } = await import("../security");
const { session } = await import("../session");
const { runner } = await import("../transcribe");
const { handleAudio } = await import("./audio");

interface Recorded {
  replies: string[];
  reactions: string[];
  edits: string[];
}

const rec = (): Recorded => ({ replies: [], reactions: [], edits: [] });

// No `ctx.getFile`, so downloadTelegramFile throws and execution stops at the download —
// the same trick video.test.ts uses to prove a call got past the guards without stubbing a
// module.
const makeCtx = (message: Record<string, unknown>, r: Recorded): any => ({
  from: { id: 1, username: "tester" },
  chat: { id: 100 },
  msg: { message_id: 5 },
  message,
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

test("a message with neither voice nor audio returns before spending a reaction", async () => {
  const r = rec();
  await handleAudio(makeCtx({}, r));
  expect(r.replies).toEqual([]);
  expect(r.reactions).toEqual([]);
});

// Duration is checked before the download, so an over-long clip costs no transfer and no
// whisper run.
test("a clip past the duration cap is refused before it is downloaded", async () => {
  const r = rec();
  await handleAudio(makeCtx({ voice: { file_id: "v1", duration: 601 } }, r));
  expect(r.replies).toEqual([
    "❌ Too long to transcribe. Maximum is 600 seconds.",
  ]);
  expect(r.reactions).toEqual(["👀", "👎"]);
  expect(r.edits).toEqual([]);
});

// The cap is `>`, so exactly at it is allowed. This pins the boundary only — it reads the
// same with the guard deleted, which the over-long test above is what covers.
test("a clip exactly at the cap is not treated as too long", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  limiter.check = () => [true];
  try {
    await handleAudio(makeCtx({ voice: { file_id: "v2", duration: 600 } }, r));
  } finally {
    delete limiter.check;
  }
  expect(r.replies).toEqual(["⏳ Transcribing..."]);
  expect(r.edits).toEqual(["❌ Failed to download audio."]);
});

test("an audio file is accepted on the same path as a voice note", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  limiter.check = () => [true];
  try {
    await handleAudio(makeCtx({ audio: { file_id: "a1", duration: 12 } }, r));
  } finally {
    delete limiter.check;
  }
  expect(r.replies).toEqual(["⏳ Transcribing..."]);
  expect(r.edits).toEqual(["❌ Failed to download audio."]);
});

// Transcription is the most expensive thing this bot does per message, so it sits behind
// the limiter like every other handler. Every other test here pins the limiter open, so
// without this one the guard could be deleted outright and nothing would notice.
test("a rate-limited clip is refused before anything is downloaded or spawned", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  let spawned = false;
  limiter.check = () => [false, 4.2];
  (runner as any).spawn = () => {
    spawned = true;
    throw new Error("must not spawn");
  };
  try {
    await handleAudio(
      makeDownloadableCtx({ voice: { file_id: "v13", duration: 8 } }, r)
    );
  } finally {
    delete limiter.check;
    runner.spawn = realSpawn;
  }
  expect(spawned).toBe(false);
  expect(r.replies).toEqual(["⏳ Rate limited. Please wait 4.2 seconds."]);
  expect(r.reactions).toEqual(["👀", "👎"]);
  expect(r.edits).toEqual([]);
});

// Everything above stops at the download, so none of it would notice if the transcription
// and hand-off were deleted outright. The two tests below are the ones that would.

/** A ctx whose download succeeds, returning the path it was asked to write. */
const makeDownloadableCtx = (message: Record<string, unknown>, r: Recorded): any => ({
  ...makeCtx(message, r),
  getFile: async () => ({ download: async (p: string) => p }),
});

const realSpawn = runner.spawn;

/** Pins the rate limiter, the two subprocesses, and the session in one place. */
async function withPipeline(
  whisperStdout: string,
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
  // First spawn is ffmpeg, second is whisper-cli.
  const runs = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: whisperStdout, stderr: "" },
  ];
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

// The whole point of the handler: what was said reaches Claude as the prompt, unchanged.
// Deleting the transcription or the hand-off fails this.
/** The audit log is append-only, so a test reads back only what it added. */
const readAudit = (): string => {
  try {
    return readFileSync(AUDIT_LOG_PATH, "utf8");
  } catch {
    return "";
  }
};

test("the transcript is what gets sent to Claude, and is echoed back to the user", async () => {
  const r = rec();
  const s = session as any;
  const auditBefore = readAudit().length;
  await withPipeline("  book me a flight to Rome  ", async (sent) => {
    // setTitleIfNew is a no-op once a session exists, so the title assertion below only
    // means anything against an inactive one. withPipeline puts the real value back.
    s.sessionId = null;
    await handleAudio(
      makeDownloadableCtx({ voice: { file_id: "v9", duration: 8 } }, r)
    );
    expect(sent).toEqual(["book me a flight to Rome"]);
    // Asserted before withPipeline restores them. /retry replays lastMessage, so dropping
    // it makes /retry after a voice note repeat whatever was typed before it.
    expect(s.lastMessage).toBe("book me a flight to Rome");
    expect(s.conversationTitle).toBe("book me a flight to Rome");
  });
  expect(r.edits).toContain("🎤 book me a flight to Rome");
  expect(r.reactions).toEqual(["👀", "👌"]);
  // Spoken messages are auditable like typed ones. AUDIT_LOG_PATH points at a test file —
  // test-preload sets it, because the default is the running bot's own log.
  const added = readAudit().slice(auditBefore);
  expect(added).toContain("message_type: VOICE");
  expect(added).toContain("book me a flight to Rome");
});

// Whisper transcribes 99 languages, so a preview cut can land mid-character. `slice` counts
// UTF-16 units and would halve an astral one, leaving a lone surrogate in the text sent to
// Telegram. 500 is TRANSCRIPT_PREVIEW_CHARS, so the emoji here sits exactly on the boundary.
test("a preview cut on an astral character keeps it whole", async () => {
  const r = rec();
  const spoken = `${"a".repeat(499)}😀 and then some more`;
  await withPipeline(spoken, async (sent) => {
    await handleAudio(
      makeDownloadableCtx({ voice: { file_id: "v14", duration: 8 } }, r)
    );
    // Claude gets all of it regardless; only the preview is truncated.
    expect(sent).toEqual([spoken]);
  });
  expect(r.edits).toEqual([`🎤 ${"a".repeat(499)}😀…`]);
  // A halved surrogate pair leaves an unpaired code unit behind.
  expect(r.edits[0]).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

// Telegram rejects an edit whose text matches what the message already says. The status
// placeholder is edited into `🎤 <transcript>`, so sharing its emoji would make a transcript
// of the placeholder's own words an unmodified edit — a 400 thrown past the transcription,
// costing the query. Asserting the placeholder string alone would not catch that; this
// drives the collision itself through a ctx that fails the way Telegram does.
test("a transcript that echoes the placeholder still reaches Claude", async () => {
  const r = rec();
  const s = session as any;
  await withPipeline("Transcribing...", async (sent) => {
    const ctx = makeDownloadableCtx({ voice: { file_id: "v12", duration: 8 } }, r);
    let shown = "";
    ctx.reply = async (t: string) => {
      r.replies.push(t);
      shown = t;
      return { chat: { id: 100 }, message_id: 901 };
    };
    ctx.api.editMessageText = async (_c: number, _m: number, t: string) => {
      if (t === shown) {
        throw new Error("400: Bad Request: message is not modified");
      }
      r.edits.push(t);
      shown = t;
    };
    await handleAudio(ctx);
    expect(sent).toEqual(["Transcribing..."]);
  });
  expect(r.edits).toEqual(["🎤 Transcribing..."]);
  expect(r.reactions).toEqual(["👀", "👌"]);
});

// Whisper runs for the better part of a minute on a long clip, and `session.isRunning` is
// what /status reads. Marked busy after the transcription instead, /status reports an idle
// bot while it is plainly working — which no other test here can see, since they all observe
// the handler only once it has returned.
test("the session reads as busy while whisper is still running", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  const s = session as any;
  const busyAtSpawn: boolean[] = [];
  // This test does not go through withPipeline, so it restores the session fields the
  // handler writes itself — left behind, they make a later test file order-dependent.
  const saved = {
    conversationTitle: s.conversationTitle,
    lastMessage: s.lastMessage,
  };
  limiter.check = () => [true];
  const runs = [
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "still working", stderr: "" },
  ];
  (runner as any).spawn = () => {
    busyAtSpawn.push(session.isRunning);
    const next = runs.shift() ?? { code: 0, stdout: "", stderr: "" };
    return { stdout: next.stdout, stderr: next.stderr, exited: Promise.resolve(next.code) };
  };
  s.sendMessageStreaming = async () => "ok";
  try {
    await handleAudio(
      makeDownloadableCtx({ voice: { file_id: "v11", duration: 8 } }, r)
    );
  } finally {
    delete limiter.check;
    runner.spawn = realSpawn;
    delete s.sendMessageStreaming;
    Object.assign(s, saved);
  }
  // Both subprocesses — ffmpeg and whisper-cli — run inside the busy window.
  expect(busyAtSpawn).toEqual([true, true]);
  // And the window closes: the finally must release it however the handler exits.
  expect(session.isRunning).toBe(false);
});

// A host with no ffmpeg or whisper-cli is the normal state outside the container, and it
// must say so rather than blaming the file.
test("a host without the binaries says so, and sends nothing to Claude", async () => {
  const r = rec();
  const limiter = rateLimiter as any;
  const s = session as any;
  let queried = false;
  limiter.check = () => [true];
  (runner as any).spawn = () => {
    const err: any = new Error('Executable not found in $PATH: "ffmpeg"');
    err.code = "ENOENT";
    throw err;
  };
  s.sendMessageStreaming = async () => {
    queried = true;
    return "";
  };
  try {
    await handleAudio(
      makeDownloadableCtx({ voice: { file_id: "v10", duration: 8 } }, r)
    );
  } finally {
    delete limiter.check;
    runner.spawn = realSpawn;
    delete s.sendMessageStreaming;
  }
  expect(queried).toBe(false);
  expect(r.edits).toEqual(["❌ Transcription isn't available on this host."]);
  expect(r.reactions).toEqual(["👀", "👎"]);
  // This path returns from inside the try, so only the `finally` releases the busy flag.
  // Cleanup done at the end of the try instead would leak it here and on download failure,
  // leaving /status wedged on "busy" until the process restarts.
  expect(session.isRunning).toBe(false);
});
