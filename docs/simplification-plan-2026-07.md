# Simplification plan — 2026-07-30

Baseline: HEAD `7b600c1`, clean tree. `bun run typecheck` exit 0. `bun test` 228 pass / 0 fail / 808 expect() / 16 files.
Source: 41 TS files, 5,695 code lines, 982 comment lines (measured, not the 766 tokei reports — tokei undercounts block-comment continuation).

Eight parallel audits: core `src/`, `src/handlers/`, comments (x2), architecture, security, tests+MCP+infra, docs.

## Where this stands — 2026-07-30

Branch `simplify-2026-07`, off `7b600c1`. Run `git log --oneline main..HEAD` — that, not this block, is the authority on what landed.

| Batch | State |
|---|---|
| 0, 0b docs · 1 free deletes · 2 docker · 3 bugs · 4 dedup helpers · 5 local shrinks · 6 tests · 7 comments | **Done.** Codex clean on each. All batches complete |

Gate now reads **283 pass / 911 expect()**, up from the 228/808 baseline — Batch 3 added two audit-log tests, Batch 4 eighteen, Batch 5 thirty-four, Batch 7 one. It must never fall. Batch 6 held it at exactly 282/906: it converted tests and added none, so an increase would have hidden a lost case as readily as a decrease would have exposed one.

**Still uncovered, and the reason this is not finished:** the Telegram wire. Nothing in-process reaches it, so a manual pass at deploy is the only check. See the end of this document for what that pass has to cover.

## Constraints agreed before the audit

| Constraint | Value |
|---|---|
| Behavior | Behavior-preserving only. Anything observable gets its own opt-in decision. |
| New deps | May be proposed, never applied without a yes. |
| Scope | `src/`, tests, MCP servers, build/infra, docs. |
| Deliverable | This plan, then applied cuts in batches, typecheck + test green per batch. |

## Assumptions and confidence

| # | Claim | Tier | Basis |
|---|---|---|---|
| A1 | `node:net` `BlockList` reproduces every branch of the hand-rolled SSRF classifier | ✅ | Probed Bun 1.3.14: 8 v4 + 9 v6 cases incl. `::ffff:7f00:1`, `::ffff:a9fe:a9fe`, `fe90::1`, `febf::1` in / `fec0::1` out |
| A2 | No import cycle between `utils.ts` and `session.ts` | ✅ | `session.ts` imports config/formatting/sandbox/security/types/handlers-streaming; none reaches `utils.ts` |
| A3 | `handlers/index.ts` barrel has exactly one consumer | ✅ | `rg` → `src/index.ts:30` only |
| A4 | `.env.example` documents `CLAUDE_CLI_PATH`; code reads `CLAUDE_CODE_PATH` | ✅ | `rg` across tree: one definition site, `session.ts:282` |
| A5 | `README.md:195` advertises an intent-classification security layer that does not exist | ✅ | `rg -ni 'intent\|classif' src/` → one unrelated hit (`sandbox.ts:52` "intentionally") |
| A6 | `video.ts` catch passes `[]` — tool messages leak on failure | ✅ | `state` declared line ~109 inside `try`; catch at :128 |
| A7 | `callback.ts` never calls `startProcessing()` | ✅ | `rg` over the file: zero hits |
| A8 | `.*.bun-build` missing from `.dockerignore`; 2x 63 MB present now | ✅ | `ls` + `grep` — in `.gitignore:46` only |
| A9 | `Bun.escapeHTML` emits `&#x27;` for `'` | ✅ | Probed. Telegram HTML-mode acceptance of numeric entities NOT confirmed |
| A10 | Line-saving numbers per finding | ⚠ | Agent estimates. Measured per batch at apply time, not trusted up front. |
| A11 | `test.each` conversion preserves failure-output readability | 🟡 | Single agent measured 177→80 lines; not independently re-measured |

**Validate before build:** A9 (probe a live apostrophe through Telegram HTML mode) and A11 (convert one describe block, eyeball a deliberately failing row) — both gate optional items only.

## What the audit actually found

This is not an over-abstracted codebase. No registries, no interface-with-one-impl worth killing, one justified factory. Two independent agents converged on the same verdict: the cost is **the same handler tail copy-pasted six times, which has already drifted into two live bugs**.

The docs are a different story — not bloated, **wrong**. 22 stale claims, three of them security-material.

---

## Batch 0 — Docs and facts

Zero runtime risk. Highest ratio in the plan.

| Item | File | Action |
|---|---|---|
| `CLAUDE_CLI_PATH` documented, `CLAUDE_CODE_PATH` read | `.env.example:51` | Rename. Setting the documented name silently does nothing. |
| "Intent classification — AI filter blocks dangerous requests" listed as security layer 2 | `README.md:195` | Delete. Never existed. |
| "Text messages with intent filtering" | `AGENTS.md:38` | Delete the clause. |
| "System prompt is the **primary** protection layer" | `SECURITY.md:126` | Inverted under `bypassPermissions`. The PreToolUse hook (`session.ts:255`) is the enforcing control; the prompt is advisory. `README.md:201` already says this correctly — the two files disagree. |
| Defense-in-depth list omits the OS Bash sandbox entirely | `SECURITY.md:33-143` | Add `sandbox.ts` layer + `BASH_SANDBOX_ENABLED`. A reader deploying on SECURITY.md alone never learns it exists. |
| Denylist presented with no caveat | `SECURITY.md:85-115` | Carry over README's "best-effort, trivially bypassable by construction". |
| `~/.claude` missing from documented default paths | `SECURITY.md:66-72` | Five entries in `config.ts:80`, four documented. |
| `/private/tmp/` missing from temp paths | `SECURITY.md:82` | `TEMP_PATHS` has 3 (`config.ts:199`). |
| `cp mcp-config.ts mcp-config.local.ts` | `README.md:123` | Backwards, and the destination is never read. Correct: `cp mcp-config.example.ts mcp-config.ts`. |
| Clone URL carries `?tab=readme-ov-file`; `cd` into wrong dir | `README.md:37-38` | Fix both. |
| BotFather `/setcommands` list | `README.md:80-89` | Bot overwrites it on every boot (`index.ts:116`). Registered set: new, stop, status, resume, retry, restart — no `/start`. |
| `THINKING_TRIGGER_KEYWORDS` | `README.md:30` | Not read anywhere. Real names: `THINKING_KEYWORDS`, `THINKING_DEEP_KEYWORDS`. Defaults are `think,pensa,ragiona` — "reason" triggers nothing. |
| "~3,300 lines TypeScript" | `AGENTS.md:16` | 5,695. Understates by 45%. |
| Key Modules omits `sandbox.ts` | `AGENTS.md:24-32` | The newest and largest security surface. |
| Handler list: 8 of 14 | `AGENTS.md:34-44` | Missing auth, media-group, trigger, download, reactions, index. |
| Runtime files: 3 of 6 | `AGENTS.md:64-68` | Missing restart.json, ctb-sandbox, ask-user-*.json. |
| Env vars: 4 of 20 | `AGENTS.md:55-60` | Document the rest or drop the pretence of a list. |
| `bun run test` missing from commands | `AGENTS.md:7-12` | CI gates on it. |
| `/retry` missing from command table | `README.md:133-142` | 7 registered, 6 documented. |
| ~17 lines of prose bloat + `wether` typo x2 | README, SECURITY, AGENTS, guide | Apply the listed rewrites. |

**Rejected from the docs findings:** AGENTS.md:28 "Agent SDK V2" vs `session.ts:320` "// Use V1 query() API". These name different things — package generation vs API surface within the package. Not a contradiction. Drop the version marker rather than flip it to V1.

### Batch 0b — Prose trims (itemised 2026-07-30, awaiting approval)

Batch 0 shipped the factual corrections and skipped the plan's un-itemised "~17 lines of prose bloat". Itemised here. Real total is ~10 lines, not 17 — the original estimate counted the author's first-person narrative, which is register, not bloat.

**Accepted — DELETE.** Each restates a heading, a code block, or a sentence already on the page.

| # | Site | Text | Why |
|---|---|---|---|
| 1 | `SECURITY.md:3` | "This document describes the security architecture of the Claude Telegram Bot." | Restates the H1 above it. |
| 2 | `SECURITY.md:20` (3rd sentence) | "Instead of per-action prompts, we rely on defense-in-depth with multiple security layers described below." | The `## Defense in Depth` heading two sections down is the same statement. Keep sentences 1-2. |
| 3 | `SECURITY.md:35` | "The bot implements multiple layers of security:" | Restates the heading directly above. |
| 4 | `SECURITY.md:148` | "Each path argument is checked against `ALLOWED_PATHS` before execution." | The code block immediately above demonstrates exactly this, four times, with per-line comments. |
| 5 | `README.md:62` (final sentence) | "This uses your Claude Code subscription which is much more cost-effective for heavy usage." | Duplicates the table's "High usage, cost-effective" *and* the API-cost note at `:70`. Keep `:70`. |

Rows 4 and 5 were both wrong, caught by the Codex review of the applied batch and reinstated in shortened form:

- Row 4 — all four examples are single-target. `security.ts:207-248`'s rm parser loops every non-flag argument (`:211` skips anything starting with `-`) and rejects the whole command on the first out-of-bounds one; the code block never shows that. Replaced with one line stating it.
- Row 5 — the table row says "cost-effective" and `:70` says the API is per-token, but neither states that CLI auth bills against the **subscription**. That is the mechanism a reader picks between. Replaced with one clause.

**Accepted — TRIM.**

| # | Site | Cut | Keep |
|---|---|---|---|
| 6 | `README.md:190` | "for details on how permissions work and what protections are in place" | The link. A doc titled "Security Model" needs no gloss. |
| 7 | `AGENTS.md:36` | "Each message type has a dedicated async handler:" | "Message-type handlers:" |

**Considered and rejected.**

| Site | Why it stays |
|---|---|
| `README.md:152` "The bot will start automatically on login and restart if it crashes." | Reads as restating "LaunchAgent", but a reader who doesn't know launchd learns the behaviour here. |
| `README.md:189` security warning | Hedges and intensifiers are load-bearing in a warning. |

**Protected — do not sweep.**

- `README.md:12-20`, the "Claude Code as a Personal Assistant" section — the author's first-person pitch. Voice, not bloat.
- **All of `docs/personal-assistant-guide.md`.** First-person narrative throughout, and lines 75, 304-306 and 355 are quoted `CLAUDE.md` prompt content — editing those changes a worked example, not prose. The `wether`→`whether` fix already applied is the whole of the intended change to this file.

## Batch 1 — Free deletes

Compiler-checked, mechanical.

- `src/handlers/index.ts` — barrel, 15 re-exports, one consumer, two names (`StreamingState`, `createStatusCallback`) nobody imports through it. Delete; `src/index.ts` imports the files directly. Also removes a step from the pattern documented in `AGENTS.md:74`.
- `src/handlers/media.ts` — 13-line file wrapping one `ctx.reply`. Inline at `index.ts:83-84` via `bot.on(["message:voice","message:audio"], …)`.
- `src/session.ts:68-78` `getTextFromMessage()` — zero callers.
- `src/utils.ts:7` `import type { Chat }` — unused.
- `src/security.ts:7` `normalize` — imported, never called (named only in a comment).
- `src/formatting.ts:197` `TodoWrite: "📋"` — unreachable, the substring loop hits `Write` first. Probe: `formatToolStatus("TodoWrite", {})` returns `📝 TodoWrite` today.
- `src/utils.ts:85-87` `TypingController` — named interface for `{ stop: () => void }`, one impl; `startTempReaper` 12 lines below writes the identical shape inline.
- `src/types.ts` — move `RateLimitBucket` (only `security.ts`) and `PendingMediaGroup` (only `media-group.ts`) next to their single consumers.
- `mcp-config.example.ts:17-21` — re-declares the `McpStdioConfig | McpHttpConfig` union instead of importing `McpServerConfig` from `src/types.ts`.
- `tsconfig.json:8-9,24-27` — `jsx`, `allowJs` (zero jsx/tsx/js files outside node_modules), and three explicitly-`false` flags that are already tsc defaults. Verified: trimmed config typechecks the identical 41-file set, exit 0.
- `package.json:3` `"module": "src/index.ts"` — `bun init` boilerplate on a `private: true` app.
- `src/handlers/media-group.ts:150-154` — returns `{addToGroup, processGroup, pendingGroups}`; nothing outside the factory touches the latter two, and `addToGroup`'s documented `@returns false when rate-limited` is discarded at both call sites. Narrow to `{addToGroup}`, return `void`, drop the `@returns`.

## Batch 2 — Image size

- `Dockerfile:63` `RUN chown -R akhozya:akhozya /app` after `COPY` — copies up every file into a new layer, ~343 MB of duplicated `node_modules`. Replace with `COPY --chown=` on lines 56-57; move the `adduser` RUN above them.
- `.dockerignore` — add `.*.bun-build`. Two 63 MB leftovers are in the repo root right now and `COPY . .` ships all of it. Already in `.gitignore:46`.
- `Dockerfile:6-7` — fold the `ARG BUILD_TS` cache-buster `RUN echo` into the `bun update` line; line 51 already uses that idiom. One layer.

**Measured on apply (2026-07-30, linux/arm64, `oven/bun:1.3-alpine`).** The ~469 MB
estimate understated it — it assumed `node_modules` ≈343 MB; the real layer is 617 MB.

| Layer | Before | After |
|---|---|---|
| `RUN chown -R akhozya:akhozya /app` | 744 MB | gone (8.19 kB non-recursive dir chown) |
| `COPY . .` | 127 MB | 905 kB |
| Layer sum | 2390 MB | 1520 MB |

**−870 MB** for three lines of text — 744 from the duplicated recursive chown, 126 from
the two `.bun-build` leftovers. `docker image ls` reports 3.27 GB → 2.12 GB.

Equivalence checked in the built image, not assumed: uid 1000, `/app`, `/app/node_modules`
and `/app/src` all `akhozya:akhozya`, `/app` writable, `import("grammy")` resolves,
`.bun-build` absent, node and pdftotext present.

**Re-measured 2026-07-30 at HEAD `1dce85b`**, both sides rebuilt from scratch on linux/arm64
— the after side from the working tree, the before side from a detached worktree at
`7b600c1` with the two `.bun-build` artifacts copied in, since they are untracked and a
clean checkout does not carry them. Every figure above reproduced: `docker image ls`
3.27 GB → 2.12 GB, layer sum 2390 MB → 1520 MB, the recursive chown 744 MB → 8.19 kB, and
`node_modules` 617 MB on both sides. The two 63 MB `.bun-build` files were confirmed present
inside the before image and absent from the after one. Ownership and the `import("grammy")`
resolve are identical across both images, so the per-`COPY --chown` form is equivalent to
the recursive chown it replaced.

One figure drifted, as expected: `COPY . .` reads **934 kB** now against the 905 kB recorded
at apply time — Batches 3-7 added test files to the build context. Nothing else moved, and
`Dockerfile`/`.dockerignore` have not changed since `0cdb2f9`.

## Batch 3 — Bugs and one security fix

**Behavior-changing by intent.** Each needs a yes.

1. **`video.ts:109`** — `const state = new StreamingState()` sits inside the `try`, so the catch at :135 passes `[]` to `handleProcessingError`. Tool-status messages are never deleted when a video query fails. Hoist the declaration above the `try`. (`markFailed` is unaffected — `handleProcessingError` calls it.)
2. **`callback.ts:102`** — no `session.startProcessing()`, so `isRunning` is false between the button tap and the query. `/status` and `/stop` misreport for button-initiated queries. This is the same drift `session.ts:170-178` already documents. Add the call + `finally { stopProcessing() }`.
3. **`utils.ts:20-45` audit log mode** — `fs.appendFile` with no mode, umask 022, nothing chmods it → `0644`. Under `AUDIT_LOG_JSON=true` the JSON branch logs the full message and full response **unredacted** (the 500-char truncation is only in the human-readable branch). A user pasting a credential into Telegram writes it world-readable to `/tmp/claude-telegram-audit.log`. The bot's own sandbox blocks *Claude* from reading it — that does nothing for another OS user. Fix: `mode: 0o600` plus an explicit chmod on first create, mirroring `sandbox.ts:22`'s `0o700`.

Note on 2: folding `callback.ts`'s catch into `handleProcessingError` also **adds a 👎 reaction** it does not currently post. Do that knowingly or leave the catch inline.

**Applied 2026-07-30.** Four items: the two above plus `processArchive` (plan-review finding 2, same leak class) and the audit-log mode.

- `processArchive` got the minimal fix — `state` hoisted, a delete loop added — **not** a fold into `handleProcessingError`. Its error text and `markFailed` are unchanged, so Batch 4 item 5's two-site scope still holds.
- **`callback.ts`'s catch stays inline.** The plan permitted either; inline wins on a fact the plan did not record: `callback.ts` calls neither `markDone` nor `markFailed`, so folding would post 👎 on failure while success still posts nothing. Asymmetric reactions are a worse outcome than the missing one.
- `handleResumeCallback`, the next function down in `callback.ts`, runs a query with no `startProcessing()` either — the same drift. **Not applied**: outside the four approved items. Raised instead.
- Audit log: the chmod runs **before** the append (`mode` is ignored on an existing file, so appending first writes one record into the 0644 file), and the once-per-process guard is a memoized promise, not a boolean — a boolean lets a concurrent second writer skip the pending chmod. Both were Codex findings against the first draft.
- **Decided 2026-07-30: stay fail-open.** When `chmod` fails with anything but `ENOENT`, log it once and append anyway. `chmod` needs ownership while append needs only write permission, so the gap opens on group/other/ACL write on a file someone else owns — and on an **append-only log** (`chattr +a`), where `chmod` is refused and append is exactly what the operator intended. Failing closed would silently break that hardened setup to defend a case where whoever owns the file can already read it. The audit trail is itself a security control; dropping records to protect their confidentiality trades the property the log exists for.

  The real fix for secrets in the log is **redaction**, not the file mode — `AUDIT_LOG_JSON=true` writes message and response untruncated, and 0600 only decides who can read them. Still out of scope here.

## Batch 4 — Five helpers for duplicated handler code

*(Was headed "six copies of one handler tail". Misleading: six is the rate-limit-block count in item 2. The `runPrompt` tail in item 5 has two confirmed sites.)*

Ordered smallest-blast-radius first so each lands green before the next.

**Locate by grep, not by line number.** Every item below lands in files the item before it just moved, so any line number written here is wrong by the time it is read. The anchors given are stable strings. Line numbers still in Batch 5 are from the original audit against `7b600c1` and have already drifted through Batches 1 and 3 — re-derive those too.

0. **`handleResumeCallback` `startProcessing()`** — carried over from Batch 3, approved 2026-07-30. It runs a query with no `startProcessing()`, exactly the drift Batch 3 fixed one function up in `handleCallback`. Behavior-changing like the rest of Batch 3 — `/status` and `/stop` start reporting the resume recap as running.

   **Placement is not free** (plan review, 2026-07-30 — the first draft of this item said it was). "After the guards" is too early: `editMessageText` and the bare `await ctx.answerCallbackQuery(…)` still run before the `try`, and `answerCallbackQuery` is unguarded. Starting processing before it means a throw there skips `stopProcessing()` and strands `isRunning` true for the process lifetime. Put the call **after `answerCallbackQuery`, immediately before `const typing = …`** — the same position Batch 3 used in `handleCallback` — or widen the `try/finally` to cover every await after it. The narrower claim does hold: no `isRunning` interrupt check precedes this function's query, unlike `handleCallback`.

1. **`session.setTitleIfNew(seed)`** — the `if (!session.isActive) { …len>50 ? slice(0,47)+"..." : raw }` block, copied 5x. `grep -n "if (!session.isActive)" src/handlers/*.ts` — `text.ts`, `photo.ts`, `video.ts`, and **two** in `document.ts`. `conversationTitle` and `isActive` are both session state written from **five sites across four files**. 4-line method, five one-line call sites. ~25 → ~9. Plan review confirms all five are identical apart from the seed string.
2. **`rateLimitOrReply(ctx, userId, username): Promise<boolean>`** — the same 9 lines (check → `auditLogRateLimit` → `⏳ Rate limited` → `markFailed` → return), 6x. `grep -n auditLogRateLimit src/handlers/*.ts` — `text.ts`, `photo.ts`, `video.ts`, `media-group.ts`, and **two** in `document.ts`. Not middleware — albums are charged once per album (see the `mediaGroupId` branch in `photo.ts`). ~-32.

   Plan review confirms the six blocks themselves are interchangeable: same check, same `auditLogRateLimit`, same exact reply text, same `markFailed`, same bare return from a `Promise<void>` caller. A boolean helper must still make the caller return, and each call must stay inside its existing guard.

   **The "free hoist" in `document.ts` was wrong — do not do it** (plan review, 2026-07-30). The two copies are not parallel branches of one split. The first sits inside `if (isArchiveFile) { … return; }`; the second inside `if (!mediaGroupId)`. Hoisting above them would charge **every album item individually**, breaking the once-per-album rule this same item relies on. A `downloadDocument` failure path also `return`s before both, so a hoisted check would rate-limit requests that currently return first. Keep both calls where they are.
3. **`stopAndSettle()`** in `commands.ts` — `handleNew:38-44` re-inlines `handleStop:53-60`'s stop → `Bun.sleep(100)` → `clearStopRequested` dance. That 100 ms + clear pairing is exactly the coupling `session.ts:170-178` records as already dropped once by a hand-copy. ~-6.
   The duplication itself is confirmed: both handlers run the same `isRunning` → `stop()` → successful-result → `sleep(100)` → `clearStopRequested` sequence.

   **The stated reason for not folding the sleep into `ClaudeSession.stop()` was false** (plan review, 2026-07-30). That test exercises `session.interruptForNewMessage()`, not `handleNew`/`handleStop`, and it stubs `s.stop` — so moving a sleep into the real `stop()` would not fail it. It guards mark/stop/clear **ordering**, nothing about the sleep. The decision to leave `stop()` alone may still be right, but it needs a real reason: check `stop()`'s other callers first and confirm none of them would be wrong with a 100 ms settle baked in. Decide at apply time on that evidence, not on this test.
4. **`state.deleteToolMessages(ctx)`** on `StreamingState` — the 7-line swallow-and-delete loop. `grep -n "for (const toolMsg of" src/handlers/*.ts`. It already owns the array. ~-19.

   **Five sites now, not the four the audit found** — Batch 3 added one to `document.ts`'s `processArchive` catch. `media-group.ts`'s copy is inside `handleProcessingError` and takes `toolMessages` as a parameter, not `state`; converting it means changing that signature or passing the state in. Decide which at apply time.

   Per plan-review finding 3, the unified version **logs** (`console.debug("Failed to delete tool message:", …)`). `text.ts` swallows silently today and gains that line. Debug-level, no user-visible change, recorded rather than absorbed.
5. **`runPrompt(ctx, {...})`** — the full tail (`startProcessing` → title → typing → `StreamingState` + `createStatusCallback` → `sendMessageStreaming` → `auditLog` → `markDone` → catch → `finally`).

   **CORRECTED after plan review.** The original claim — "three byte-identical sites: `processPhotos`, `processDocuments`, the `processArchive` tail" — was wrong. The success paths match; the catch blocks do not. `processPhotos` and `processDocuments` catch with `handleProcessingError(ctx, error, state.toolMessages)`. `processArchive` still catches differently: `console.error` → `markFailed` → delete `statusMsg` → its own `❌ Failed to process archive: …` text. (Batch 3 added a tool-message loop there, so the *leak* is gone, but the error text and shape still differ — folding it would change what the user reads.)

   Confirmed scope is **two** sites: `processPhotos` and `processDocuments`.

   **CRITICAL, from the 2026-07-30 plan review — the two "matching" success paths do not match.** `photo.ts` audits the **full constructed prompt** (`auditLog(userId, username, "PHOTO", prompt, response)`); `document.ts` audits a summary (`` `[${documents.length} docs] ${caption || ""}` ``) precisely because the prompt holds entire document bodies. A helper that derives its audit input from `prompt` would start writing **whole documents into the audit log** — which Batch 3 established is written unredacted under `AUDIT_LOG_JSON`. The helper therefore needs `prompt`, `titleSeed`, `auditAction` and `auditInput` as four independent parameters, never derived from one another.

   Second constraint from the same finding: prompt construction currently happens after `startProcessing()` but **outside** the `try`. Precomputing it for the helper, or moving it inside, shifts the exception boundary. Preserve the existing order and boundary — or skip this extraction. Of the five items this is the one with the least margin; dropping it costs the least too.

   **Do not fold in `callback.ts`** — it calls no `markFailed`. (Decision 1 approved its `isRunning` fix, not folding its catch; Batch 3 as applied left the catch inline.)

   **`video.ts` — keep it out.** The audit said hold it until Batch 3 landed, because folding it earlier would have baked the `[]` bug into the helper. Batch 3 has landed and its catch now matches the two confirmed sites — but the plan review looked at the whole tail and the evidence favours exclusion: it edits a status message before sending and deletes it after `markDone`, its catch adds a video-specific log and deletes that status before calling `handleProcessingError`, and its audit input is `caption || "[video]"` rather than the prompt. Folding it needs lifecycle hooks or special-casing that risk reordering operations. Reopen only if the helper stays simple while preserving every one of those steps.

### Batch 4 — Applied 2026-07-30

All six items landed. The nine files they were extracted from go +97 / −218; the two new files (`handlers/rate-limit.ts`, `handlers/run-prompt.ts`) add 99. **−22 source lines net** — the payoff here is the removed drift surface, not the line count. Gate 230 pass / 812 expect() → **248 / 848**.

- **Item 3's decision was re-justified on evidence, and the answer did not change.** `stop()` has exactly three callers — `interruptForNewMessage`, `handleNew`, `handleStop` — and all three want the settle, so folding it in *would* have worked: `interruptForNewMessage` guards on `isRunning` first, which is the same condition as the commands' `if (result)`. Declined anyway, for a reason the old text did not have: the settle exists for what the caller does **next** (`/new` kills the session, `/stop` clears the way for the next message), not for the stop itself. `stop()` stays a pure cancel request, and `interruptForNewMessage` keeps the variant that also marks the interrupt — which `/stop` must not do, or the preempted query stops showing "🛑 Query stopped.".
- **Item 4** changed `handleProcessingError`'s third parameter from `toolMessages: Message[]` to `state: StreamingState`. Only two non-test callers exist (`video.ts`, `run-prompt.ts`); both pass `state`. `text.ts` gains the `console.debug` line it never emitted, as decided.
- **Item 5 shipped with the four independent parameters.** `photo.ts` passes `auditInput: prompt`; `document.ts` passes `` `[${documents.length} docs] ${caption || ""}` ``, byte-identical to before. `video.ts` and `callback.ts` stayed out.
- **Item 5's one reordering, checked and accepted.** `startProcessing()` used to run before the prompt was built; the caller now builds the prompt first. Unobservable: prompt construction is pure synchronous string building with no await, so nothing can interleave in the gap.

**Coverage added** — five files that had none now have some. `text.test.ts`, `media-group.test.ts`, `callback.test.ts`, `prompt-audit.test.ts`, plus four tests appended to `commands.test.ts`.

- Every behavior-preserving test was written against the **unrefactored** code and watched pass before the edit. Item 0's test was the exception and the proof: it failed first, because the missing `startProcessing()` was a real bug.
- `prompt-audit.test.ts` spawns subprocesses. `AUDIT_LOG_PATH` binds at config module-eval and `bun test` shares one registry, so an in-process call would append test data to the real `/tmp/claude-telegram-audit.log`.
- **Gap, stated not papered over:** `processDocuments` is not exported, so its audit input cannot be pinned against the pre-refactor code. What exists instead is a direct `runPrompt` guard — send `SECRET-DOCUMENT-BODY`, audit `[1 docs] a caption`, assert the log holds the second and not the first, with an exit-3 check that the prompt reached `sendMessageStreaming` so the negative assertion cannot pass vacuously.

**Codex, three rounds.** Round 1 (source): no findings, SHIP. Round 2 (tests): three defects — a helper restoring prototype methods by assigning them back instead of deleting; two tests recording only *successful* deletions, so skipping the failing id produced the same array as attempting all three; and a throw-path test that a no-op handler would have passed. All three verified against source, fixed, and confirmed closed in round 3.

Two claims Codex could not check from the diff were closed by direct grep instead of taken on faith: every `handleProcessingError` caller passes `state`, and `startProcessing()` sits after `answerCallbackQuery` (`callback.ts` :172 → :180 → try :185 → finally :198).

**Still needs the live-bot pass:** text, photo, album, video, button, `/new`, `/stop`, and `/resume`'s recap. Item 0 changes what `/status` and `/stop` report during a resume recap, and items 1–5 touch every message path — none of which any in-process test reaches.

## Batch 5 — Local shrinks

Plan-reviewed 2026-07-30 against re-derived anchors — every line number in the original
table had drifted through Batches 1, 3 and 4. **Seven of twenty rows survived.** The
review's job here was mostly subtraction: most rows traded a real behavior risk for one to
nine lines.

Two rows an earlier review had already resolved as dropped — `csvEnv` and the `callback.ts`
regex routing rewrite — were **still sitting in this table**, contradicting their own
recorded resolutions further down this document. Deleted here.

### Applied

| File | Cut | Replacement |
|---|---|---|
| `session.ts` | two near-identical "sleep 200, then 3 attempts x 100 ms" pollers | one `pollFor(check)` + two call lines |
| `formatting.ts` | 8-element `imageExtensions` + `.some(endsWith)` | one `IMAGE_EXTENSIONS` regex |
| `utils.ts` | `await import("fs/promises")` re-executed per call, at two sites | one top-level `node:fs/promises` import |
| `utils.ts` | `checkInterrupt`'s lazy-import cycle guard + structural type + module cache | moved into `text.ts`, its only caller, which already imports `session` |
| `media-group.ts` | the `setTimeout(processGroup, …)` written once per branch | one `arm()` closure. `clearTimeout` stays explicit in the debounce branch — folding it in hides which branch is a restart |
| `streaming.ts` | keyboard object literal in a loop | `keyboard.text(display, data).primary().row()` |
| `document.ts` | `isArchive` + `getArchiveExtension` over the same list | one `find(endsWith)`; order-independent since `"x.tar.gz".endsWith(".tar")` is false |

Plus one behavior fix, not a shrink, surfaced by a row that was dropped — see below.

### Dropped, with the reason

| Row | Why |
|---|---|
| `config.ts` `csvEnv` | Already resolved dropped; the three splitters are not parallel. Row deleted |
| `callback.ts` regex routing | Already resolved dropped; loses two specific error toasts and touches the no-cut #19 charset guard. Row deleted |
| `session.ts` `Bun.file().size` probe | Not equivalent for every path the config allows: on a FIFO the probe returns 0 and short-circuits where `readFileSync` would block on a writer. Three lines is not worth a hang |
| `session.ts` `getThinkingLevel` twice | The proposed mechanism is itself broken — the adaptive branch returns `{type:"adaptive"}` with no `budgetTokens`, so the derived label reads `"undefined"`. And there is nothing to save: it is a pure scan of two keyword arrays |
| `formatting.ts` verb table | `Read` is not symmetric with `Write`/`Edit` — it carries the image early-return. Lifting that back out leaves the same line count plus an indirection |
| `security.ts` / `sandbox.ts` `CREDENTIAL_DIRS` | Two different matching models — basename equality plus `under()` containment, vs. glob strings for the SDK — over two non-identical sets. A shared constant needs a mode flag to serve both. Security layer: the fold has to be exact or not happen |
| `streaming.ts` extension lookup | A method-name table needs `ctx[method](...)` and loses type safety; an arrow table is longer. Two `Set.has` calls are not a problem |
| `commands.ts` `InlineKeyboard` | Replaces a `.map()` with a loop. The options object stays regardless because of `parse_mode`. Saves nothing |
| `commands.ts` `new Context(...)` | Constructor shape is right and files hydration does survive (it rides `ctx.api`), but `bot.command()` sets `ctx.match` as an **own property** — probe-verified, `own keys: ["update","api","me","match"]` — which `Object.assign(…, ctx, …)` copies and the constructor drops. Zero lines saved, and it turns a type-only import into a runtime one |
| `reactions.ts` `ctx.react` | `ctx.react` exists, but it `orThrow`s on a missing chat/message where the current guard returns silently, and six test files build fake contexts stubbing `api.setMessageReaction` with no `.react`. One of them would keep passing **vacuously**, via a swallowed TypeError instead of the guard it claims to test. Four source lines do not buy that |
| `document.ts` `localeCompare` comparator | Old and new agreed on every case spiked, but it swaps a deterministic numeric parse for locale-dependent collation, and the output is PDF **page order** fed to a vision prompt — a wrong sort is silent. One line |
| `document.ts` `mkdir`/`rm` via `node:fs/promises` | Error text changes, and `processArchive`'s catch puts `String(error).slice(0,100)` in front of the user. The perf argument does not survive contact: every one of those spawns sits beside a `pdftocairo`/`unzip`/`tar` spawn on the same path |
| `photo.ts` album-branch hoist | Not a local shrink. The download is shared but its failure reporting differs by path — edit a status message vs. reply — so hoisting means duplicating ~18 lines or extracting a helper. `handlePhoto` has no test |
| `Bun.randomUUIDv7()` everywhere | The row conflated four things. Kept the part that was a real bug (below); dropped swapping stdlib `randomUUID` in `session.ts`'s atomic-write path for a Bun-only API, and dropped the two `doc_${Date.now()}` **filename fallbacks**, which are not unique-suffix sites at all |

### The one behavior change

`extractArchive` used `${TEMP_DIR}/archive_${Date.now()}` with no random part, while the
PDF path two functions above already carried a random suffix and a comment saying why.
Two archives uploaded in the same millisecond shared an extraction dir, and the first to
finish `rm -rf`'d the second's files mid-read. Both sites now call one exported
`uniqueTempDir(prefix)`.

A fix, not a shrink, and the only row in Batch 5 that changes behavior. Its test is the
only one here that **failed before the edit**.

### Coverage

Thirty-four new tests; 248/848 → **282/906**.

- `formatting.test.ts` — `formatToolStatus` image detection: all eight extensions, case-insensitivity, four near-miss paths, and a trailing newline. `formatToolStatus` had no test at all before.
- `text.test.ts` — `checkInterrupt`: passthrough, strip-and-forward, the four `!stop` spellings, and that the strip still happens with nothing running.
- `document.test.ts` — `isArchive`/`getArchiveExtension` asserted as a **pair**, since a disagreement between them surfaces as `Unknown archive type` only after the file is already extracted. Plus the temp-dir collision guard.
- Written against the unrefactored code and watched pass first, except the collision guard.
- The collision guard strips the timestamp before comparing (`_\d+_` → `_T_`). Comparing raw would pass on two calls that merely landed in different milliseconds — the vacuous-assertion shape Batch 4's review caught twice.

Not covered, stated rather than papered over: `pollFor` is reachable only through an MCP
round trip, and the `node:fs/promises` import has no observable behavior. Neither got a test.

## Coverage for Batches 4 and 5 — added 2026-07-30

**The gap this closes.** Batch 6 below converts tests that already exist; it adds no coverage. Nothing anywhere in this plan tested `text.ts`, `photo.ts`, `video.ts`, `media-group.ts` or `callback.ts` — which is precisely the set Batches 4 and 5 rewrite. `bun test` stays green through any regression in them. Assuming Batch 6 covered this was wrong.

**Rule: a Batch 4 or 5 item ships its test in the same commit as its edit.**

**Order matters more than the tests do.** Write the test against the **unrefactored** code and watch it pass *before* touching anything. A test written after a behavior-preserving refactor only describes the new code — it cannot show behavior held, which is the single thing these two batches claim. Any test that will not pass before the edit is testing the wrong thing.

No conflict with Batch 6's "run last": that rule forbids **rewriting** the existing suite mid-flight, because the suite is the oracle. Adding new coverage builds more oracle. Opposite direction.

**Do not `mock.module("../session", …)`.** `mock.restore()` does not undo it in Bun 1.3.14, and Bun's test-file order is neither lexicographic nor settable, so a leak lands on an arbitrary set of later files — the hazard `session-reset.test.ts:11-14` records. The handlers use the `session` singleton, so assign over the one or two methods under test and restore them in `afterAll`. No module mocking, no leak class.

What each item needs:

| Item | Test |
|---|---|
| 4.0 `handleResumeCallback` | `isRunning` true during the query, false after — and after a throw |
| 4.1 `setTitleIfNew` | the >50 truncation, and that an already-active session keeps its title. Then one call site per handler |
| 4.2 `rateLimitOrReply` | over-limit replies and returns true; the album path charges once, not once per item |
| 4.4 `deleteToolMessages` | every message attempted even when one delete throws — that swallow is the point |
| 4.5 `runPrompt` | `processPhotos` and `processDocuments` only. Success and catch paths |
| Batch 5 | Per row, and only where the row has observable behavior. Four of the five rows named here were dropped at plan review; the survivor (`getArchiveExtension`) shipped its test, as did two rows this list never anticipated. See Batch 5's own Coverage block |

**Still uncovered after all of it:** the Telegram wire. A manual pass at deploy stays the check for that — nothing in-process reaches it.

## Batch 6 — Tests — Applied 2026-07-30

Ran **after** all source batches were green. The suite is the oracle for everything above;
rewriting it mid-flight would destroy the only signal that the refactors held. This batch
**converted existing tests only** — the new coverage for Batches 4 and 5 is specified above.

Plan-reviewed first against re-derived anchors: four of the five rows survived, and every
count in the original table was stale except one.

### Applied

| Row | What landed |
|---|---|
| `bunfig.toml` `[test] preload` | New `test-preload.ts` sets `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALLOWED_USERS`. The identical preamble was in **16 of 20** files, not 12 of 16 |
| `security.test.ts` `checkCommandSafety` | **58** single-expect cases across three describes → one `test.each` per describe. The 2 multi-expect `/proc` tests stay as they are |
| `security.test.ts` `evaluateToolUse` | **41** stateless cases → one typed `TOOL_GATE_CASES` table. The **7** that mutate module or process state stay standalone |
| `streaming.test.ts` | **4** in-test `await import("./streaming")` folded into the existing top-level destructure, not 3 |

### Dropped, with the reason

| Row | Why |
|---|---|
| push-closures → `mock()` + `toHaveBeenCalledWith` | Only **5** sites exist, not 7, and `auth.test.ts` — one of the three files named — has none; it uses counters. `toHaveBeenCalledWith` matches **any** call, so it cannot express `reactions.test.ts`'s `calls[0]` / `calls[1]` ordering (spiked: a spy called `("b")` then `("a")` passes `toHaveBeenCalledWith("a")`). Collapsing three assertions into one would also drop the `expect()` count below the gate. Nine lines is not worth a weaker oracle |

### Why the preload is safe

`config.ts` reads both vars at module-eval and exits without the token; `bun test` shares
one module registry, and Bun's file order is neither lexicographic nor settable — so the
16 per-file copies only worked by all agreeing. Spiked on Bun 1.3.14: preload runs once per
test process, before any test file's module body, same pid, shared registry. The two files
that spawn `bun -e` subprocesses pass `{ ...process.env }`, so the children inherit.
`sandbox.test.ts` was the one file setting a different token (`"x:y"`); its only `x:y`
assertions use a local object literal, never `process.env`.

### How the conversion was proved non-vacuous

The count gate alone cannot see a row whose argument changed in porting, so two checks ran
on top of it:

- **Case-multiset comparison**, tokenizer-based and table-aware, `HEAD` vs the working
  tree: 66 `checkCommandSafety` cases before and after, 62 `evaluateToolUse` cases before
  and after, zero differences in `(input => expectation)`.
- **Per-row mutation**, both directions. `checkCommandSafety` stubbed to always-`[true]`
  then always-`[false]`: every one of the 58 table rows fails under one mutant or the
  other, none survives both. Same for `evaluateToolUse` stubbed to always-allow then
  always-deny across its 41 rows. Emptying `test-preload.ts` halts the suite outright,
  which is what proves the preload — not the invoking shell — supplies the env.

### Gate

**282 pass / 906 expect() / 20 files — exactly**, unchanged from what the branch carried
in, and typecheck clean. Exact, not "not below": a batch that adds no cases can hide a lost
one behind an increase just as easily as a decrease would expose it.

Net **-332 lines**.

## Batch 7 — Comment sweep — Applied 2026-07-30

Two passes disagreed hard. Pass 1: 1 finding out of 982 comment lines. Pass 2 (adversarial,
same files): 55 DELETE / 17 TRIM. Neither was taken as-is, and the plan review that followed
cut the reconciled list again — from ~35 DELETE + ~17 TRIM down to **13 deletions**.

Ran after Batch 4, as planned: the `deleteToolMessages` and `statusMessage` helpers had
already removed most of the duplicated `try/catch { /* ignore */ }` sites.

### Applied — 13 deletions

| Site | Comment |
|---|---|
| `commands.ts` | `// Format date: "18/01 10:30"` — the template two statements below assembles `${dateStr} ${timeStr}` in plain sight |
| `formatting.ts` x7 | Headers, Bold, Double underscore, Blockquotes, Bullet lists, Horizontal rules, Links — each restated the regex beneath it |
| `formatting.ts` | `// Handle blockquote at end` — the one finding both passes agreed on |
| `security.ts` x2 | `// flags / empty tokens` (translates `!arg \|\| arg.startsWith("-")`) and `// file:, gopher:, ...` (restates an explicit http/https allowlist) |
| `session.ts` x2 | `// Use V1 query() API …` and `// V1 query completes …`. The installed SDK exports one `query`; there is no V1/V2 split for the marker to name |

### The TRIM half was DROPPED, not applied

The plan said "Pass 2's replacements are good … **apply as given**" for ~17 trims, but
**the replacement texts are nowhere in this document**. They lived in a pass-2 agent output
that was never captured. Reconstructing them means running a fresh adversarial comment pass
— a new audit, not execution of the reconciled plan. Dropped and recorded rather than
re-derived. The one trim the plan named by hand, `session.ts` `interruptForNewMessage`, was
already in its trimmed form; an earlier batch had done it.

### Kept, against the DELETE list

The standing rule — never delete a correct section banner — overrode the list for: all six
`commands.ts` `/status` markers, `types.ts` "Session persistence", `streaming.ts` "File
extensions grouped by Telegram send method", `index.ts` "Graceful shutdown", and
`security.ts` "IPv4 literal".

Kept on content: both `callback.ts` markers, which record the **callback-data wire format**
the `startsWith` checks parse, not a translation of them; both `document.ts` limits, which
name the unit and scope of otherwise bare magic numbers (files per archive, characters per
file); and the `security.ts` address-classification run — `::` meaning "unspecified" and
`fe[89ab]` meaning `fe80::/10` are knowledge, not restatement, and deleting two of three
RFC1918 markers would have left an inconsistent block.

### Two things the deletions forced

**A dangling back-reference.** Cutting `// Bold: **text** -> <b>text</b>` orphaned the next
comment, which opened "**Also** handle `*text*` as bold" — a pointer to a line that no
longer existed. Both surviving comments in that chain were rewritten to stand alone.

Rewriting them turned up a real asymmetry that neither comment had recorded, and that the
first rewrite got wrong in the other direction:

| Pass | Regex | Excludes the doubled form on its own? |
|---|---|---|
| single `*` | `/(?<!\*)\*(.+?)\*(?!\*)/` | **No.** `(.+?)` spans the inner delimiters, so `**x**` alone yields `<b>*x*</b>`. The `**` pass above must run first |
| single `_` | `/(?<!_)_([^_]+)_(?!_)/` | **Yes.** `[^_]+` cannot span them, so order is irrelevant |

Nothing covered this. A reorder is silent — the output stays well-formed HTML, so the
tag-balance fuzz tests in `streaming.test.ts` cannot see it. A guard test landed in
`formatting.test.ts`, mutation-checked by swapping the two `*` replace lines.

**The `/restart` sleep, the plan's one Open item.** The stated reason is false — `ctx.reply`
and `Bun.write` are both awaited before `await Bun.sleep(500)`. But something IS
outstanding: `index.ts` runs `@grammyjs/runner`, whose SIGINT/SIGTERM handlers call
`runner.stop()`; `handleRestart` calls `process.exit(0)` directly and never does, so
long-polling is live at exit. Blame puts both the sleep and its comment in the initial
import `d9c94bb`, with no recorded race. Whether 500 ms is what stops a redelivered
`/restart` from looping cannot be settled statically. The sleep stays; the false comment was
replaced with the established facts and an explicit do-not-drop-blind. Settling it needs a
live restart-path run against the supervisor.

### Gate

`bun run typecheck` exit 0. **283 pass / 911 expect() / 20 files**, up from 282/906 — the
one added test is the ordering guard above. Net −11 lines.

## No-cut list

From the security review. These look redundant, verbose, or paranoid to a simplification pass and must survive it.

**Deliberate cross-layer redundancy — both sites stay:**

| Pair | Site A | Site B | Why both |
|---|---|---|---|
| ALLOWED_PATHS containment | `security.ts:509` `evaluateToolUse` (native tools) | `sandbox.ts:104` `buildSandboxSettings` (Bash, OS-level) | The hook does not bind Bash syscalls; the sandbox does not bind Read/Write/Edit. Cutting either opens one whole tool surface. |
| Credential paths | `security.ts:466` `isCredentialPath` | `sandbox.ts:30` `READ_DENY` | Same split. Sharing the *list* is fine (Batch 5); sharing an *enforcement point* is not. |
| `/proc/<pid>/environ` | `security.ts:172` regex | `security.ts:480` + `sandbox.ts:49` | Three different execution paths to one leak. |
| Secret env vars | `sandbox.ts:82` `sanitizeEnv` | `sandbox.ts:73,134` `credentials.envVars` | `AUTH_KEEP` vars are deliberately *kept* in the child env so Claude can authenticate — the sandbox deny is the only thing hiding them from Bash. |
| `DENIED_TOOLS` | `session.ts:248` SDK `disallowedTools` | `security.ts:509` hook check | A stops the model emitting it; B is the runtime backstop. |
| Tool-use verdict | `session.ts:254` PreToolUse hook | `session.ts:368` stream backstop | The backstop must never throw — throwing aborts the turn instead of letting Claude see the denial. |
| Bash write gating | `security.ts:112` redirect/rm parser | `sandbox.ts:104` OS sandbox | `BASH_SANDBOX_ENABLED=false` is a supported mode (`sandbox.ts:93`). There, the parser is the only containment left. |
| Temp access | `security.ts:76` broad `TEMP_PATHS` | `sandbox.ts:8` narrow `SANDBOX_SCRATCH` | Asymmetric on purpose: native tools need scattered `/tmp` downloads, Bash is confined to one scratch dir. |
| Rate limiting | `photo/video/document.ts` per-item | `media-group.ts:103` per-album | Unifying either double-charges a 10-photo album or drops single-send limiting. |
| Archive containment | `document.ts:234` zip-slip pre-check | `document.ts:212` `stripLinks` + `:273` `nlink>1` re-check | Write-outside, read-exfil, and a TOCTOU belt. Three attack classes. |

**Single points that look prunable and are load-bearing:** `security.ts:391` `canonicalize` (lexical `..` resolution against a symlink segment is the exact escape it prevents — no stdlib realpath tolerates a missing tail), `security.ts:112` `checkRedirectTargets` (every edge case is a documented near-miss), `security.ts:342` DNS-resolve branch (closes `evil.example.com A 169.254.169.254`), `sandbox.ts:99` fail-secure env parse, `sandbox.ts:14` scratch-dir symlink pre-check, `trigger.ts:31` `timingSafeEqual`, `callback.ts:44` requestId charset (callback_data is attacker-shaped regardless of which buttons were rendered), `session.ts:86` `writeJsonAtomic`, `utils.ts:121` reaper NaN guard (the failure mode is deletion), `index.ts:44` `authGate` before `sequentialize` (the sole auth choke point), `streaming.ts:106` `isPathAllowed` (the **only** validation of `send_file`'s path anywhere — the MCP server does none), `security.test.ts:694` SDK tool-surface tripwire.

**Pushback on the architect's finding 7:** `plugins.test.ts` is 15 lines and reads as "testing a dependency", but it asserts *our* wiring does not throw at install time. Keep.

**Pushback on architect finding 11** (move the MCP-IPC pollers out of `streaming.ts` into `session.ts`): net 0 lines, grows the largest file 617 → 745. Buys graph shape, not size. Skip.

---

## Deliberately rejected

| Proposal | Lines | Why not |
|---|---|---|
| `net.BlockList` for `isPrivateV4`/`isBlockedV6` | -23 | A1 says it would work — every branch probed identical. But it is the SSRF classifier, the payoff is 23 lines, and the security review flags it no-cut. Not worth touching working, tested code. Revisit only with a differential fuzz test as the gate. |
| MCP servers → `registerTool` + zod | -177 | Wire-visible change: malformed input goes from `-32603` with a custom message to `-32602` zod text. Violates behavior-preserving. **Take the `fail()` helper alone** (-41 on `send_file`) — zero API difference. |
| Delete `AUDIT_LOG_JSON` | -13 | Operator-facing, documented in `SECURITY.md:143`. |
| `Bun.escapeHTML` | -6 | A9: emits `&#x27;` for `'`; Telegram HTML-mode acceptance unconfirmed. Six lines is not worth a rendering regression. |
| `extname()` for the 4 extension spellings | -4 | Extension-less `README` currently yields `.readme` and can match `TEXT_EXTENSIONS`; `extname` yields `""`. |
| `describeError` in `document.ts:386,623` | 0 | Widens the cap 100 → 200 chars. |
| `PATH` prepend via `toReversed`+Set | -5 | Moves an already-present entry to the front instead of leaving it. |
| Delete the archive feature | **-200** | Largest removable block in the repo, and it carries the densest attack surface (zip-slip, link stripping, 2 external CLIs). Not behavior-preserving — raised as a **question**, not a recommendation. Grep the audit log for `ARCHIVE` events before deciding. |
| Widen denylist to `tee`/`dd of=`/`cp`/`mv`/`find -delete` | +N | Real gap, and it is the *only* gap when `BASH_SANDBOX_ENABLED=false` with no OS backstop. Already self-documented as an accepted ceiling at `security.ts:144-149`. Scope expansion — separate decision. |

## Sequencing

```
Batch 0 (docs)  ─┐
Batch 1 (deletes)├─ independent, any order, each: typecheck + test
Batch 2 (docker) ─┘
        ↓
Batch 3 (bugs + audit-log mode)   ← needs explicit yes; must land before 4.5
        ↓
Batch 4 (dedup helpers, 1→5 in order)
        ↓
Batch 5 (local shrinks)
        ↓
Batch 6 (tests)                   ← last: the suite is the oracle for 1-5
        ↓
Batch 7 (comments)
```

Per batch: `bun run typecheck` && `bun test`, then one commit. The counts must never fall below the batch before — **282 pass / 906 expect() after Batch 5**. A drop means a row was lost in porting. Baseline restated: a green typecheck does not prove runtime — `bun test` is the gate that matters, and neither covers the Telegram wire. Batch 3, and every Batch 4/5 item touching reactions or message flow, wants a live bot pass before the branch merges.

## Decisions — 2026-07-30

| # | Question | Decision |
|---|---|---|
| 1 | Batch 3 scope | **All three, in order:** `video.ts` tool-message leak, `callback.ts` `isRunning`, audit-log `0o600`. |
| 2 | Archive feature | **Keep.** Local check inconclusive — no `/tmp/claude-telegram-audit.log` on this host and no pod matched `app=claude-telegram-bot`. Not re-litigated by a future pass without new evidence: run `grep -c ARCHIVE "$AUDIT_LOG_PATH"` against the running bot to reopen. |
| 3 | MCP servers | **Full `registerTool` + zod rewrite**, -177 lines. Accepted as a deliberate wire change. |
| 4 | `security.test.ts` `test.each` | **Do it, last**, gated on ≥228 tests / ≥808 expect(). |

### Consequences of decision 1

All three land in Batch 3, before Batch 4 touches any of the same files.

- Folding `callback.ts`'s inlined catch into `handleProcessingError` would **add a 👎 reaction it does not post today**. **Declined at apply time** — the fold restores no pair, because `callback.ts` posts no 👌 on success either; it only makes the reactions asymmetric. The `isRunning` fix landed without it.
- Once `isRunning` is correct on the callback path, `/status` and `/stop` start reporting button-initiated queries as running. Anything that assumed the old (wrong) reading changes with it.
- The audit-log mode fix is `mode: 0o600` on create plus a chmod for a log an older build left behind, mirroring `ensureScratchDir`'s `0o700` in `sandbox.ts`. It does not redact anything — under `AUDIT_LOG_JSON=true` the full message and response are still written, no longer world-readable **once the chmod succeeds**. When it cannot, see the open question above. Redaction is a separate question, not in this plan.

## Plan review — findings folded in

An adversarial review of this plan against the source found four defects in it. Verdict: SHIP WITH LISTED FIXES.

1. **CRITICAL — `runPrompt`'s "three byte-identical sites" was false.** Corrected in Batch 4 item 5 above. Scope drops to two sites.

2. **A bug the audit missed.** `processArchive`'s catch (`document.ts:377-387`) never touches `state.toolMessages` — it deletes only `statusMsg`. That is the **same leak class as the `video.ts` bug in Batch 3 item 1**: tool-status messages survive a failed archive query. Fix it in Batch 3 alongside `video.ts`, since it is the same root cause, not a separate symptom. (Batch 3 approval covered `video.ts`; this is the sibling that grep should have surfaced first time.)

3. **HIGH — `deleteToolMessages` is not a uniform swallow.** `text.ts:80-85` swallows silently; `streaming.ts:502`, `callback.ts:125` and `media-group.ts:169` each `console.debug("Failed to delete tool message:", error)`. Unifying forces a choice. **Resolution: adopt the logging version.** `text.ts` gains a debug line it never emitted — debug-level only, no user-visible change. Recorded rather than silently absorbed.

4. **HIGH — the `callback.ts` regex rewrite drops specific error toasts.** Today a malformed payload answers with `"Invalid callback data"` (`callback.ts:39`) or `"Invalid request id"` (`callback.ts:47`). A `bot.callbackQuery(/^askuser:([A-Za-z0-9_-]+):(\d+)$/)` matches only well-formed payloads; everything else falls to the generic catch-all ack, losing both toasts. The proposal also never said where `resume:` lands. **Resolution: dropped from Batch 5.** It was a ~18-line shrink that trades away user-facing error specificity and touches the charset guard protected by no-cut #19. Not worth it.

5. **MEDIUM — `csvEnv` is not a clean fold.** The three splitters are not parallel: `ALLOWED_USERS` (`config.ts:37`) maps `parseInt` + `isNaN` filter; `ALLOWED_PATHS` (`config.ts:76`) falls back to a pre-built **array**, not a CSV string, and drops falsy entries; `THINKING_*` (`config.ts:136`) lowercases and trims but keeps empty entries. A helper covering all three needs a map fn, a filter fn, and an array-or-string fallback — more surface than the ~9 lines it removes, on three security/UX-relevant env vars. **Resolution: dropped from Batch 5.**

6. **Confirmed sound, no change:** `setTitleIfNew` (identical truncation and `isActive` gate at all 5 sites; only the seed differs and it stays caller-side), `rateLimitOrReply` (identical string and check→audit→reply→`markFailed` ordering at all 6; `document.ts:537`/`561` are true mutually-exclusive siblings so the hoist holds), `withMessageText` via `new Context()` (grammY's constructor assigns only `update`/`api`/`me` as own props; `@grammyjs/files` hydration rides on the shared `Api` transformer, not a per-context property), the A1 `BlockList` rejection, A2, and the Batch 3→4 ordering.

### Open risk — accepted or fixed before merge

The per-batch gate (`bun run typecheck` + `bun test`) **cannot catch findings 1, 3, or 4.** There was no `text.test.ts`, `photo.test.ts`, `video.test.ts`, `media-group.test.ts`, or `callback.test.ts` — and Batch 4/5's dedup work touches exactly those five files. The suite stayed green through every regression above.

**Resolved as written, 2026-07-30.** Batches 4 and 5 shipped `text.test.ts`, `media-group.test.ts` and `callback.test.ts` with their edits. `photo.ts` and `video.ts` are still untested and stay on the live-bot pass at the end of this document. Batch 2 was measured at apply time with a real `docker build` — see the Batch 2 section, which supersedes the ~469 MB estimate with −870 MB.

### Consequence of decision 3

The `registerTool` rewrite is the plan's only accepted behavior change beyond the `video.ts` fix. Malformed MCP input moves from JSON-RPC `-32603` with a custom message to `-32602` carrying zod validation text. Valid calls are byte-identical (probed). `bun test` will not catch a regression here — neither MCP server has a test. Verify by calling each tool once through a live session before merging.

---

## What is still unverified when the branch merges

All seven batches are green under `bun run typecheck` + `bun test`. Neither reaches the
Telegram wire, and no in-process test can. Three things need a human at deploy.

### 1. The live-bot pass

Batches 6 and 7 changed no runtime behaviour — tests and comments only — so this list is
what Batches 3, 4 and 5 left behind, unchanged.

| Path | What to send | What changed under it |
|---|---|---|
| Text | a normal message | `setTitleIfNew`, `rateLimitOrReply`, `deleteToolMessages` — five call sites folded into one each |
| Text | `!` + a follow-up while a query runs | `checkInterrupt` moved from `utils.ts` into `text.ts`; the preempted query must stay silent, not print "🛑 Query stopped." |
| Text | `!stop` and `!/stop` | both must cancel and forward nothing |
| Photo | one image | shared `runPrompt`; the whole constructed prompt is audited here, deliberately |
| Album | 3+ images at once | the debounce was rewritten as one `arm()` closure. The album must be rate-limited **once**, not once per image |
| Video | a video and a video note | the catch used to pass `[]` and leak tool messages; that is the Batch 3 fix |
| Document | a PDF, a text file, and **two archives uploaded together** | the two-archive case is the Batch 5 fix: extraction dirs used to collide within a millisecond and delete each other's files mid-read |
| Button | an `ask_user` prompt, then tap an option | the keyboard is now built with `.text().primary().row()`; `isRunning` must be true during the query and false after |
| `/new`, `/stop` | during a running query | the stop → settle → clear sequence |
| `/resume` | pick a saved session | check what `/status` and `/stop` report **during the recap** — Batch 4 changed it |
| `/restart` | once | Batch 7 could not settle statically whether the 500 ms sleep is what stops a redelivered `/restart` looping. Watch for a restart loop |

### 2. Batch 2 — already closed, not outstanding

The Dockerfile and `.dockerignore` changes sit outside `bun test` entirely, so they were
verified separately **at apply time**: a real `docker build` on linux/arm64 plus in-image
inspection. Numbers and equivalence checks are in the Batch 2 section above. Nothing further
is needed unless the base image moves.

### 3. The MCP `registerTool` rewrite, if it is taken

Not applied on this branch. If it is, malformed MCP input moves from JSON-RPC `-32603` with
a custom message to `-32602` carrying zod validation text. Valid calls are byte-identical
(probed). Neither MCP server has a test, so each tool needs one live call.
