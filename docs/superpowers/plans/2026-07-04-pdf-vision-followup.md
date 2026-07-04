# PDF Vision + Follow-up Fixes Implementation Plan

> **For agentic workers:** bounded ~6-file change. Right-sized: implement in-session, external review gates (codex plan review + codex/security diff review) preserved.

**Goal:** Make PDF handling work in-container (text PDFs + image/print PDFs via Claude vision), raise the file cap to 20 MB, and fold in two pre-existing bug fixes (`/retry` no-op, stuck-👀).

**Architecture:** Text-first, vision-fallback. `pdftotext` extracts the text layer; if a PDF has ~no text (scanned / Chrome print-to-PDF), render its pages to PNG with `pdftoppm` and route them through the existing photo-analysis flow (`processPhotos`) — Claude's multimodal Read *is* the OCR. No tesseract.

**Tech Stack:** Bun `Bun.$`, grammY, poppler-utils (`pdftotext` + `pdftoppm`) added to the Alpine image.

## Global Constraints

- Base image `oven/bun:1.3-alpine` (apk, musl). PDF tool must be apk-installable.
- No new npm deps for PDF (native CLI via `Bun.$`, matching existing `pdftotext` usage).
- Reaction emoji stay in Telegram's valid set: 👀 received / 👌 done / 👎 fail.
- `bun run typecheck` green before commit. Single-line commits, no Claude trailer.
- Telegram `getFile` ceiling ≈ 20 MB; >20 MB is out of scope (needs `TELEGRAM_API_ROOT` local server, already wired but not deployed).

---

### Task 1: Add PDF tooling to the container

**Files:**
- Modify: `Dockerfile:16`

**Change:** add `poppler-utils` to the apk line (provides `pdftotext`, `pdftoppm`, `pdfinfo`).

```dockerfile
RUN apk add --no-cache git openssh-client curl jq ca-certificates bash poppler-utils
```

**Verify:** after build, pod has `pdftotext -v` and `pdftocairo -v`. Tool choice confirmed by research: poppler-utils is the incumbent (already used for text), ~5 MiB total on Alpine vs ~50 MiB mupdf-tools / ~63 MiB ghostscript, and the narrowest attack surface for untrusted user PDFs (no PostScript interpreter, no embedded JS engine). `pdftocairo` ships in the same package and reuses poppler's cairo/lcms2 deps.

---

### Task 2: Raise file-size cap to 20 MB

**Files:**
- Modify: `src/handlers/document.ts:45` and the size-check reply at `:432`

```ts
// Max file size (20MB — Telegram getFile ceiling)
const MAX_FILE_SIZE = 20 * 1024 * 1024;
```
```ts
await ctx.reply("❌ File too large. Maximum size is 20MB.");
```

---

### Task 3: PDF vision fallback in document.ts

**Files:**
- Modify: `src/handlers/photo.ts` — export `processPhotos`
- Modify: `src/handlers/document.ts` — PDF classify/render helpers + route in single-doc path
- Test: `src/handlers/document.pdf.test.ts` (smoke: empty-text detection heuristic)

**Interfaces:**
- `photo.ts` produces: `export async function processPhotos(ctx, photoPaths: string[], caption, userId, username, chatId): Promise<void>` (already exists — just export it).

**Helpers (document.ts):**

```ts
const PDF_VISION_MAX_PAGES = 10;       // cap pages sent to vision (cost + Telegram)
const PDF_TEXT_MIN_CHARS_PER_PAGE = 20; // < this/page of non-whitespace ⇒ image PDF

/**
 * meaningful-char check, extracted so it's unit-testable without a real PDF.
 * pdftotext emits one \f between pages, so page count ≈ \f count + 1 — no pdfinfo call.
 */
export function pdfHasUsableText(rawText: string): boolean {
  const pages = (rawText.match(/\f/g)?.length ?? 0) + 1;
  const meaningful = rawText.replace(/\f/g, "").trim();
  return meaningful.length >= PDF_TEXT_MIN_CHARS_PER_PAGE * pages;
}

/**
 * Extract a PDF's text layer, or null if it has ~no usable text
 * (scanned / print-to-PDF) — caller should render pages to images instead.
 */
async function extractPdfText(filePath: string): Promise<string | null> {
  const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
  const text = result.text();
  return pdfHasUsableText(text) ? text : null;
}

/**
 * Render the first PDF_VISION_MAX_PAGES pages to PNGs in TEMP_DIR.
 * Returns sorted PNG paths; [] on failure. pdftocairo writes base-1.png, base-2.png…
 * (research picked pdftocairo over pdftoppm: same package, better color via cairo+lcms2).
 */
async function renderPdfToImages(filePath: string): Promise<string[]> {
  const stem = `pdfpage_${Date.now()}`;
  const base = `${TEMP_DIR}/${stem}`;
  try {
    await Bun.$`pdftocairo -png -r 150 -l ${PDF_VISION_MAX_PAGES} ${filePath} ${base}`.quiet();
  } catch (error) {
    console.error("PDF render failed:", error);
    return [];
  }
  const names = await Array.fromAsync(
    new Bun.Glob(`${stem}*.png`).scan({ cwd: TEMP_DIR })
  );
  names.sort();
  return names.map((n) => `${TEMP_DIR}/${n}`);
}
```

Note: `pdftocairo` zero-pads page numbers once a doc has ≥10 pages (`page-01.png`); the `sort()` on the glob keeps order correct either way since the cap is 10.

**Route (single-doc path, replacing the `extractText` call around `:531`):**

```ts
try {
  if (isPdf) {
    const text = await extractPdfText(docPath);
    if (text !== null) {
      await processDocuments(ctx, [{ path: docPath, name: fileName, content: text }],
        ctx.message?.caption, userId, username, chatId);
    } else {
      const images = await renderPdfToImages(docPath);
      if (images.length === 0) {
        await markFailed(ctx);
        await ctx.reply("❌ Could not read this PDF (no text layer and rendering failed).");
        return;
      }
      const cap = ctx.message?.caption;
      const pdfCaption = cap
        ? `[PDF: ${fileName}] ${cap}`
        : `[PDF: ${fileName}] Read these page images and analyze the document.`;
      await processPhotos(ctx, images, pdfCaption, userId, username, chatId);
    }
  } else {
    const content = await extractText(docPath, doc.mime_type);
    await processDocuments(ctx, [{ path: docPath, name: fileName, content }],
      ctx.message?.caption, userId, username, chatId);
  }
} catch (error) {
  console.error("Failed to extract document:", error);
  await markFailed(ctx);
  await ctx.reply(`❌ Failed to process document: ${String(error).slice(0, 100)}`);
}
```

**`extractText` PDF branch (used by media-group / multi-doc path):** replace the failure string with an honest note so image PDFs in an album degrade gracefully instead of feeding Claude garbage:

```ts
if (mimeType === "application/pdf" || extension === ".pdf") {
  const text = await extractPdfText(filePath);
  if (text !== null) return text;
  return `[Image-based PDF — no text layer. Send it on its own for page-image analysis.]`;
}
```

**Smoke test:** assert `extractPdfText`'s heuristic — a string of only `\f` and spaces classifies as image (null path), real text passes. (Pure-function extraction of the meaningful-char check so it's testable without a real PDF.)

**Cleanup note (ponytail):** rendered PNGs stay in `TEMP_DIR` like downloaded photos do (no unlink in `processPhotos`); pod `/tmp` is ephemeral. Matches existing photo behavior — no new cleanup added.

**Comment fix:** update the `brew install poppler` comments (`document.ts:5`, `:85`) to note apk in-container.

---

### Task 4: Fix `/retry` no-op

**Files:**
- Modify: `src/handlers/commands.ts:294-302` (`handleRetry`)

**Bug:** `fakeCtx = { ...ctx, message: {...} }` spreads only own-enumerable props; grammY's `Context` exposes `chat`/`from`/`msg`/`reply` as **prototype getters**, which the spread drops. `handleText(fakeCtx)` then hits its `!chatId` guard and silently returns. Broken since commit 7498057.

**Fix:** don't rebuild the context. Mutate a real Context so the prototype chain and getters survive, or re-dispatch through grammY. Minimal correct fix — override the message text on the live update object via `Object.create` preserving the prototype:

```ts
const fakeCtx: BotContext = Object.assign(
  Object.create(Object.getPrototypeOf(ctx)),
  ctx,
  { update: { ...ctx.update, message: { ...ctx.message, text: message } } }
);
await handleText(fakeCtx);
```

`ctx.message` / `ctx.chat` / `ctx.from` are getters reading `ctx.update.message.*`; overriding `update.message.text` is what actually changes the retried text. `Object.create(getPrototypeOf(ctx))` keeps the getters live. Verify: `/retry` after a text message re-runs the query (not a silent no-op).

---

### Task 5: Fix stuck-👀 (early returns after markReceived)

**Rule:** once `markReceived` (👀) fires, every terminal path must end 👌 (`markDone`) or 👎 (`markFailed`). Add `await markFailed(ctx);` before each leaking early return. Root-cause fix for `processAudioFile` covers both its callers.

**Sites:**
- `text.ts`: L41 (empty-after-interrupt), L51 (rate-limited)
- `voice.ts`: L45 (not-configured), L55 (rate-limited), L83 (transcript-failed)
- `audio.ts`: `handleAudio` L179 (rate-limited); `processAudioFile` L64 (not-configured), L81 (transcript-failed)
- `document.ts`: L432 (too-large), audio-doc rate-limited (~L455), L480 (unsupported), L503 (archive rate-limited), L528 (single-doc rate-limited)

Each: insert `await markFailed(ctx);` immediately before the `return;`.

---

### Verify (whole branch)
- `bun run typecheck` green
- smoke test passes
- codex static diff review + ecc security-review (PDF path handles user files via `Bun.$` — check shell-arg safety; `Bun.$` interpolation is auto-escaped, confirm no template breaks)
- deploy: homelab GHA build → bump 3 pins → Flux → live retest (text PDF, image/print PDF, 10–20 MB file, `/retry`, reaction lifecycle)
