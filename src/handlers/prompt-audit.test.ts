import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";

// config.ts (pulled in transitively) reads these at eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const AUDIT_PATH = `/tmp/prompt-audit-test-${process.pid}.log`;

// Runs in a subprocess: AUDIT_LOG_PATH is read once at config module-eval and bun test
// shares one module registry across files, so an in-process call would append to the real
// /tmp/claude-telegram-audit.log instead. Same reason as utils.test.ts.
const runInSubprocess = async (body: string): Promise<string> => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `const { session } = await import("${import.meta.dir}/../session.ts");
       const ctx = {
         chat: { id: 100 },
         msg: { message_id: 5 },
         reply: async () => ({ chat: { id: 100 }, message_id: 901 }),
         replyWithChatAction: async () => {},
         api: {
           setMessageReaction: async () => {},
           deleteMessage: async () => {},
           editMessageText: async () => {},
         },
       };
       ${body}
       process.exit(0);`,
    ],
    {
      env: { ...process.env, AUDIT_LOG_PATH: AUDIT_PATH },
      stdout: "ignore",
      stderr: "inherit",
    }
  );
  expect(await proc.exited).toBe(0);
  return readFileSync(AUDIT_PATH, "utf8");
};

describe("what reaches the audit log", () => {
  beforeEach(() => rmSync(AUDIT_PATH, { force: true }));
  afterEach(() => rmSync(AUDIT_PATH, { force: true }));

  // photo.ts deliberately audits the whole constructed prompt — it is short, and the file
  // paths in it are the record of what was analysed. document.ts must NOT do this: its
  // prompt carries entire file bodies, and the log is written unredacted under
  // AUDIT_LOG_JSON. Any shared helper therefore needs the audit input as its own
  // parameter, never derived from the prompt.
  test("a photo query audits its full constructed prompt", async () => {
    const log = await runInSubprocess(
      `session.sessionId = "live";
       session.sendMessageStreaming = async () => "the response";
       const { processPhotos } = await import("${import.meta.dir}/photo.ts");
       await processPhotos(ctx, ["/tmp/telegram-bot/p1.jpg"], "describe it", 7, "tester", 100);`
    );

    expect(log).toContain("[Photo: /tmp/telegram-bot/p1.jpg]");
    expect(log).toContain("describe it");
    expect(log).toContain("the response");
    expect(log).toContain("message_type: PHOTO");
  });

  // Deriving the audit input from the prompt would write every uploaded document's full
  // body into a log that is unredacted under AUDIT_LOG_JSON. The two must stay separate
  // parameters.
  test("runPrompt logs its audit input, not the prompt it sent", async () => {
    const log = await runInSubprocess(
      `session.sessionId = "live";
       const sent = [];
       session.sendMessageStreaming = async (p) => { sent.push(p); return "ok"; };
       const { runPrompt } = await import("${import.meta.dir}/run-prompt.ts");
       await runPrompt(ctx, 7, "tester", 100, {
         prompt: "SECRET-DOCUMENT-BODY",
         titleSeed: "seed",
         auditAction: "DOCUMENT",
         auditInput: "[1 docs] a caption",
       });
       // Or the assertions below would pass on a helper that sent nothing at all.
       if (sent[0] !== "SECRET-DOCUMENT-BODY") process.exit(3);`
    );

    expect(log).toContain("[1 docs] a caption");
    expect(log).not.toContain("SECRET-DOCUMENT-BODY");
  });
});
