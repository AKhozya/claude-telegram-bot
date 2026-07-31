# Open questions — 2026-07-31

What the `simplify-2026-07` work did not establish. Written at branch tip `986eef5`,
unmerged, gate **345 pass / 1097 expect() / 22 files**, typecheck 0.

Everything here is self-reported by the agent that did the work. Verify against the code
before acting: it was wrong about severity twice — it overstated `ask_user`'s blast radius
and missed the `/tmp` leak underneath it entirely.

Tiers 1 and 2 and part of tier 3 were worked on 2026-07-31; their entries record what each
turned out to be. Every pass makes the point again: item 1's headline claim was wrong and
hid a real defect, item 10's stated justification was wrong, item 20 is wrong, and item 13
was right about the mechanism but wrong that it failed visibly. Items 14-20 and 23 are
still as first written.

## Tier 1 — worked 2026-07-31

Gate after this pass: **351 pass / 1111 expect() / 22 files**, typecheck 0.

### 1. The rewritten MCP servers may not be wired into anything — WRONG, but it hid a real defect

Not a defect. `mcp-config.ts` is **gitignored** (`.gitignore:26`) and user-supplied, so its
absence here is by design, and the example ships every entry commented out because each one
is opt-in. Written by hand and loaded, the chain works end to end: `Loaded 2 MCP servers
from mcp-config.ts`, both reaching `session.ts:262 mcpServers: MCP_SERVERS`. Started with a
throwaway token, the bot registers everything and gets as far as `getMe` (401 on the fake
token) — so nothing before the network call is broken.

The spike did find a defect underneath, **pre-existing** (`528cb8d` only stripped comments
from it). The loader wrapped its import in `.catch(() => null)`, so a syntax error in
`mcp-config.ts` was indistinguishable from the file being absent, and the `catch` beneath it
could never be reached by an import rejection. Probed: with no config the process printed
**nothing at all** — the documented `No mcp-config.ts found` line had never once run — and
with a broken config it also printed nothing and started with zero MCP servers. Fixed in
`145db94`: absence, load failure and a missing export each say so. Five mutations, all
killed.

Residual, not fixed: a config exporting a *truthy but malformed* `MCP_SERVERS` still prints
`Loaded N` and fails later inside the SDK. Validating it would be new surface for a mistake
that is not silent.

### 2. The bot was never started — still open, blocked

Now partly answered. `bun run start` with a throwaway token loads both MCP servers, prints
its banner, registers handlers, and fails only at `getMe` with 401. Everything up to the
Telegram network call is exercised.

**Still blocked:** no real token exists on this host — no `.env`, no LaunchAgent, no
1Password entry. The live-bot pass at the end of
[simplification-plan-2026-07.md](simplification-plan-2026-07.md) cannot be run without one.
This is the only tier-1 item still outstanding.

### 3. `bun test` can delete a live bot's request files — CONFIRMED, fixed in `ab8101c`

Confirmed exactly as written, and proven rather than argued: a decoy
`/tmp/ask-user-<uuid>.json` in `pending`, backdated ten minutes, was **deleted** by a
pre-fix `bun test` and **survived** the post-fix run. The reap ran at `streaming.ts:109` and
`:118`, both ahead of the chat filter at `:120`, against a hardcoded `/tmp`.

Fixed by giving both pollers a `dir` parameter defaulting to the module constant `IPC_DIR`;
tests pass a `mkdtemp` scratch directory. Production behaviour is unchanged. An env var was
rejected: the MCP SDK inherits only `DEFAULT_INHERITED_ENV_VARS` to child servers, so an env
var might reach the reader and not the writers and split the channel. Six mutations, all
killed. The MCP protocol tests still write to `/tmp`, but they delete only their own named
fixtures — no glob, no foreign deletion.

### 4. The "tdlib never trims" proof rests on an unread tail — read; conclusion stands

The full `clean_input_string` normalizes some controls to spaces, drops CR, strips
U+2028–U+202E and some combining marks, then returns — **no trim**, confirming the guard
solves a real problem. `ReplyMarkup.cpp:566` runs it on button text and rejects only a
fully empty result; `strip_empty_characters` is never applied there.

The same file gave something better than the previous reasoning: `strip_empty_characters`
carries tdlib's own list of blank characters. Checked against the class — every entry was
already excluded except **U+FFFC**, added in `ccbc9d3`, with the comment now citing tdlib
instead of recall. Coverage of all 19 entries verified by probe, not by memory. Mutations
killed both dropping and widening the new range, the latter via a new acceptance row for
U+FFFD, which is visible and sits inside the widened range.

## Tier 2 — worked 2026-07-31

Gate after this pass: **353 pass / 1117 expect() / 22 files**, typecheck 0. Every item was
Codex-reviewed before its commit, and Codex found an overclaim of mine in four of the five
reviews — each one a sentence that said more than the code showed.

### 5. `IPC_PENDING_TTL_MS = 5 min` chosen from nothing — derivable after all, `f34028b`

The number is slack, not a measurement, but the quantity it has to clear is in the repo:
`pollFor` (`session.ts:56`) gives a new request file 400 ms of sleeps across three checks
and never looks again for that call. The comment now derives it.

Codex killed the first draft of that comment. It said a legitimate file "never comes close",
which is false: one written after the last check is never re-polled for that call, and waits
for the poll of some later `ask_user`. That is what the window actually decides — under it
the old question arrives beside the new one, over it the file is dropped rather than putting
live buttons under a dead session's question.

### 5b. The reap only runs when a poller runs — CONFIRMED, and sharper, `8dd7224`

True, and narrower than written. Both pollers are called only from the
`toolName.startsWith("mcp__ask-user")` and `mcp__send-file` branches of `session.ts:413-420`
— the only production callers — and each scans its own glob. So an idle bot reaps nothing,
and a stranded file waits for the next call **of its own kind**: an `ask_user` poll never
touches an orphaned `send-file-*.json`.

`AGENTS.md` was wrong in the same way twice, presenting `TEMP_RETENTION_HOURS` as a bound on
how long an IPC file survives. It is the age at which one becomes *eligible*. Both rows and
the config table now say so.

No timer added. A timer would sweep a shared `/tmp` while this bot is idle, which is how a
second bot on the same host loses its live requests — the defect fixed in `ab8101c`.

### 6. Unicode ranges recalled from memory — diffed at last; class was already right, `6740b48`

Diffed against `DerivedCoreProperties-17.0.0.txt`: **all 66** BMP Default_Ignorable code
points were already excluded, and the only exclusions beyond that property and JS `\s` are
exactly what the comment claims — C0/C1 controls, U+2800, U+FFFC. No gap.

"Blank in every font" is gone; tdlib's own `strip_empty_characters` is the authority, and
the docstring now records that Unicode grants this property no stability guarantee, so the
class is a transcription that a later version can outdate.

The hand-check became a gate: the 66 code points are enumerated against the **published**
JSON Schema `pattern`, and a second test refuses a label built from all 66 over the wire,
with a visible-character control so a refusal for any other reason cannot pass for the guard
working. Six mutations — five two-place edits that narrow the class *and* the asserted
pattern together, the tidy-up that passes every pre-existing test, plus a fixture-row
deletion — all killed by the new tests specifically.

Codex corrected two claims: the rejection table reaches six of the 66, not ten, and
`listTools` serialization is a separate path from the `safeParseAsync` a call goes through,
so the first test proves the advertised half only.

### 7. mtime vs `created_at` never considered — considered; mtime is right, `516d6ae`

mtime, and deliberately: the retention reap runs **before** the parse so an unparseable file
is still reapable, and a clock that has to be parsed cannot do that. The cost is real but
small — flipping an ask-user request to `sent` rewrites it and restarts its retention, at
delivery, so minutes in against a default 24 h. A send-file request is never rewritten.

Codex killed a second overclaim: the skew is not *bounded* by `IPC_PENDING_TTL_MS`, because
the age is sampled before the parse and `ctx.reply()` can cross the window before the write.

### 8. One reviewer throughout — partly answered, still open

A second reviewer of a different class ran over the branch, and found one thing Codex did
not: **item 20 below is wrong**. `bun test --coverage` puts `run-prompt.ts` at 0.00 % of
functions, so photo and video are not the only untested handlers.

| Reviewer | Scope | Result |
|---|---|---|
| `gitleaks` | 33 commits, `main..HEAD` | no leaks |
| `actionlint` | workflows | clean |
| `shellcheck` | both `scripts/*.sh` | clean |
| `knip` | exports, files, dependencies | one unused file: `mcp-config.example.ts`, which is a template |
| `bun test --coverage` | whole suite | contradicts item 20 |

Still open: no second *model* has reviewed this diff. That is a resource decision, not
something to settle unilaterally.

### 9. Batch 6's proof came from a self-written script — cross-checked, `17de0d7`

Re-run with an oracle that reads no test source: both functions in `security.ts` wrapped,
`ac93943~1:src/security.test.ts` and the converted file run against that same source,
comparing the multiset of `(arguments => return value)` pairs each suite actually produces.
**67** `checkCommandSafety` pairs and **61** `evaluateToolUse` pairs, identical before and
after, multiplicities included. `git show ac93943 --stat` confirms `security.ts` itself was
untouched by that batch.

Codex was right that "re-proved" overclaimed it, and the plan now says so: this establishes
that the same inputs are exercised, and is blind to an assertion weakened in porting, since
the recorded return value is the real one either way. The per-row mutation check covers that
half.

### 10. Test-only exports — they stand, and this register's justification was wrong

`withMessageText` is not the precedent claimed: it has a production caller at
`commands.ts:224`, so it is an internal helper that is also tested, not a test-only export.
`fileAgeMs` and `reapIfOlderThan` genuinely are test-only, and the alternative — mocking
`statSync` to drive a failing `stat` through the pollers — is more machinery than exporting
two pure functions, not less. No change.

Found while checking it (`ebb5837`): the `!Number.isFinite(ttlMs)` guard is **reachable**,
not defensive. `positiveNumberEnv` vets `TEMP_RETENTION_HOURS` and not what is derived from
it, so `1e302` is accepted and overflows to `Infinity` once multiplied into milliseconds —
where the guard makes it reap nothing rather than everything.

### 11. Docker numbers reconstructed — sound for what it was used for, `17de0d7`

The two `.bun-build` files enter only through `COPY . .`, and on the before side the
`chown -R` at `7b600c1:63` walks them into a second layer. Nothing opens them, so two files
of that size at those paths give the same **uncompressed** layer sizes, which is the unit
every figure is in. Copying them into a worktree is sound for the 126 MB it established, and
would not be for a claim about layer digests or compressed size.

The architecture caveat cannot be closed here: the only builder on this host is linux/arm64
(Rancher Desktop, no emulation). The mechanisms do not depend on the architecture; the
megabytes do. **−870 MB** is this machine's number.

## Tier 3 — worked from 2026-07-31

Gate after items 12, 13 and 24: **402 pass / 1303 expect() / 23 files**, typecheck 0.

### 12. `send_file` caption over 1024 chars is unbounded — CONFIRMED, fixed in `d7c0d71`

Real, and worse than "fails visibly": Telegram rejects the **whole send** over the limit,
so an unclipped caption costs the file it was attached to. Nothing bounded it — the MCP
schema is `z.string().optional()` and the tool description states no limit. Now clipped in
the bot, where the Telegram limits already live.

Counted in **code points**, which is the unit the limit is enforced in. Read off the
enforcing line rather than assumed: `td/telegram/MessageContent.cpp:5241` compares
`utf8_length(caption.text)` — UTF-8 lead bytes — against `message_caption_length_max`,
default 1024 (`OptionManager.cpp:112`). tdlib keeps a separate `utf8_utf16_length` for
entity offsets, so the choice is deliberate. Codex caught the first draft counting JS
`.length`, which would clip 1024 emoji Telegram accepts and could cut a surrogate pair.

The constant is pinned against the installed `@grammyjs/types` rather than itself: every
other assertion is written in terms of `TELEGRAM_CAPTION_LIMIT`, so mutating 1024 to 2048
moved code and assertions together and survived. Scoped to the four methods this bot
calls — a file-wide scan finds `sendStory`'s 0-2048 and concludes the cap varies.

Eight mutations, all killed.

### 13. `send_file` queues an unreadable file — CONFIRMED as stated, fixed elsewhere, `c8bb6cf`

Re-probed and exact: mode 000, `Bun.file().size` 7, `text()` and grammY's `InputFile` both
`EACCES`. The register's reasoning holds and **no queue-time check was added** — it would
be TOCTOU, it duplicates what the send already discovers, and doing it honestly means
reading up to 50 MB.

What was wrong was "fails visibly". The reply named only the file, so the cause reached
nobody: the tool is fire-and-forget, the model is told "queued", and the reason lived only
in stderr. Now the errno is reported — lifted off `.error` by name, never the nested
message, because grammY drops that message unless `sensitiveLogs` is on and it can carry
the token-bearing URL (`grammy/out/core/error.js:76`). A Telegram rejection needs none of
that: `GrammyError` builds its own message as `... (error_code: description)`.

Both halves of the reply are bounded, and the unlink moved into a `finally` — `ctx.reply`
can itself reject, and the request was then left to fail again on every poll.

Five Codex rounds, each finding a defect in the last round's fix. Nine mutations, all
killed, each verified to apply **and compile** first.

### Found while working tier 3 — not in the original register

| # | Item | State |
|---|---|---|
| 24 | `autoRetry` retries an `HttpError` in an unbounded loop | **CONFIRMED, fixed in the commit below.** See the entry under it |
| 25 | `TEMP_PATHS` lists `/var/folders/` with no `/private` spelling, while `/tmp` gets both. `canonicalize` resolves `/var/folders/…` to `/private/var/folders/…` on macOS, so the entry can never match and `isPathAllowed` rejects the platform's own `TMPDIR` | Open. Fail-closed over-block, not a hole. Belongs with item 14 |

### 24. `autoRetry` retries an `HttpError` forever — CONFIRMED, fixed

Every claim re-read at the source and every one held. `call()`
(`@grammyjs/auto-retry/out/mod.js:49-68`) loops `while (res === undefined)` and never reads
`remainingAttempts`; that counter guards only the outer `do/while` over unsuccessful
**results** (`:88`). `rethrowHttpErrors` defaults false (`:39`). grammY wraps the whole
fetch race in one `catch` that produces an `HttpError` (`grammy/out/core/client.js:58`),
and a filesystem error while streaming an upload rejects into that race through
`createFormDataPayload`'s error callback (`:44`), which is how item 13's unreadable file got
there. Codex's round-5 reversal was wrong.

One claim in the original entry was **too generous to the config**: `maxDelaySeconds: 30`
does not cap the backoff either. It is only ever compared against
`result.parameters.retry_after` (`:74`); the `HttpError` backoff doubles to `ONE_HOUR`
(`:47`).

Found while verifying, and worse than the item as written: `@grammyjs/runner` has its own
`getUpdates` retry — exponential backoff, a 15 h ceiling, `throwIfUnrecoverable` for 401/409,
and a `console.error` per failure (`out/runner.js:92-115`, `:179`). Because `autoRetry`
never returns, **none of it has ever run**, including the log. So a network failure while
polling was silent as well as endless.

Fixed in `src/retry.ts`: a bounded `HttpError` retry transformer, installed by
`installRetry` together with `autoRetry({..., rethrowHttpErrors: true})`. The two are
installed in one function because each is inert alone, and in that order because it is
load-bearing — `remainingAttempts` is per invocation (`mod.js:42`), so a transport retry
placed outside `autoRetry` would refresh its 5xx budget every time the connection flapped.
An earlier draft claimed the order was unobservable; Codex disproved it, and a test now
drives a mixed sequence the two orders answer differently.

Sixteen mutations, each verified to apply **and** compile. Fifteen killed; two of those hung
the suite past 180 s, which is the production symptom. The survivor is `clearTimeout` in the
backoff's abort path: the timer firing later rejects an already-settled promise, a no-op, so
nothing in-process can observe it — it only releases an event-loop timer early. Kept.

Two clauses came out rather than being documented. `signal?.aborted` in the retry guard went
redundant the moment the backoff itself became abort-aware, and the ordering rationale was
deleted before the real one replaced it.

## Tier 3 — remaining

| # | Item | Why it was left |
|---|---|---|
| 14 | The `send_file` MCP server validates no paths; `isPathAllowed` runs only in the bot | Noted in the plan as load-bearing, never questioned as a defense-in-depth gap |
| 15 | Astral default-ignorables (U+E0100) still make blank buttons | A JSON Schema `pattern` carries no `u` flag; closing it breaks advertised-equals-enforced. A test pins the acceptance |
| 16 | Archive feature kept on inconclusive evidence | The stated way to reopen — `grep -c ARCHIVE "$AUDIT_LOG_PATH"` against the running bot — was never run |
| 17 | `/restart`'s 500 ms sleep | Batch 7 could not settle statically whether it stops a redelivered `/restart` looping. Needs a live run against the supervisor |
| 18 | `net.BlockList` for the SSRF classifier | Rejected; would need a differential fuzz test as the gate |
| 19 | Denylist misses `tee`, `dd of=`, `cp`, `mv`, `find -delete` | Real gap when `BASH_SANDBOX_ENABLED=false`. Self-documented as an accepted ceiling at `security.ts:144-149` |
| 20 | `photo.ts` and `video.ts` remain the only untested handlers — **wrong**, see item 8: coverage puts `run-prompt.ts` at 0.00 % of functions too, and `commands.ts` at 13 % of lines | — |
| 21 | The audit log is written **unredacted** under `AUDIT_LOG_JSON`; document prompts carry whole file bodies, and the `0o600` fix fails **open** when chmod fails | Recorded as an open security question, never resolved |
| 22 | Merge to `main` | Never discussed |
| 23 | `mcp-config.example.ts` ships the repo's **own** `ask_user` and `send_file` entries commented out, beside third-party examples that need external setup. Copy the example and both features are silently absent | Surfaced 2026-07-31 while disproving tier-1 #1. Not changed: it is an outward-facing product default, the user's call, not a defect to fix unilaterally |

## Working rules for whoever picks this up

- Verify each item against the code before acting. Push back with evidence rather than
  fixing on faith.
- `bun run typecheck && bun test`, never below **402 / 1303** (345 / 1097 before tier 1,
  351 / 1111 after it, 353 / 1117 after tier 2, 360 / 1135 after tier-3 #21, 390 / 1268
  after #12 and #13).
- Mutation-test every fix against the exact scenario it claims to close. Two fixes last
  session passed review and killed nothing. Anchor the mutation on the code construct, not
  the first textual match — a comment table ate eight mutations once.
- A test that asserts an error was *reported* must assert on something only the intended
  error produces. One here passed on a resolver failure while claiming to test a parse
  failure, and every mutation still died.
- One single-line commit per item. `git status --short` first.
- Do not add an `until` loop to wait for a Codex job. The dispatch already notifies; a
  finished job leaves the Active-jobs table, so a poll for its terminal status never
  matches and hangs until the session ends.
  1Password is locked — use `git -c commit.gpgsign=false commit`.
