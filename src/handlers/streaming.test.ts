import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { isPathAllowed } = await import("../security");
const {
  createStatusCallback,
  StreamingState,
  createAskUserKeyboard,
  splitMarkdownForTelegram,
  checkPendingAskUserRequests,
  checkPendingSendFileRequests,
  fileAgeMs,
  reapIfOlderThan,
} = await import("./streaming");
const { TEMP_RETENTION_MS, IPC_PENDING_TTL_MS, TELEGRAM_CAPTION_LIMIT } =
  await import("../config");
const { convertMarkdownToHtml } = await import("../formatting");

describe("send-file path gate (isPathAllowed)", () => {
  test("rejects paths outside ALLOWED_PATHS and temp", () => {
    expect(isPathAllowed("/etc/passwd")).toBe(false);
    expect(isPathAllowed("/Users/other/secret.key")).toBe(false);
  });
  test("accepts bot temp dir", () => {
    expect(isPathAllowed("/tmp/telegram-bot/out.png")).toBe(true);
  });
  test("rejects traversal", () => {
    expect(isPathAllowed("/tmp/telegram-bot/../../etc/passwd")).toBe(false);
  });
  test("rejects /tmp symlink escaping to disallowed target", () => {
    const dir = "/tmp/telegram-bot-test";
    mkdirSync(dir, { recursive: true });
    const link = `${dir}/evil-link`;
    try { rmSync(link, { force: true }); } catch {}
    symlinkSync("/etc/passwd", link);
    try {
      expect(isPathAllowed(link)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rich message send via typed grammy api", () => {
  test("sendRichWithFallback uses typed ctx.api.sendRichMessage with markdown payload", async () => {
    const calls: any[] = [];
    const ctx: any = {
      chatId: 42,
      api: { sendRichMessage: (...a: any[]) => { calls.push(a); return { chat: { id: 42 }, message_id: 1 }; } },
      reply: () => { throw new Error("should not fall back"); },
    };
    const cb = createStatusCallback(ctx, new StreamingState());
    await cb("text", "# Title\n\nbody", 0);
    expect(calls[0][0]).toBe(42);
    expect(calls[0][1]).toEqual({ markdown: "# Title\n\nbody", skip_entity_detection: true });
  });

  test("editRichWithFallback edits via typed ctx.api.editMessageText with markdown payload", async () => {
    const editCalls: any[] = [];
    const ctx: any = {
      chatId: 42,
      api: {
        sendRichMessage: () => ({ chat: { id: 42 }, message_id: 7 }),
        editMessageText: (...a: any[]) => { editCalls.push(a); },
      },
      reply: () => { throw new Error("should not fall back"); },
    };
    const cb = createStatusCallback(ctx, new StreamingState());
    await cb("text", "initial", 0); // creates the segment message via sendRichMessage
    await cb("segment_end", "final content", 0); // edits it -> editRichWithFallback
    expect(editCalls[0][0]).toBe(42);
    expect(editCalls[0][1]).toBe(7);
    expect(editCalls[0][2]).toEqual({ markdown: "final content", skip_entity_detection: true });
  });
});

describe("link preview suppression", () => {
  test("HTML fallback reply disables link preview", async () => {
    const opts: any[] = [];
    const ctx: any = {
      chatId: 7,
      api: { sendRichMessage: async () => { throw new Error("force fallback"); } },
      reply: async (_t: string, o: any) => { opts.push(o); return { chat: { id: 7 }, message_id: 1 }; },
    };
    const cb = createStatusCallback(ctx, new StreamingState());
    await cb("text", "see https://example.com and more text over twenty chars", 0);
    expect(opts[0]).toMatchObject({ parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
});

describe("ask_user keyboard styling", () => {
  test("ask_user keyboard applies a style to each button", async () => {
    const kb = createAskUserKeyboard("req1", ["Yes", "No"]);
    const rows = kb.inline_keyboard;
    expect(rows[0]![0]).toMatchObject({ text: "Yes", style: "primary" });
  });
});

describe("splitMarkdownForTelegram", () => {
  // Balanced-tag check: every <x> in a chunk must have a matching </x>. A chunk
  // sliced mid-tag is what made Telegram reject it and fall back to plain text.
  const tagsBalanced = (html: string) => {
    const stack: string[] = [];
    for (const m of html.matchAll(/<(\/?)(\w+)[^>]*>/g)) {
      if (m[1]) { if (stack.pop() !== m[2]) return false; }
      else stack.push(m[2]!);
    }
    return stack.length === 0;
  };

  test("every chunk converts to balanced HTML, unlike slicing converted HTML", () => {
    const md = Array.from({ length: 200 }, (_, i) => `**bold line ${i}** and _italic ${i}_`).join("\n");
    const chunks = splitMarkdownForTelegram(md, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(tagsBalanced(convertMarkdownToHtml(c))).toBe(true);

    // The old approach for comparison: slice the converted HTML at fixed offsets.
    const html = convertMarkdownToHtml(md);
    const sliced = Array.from({ length: Math.ceil(html.length / 200) }, (_, i) =>
      html.slice(i * 200, (i + 1) * 200)
    );
    expect(sliced.some((c) => !tagsBalanced(c))).toBe(true);
  });

  test("no chunk exceeds the limit", () => {
    const md = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    for (const c of splitMarkdownForTelegram(md, 50)) expect(c.length).toBeLessThanOrEqual(50);
  });

  test("a fence spanning a boundary is closed and reopened", () => {
    const md = "```ts\n" + Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n```";
    const chunks = splitMarkdownForTelegram(md, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect((c.match(/```/g) ?? []).length % 2).toBe(0); // balanced fences
      expect(tagsBalanced(convertMarkdownToHtml(c))).toBe(true);
    }
    expect(chunks[1]!.startsWith("```ts")).toBe(true); // reopened with its language
  });

  test("a single line longer than the limit is still cut", () => {
    const chunks = splitMarkdownForTelegram("x".repeat(250), 100);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("")).toBe("x".repeat(250));
  });

  test("content short enough is returned as one chunk, unchanged", () => {
    expect(splitMarkdownForTelegram("hello\nworld", 4000)).toEqual(["hello\nworld"]);
  });
});

// Regressions from the 2026-07-29 static review. The limit checks above only exercised
// unfenced text, where no synthetic closer is ever appended.
describe("splitMarkdownForTelegram limit accounting inside fences", () => {
  const LIMIT = 4000;

  // Iterating [] runs zero assertions, so every size check below would pass vacuously on
  // empty output.
  // Size and marker assertions alone pass on output that lost every payload character,
  // so anything asserting a split also counts what survived.
  const countChar = (chunks: string[], ch: string) =>
    chunks.join("").split(ch).length - 1;

  const expectWithinLimit = (chunks: string[], limit = LIMIT) => {
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0); // an empty chunk is not sendable
      expect(c.length).toBeLessThanOrEqual(limit);
    }
  };

  test("the synthetic closer is counted, not added after the limit check", () => {
    // Reported: emitted 4004. cur reached exactly the limit, then "\n```" went on top.
    expectWithinLimit(splitMarkdownForTelegram("```ts\n" + "x".repeat(3994), LIMIT));
  });

  test("a reopened fence plus a full-size piece stays within the limit", () => {
    // Emitted 4010: after a flush, cur was reseeded with the fence and a whole
    // limit-sized piece appended without rechecking.
    const chunks = splitMarkdownForTelegram("```ts\n" + "x".repeat(4001), LIMIT);
    expectWithinLimit(chunks);
    expect(countChar(chunks, "x")).toBe(4001);
  });

  // The two cases above are single points. Walking the boundary is what catches the
  // off-by-one that a fixed pair of inputs happens to straddle.
  test("no chunk exceeds the limit across the whole fence boundary neighbourhood", () => {
    const bad: string[] = [];
    for (const fence of ["```", "```ts", "```typescript"]) {
      for (let n = LIMIT - 20; n <= LIMIT + 20; n++) {
        const chunks = splitMarkdownForTelegram(`${fence}\n` + "x".repeat(n), LIMIT);
        if (chunks.length === 0) bad.push(`${fence} n=${n} returned nothing`);
        for (const c of chunks) {
          if (c.length > LIMIT) bad.push(`${fence} n=${n} len=${c.length}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test("a fence opening near the end of a full chunk does not overflow it", () => {
    for (let pad = LIMIT - 20; pad <= LIMIT; pad++) {
      expectWithinLimit(
        splitMarkdownForTelegram("y".repeat(pad) + "\n```ts\ncode", LIMIT)
      );
    }
  });

  test("a trailing unmatched fence is preserved, not silently dropped", () => {
    // Reported: the `cur !== openFence` guard treated a real trailing fence as an empty
    // reopened one and dropped it.
    const chunks = splitMarkdownForTelegram("x".repeat(LIMIT) + "\n```", LIMIT);
    expectWithinLimit(chunks);
    expect(chunks.join("")).toContain("```");
    expect(countChar(chunks, "x")).toBe(LIMIT); // ["```"] alone would pass the above
  });

  // The neighbourhood sweep above only ever built `fence\ncontent`, so the fence LINE was
  // always short. These are the shapes it could not reach.
  test("a fence marker sharing its line with content does not overflow", () => {
    // Marker and payload on one line: an empty `cur` skipped the budget check. Emitted 4001.
    for (const n of [3990, 3994, 3996, 4000, 4100]) {
      expectWithinLimit(splitMarkdownForTelegram("```" + "x".repeat(n), LIMIT));
    }
  });

  test("a limit too small to hold the fence wrapper still respects the limit", () => {
    // maxPiece floors at 1, so the reopen + closer cannot fit. Emitted 9 at limit 8.
    for (let limit = 1; limit <= 12; limit++) {
      expectWithinLimit(splitMarkdownForTelegram("```\nx", limit), limit);
    }
  });

  test("a fractional limit is floored, not overshot by integer slicing", () => {
    // Slice offsets step by whole characters, so 2.5 used to yield a 3-character chunk.
    expectWithinLimit(splitMarkdownForTelegram("abcdef", 2.5), 2);
    expectWithinLimit(splitMarkdownForTelegram("```ts\nabcdef", 7.9), 7);
  });

  test("leading blank lines survive, like interior and trailing ones", () => {
    // `cur === ""` doubled as "nothing accumulated yet", swallowing leading blanks.
    expect(splitMarkdownForTelegram("\n\nb", 100)).toEqual(["\n\nb"]);
    expect(splitMarkdownForTelegram("a\n\nb", 100)).toEqual(["a\n\nb"]);
    expect(splitMarkdownForTelegram("a\n\n", 100)).toEqual(["a\n\n"]);
  });

  test("input with nothing but whitespace yields no chunk to send", () => {
    // Telegram rejects empty message text, so [] is correct — nothing here to lose.
    // `line !== ""` let "   " and a CRLF "\r" through as content.
    expect(splitMarkdownForTelegram("\n\n", 10)).toEqual([]);
    expect(splitMarkdownForTelegram("", 10)).toEqual([]);
    expect(splitMarkdownForTelegram("\n\n\n\n", 4000)).toEqual([]);
    expect(splitMarkdownForTelegram("   \n\t\n  ", 4000)).toEqual([]);
    expect(splitMarkdownForTelegram("\r\n", 4000)).toEqual([]);
  });

  test("a whitespace-only tail does not flush a scaffold-only chunk", () => {
    // "```\nxx\n   " used to emit "```\n  \n```" and "```\n \n```" after the split.
    for (const c of splitMarkdownForTelegram("```\nxx\n   ", 10)) {
      expect(c.replace(/`/g, "").trim()).not.toBe("");
    }
  });

  test("indentation split across chunks is kept, not trimmed away as blank", () => {
    // At limit 16 maxPiece is 8, so "<16 spaces>x" splits into two space-only pieces and
    // an "x". Judging each piece alone discarded one of the space pieces.
    const chunks = splitMarkdownForTelegram("```\n" + " ".repeat(16) + "x", 16);
    expectWithinLimit(chunks, 16);
    const spaces = chunks.join("").split(" ").length - 1;
    expect(spaces).toBe(16);
    expect(chunks.join("")).toContain("x");
  });

  test("a lone fence marker is passed through, neither dropped nor expanded", () => {
    // Dropping it loses a line the user sent; closing it makes an empty code block.
    expect(splitMarkdownForTelegram("```", 16)).toEqual(["```"]);
    expect(splitMarkdownForTelegram("```x\n```", 16)).toEqual(["```x\n```"]);
  });

  // A long fence info string pushed the wrapper overhead past the limit, flooring
  // maxPiece at 1: every character became its own chunk carrying a full copy of the
  // fence. A 235-char input produced 66 chunks / 5198 chars.
  test("a fence too long to wrap does not explode the output", () => {
    // "z" so the count below cannot pick up a stray letter from the prose line.
    const md = "```" + "z".repeat(200) + "\nhello world this is the payload";
    for (const limit of [4000, 300, 150, 84]) {
      const chunks = splitMarkdownForTelegram(md, limit);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      expect(total).toBeLessThan(md.length * 2);
      expectWithinLimit(chunks, limit);
      // Shrinking the output is the opposite failure and passes the bound above.
      expect(countChar(chunks, "z")).toBe(200);
      expect(chunks.join("")).toContain("payload");
    }
  });

  test("no chunk is whitespace only", () => {
    // Telegram rejects a message with no text. Splitting an indented fence marker used to
    // emit its 12-space indentation as its own chunk.
    for (const c of splitMarkdownForTelegram("123456789. item\n            ```\nx", 16)) {
      expect(c.trim()).not.toBe("");
    }
  });

  test("a blank line inside a fence survives at realistic limits", () => {
    // A message boundary does not stand in for it: inside a YAML literal or a diff the
    // blank line is data. A chunk with no payload is held back and its blanks carried
    // into the next one rather than dropped.
    const yaml = "```\na: |-\n  first!\n\n  second\n```";
    const lost: number[] = [];
    for (let limit = 12; limit <= 200; limit++) {
      if (!splitMarkdownForTelegram(yaml, limit).join("\n").includes("\n\n")) {
        lost.push(limit);
      }
    }
    // Only where the block barely fits at all; never near the 4000 used in production.
    expect(lost.every((l) => l < 20)).toBe(true);
    expect(splitMarkdownForTelegram(yaml, 4000).join("\n")).toContain("first!\n\n  second");
  });

  test("a closing fence is not budgeted as if it needed wrapping", () => {
    // The closer was split using the OPEN-fence overhead before being recognised as a
    // closer, turning the balanced "```\n```" into ["```\n``", "```\n`"].
    expect(splitMarkdownForTelegram("```\n```", 10)).toEqual(["```\n```"]);
    for (let limit = 6; limit <= 24; limit++) {
      expectWithinLimit(splitMarkdownForTelegram("```\n```", limit), limit);
    }
  });

  test("a long language tag is passed through, not given a synthetic closer", () => {
    // A 21-char tag is valid; bounding "is this a marker" by a fixed character count
    // treated it as payload. The bound is limit-relative and matches the reopen rule.
    expect(splitMarkdownForTelegram("```abcdefghijklmnopqrstu", 100)).toEqual([
      "```abcdefghijklmnopqrstu",
    ]);
  });

  test("a closer that does not fit is omitted, not sliced through", () => {
    // At limit 7 no fenced block fits, and emit used to cut the chunk mid-delimiter,
    // producing fragments like "``".
    for (let limit = 4; limit <= 12; limit++) {
      const chunks = splitMarkdownForTelegram("```\nx", limit);
      expectWithinLimit(chunks, limit);
      expect(countChar(chunks, "x")).toBe(1);
    }
  });

  test("a chunk of only a reopened fence and blank lines is not emitted", () => {
    // An unclosed fence plus trailing blanks used to flush a tail chunk of "```\n\n```".
    // Asserted as a property across limits: the exact split varies with the limit.
    const scaffoldOnly: string[] = [];
    for (const limit of [10, 20, 30, 50, 80]) {
      for (const md of [
        "```\nxx\n",
        "```ts\n" + "a".repeat(40) + "\n\n",
        "```\n" + "b".repeat(60) + "\n  \n",
      ]) {
        for (const c of splitMarkdownForTelegram(md, limit)) {
          // A multi-line chunk with no text between its fences is a wrapper we built. A
          // single-line "```" is an input line and stays.
          if (c.includes("\n") && c.replace(/`/g, "").trim() === "") {
            scaffoldOnly.push(`limit=${limit} chunk=${JSON.stringify(c)}`);
          }
        }
      }
    }
    expect(scaffoldOnly).toEqual([]);
  });

  // Deciding emptiness by inspecting chunk text reads a "```" line carrying the payload
  // as a bare marker and drops the whole message.
  test("a fence line carrying its own payload is never mistaken for scaffolding", () => {
    const chunks = splitMarkdownForTelegram("```" + "x".repeat(3994), LIMIT);
    expectWithinLimit(chunks);
    // The info string IS the payload, so the line is split and wrapped, not kept whole.
    // Count characters rather than assert a layout.
    expect((chunks.join("").match(/x/g) ?? []).length).toBe(3994);
  });

  test("fenced content survives the split, ignoring synthetic fence markers", () => {
    const body = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const chunks = splitMarkdownForTelegram("```ts\n" + body + "\n```", 500);
    const recovered = chunks
      .join("\n")
      .split("\n")
      .filter((l) => !l.startsWith("```"))
      .join("\n");
    expect(recovered).toBe(body);
  });
});

// The chat ids in both blocks below avoid any real chat.
describe("MCP request files: the callback_data budget", () => {
  test("a whole-UUID request id still fits Telegram's 64-byte callback_data limit", () => {
    // This limit is why the id used to be truncated to 8 hex chars, which let two requests
    // collide — and `callback.ts` resolves a tap by id alone, so the older prompt would be
    // answered with the newer one's option. Ten options is the schema's maximum.
    const keyboard = createAskUserKeyboard(
      crypto.randomUUID(),
      Array.from({ length: 10 }, (_, i) => `option ${i}`)
    );
    const datas = keyboard.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data ?? "");

    expect(datas).toHaveLength(10);
    for (const d of datas) {
      expect(d.startsWith("askuser:")).toBe(true);
      expect(Buffer.byteLength(d, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("MCP request files: reaping the dead ones", () => {
  const CHAT = 99000000003;
  const OTHER_CHAT = 99000000004;
  const written: string[] = [];

  // A directory of its own, never the `/tmp` root the pollers default to. The reap deletes
  // by age across every chat and runs before the chat filter, so aiming these tests at the
  // directory the MCP servers write to would delete the queued prompts of a bot running on
  // this host. The glob carries no `**`, so a scratch dir under `/tmp` stays isolated.
  const IPC = mkdtempSync(join(tmpdir(), "ctb-ipc-test-"));
  afterAll(() => rmSync(IPC, { recursive: true, force: true }));

  // Files a send-file request points AT, which unlike the request files themselves go
  // through `isPathAllowed`. Rooted in /tmp rather than beside IPC above: on macOS
  // `tmpdir()` is /var/folders, `canonicalize` resolves that to /private/var/folders, and
  // TEMP_PATHS lists /var/folders/ without the /private prefix it lists for /tmp.
  const PAYLOADS = mkdtempSync("/tmp/ctb-payload-test-");
  afterAll(() => rmSync(PAYLOADS, { recursive: true, force: true }));

  /** Write a request file and backdate it, since the reap goes by mtime. */
  async function put(
    prefix: "ask-user" | "send-file",
    data: Record<string, unknown> | string,
    ageMs: number
  ): Promise<string> {
    const path = `${IPC}/${prefix}-${crypto.randomUUID()}.json`;
    await Bun.write(path, typeof data === "string" ? data : JSON.stringify(data));
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    written.push(path);
    return path;
  }

  function stubCtx() {
    const replies: unknown[][] = [];
    return {
      replies,
      ctx: {
        reply: async (...args: unknown[]) => { replies.push(args); return { message_id: 1 }; },
        replyWithChatAction: async () => {},
        replyWithDocument: async () => {},
      } as never,
    };
  }

  afterEach(() => {
    for (const p of written.splice(0)) rmSync(p, { force: true });
  });

  test("a pending request older than the poll window is deleted, not delivered", async () => {
    const path = await put(
      "ask-user",
      { request_id: "x", question: "an old question", options: ["a", "b"],
        status: "pending", chat_id: String(CHAT) },
      IPC_PENDING_TTL_MS + 60_000
    );
    const { ctx, replies } = stubCtx();

    expect(await checkPendingAskUserRequests(ctx, CHAT, IPC)).toBe(false);
    expect(replies).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
  });

  test("a fresh pending request is still delivered", async () => {
    const path = await put(
      "ask-user",
      { request_id: "y", question: "a live question", options: ["a", "b"],
        status: "pending", chat_id: String(CHAT) },
      0
    );
    const { ctx, replies } = stubCtx();

    expect(await checkPendingAskUserRequests(ctx, CHAT, IPC)).toBe(true);
    expect(replies).toHaveLength(1);
    expect(String(replies[0]![0])).toContain("a live question");
    // Delivered, so it survives for the tap — with its status flipped.
    expect(await Bun.file(path).json()).toMatchObject({ status: "sent" });
  });

  test("a sent request keeps its buttons alive until the retention window closes", async () => {
    const live = await put(
      "ask-user",
      { request_id: "z", question: "answered", options: ["a"], status: "sent", chat_id: String(CHAT) },
      TEMP_RETENTION_MS / 2
    );
    const expired = await put(
      "ask-user",
      { request_id: "w", question: "ancient", options: ["a"], status: "sent", chat_id: String(CHAT) },
      TEMP_RETENTION_MS + 60_000
    );
    const { ctx } = stubCtx();

    await checkPendingAskUserRequests(ctx, CHAT, IPC);

    expect(existsSync(live)).toBe(true);
    expect(existsSync(expired)).toBe(false);
  });

  test("a stale request for another chat is reaped too, not skipped forever", async () => {
    // The chat filter `continue`s without deleting, so reaping has to come first or a
    // request from a chat this poll is not serving accumulates for good.
    const path = await put(
      "ask-user",
      { request_id: "v", question: "other chat", options: ["a", "b"],
        status: "pending", chat_id: String(OTHER_CHAT) },
      IPC_PENDING_TTL_MS + 60_000
    );
    const { ctx } = stubCtx();

    await checkPendingAskUserRequests(ctx, CHAT, IPC);
    expect(existsSync(path)).toBe(false);
  });

  // An age the bot cannot measure must not read as "old enough to delete". A stat can fail
  // for reasons unrelated to staleness — EIO, or EMFILE once the process is out of
  // descriptors, which is precisely when requests are in flight. Infinity here would have
  // deleted a live request before the parse, status, chat and path checks ever ran.
  test("an unmeasurable age is NaN, which reaps nothing", async () => {
    const real = await put("ask-user", { status: "sent" }, 0);
    expect(fileAgeMs(real)).toBeGreaterThanOrEqual(0);
    expect(fileAgeMs(real)).toBeLessThan(60_000);

    const age = fileAgeMs(`${IPC}/ask-user-no-such-file-4e91c2.json`);
    expect(Number.isNaN(age)).toBe(true);
    // The comparison the pollers actually make, in both directions.
    expect(age > TEMP_RETENTION_MS).toBe(false);
    expect(age > IPC_PENDING_TTL_MS).toBe(false);
  });

  // The guard the pollers depend on, driven directly: neither a failing stat nor a
  // misconfigured retention can be produced through them. Deletion is the failure mode
  // here, so both non-finite inputs must reap nothing — and `ageMs <= ttlMs` alone reads
  // false for a NaN age, which would delete the file whose age could not be measured.
  test.each([
    ["an unmeasurable age", NaN, 0, false],
    ["a non-finite threshold", 10, NaN, false],
    ["an infinite age", Infinity, 0, false],
    ["an age past the threshold", 10, 5, true],
    ["an age inside the threshold", 5, 10, false],
    ["an age exactly at the threshold", 10, 10, false],
  ] as const)("reapIfOlderThan with %s deletes: %p", async (_name, age, ttl, reaped) => {
    const path = await put("ask-user", { status: "sent" }, 0);
    expect(reapIfOlderThan(path, age, ttl)).toBe(reaped);
    expect(existsSync(path)).toBe(!reaped);
  });

  // A write cut short by a crash leaves something JSON.parse throws on. That file used to
  // be re-read and re-logged on every poll for the life of the host, because the reap sat
  // after the parse — which is why the retention check now runs before it, in both loops.
  test.each([
    ["ask-user", checkPendingAskUserRequests],
    ["send-file", checkPendingSendFileRequests],
  ] as const)("an unparseable %s file is reaped, not re-read forever", async (prefix, poll) => {
    const path = await put(prefix, "{", TEMP_RETENTION_MS + 60_000);
    const { ctx } = stubCtx();

    expect(await poll(ctx, CHAT, IPC)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  /**
   * Deliver one send-file request carrying `caption`, and return what reached Telegram.
   *
   * `caption` is typed `unknown` because these files are JSON from a world-writable
   * directory, not values the MCP server's schema has vouched for.
   *
   * The `isPathAllowed` assertion is a diagnostic, not a guard: a payload outside the
   * allowlist makes the poller drop the request and return false, so the delivery
   * assertion below would fail anyway — but it would point at the clipping rather than at
   * the fixture path.
   */
  async function deliverCaption(caption: unknown): Promise<string | undefined> {
    const target = `${PAYLOADS}/payload.txt`;
    await Bun.write(target, "x");
    expect(isPathAllowed(target)).toBe(true);

    let sent: string | undefined;
    let calls = 0;
    const ctx = {
      reply: async () => ({ message_id: 1 }),
      replyWithChatAction: async () => {},
      replyWithDocument: async (_file: unknown, opts: { caption?: string }) => {
        calls++;
        sent = opts.caption;
      },
    } as never;

    await put(
      "send-file",
      { request_id: "c", file_path: target, caption,
        status: "pending", chat_id: String(CHAT) },
      0
    );
    expect(await checkPendingSendFileRequests(ctx, CHAT, IPC)).toBe(true);
    expect(calls).toBe(1);
    return sent;
  }

  /** Any code unit left without its pair — what slicing UTF-16 mid-character produces. */
  const hasLoneSurrogate = (s: string) =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  // Telegram rejects the whole send over the limit, so an unclipped caption costs the
  // file, not just the caption. The at-the-limit rows are the control: clipping one
  // character early would be a silent change no over-limit assertion could see.
  //
  // The astral rows are the unit test. tdlib counts code points (`utf8_length`), so 1024
  // emoji are legal at 2048 JS `.length` — measuring in code units would clip them.
  test.each([
    ["ascii under the limit", "a", TELEGRAM_CAPTION_LIMIT - 1],
    ["ascii exactly at the limit", "a", TELEGRAM_CAPTION_LIMIT],
    ["astral exactly at the limit", "😀", TELEGRAM_CAPTION_LIMIT],
  ] as const)("a caption %s is sent unchanged", async (_name, char, count) => {
    const whole = char.repeat(count);
    expect(await deliverCaption(whole)).toBe(whole);
  });

  test.each([
    ["ascii", "a"],
    ["astral", "😀"],
  ] as const)(
    "an %s caption over the limit is clipped to it, not dropped with the file",
    async (_name, char) => {
      const sent = await deliverCaption(char.repeat(TELEGRAM_CAPTION_LIMIT * 2));

      expect(Array.from(sent!)).toHaveLength(TELEGRAM_CAPTION_LIMIT);
      expect(sent?.endsWith("...")).toBe(true);
      expect(sent?.slice(0, -3)).toBe(char.repeat(TELEGRAM_CAPTION_LIMIT - 3));
      // A UTF-16 slice would cut the emoji at the boundary in half.
      expect(hasLoneSurrogate(sent!)).toBe(false);
    }
  );

  // `data.caption || undefined` predates the clipping and survives it. Pinned because the
  // clipping rewrote the expression: the MCP server writes "" for an omitted caption, and
  // turning that into `caption: ""` would be a silent change of what grammY is sent.
  test("an empty caption reaches Telegram as no caption at all", async () => {
    expect(await deliverCaption("")).toBeUndefined();
  });

  // These files are world-writable, so the schema that vouches for `caption` is not on
  // this side of the channel. Reading `.length` off a truthy non-string and slicing it
  // throws past the send handler, stranding the request to fail again on every poll
  // until the pending window reaps it.
  test.each([
    ["an object wearing a length", { length: TELEGRAM_CAPTION_LIMIT * 2 }],
    ["a number", 42],
    ["an array of strings", ["a", "b"]],
  ] as const)("%s is delivered as no caption, not a throw", async (_name, caption) => {
    expect(await deliverCaption(caption)).toBeUndefined();
  });

  test("a stale send-file request is deleted rather than sent late", async () => {
    const path = await put(
      "send-file",
      { request_id: "u", file_path: "/tmp/telegram-bot/whatever.txt", caption: "",
        status: "pending", chat_id: String(CHAT) },
      IPC_PENDING_TTL_MS + 60_000
    );
    const { ctx, replies } = stubCtx();

    expect(await checkPendingSendFileRequests(ctx, CHAT, IPC)).toBe(false);
    expect(replies).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
  });
});
