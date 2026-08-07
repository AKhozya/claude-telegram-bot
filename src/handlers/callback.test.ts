import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";

const { session } = await import("../session");
const { handleCallback } = await import("./callback");

// `isRunning` is what /status and /stop read. A button-initiated query that never sets it
// is invisible to both — the drift `session.ts` documents on `interruptForNewMessage`.
const makeCtx = (data: string, rec?: { replies: string[]; reactions: string[] }): any => ({
  from: { id: 1, username: "tester" },
  chat: { id: 100 },
  msg: { message_id: 5 },
  callbackQuery: { data },
  answerCallbackQuery: async () => {},
  editMessageText: async () => {},
  reply: async (t: string) => {
    rec?.replies.push(t);
    return { chat: { id: 100 }, message_id: 901 };
  },
  replyWithChatAction: async () => {},
  api: {
    setMessageReaction: async (_c: number, _m: number, r: any[]) => {
      rec?.reactions.push(r[0].emoji);
    },
    deleteMessage: async () => {},
  },
});

const s = session as any;
const saved = { sessionId: s.sessionId, conversationTitle: s.conversationTitle };

afterEach(() => {
  delete s.resumeSession;
  delete s.sendMessageStreaming;
  Object.assign(s, saved);
});

describe("resume button", () => {
  test("isRunning is true while the recap query runs and false after", async () => {
    s.sessionId = null; // not already active, or the handler bails early
    s.resumeSession = () => [true, "Session resumed"];

    const runningDuringQuery: boolean[] = [];
    s.sendMessageStreaming = async () => {
      runningDuringQuery.push(session.isRunning);
      return "recap";
    };

    await handleCallback(makeCtx("resume:sess-abc"));

    expect(runningDuringQuery).toEqual([true]);
    expect(session.isRunning).toBe(false);
  });

  test("isRunning is released when the recap query throws", async () => {
    s.sessionId = null;
    s.resumeSession = () => [true, "Session resumed"];

    // isRunning starts false, so asserting it alone would also pass on a handler that
    // never ran the query. The recorded call is what makes the release meaningful.
    const runningDuringQuery: boolean[] = [];
    s.sendMessageStreaming = async () => {
      runningDuringQuery.push(session.isRunning);
      throw new Error("boom");
    };

    await handleCallback(makeCtx("resume:sess-abc"));

    expect(runningDuringQuery).toEqual([true]);
    expect(session.isRunning).toBe(false);
  });
});

describe("ask_user button", () => {
  const requestId = `cbtest${process.pid}`;
  const requestFile = `/tmp/ask-user-${requestId}.json`;

  afterEach(() => rmSync(requestFile, { force: true }));

  test("isRunning is true while the selected option runs and false after", async () => {
    writeFileSync(
      requestFile,
      JSON.stringify({ question: "Pick one", options: ["Yes", "No"], status: "pending" }),
    );
    s.sessionId = "live-session";

    // Throws rather than returns: the success path audits, and auditLog would append to
    // whatever AUDIT_LOG_PATH config bound at module-eval. test-preload.ts now points that
    // at a test file rather than the running bot's log, but this test still has no reason
    // to reach the audit path at all.
    const runningDuringQuery: boolean[] = [];
    s.sendMessageStreaming = async () => {
      runningDuringQuery.push(session.isRunning);
      throw new Error("boom");
    };

    const rec = { replies: [] as string[], reactions: [] as string[] };
    await handleCallback(makeCtx(`askuser:${requestId}:0`, rec));

    expect(runningDuringQuery).toEqual([true]);
    expect(session.isRunning).toBe(false);
    // The error must reach the user via the shared handler, not vanish in the catch.
    expect(rec.reactions).toEqual(["👎"]);
    expect(rec.replies).toEqual(["❌ Error: Error: boom"]);
  });
});
