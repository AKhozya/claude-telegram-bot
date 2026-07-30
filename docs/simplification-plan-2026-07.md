# Simplification plan — 2026-07-30

Baseline: HEAD `7b600c1`, clean tree. `bun run typecheck` exit 0. `bun test` 228 pass / 0 fail / 808 expect() / 16 files.
Source: 41 TS files, 5,695 code lines, 982 comment lines (measured, not the 766 tokei reports — tokei undercounts block-comment continuation).

Eight parallel audits: core `src/`, `src/handlers/`, comments (x2), architecture, security, tests+MCP+infra, docs.

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

~469 MB off the image for three lines of text.

## Batch 3 — Bugs and one security fix

**Behavior-changing by intent.** Each needs a yes.

1. **`video.ts:109`** — `const state = new StreamingState()` sits inside the `try`, so the catch at :135 passes `[]` to `handleProcessingError`. Tool-status messages are never deleted when a video query fails. Hoist the declaration above the `try`. (`markFailed` is unaffected — `handleProcessingError` calls it.)
2. **`callback.ts:102`** — no `session.startProcessing()`, so `isRunning` is false between the button tap and the query. `/status` and `/stop` misreport for button-initiated queries. This is the same drift `session.ts:170-178` already documents. Add the call + `finally { stopProcessing() }`.
3. **`utils.ts:20-45` audit log mode** — `fs.appendFile` with no mode, umask 022, nothing chmods it → `0644`. Under `AUDIT_LOG_JSON=true` the JSON branch logs the full message and full response **unredacted** (the 500-char truncation is only in the human-readable branch). A user pasting a credential into Telegram writes it world-readable to `/tmp/claude-telegram-audit.log`. The bot's own sandbox blocks *Claude* from reading it — that does nothing for another OS user. Fix: `mode: 0o600` plus an explicit chmod on first create, mirroring `sandbox.ts:22`'s `0o700`.

Note on 2: folding `callback.ts`'s catch into `handleProcessingError` also **adds a 👎 reaction** it does not currently post. Do that knowingly or leave the catch inline.

## Batch 4 — The actual win: six copies of one handler tail

Ordered smallest-blast-radius first so each lands green before the next.

1. **`session.setTitleIfNew(seed)`** — the `if (!session.isActive) { …len>50 ? slice(0,47)+"..." : raw }` block is copied 5x (`text.ts:48`, `photo.ts:62`, `document.ts:342`, `document.ts:419`, `video.ts:98`). `conversationTitle` and `isActive` are both session state written from five handler files. 4-line method, five one-line call sites. ~25 → ~9.
2. **`rateLimitOrReply(ctx, userId, username): Promise<boolean>`** — the same 9 lines (check → `auditLogRateLimit` → `⏳ Rate limited` → `markFailed` → return) at `text.ts:36`, `photo.ts:111`, `video.ts:56`, `document.ts:537`, `document.ts:561`, `media-group.ts:103`. Not middleware — albums are charged once per album, per `photo.ts:106`. Free bonus: `document.ts`'s two copies are sibling branches of one function; hoisting above the split kills one with no helper at all. ~-32.
3. **`stopAndSettle()`** in `commands.ts` — `handleNew:38-44` re-inlines `handleStop:53-60`'s stop → `Bun.sleep(100)` → `clearStopRequested` dance. That 100 ms + clear pairing is exactly the coupling `session.ts:170-178` records as already dropped once by a hand-copy. ~-6.
   *Not* folding the sleep into `ClaudeSession.stop()`: `session.test.ts:35-57` asserts the literal `["mark","stop","clear"]` sequence as the regression guard for that drift. Rewriting the test that exists to catch this class of change is the wrong trade.
4. **`state.deleteToolMessages(ctx)`** on `StreamingState` — the 7-line swallow-and-delete loop at `streaming.ts:498`, `callback.ts:121`, `media-group.ts:165`, `text.ts:80`. It already owns the array. ~-19.
5. **`runPrompt(ctx, {...})`** — the full tail (`startProcessing` → title → typing → `StreamingState` + `createStatusCallback` → `sendMessageStreaming` → `auditLog` → `markDone` → catch → `finally`).

   **CORRECTED after plan review.** The original claim — "three byte-identical sites: `processPhotos`, `processDocuments`, the `processArchive` tail" — was wrong. The success paths match; the catch blocks do not. `processPhotos` and `processDocuments` catch with `handleProcessingError(ctx, error, state.toolMessages)` (`document.ts:451`). `processArchive`'s catch (`document.ts:377-387`) is a different shape: `console.error` → `markFailed` → delete **only** `statusMsg` → `ctx.reply(\`❌ Failed to process archive: ${String(error).slice(0,100)}\`)`. It never touches `state.toolMessages`.

   Real behavior-preserving scope is **two** sites: `processPhotos` and `processDocuments`. Folding `processArchive` in would change the user-facing error text and start deleting tool messages — an unflagged behavior change.

   **Do not fold in `callback.ts`** (no `markFailed`, and decision 1 declined its fix). Hold `video.ts` until Batch 3 lands, or the refactor silently preserves the bug.

## Batch 5 — Local shrinks

Each independent; drop any that reads worse after the edit.

| File | Cut | Replacement |
|---|---|---|
| `session.ts:402-432` | two near-identical "sleep 200, then 3 attempts x 100 ms" pollers | one `pollFor(check)` + two call lines |
| `config.ts:37,77,141` | three hand-rolled comma-env splitters | one `csvEnv(name, fallback, map?)` |
| `session.ts:562-574` | `Bun.file().size` probe before `readFileSync` | `try { JSON.parse(readFileSync(...)) } catch` — `JSON.parse("")` already throws into the same catch |
| `session.ts:203` | `getThinkingLevel` called twice per message (log label, then inside `getThinkingConfig`) | call once, derive the label from `.budgetTokens` |
| `formatting.ts:211-289` | Read/Write/Edit branches differing only by verb | 3-entry verb table + one shared return; leave the other 9 branches alone |
| `formatting.ts:214-226` | 8-element `imageExtensions` + `.some(endsWith)` | one regex |
| `utils.ts:40,133` | `await import("fs/promises")` re-executed per call | one top-level `node:fs/promises` import |
| `utils.ts:172-206` | `checkInterrupt`'s lazy-import cycle guard (A2: no cycle) + structural type + cache | move the body into `text.ts`, its only caller, which already imports `session` |
| `callback.ts:14-50` | manual `startsWith` prefix dispatch + `parts.length` check + charset regex | `bot.callbackQuery(/^askuser:([A-Za-z0-9_-]+):(\d+)$/, …)` reading `ctx.match`, plus a trailing catch-all `bot.on("callback_query", …)` to keep the unmatched-data ack. **The charset class must survive verbatim** — see no-cut #19 |
| `media-group.ts:118-144` | the `setTimeout(processGroup, …)` written once per branch | one `arm()` closure |
| `streaming.ts:113-133` | extension-Set ternary chain evaluated twice | one `{video:[action,method], photo:…, audio:…}` lookup |
| `streaming.ts:22-36` | keyboard object literal in a loop | `keyboard.text(...).primary().row()` |
| `commands.ts:143-172` | raw `reply_markup:{inline_keyboard:[...]}` | `InlineKeyboard` — one spelling repo-wide |
| `reactions.ts:10-19` | manual `ctx.chat?.id`/`ctx.msg?.message_id` + guard | `ctx.react(emoji)` inside the existing try/catch |
| `document.ts:81-84` | `parseInt(match(/-(\d+)\.png$/))` comparator | `toSorted((a,b)=>a.localeCompare(b,undefined,{numeric:true}))` — satisfies `document.test.ts:71-86` |
| `document.ts:99,108,230,370` | `Bun.$\`mkdir -p\`` / `Bun.$\`rm -rf\`` — 4 subprocess spawns | `mkdir`/`rm` from `node:fs/promises` |
| `document.ts:160-172` | `isArchive` + `getArchiveExtension` over the same list | one `find(endsWith)`; order-independent since `"x.tar.gz".endsWith(".tar")` is false |
| `photo.ts:108-165` | nullable `statusMsg`, a re-test, and an unreachable `if (!mediaGroupId) return` | hoist the album branch to the top; the rest is straight-line with a non-nullable `statusMsg` |
| `commands.ts:223-237` | `withMessageText`'s `Object.create(getPrototypeOf(ctx))` + `Object.assign` | `new Context({...ctx.update, message:{...ctx.message, text}}, ctx.api, ctx.me)` — public constructor |
| `photo.ts:29`, `document.ts:98`, `session.ts:87` | three spellings of "unique suffix" (`Date.now()+Math.random`, x2, and `randomUUID`) | `Bun.randomUUIDv7()`, one spelling |
| `security.ts:488` / `sandbox.ts:31` | the credential-dir list maintained in two files; `security.ts:465` already says "Mirrors READ_DENY" | one exported `CREDENTIAL_DIRS`, **both enforcement sites kept** (no-cut #2) |

## Batch 6 — Tests

Run **after** all source batches are green. The test suite is the oracle for everything above; rewriting it mid-flight destroys the only signal that the refactors held.

- `bunfig.toml` `[test] preload` — the `TELEGRAM_BOT_TOKEN`/`ALLOWED_USERS` preamble repeats in 12 of 16 test files. ~-29.
- `security.test.ts:409-675` — 58 single-assertion `checkCommandSafety` blocks → `test.each` per describe, row[0] as the test name so failure output is unchanged. ~-97.
- `security.test.ts:135-404` — 39 single-assertion `evaluateToolUse` blocks → `test.each`; 7 rows need hand-porting for multi-arg shapes. ~-84.
- `reactions/auth/streaming.test.ts` — 7 hand-rolled `const calls: any[] = []` push-closures → `mock()` + `toHaveBeenCalledWith`. ~-9.
- `streaming.test.ts:43,60,78` — `await import("./streaming")` inside 3 tests when line 94 already imports it top-level. ~-3.

Gate: test count must stay ≥228 and `expect()` calls ≥808 after each conversion. A drop means a row was lost in porting.

## Batch 7 — Comment sweep

Two passes disagreed hard. Pass 1: 1 finding out of 982 comment lines. Pass 2 (adversarial, same files): 55 DELETE / 17 TRIM. Neither is taken as-is.

Runs **after Batch 4** — the `deleteToolMessages` and `statusMessage` helpers delete most of the duplicated `try/catch { /* ignore */ }` sites outright, so sweeping their comments first is wasted work.

**Accepted — DELETE (~35).** Pure restatement of the line beneath.
- `commands.ts:69,76,92,100,115,123` — `// Session status`, `// Query status`, `// Last activity`, `// Usage stats`, `// Error status`, `// Working directory`.
- `commands.ts:144` — `// Format date: "18/01 10:30"` above a function named for it.
- `formatting.ts:75,78,81,84,87,93,96,99` — the `// Bold: **text** -> <b>text</b>` run; each restates the regex on the next line.
- `formatting.ts:152` — `// Handle blockquote at end` (the only finding both passes agreed on).
- `types.ts:15,21`, `streaming.ts:76`, `callback.ts:25,31`, `index.ts:154`, `document.ts:258,291`, `security.ts:120,207,311,312,319,346,368`.
- `session.ts:320,477` — `// Use V1 query() API` / `// V1 query completes…`. Deleting these also removes the source of the V1-vs-V2 doc confusion in Batch 0.

**Accepted — TRIM (~17).** Pass 2's replacements are good; the `session.ts:170` `interruptForNewMessage` rewrite in particular keeps the drift warning while cutting the narration. Apply as given, except the two listed below.

**Rejected (14).** Each names a constraint the code cannot show, and most sit inside the security reviewer's explicit protect-list:

| Rejected delete | Why it stays |
|---|---|
| `security.ts:176` `// #10: output-redirect targets — a write-anywhere…` | Protect-list 176-187. Names the primitive the parser exists to close. |
| `security.ts:237` `// Plain path — resolve relative to WORKING_DIR` | Protect-list. Names the resolution base, which is not visible at the call. |
| `security.ts:513` dangerous-tools rationale | Protect-list 504-507. |
| `security.ts:563` bot's own audit log / session state | Protect-list 559-561, 567-575. |
| `document.ts:247` `// Drop extracted symlink/hard-link members…` | Archive link-exfil rationale — the *why* behind `stripLinks`. |
| `document.ts:108` `// don't leak the temp dir on failure` | Names the cleanup constraint. |
| `media-group.ts:102` `// Rate limit on first item only` | Security no-cut #10 cites this exact comment as the record of the deliberate album/single split. Batch 4 item 2 depends on a reader knowing it. |
| `plugins.test.ts:10` `// Wiring must not throw at install time.` | It is the reason the test exists. Deleting it invites deleting the test — which a separate agent already proposed. |
| `streaming.ts:348,385,398` | The fallback-ladder comments. Each names which Telegram rejection its level handles. TRIM, not DELETE. |
| `video.ts:123,131`, `document.ts:375,383`, `text.ts:84`, `streaming.ts:102,108,143` | Bare `catch {}` reads as an oversight; the marker records a deliberate swallow. Most of these sites disappear in Batch 4 anyway — re-check what survives rather than deleting now. |

**Corrected.** Pass 2 filed `utils.ts:174` as KEEP on the grounds that "session.ts imports utils.ts; cycle". That is false — verified A2: `session.ts` imports config/formatting/sandbox/security/types/handlers-streaming, and none of those reaches `utils.ts`. The comment and the machinery it guards both go, per Batch 5.

**Open, do not blind-delete.** `commands.ts:197` `// Give time for the message to send` — pass 2 showed the claim is false (the `ctx.reply` and the `Bun.write` are both awaited before the sleep), but could not determine what the 500 ms actually protects. Deleting the comment leaves an unexplained sleep, which is worse. Investigate the restart path, then either document the real reason or drop the sleep.

Protected, do not sweep: the `// ===== Name =====` section banners, commented-out code (all of `mcp-config.example.ts`), and every security-constraint comment in the no-cut list below.

---

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

Per batch: `bun run typecheck` && `bun test` (≥228 pass, ≥808 expect), then one commit. Baseline restated: a green typecheck does not prove runtime — `bun test` is the gate that matters, and neither covers the Telegram wire. Batch 3 and any Batch 4 item touching reactions want a live bot smoke test before the branch merges.

## Decisions — 2026-07-30

| # | Question | Decision |
|---|---|---|
| 1 | Batch 3 scope | **All three, in order:** `video.ts` tool-message leak, `callback.ts` `isRunning`, audit-log `0o600`. |
| 2 | Archive feature | **Keep.** Local check inconclusive — no `/tmp/claude-telegram-audit.log` on this host and no pod matched `app=claude-telegram-bot`. Not re-litigated by a future pass without new evidence: run `grep -c ARCHIVE "$AUDIT_LOG_PATH"` against the running bot to reopen. |
| 3 | MCP servers | **Full `registerTool` + zod rewrite**, -177 lines. Accepted as a deliberate wire change. |
| 4 | `security.test.ts` `test.each` | **Do it, last**, gated on ≥228 tests / ≥808 expect(). |

### Consequences of decision 1

All three land in Batch 3, before Batch 4 touches any of the same files.

- Fixing `callback.ts` means folding its inlined catch into `handleProcessingError` **adds a 👎 reaction it does not post today**. That is the point of the fix — the drift is what dropped it — but it is user-visible on a failed button-initiated query.
- Once `isRunning` is correct on the callback path, `/status` and `/stop` start reporting button-initiated queries as running. Anything that assumed the old (wrong) reading changes with it.
- The audit-log mode fix is `mode: 0o600` on create plus an explicit chmod, mirroring `sandbox.ts:22`. It does not redact anything — under `AUDIT_LOG_JSON=true` the full message and response are still written, just no longer world-readable. Redaction is a separate question, not in this plan.

## Plan review — findings folded in

An adversarial review of this plan against the source found four defects in it. Verdict: SHIP WITH LISTED FIXES.

1. **CRITICAL — `runPrompt`'s "three byte-identical sites" was false.** Corrected in Batch 4 item 5 above. Scope drops to two sites.

2. **A bug the audit missed.** `processArchive`'s catch (`document.ts:377-387`) never touches `state.toolMessages` — it deletes only `statusMsg`. That is the **same leak class as the `video.ts` bug in Batch 3 item 1**: tool-status messages survive a failed archive query. Fix it in Batch 3 alongside `video.ts`, since it is the same root cause, not a separate symptom. (Batch 3 approval covered `video.ts`; this is the sibling that grep should have surfaced first time.)

3. **HIGH — `deleteToolMessages` is not a uniform swallow.** `text.ts:80-85` swallows silently; `streaming.ts:502`, `callback.ts:125` and `media-group.ts:169` each `console.debug("Failed to delete tool message:", error)`. Unifying forces a choice. **Resolution: adopt the logging version.** `text.ts` gains a debug line it never emitted — debug-level only, no user-visible change. Recorded rather than silently absorbed.

4. **HIGH — the `callback.ts` regex rewrite drops specific error toasts.** Today a malformed payload answers with `"Invalid callback data"` (`callback.ts:39`) or `"Invalid request id"` (`callback.ts:47`). A `bot.callbackQuery(/^askuser:([A-Za-z0-9_-]+):(\d+)$/)` matches only well-formed payloads; everything else falls to the generic catch-all ack, losing both toasts. The proposal also never said where `resume:` lands. **Resolution: dropped from Batch 5.** It was a ~18-line shrink that trades away user-facing error specificity and touches the charset guard protected by no-cut #19. Not worth it.

5. **MEDIUM — `csvEnv` is not a clean fold.** The three splitters are not parallel: `ALLOWED_USERS` (`config.ts:37`) maps `parseInt` + `isNaN` filter; `ALLOWED_PATHS` (`config.ts:76`) falls back to a pre-built **array**, not a CSV string, and drops falsy entries; `THINKING_*` (`config.ts:136`) lowercases and trims but keeps empty entries. A helper covering all three needs a map fn, a filter fn, and an array-or-string fallback — more surface than the ~9 lines it removes, on three security/UX-relevant env vars. **Resolution: dropped from Batch 5.**

6. **Confirmed sound, no change:** `setTitleIfNew` (identical truncation and `isActive` gate at all 5 sites; only the seed differs and it stays caller-side), `rateLimitOrReply` (identical string and check→audit→reply→`markFailed` ordering at all 6; `document.ts:537`/`561` are true mutually-exclusive siblings so the hoist holds), `withMessageText` via `new Context()` (grammY's constructor assigns only `update`/`api`/`me` as own props; `@grammyjs/files` hydration rides on the shared `Api` transformer, not a per-context property), the A1 `BlockList` rejection, A2, and the Batch 3→4 ordering.

### Open risk — accepted or fixed before merge

The per-batch gate (`bun run typecheck` + `bun test`) **cannot catch findings 1, 3, or 4.** There is no `text.test.ts`, `photo.test.ts`, `video.test.ts`, `media-group.test.ts`, or `callback.test.ts` — and Batch 4/5's dedup work touches exactly those five files. The suite stays green through every regression above.

Batch 2 (Dockerfile, `.dockerignore`) is outside the gate entirely — it needs a real `docker build` plus image inspection to confirm the ~469 MB claim.

Before Batch 4/5 merge, one of: add smoke coverage for the five untested handlers, or run a live-bot pass over text / photo / video / album / button paths. Batch 2 needs its own `docker build` check.

### Consequence of decision 3

The `registerTool` rewrite is the plan's only accepted behavior change beyond the `video.ts` fix. Malformed MCP input moves from JSON-RPC `-32603` with a custom message to `-32602` carrying zod validation text. Valid calls are byte-identical (probed). `bun test` will not catch a regression here — neither MCP server has a test. Verify by calling each tool once through a live session before merging.
