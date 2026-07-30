import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";

// config.ts (pulled in transitively) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { session } = await import("../session");
const { handleCallback } = await import("./callback");

// `isRunning` is what /status and /stop read. A button-initiated query that never sets it
// is invisible to both — the drift `session.ts` documents and Batch 3 fixed one function
// up, in handleCallback's askuser branch.
const makeCtx = (data: string): any => ({
  from: { id: 1, username: "tester" },
  chat: { id: 100 },
  msg: { message_id: 5 },
  callbackQuery: { data },
  answerCallbackQuery: async () => {},
  editMessageText: async () => {},
  reply: async () => ({ chat: { id: 100 }, message_id: 901 }),
  replyWithChatAction: async () => {},
  api: {
    setMessageReaction: async () => {},
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
      JSON.stringify({ question: "Pick one", options: ["Yes", "No"], status: "pending" })
    );
    s.sessionId = "live-session";

    // Throws rather than returns: the success path audits, and auditLog would append to
    // whatever AUDIT_LOG_PATH config bound at module-eval — in a shared registry that is
    // the real /tmp/claude-telegram-audit.log.
    const runningDuringQuery: boolean[] = [];
    s.sendMessageStreaming = async () => {
      runningDuringQuery.push(session.isRunning);
      throw new Error("boom");
    };

    await handleCallback(makeCtx(`askuser:${requestId}:0`));

    expect(runningDuringQuery).toEqual([true]);
    expect(session.isRunning).toBe(false);
  });
});
