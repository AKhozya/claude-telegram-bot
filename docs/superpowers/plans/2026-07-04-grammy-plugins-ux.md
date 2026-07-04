# grammY Plugins + Bot API 10.1/9.4 UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt `@grammyjs/auto-retry` + `@grammyjs/files`, port the raw rich-message HTTP layer to typed grammy 1.44 calls, and add three low-cost Bot API UX affordances (reactions, colored buttons, per-op chat action + link-preview suppression).

**Architecture:** Two independently-shippable PRs. **PR A (resilience/cleanup)** wires the two plugins as `bot.api.config.use` transformers, deletes the hand-rolled 429 retry + raw `fetch` rich-message layer (grammy 1.44 types `sendRichMessage`/`editMessageText` with `rich_message`), and collapses 5 duplicated download blocks into `.download()`. **PR B (UX polish)** adds glanceable message reactions, colored inline buttons, and per-operation chat actions with link-preview suppression. Net effect of PR A is *fewer* lines.

**Tech Stack:** Bun, grammy ^1.44.0 (`@grammyjs/types@3.28.0`), `@grammyjs/auto-retry@2.0.2`, `@grammyjs/files@1.2.0`, `@grammyjs/runner`, TypeScript ^5.9.3, `bun test`.

## Global Constraints

- **New deps:** exactly `@grammyjs/auto-retry@2.0.2` and `@grammyjs/files@1.2.0`. No others.
- **auto-retry options are `maxRetryAttempts` and `maxDelaySeconds`.** There is NO `retryOnInternalServerErrors`; 5xx are retried by default (opt out via `rethrowInternalServerErrors: true` — we do NOT set it).
- **Reaction emoji MUST come from Telegram's fixed reaction set.** Use `👀` (received), `👌` (done), `👎` (failed). `✅` and `❌` are NOT in the set — they are a TypeScript compile error (`ctx.react`) and a runtime `REACTION_INVALID`. Never use them for reactions.
- **Preserve `TELEGRAM_API_ROOT` support.** The files plugin downloads from the configured api root; the rich-message port uses `ctx.api.*` which already respects it. Do not reintroduce a hardcoded `https://api.telegram.org`.
- **Button `style` values are `"danger" | "success" | "primary"`** (Bot API 9.4). Set via the raw button object (`InlineKeyboard.add({ text, callback_data, style })`), not the `.text()` shorthand.
- Gate every commit: `bun run typecheck` clean AND `bun test` green.
- Commit style: single line, no "Claude"/"Co-Authored-By"/"Generated with" trailers.
- Deploy (build image → bump homelab pin → Flux roll → live retest) happens after merge, outside this plan.

---

# PR A — Resilience & cleanup

### Task A1: Wire auto-retry + files plugins and flavor the Bot/Context types

**Files:**
- Modify: `package.json`, `bun.lock` (via `bun add`)
- Modify: `src/types.ts` (add `BotContext`, `BotApi`)
- Modify: `src/index.ts:7,30` (imports, `new Bot<...>()`, `config.use` wiring)
- Test: `src/plugins.test.ts` (new)

**Interfaces:**
- Produces: `BotContext = FileFlavor<Context>`, `BotApi = FileApiFlavor<Api>` — later tasks type the 5 download handlers as `BotContext` so `ctx.getFile()` returns a `.download()`-capable object.

- [ ] **Step 1: Add the two plugins**

```bash
bun add @grammyjs/auto-retry@2.0.2 @grammyjs/files@1.2.0
```

- [ ] **Step 2: Write the failing test**

`src/plugins.test.ts`:
```ts
import { test, expect } from "bun:test";
import { Bot, Api, Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles, type FileFlavor, type FileApiFlavor } from "@grammyjs/files";

test("bot constructs with auto-retry + files transformers wired", () => {
  type C = FileFlavor<Context>;
  type A = FileApiFlavor<Api>;
  const bot = new Bot<C, A>("123:FAKE");
  // Wiring must not throw at install time.
  expect(() => {
    bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
    bot.api.config.use(hydrateFiles(bot.token));
  }).not.toThrow();
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `bun test src/plugins.test.ts`
Expected: FAIL (test file references wiring that will compile once index/types updated; if it passes immediately that is fine — it is a smoke guard).

- [ ] **Step 4: Add flavor types**

In `src/types.ts`, add at top-level (after existing imports; add `import type { Context, Api } from "grammy";` and `import type { FileFlavor, FileApiFlavor } from "@grammyjs/files";`):
```ts
export type BotContext = FileFlavor<Context>;
export type BotApi = FileApiFlavor<Api>;
```

- [ ] **Step 5: Wire index.ts**

`src/index.ts` — change the import line and bot construction:
```ts
import { Bot, Api, Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { hydrateFiles, type FileFlavor, type FileApiFlavor } from "@grammyjs/files";
// ...
const bot = new Bot<FileFlavor<Context>, FileApiFlavor<Api>>(TELEGRAM_TOKEN);

// API transformers — cover EVERY api/ctx.api call (incl. streaming edits & raw).
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));
bot.api.config.use(hydrateFiles(bot.token));
```

- [ ] **Step 6: Typecheck and fix Context propagation**

Run: `bun run typecheck`
Expected: PASS. If any handler registered on the flavored `bot` errors on its `ctx: Context` param, widen that handler's param to `BotContext` (import from `../types`). Only the download handlers (Task A3) strictly need it; fix others only if typecheck demands.

- [ ] **Step 7: Run tests + commit**

Run: `bun test`
Expected: PASS.
```bash
git add package.json bun.lock src/types.ts src/index.ts src/plugins.test.ts
git commit -m "Add auto-retry + files plugins, flavor Bot/Context types"
```

---

### Task A2: Port raw rich-message layer to typed grammy calls; delete callTelegram

**Files:**
- Modify: `src/config.ts` (add `TELEGRAM_RICH_LIMIT`)
- Delete: `src/rich-message.ts`
- Modify: `src/handlers/streaming.ts` (imports; `sendRichWithFallback`, `editRichWithFallback` use `ctx.api.*`)
- Test: `src/handlers/streaming.test.ts` (extend)

**Interfaces:**
- Consumes: `ctx.api.sendRichMessage(chatId, InputRichMessage, other?)` and `ctx.api.editMessageText(chatId, msgId, string | InputRichMessage, other?)` (typed in grammy 1.44, `api.d.ts:167,1319`). `InputRichMessage = { markdown?: string; skip_entity_detection?: boolean; ... }`.
- Produces: `TELEGRAM_RICH_LIMIT` now exported from `config.ts`.

- [ ] **Step 1: Write the failing test**

Extend `src/handlers/streaming.test.ts` — assert the rich path calls the typed api with the mapped payload (mock `ctx.api`):
```ts
test("sendRichWithFallback uses typed ctx.api.sendRichMessage with markdown payload", async () => {
  const calls: any[] = [];
  const ctx: any = {
    chatId: 42,
    api: { sendRichMessage: (...a: any[]) => { calls.push(a); return { chat: { id: 42 }, message_id: 1 }; } },
    reply: () => { throw new Error("should not fall back"); },
  };
  const { createStatusCallback, StreamingState } = await import("./streaming");
  const cb = createStatusCallback(ctx, new StreamingState());
  await cb("text", "# Title\n\nbody", 0);
  expect(calls[0][0]).toBe(42);
  expect(calls[0][1]).toEqual({ markdown: "# Title\n\nbody", skip_entity_detection: true });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test src/handlers/streaming.test.ts`
Expected: FAIL — `sendRichWithFallback` still calls the raw `sendRichMessage(chatId, content)` from `rich-message.ts`.

- [ ] **Step 3: Move the limit constant to config**

In `src/config.ts`, add (near the other Telegram limits):
```ts
// Rich messages allow up to 32768 UTF-8 chars (plain messages cap at 4096).
export const TELEGRAM_RICH_LIMIT = 32768;
```

- [ ] **Step 4: Rewrite the two fallback helpers to use typed api**

In `src/handlers/streaming.ts`:
- Replace the import block `import { sendRichMessage, editRichMessage, TELEGRAM_RICH_LIMIT } from "../rich-message";` with `TELEGRAM_RICH_LIMIT` pulled from `../config` (merge into the existing config import).
- In `sendRichWithFallback`, replace `return await sendRichMessage(chatId, content);` with:
```ts
return await ctx.api.sendRichMessage(chatId, {
  markdown: content,
  skip_entity_detection: true,
});
```
- In `editRichWithFallback`, replace `await editRichMessage(msg.chat.id, msg.message_id, content); return;` with:
```ts
await ctx.api.editMessageText(msg.chat.id, msg.message_id, {
  markdown: content,
  skip_entity_detection: true,
});
return;
```

- [ ] **Step 5: Delete the raw layer**

```bash
git rm src/rich-message.ts
```
The hand-rolled 429 retry in `callTelegram` is now redundant — auto-retry (Task A1) covers 429 on `ctx.api.*`.

- [ ] **Step 6: Typecheck + test**

Run: `bun run typecheck && bun test src/handlers/streaming.test.ts`
Expected: PASS. `ctx.api.sendRichMessage` returns `Message.RichMessageMessage` (a `Message`), assignable to the `Message` stored in `StreamingState`.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/handlers/streaming.ts src/rich-message.ts src/handlers/streaming.test.ts
git commit -m "Port rich messages to typed grammy api, drop raw callTelegram + hand-rolled retry"
```

---

### Task A3: Collapse 5 download blocks into the files plugin `.download()`

**Files:**
- Modify: `src/handlers/photo.ts:25-46`, `src/handlers/voice.ts:64-74`, `src/handlers/document.ts:~64-73`, `src/handlers/audio.ts:~182-188`, `src/handlers/video.ts:~27-36`
- Test: `src/handlers/download.test.ts` (new)

**Interfaces:**
- Consumes: `BotContext` (Task A1). `ctx.getFile()` on a `FileFlavor<Context>` returns an object with `download(path?: string): Promise<string>`.

- [ ] **Step 1: Write the failing test**

`src/handlers/download.test.ts` — assert the download helper delegates to `.download(destPath)` and returns the path (mock `ctx.getFile`):
```ts
import { test, expect } from "bun:test";

test("download uses files-plugin .download(destPath) and returns it", async () => {
  const dest = "/tmp/telegram-bot/x.jpg";
  let got = "";
  const ctx: any = {
    message: { photo: [{ file_id: "a" }, { file_id: "b" }] },
    getFile: async () => ({ download: async (p: string) => { got = p; return p; } }),
  };
  // downloadPhoto is not exported today — export it for the test, or test the shared helper.
  const { downloadTelegramFile } = await import("./download");
  const path = await downloadTelegramFile(ctx, dest);
  expect(path).toBe(dest);
  expect(got).toBe(dest);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test src/handlers/download.test.ts`
Expected: FAIL — `./download` does not exist yet.

- [ ] **Step 3: Add a tiny shared helper**

Create `src/handlers/download.ts`:
```ts
import type { BotContext } from "../types";

/**
 * Download the current message's file to destPath via the files plugin.
 * Replaces the hand-built api.telegram.org URL + fetch + Bun.write pattern.
 */
export async function downloadTelegramFile(
  ctx: BotContext,
  destPath: string
): Promise<string> {
  const file = await ctx.getFile();
  return await file.download(destPath);
}
```

- [ ] **Step 4: Rewrite each handler's download block**

For each handler, type the param as `BotContext` and replace the `fetch(...arrayBuffer()) + Bun.write(...)` block with the helper. Example — `src/handlers/photo.ts` `downloadPhoto`:
```ts
import type { BotContext } from "../types";
import { downloadTelegramFile } from "./download";
// ...
async function downloadPhoto(ctx: BotContext): Promise<string> {
  const photos = ctx.message?.photo;
  if (!photos || photos.length === 0) throw new Error("No photo in message");
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  const photoPath = `${TEMP_DIR}/photo_${timestamp}_${random}.jpg`;
  return await downloadTelegramFile(ctx, photoPath);
}
```
Apply the same shape to voice (`voice_${ts}.ogg`), document, audio, video — keeping each handler's existing destination-path construction, deleting only the `fetch`/`arrayBuffer`/`Bun.write` lines and the hardcoded `https://api.telegram.org/file/bot...` URL. Widen each handler's public `ctx: Context` to `BotContext` where `ctx.getFile()` is called.

- [ ] **Step 5: Typecheck + test**

Run: `bun run typecheck && bun test`
Expected: PASS. No handler references `api.telegram.org` anymore:
```bash
! rg -q 'api\.telegram\.org/file' src/handlers/
```

- [ ] **Step 6: Commit**

```bash
git add src/handlers/download.ts src/handlers/photo.ts src/handlers/voice.ts src/handlers/document.ts src/handlers/audio.ts src/handlers/video.ts src/handlers/download.test.ts
git commit -m "Collapse 5 handler downloads into files-plugin .download()"
```

> **Runtime note for reviewer/implementer:** `.download()` uses `fetch` + Node `fs` streams, which Bun implements. There is no documented Bun caveat, but this is the one path not proven at runtime by the type-spike — verify a real photo/voice download works during the post-merge live retest.

---

# PR B — UX polish

### Task B1: Glanceable message reactions (👀 received → 👌 done / 👎 failed)

**Files:**
- Create: `src/handlers/reactions.ts`
- Modify: `src/handlers/text.ts`, `voice.ts`, `photo.ts`, `document.ts`, `audio.ts`, `video.ts` (call at start + end)
- Test: `src/handlers/reactions.test.ts` (new)

**Interfaces:**
- Produces: `markReceived(ctx)`, `markDone(ctx)`, `markFailed(ctx)` — each best-effort (swallow errors; a reaction failure must never break message handling).

- [ ] **Step 1: Write the failing test**

`src/handlers/reactions.test.ts`:
```ts
import { test, expect } from "bun:test";

test("markDone reacts 👌 on the user's message; failure is swallowed", async () => {
  const calls: any[] = [];
  const ctx: any = {
    chat: { id: 1 },
    msg: { message_id: 9 },
    api: { setMessageReaction: async (...a: any[]) => { calls.push(a); } },
  };
  const { markDone } = await import("./reactions");
  await markDone(ctx);
  expect(calls[0][0]).toBe(1);
  expect(calls[0][1]).toBe(9);
  expect(calls[0][2]).toEqual([{ type: "emoji", emoji: "👌" }]);

  const boom: any = { chat: { id: 1 }, msg: { message_id: 9 }, api: { setMessageReaction: async () => { throw new Error("x"); } } };
  await expect(markDone(boom)).resolves.toBeUndefined(); // swallowed
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test src/handlers/reactions.test.ts`
Expected: FAIL — `./reactions` does not exist.

- [ ] **Step 3: Implement the helper**

`src/handlers/reactions.ts`:
```ts
import type { BotContext } from "../types";

// Emoji MUST be from Telegram's fixed reaction set — ✅/❌ are invalid.
async function react(ctx: BotContext, emoji: "👀" | "👌" | "👎"): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.msg?.message_id;
  if (chatId === undefined || messageId === undefined) return;
  try {
    await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }]);
  } catch (err) {
    console.debug("setMessageReaction failed:", err); // best-effort, never throw
  }
}

export const markReceived = (ctx: BotContext) => react(ctx, "👀");
export const markDone = (ctx: BotContext) => react(ctx, "👌");
export const markFailed = (ctx: BotContext) => react(ctx, "👎");
```

- [ ] **Step 4: Call at handler boundaries**

In each of text/voice/photo/document/audio/video handlers: after the authorization check passes, `await markReceived(ctx);`. On the success path (after `session.sendMessageStreaming` resolves / audit log), `await markDone(ctx);`. In the `catch`, `await markFailed(ctx);`. Type the handler `ctx` as `BotContext`. Keep calls best-effort (they already can't throw). For the media-group photo path, mark received once per incoming message; mark done/failed in `processPhotos`' try/catch.

- [ ] **Step 5: Typecheck + test**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/reactions.ts src/handlers/reactions.test.ts src/handlers/text.ts src/handlers/voice.ts src/handlers/photo.ts src/handlers/document.ts src/handlers/audio.ts src/handlers/video.ts
git commit -m "Add glanceable message reactions (received/done/failed)"
```

---

### Task B2: Colored ask_user buttons (Bot API 9.4 `style`)

**Files:**
- Modify: `src/handlers/streaming.ts:29-45` (`createAskUserKeyboard`)
- Test: `src/handlers/streaming.test.ts` (extend)

**Interfaces:**
- Consumes: `InlineKeyboard.add({ text, callback_data, style })` where `style: "danger" | "success" | "primary"`.

- [ ] **Step 1: Write the failing test**

Add to `src/handlers/streaming.test.ts`:
```ts
test("ask_user keyboard applies a style to each button", async () => {
  const { createAskUserKeyboard } = await import("./streaming");
  const kb = createAskUserKeyboard("req1", ["Yes", "No"]);
  const rows = kb.inline_keyboard;
  expect(rows[0][0]).toMatchObject({ text: "Yes", style: "primary" });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test src/handlers/streaming.test.ts`
Expected: FAIL — buttons built via `.text()` have no `style`.

- [ ] **Step 3: Switch to `.add({...})` with style**

In `createAskUserKeyboard`, replace `keyboard.text(display, callbackData).row();` with:
```ts
keyboard.add({ text: display, callback_data: callbackData, style: "primary" }).row();
```
(One uniform `primary` style — the generic ask_user options carry no inherent danger/success semantics; a flat blue keeps taps deliberate without guessing intent.)

- [ ] **Step 4: Typecheck + test**

Run: `bun run typecheck && bun test src/handlers/streaming.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/streaming.ts src/handlers/streaming.test.ts
git commit -m "Color ask_user inline buttons via Bot API 9.4 style field"
```

---

### Task B3: Per-operation chat action + link-preview suppression

**Files:**
- Modify: `src/handlers/streaming.ts` (`checkPendingSendFileRequests` — action per file kind; disable link preview on Claude text replies)
- Test: `src/handlers/streaming.test.ts` (extend)

**Interfaces:**
- Consumes: `ctx.replyWithChatAction(action)` with the typed action union; `link_preview_options: { is_disabled: true }` on `ctx.reply`/`editMessageText`.

- [ ] **Step 1: Write the failing test**

Add to `src/handlers/streaming.test.ts` — assert plain-text fallback replies disable the link preview:
```ts
test("HTML fallback reply disables link preview", async () => {
  const opts: any[] = [];
  const ctx: any = {
    chatId: 7,
    api: { sendRichMessage: async () => { throw new Error("force fallback"); } },
    reply: async (_t: string, o: any) => { opts.push(o); return { chat: { id: 7 }, message_id: 1 }; },
  };
  const { createStatusCallback, StreamingState } = await import("./streaming");
  const cb = createStatusCallback(ctx, new StreamingState());
  await cb("text", "see https://example.com and more text over twenty chars", 0);
  expect(opts[0]).toMatchObject({ parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test src/handlers/streaming.test.ts`
Expected: FAIL — fallback `ctx.reply(formatted, { parse_mode: "HTML" })` has no `link_preview_options`.

- [ ] **Step 3: Disable link preview on Claude text replies**

In `sendRichWithFallback` and `sendChunkedMessages`, add `link_preview_options: { is_disabled: true }` to the `{ parse_mode: "HTML" }` reply options. (Claude output is often URL-dense; the preview card causes jitter during streaming edits and adds no value in a coding context.)

- [ ] **Step 4: Per-operation chat action when sending files**

In `checkPendingSendFileRequests`, before each send, emit the matching action instead of relying on the global typing indicator:
```ts
const action = VIDEO_EXTENSIONS.has(ext) ? "upload_video"
  : PHOTO_EXTENSIONS.has(ext) ? "upload_photo"
  : AUDIO_EXTENSIONS.has(ext) ? "upload_voice"
  : "upload_document";
await ctx.replyWithChatAction(action);
```

- [ ] **Step 5: Typecheck + test**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/streaming.ts src/handlers/streaming.test.ts
git commit -m "Per-op chat action for file sends, disable link preview on Claude replies"
```

---

## Self-review checklist (run after implementation, before final review)

- [ ] No `api.telegram.org/file` string remains in `src/handlers/`.
- [ ] `src/rich-message.ts` deleted; no dangling imports of it.
- [ ] No reaction uses `✅`/`❌`; only `👀`/`👌`/`👎`.
- [ ] auto-retry configured with `maxRetryAttempts`/`maxDelaySeconds` only.
- [ ] `bun run typecheck` clean and `bun test` green on the merged branch.
- [ ] Reviewer flags for live retest: files `.download()` on Bun; a real reaction round-trip; a rich-message send + streaming edit still render.
