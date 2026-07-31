# Register remainder — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining items of `docs/open-questions-2026-07-31.md` — fixing the two
that are real defects, correcting the register where investigation contradicted it, and
repairing the two homelab gaps found while shipping 1.27.23.

**Architecture:** Three independent groups. Bot-repo code changes (tasks 1-2) each ship with
their own test and commit. Register corrections (task 3) are documentation only. Homelab
changes (tasks 4-5) touch `deployment.yaml` and the fork's `Dockerfile`, and deploy through
Flux like any other bump.

**Tech Stack:** Bun 1.3.14 + `bun:test`, TypeScript strict, grammY 1.45.1, k3s + Flux, SOPS.

## Global Constraints

- Gate is `bun run typecheck && bun test`. **Never below 410 pass / 1312 expect() / 24 files.**
- One single-line commit per item. `git status --short` before every commit — the index is
  committed whole, not the paths passed to `git add`.
- No "Generated with Claude Code" footer, no `Co-Authored-By`.
- Mutation-test every fix against the exact scenario it claims to close. Anchor the mutation
  on the code construct, not the first textual match. Verify each mutant BOTH applied and
  compiles. Never pipe a mutation script into `head` — it SIGPIPEs before the restore.
- Codex review before each commit: STATIC git-only, foreground, re-review after acting.
  Sweep first with `~/.agents/skills/_shared/codex-hygiene.sh --apply`.
- If commit signing fails with `failed to write commit object`, 1Password is locked — retry
  with `git -c commit.gpgsign=false commit`, do not stop to ask.
- Never delete commented-out code or section banners.

---

## Findings that changed the plan

Every item below was verified against the code or the running system before being scheduled.
Four of the eight turned out to differ from the register.

| # | Register said | Investigation found | Verdict |
|---|---|---|---|
| 14 | `send_file` MCP validates no paths | True, **but the bot enforces** at `src/handlers/streaming.ts:276` (`if (!isPathAllowed(filePath))`) | Defense-in-depth only — **don't duplicate** |
| 15 | Astral ignorables "cannot be" covered — no `u` flag | **Wrong.** A surrogate-pair + lookbehind pattern rejects U+E0100-U+E01EF while still accepting emoji, U+1F100, U+1F1E6 | Correct the comment, **don't ship the pattern** |
| 16 | Reopen only if the archive feature is used | **3 `ARCHIVE` audit events** in 13,377 lines on the live pod | Keep the feature, evidence recorded |
| 18 | `net.BlockList` rejected, needs differential fuzz | Unchanged | Stays rejected — the fuzz harness is YAGNI |
| 19 | "Real gap **when** `BASH_SANDBOX_ENABLED=false`" | That **is** the production configuration — homelab `deployment.yaml` sets `BASH_SANDBOX_ENABLED=false` because bubblewrap needs user namespaces the pod's `seccompProfile: RuntimeDefault` blocks | Register understates it; see decision D2 |
| 20 | `photo.ts`/`video.ts` untested; item 8 added `run-prompt.ts`, `commands.ts` | `video.ts` is **absent from the coverage table entirely** — no test loads it. `document.ts` is 16.63 % of lines, worse than `commands.ts` at 13.23 % but far larger | Test `video.ts`; record the real numbers |
| 23 | `mcp-config.example.ts` hides the repo's own servers | Unchanged | Owner's call — **decided D1 2026-07-31: both enabled** |
| 25 | `/var/folders/` can never match | **Confirmed by spike:** `isPathAllowed(TMPDIR)` is `false`; `realpath` gives `/private/var/folders/…` | Fix |

### Spike record

- **Item 25** — `TELEGRAM_BOT_TOKEN=x TELEGRAM_ALLOWED_USERS=1 bun -e` calling `isPathAllowed`:
  `TMPDIR=/var/folders/01/…/T/` → `realpath=/private/var/folders/01/…/T` → `allowed=false`,
  while `/tmp/x` → `true`. ✅ verified
- **Item 15** — scratch spike over both patterns. Current accepts a U+E0100-only label; the
  candidate `(?:[^BLANKS󠄀-\uDDEF]|\uDB40(?![\uDD00-\uDDEF])|(?<!\uDB40)[\uDD00-\uDDEF])`
  rejects it and still accepts `😀`, `🄀` (U+1F100, whose low surrogate sits in the excluded
  range), `🇦`, and the non-VS tag space U+E0020. ✅ verified. First candidate without the
  lookbehind failed — the low surrogate alone satisfied the negated class.
- **Item 16** — `grep -o 'ARCHIVE[A-Z_]*' /home/akhozya/data/audit.log | sort | uniq -c` on the
  live pod → `3 ARCHIVE`. Written by `src/handlers/document.ts:371`. ✅ verified
- **Item 20** — `bun test --coverage`: `photo.ts` 0.00 %/10.66 %, `run-prompt.ts` 0.00 %/13.89 %,
  `commands.ts` 58.33 %/13.23 %, `document.ts` 54.17 %/16.63 %, all files 83.58 %/78.82 %.
  `video.ts` produced **no row at all**. ✅ verified
- **Item 19** — `deployment.yaml` states the reason beside the `BASH_SANDBOX_ENABLED` env entry. ✅ verified

### Assumptions and cut corners

| Confidence | Claim |
|---|---|
| ✅ | Every row in the two tables above was read from source or run against the live system this session. |
| ✅ | The `!video` and oversized guards at `src/handlers/video.ts:42-54` return before any module-level dependency that would need stubbing. The rate-limit branch at `:56` does not, and is out of scope — see task 2. |
| 🟡 | JSON Schema `pattern` is ECMA-262, so lookbehind is *specified*, but MCP clients validate with assorted libraries (Python `jsonschema` on `re`, Go) that do not implement it. Not tested against a real third-party client — this is the reason task 3 corrects the comment instead of shipping the pattern. |
| ⚠ | Task 2 covers the two size/presence guards **and** the download-failure path, which a `ctx` without `getFile` reaches for free. It does **not** cover the rate-limit branch or the happy path — the latter needs `session.sendMessageStreaming` stubbed, and `text.test.ts:7-9` warns `mock.module` leaks across files in Bun 1.3.14 (though `session-mcp-ui.test.ts` uses it successfully with an `afterAll` restore). Deliberately out of scope — stated, not hidden. |

---

## Task 1: Item 25 — macOS `TMPDIR` can never be allowed

**Files:**
- Modify: `src/config.ts:227`
- Test: `src/security.test.ts`

**Interfaces:**
- Consumes: `isPathAllowed` from `src/security.ts`, `TEMP_PATHS` from `src/config.ts`
- Produces: nothing new — `TEMP_PATHS` gains one entry

`canonicalize()` resolves every path before matching. On macOS `/var/folders/…` resolves to
`/private/var/folders/…`, so the `/var/folders/` entry matches nothing and the platform's own
`TMPDIR` is rejected. This is the same reason `/tmp/` and `/private/tmp/` are *both* listed.
Fail-closed, so an over-block rather than a hole — but it silently breaks any deployment that
points `TEMP_DIR` at `$TMPDIR` on macOS.

- [ ] **Step 1: Write the failing test**

In `src/security.test.ts`: `tmpdir` is **already imported** at line 3 and `realpathSync` is
not — extend the existing `fs` import at line 2 rather than adding a second one, and add
`isPathAllowed` to the destructured `./security` import at line 15, which currently pulls only
`evaluateToolUse`, `checkCommandSafety`, `isProtectedControlFile`, `isCredentialPath`:

```ts
// line 2 becomes:
import { symlinkSync, mkdirSync, rmSync, realpathSync } from "fs";

// line 15 becomes:
const { evaluateToolUse, checkCommandSafety, isProtectedControlFile, isCredentialPath, isPathAllowed } =
  await import("./security");
```

Then add the tests:

```ts
test("the platform temp dir is allowed under its canonical spelling", () => {
  // canonicalize() resolves before matching, so /var/folders/... arrives as
  // /private/var/folders/... — the unprefixed entry can never match, exactly as
  // /tmp/ and /private/tmp/ are both listed for.
  expect(isPathAllowed("/private/var/folders/ab/cd/T/telegram-bot/x.jpg")).toBe(true);
});

test("isPathAllowed accepts the real TMPDIR this process was given", () => {
  expect(isPathAllowed(`${realpathSync(tmpdir())}/telegram-bot-probe`)).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test src/security.test.ts -t "platform temp dir"`
Expected: FAIL — `expect(false).toBe(true)`.

- [ ] **Step 3: Add the canonical spelling**

In `src/config.ts:227`:

```ts
// Both spellings of each: canonicalize() resolves before isPathAllowed matches, so on
// macOS /tmp and /var/folders arrive under /private and the bare forms never match.
export const TEMP_PATHS = [
  "/tmp/",
  "/private/tmp/",
  "/var/folders/",
  "/private/var/folders/",
];
```

- [ ] **Step 4: Run the test and the full gate**

Run: `bun test src/security.test.ts -t "platform temp dir"` → PASS
Run: `bun run typecheck && bun test` → **≥ 412 pass**, 0 fail

- [ ] **Step 5: Mutation-test the fix**

Delete the `"/private/var/folders/"` entry, re-run `bun test src/security.test.ts`, restore.

**Only the first test is a reliable mutant-killer.** The second depends on where `tmpdir()`
points: on macOS it resolves under `/private/var/folders/` and dies with the mutant, but on
Linux it is `/tmp`, already matched by the existing `/tmp/` entry, so it passes either way.
Expect one kill on Linux and two on macOS — treat a single kill as success, not as a vacuous
test.
Verify the mutant applied (`grep -c 'private/var/folders' src/config.ts` → `0`) and that
`bun run typecheck` still passes, so a compile error is not being mistaken for a kill.

- [ ] **Step 6: Codex review, then commit**

```bash
~/.agents/skills/_shared/codex-hygiene.sh --apply
git status --short
git commit -m "Allow the canonical spelling of the platform temp dir" -- src/config.ts src/security.test.ts
```

---

## Task 2: Item 20 — `video.ts` is the one handler no test loads

**Files:**
- Create: `src/handlers/video.test.ts`
- Test: itself

**Interfaces:**
- Consumes: `handleVideo` from `src/handlers/video.ts`
- Produces: nothing — test-only

`video.ts` produced no coverage row at all, which means a coverage threshold would never flag
it. The guards at `src/handlers/video.ts:42-54` return before touching `downloadTelegramFile`
or `session`, so they need only a fake context. Follow the idiom in
`src/handlers/text.test.ts:7-9`: no `mock.module`, build a fake `ctx`.

**Scope, stated precisely:** this covers the missing-video guard and the size cap. It does
**not** cover the rate-limit branch at `:56` — that calls `rateLimitOrReply`, whose own module
is already at 100 % functions / 100 % lines in the coverage table. Re-testing it through
`video.ts` would exercise logic that is covered where it lives, at the cost of a test that has
to exhaust a shared token bucket.

- [ ] **Step 1: Write the tests**

Not red-green: `video.ts` already behaves correctly, and these tests characterise behaviour
that has never been exercised. The red-green signal comes from the mutation step instead.

```ts
import { expect, test } from "bun:test";

const { handleVideo } = await import("./video");

interface Recorded {
  replies: string[];
  reactions: string[];
  edits: string[];
}

const rec = (): Recorded => ({ replies: [], reactions: [], edits: [] });

// No `ctx.getFile` — download.ts:12 calls it on the context, not on `api`. Its absence
// makes downloadTelegramFile throw, which is the download-failure path the handler
// already catches, and the cheapest way to prove a call got past the size guard
// without stubbing a module.
const makeCtx = (video: unknown, r: Recorded): any => ({
  from: { id: 1, username: "tester" },
  chat: { id: 100 },
  msg: { message_id: 5 },
  message: video === undefined ? {} : { video },
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

// Unreachable through routing — src/index.ts:90-91 registers this handler on
// `message:video` and `message:video_note`. The guard also covers `!userId` and
// `!chatId`, and pins the behaviour if the registration is ever widened.
test("a message with no video returns before spending a reaction", async () => {
  const r = rec();
  await handleVideo(makeCtx(undefined, r));
  expect(r.replies).toEqual([]);
  expect(r.reactions).toEqual([]);
});

// file_size is checked BEFORE the download so an oversized clip costs no transfer.
test("an oversized video is refused before it is downloaded", async () => {
  const r = rec();
  await handleVideo(makeCtx({ file_id: "v1", file_size: 51 * 1024 * 1024 }, r));
  expect(r.replies).toEqual(["❌ Video too large. Maximum size is 50MB."]);
  // 👀 then 👎: received, then failed. Seeing only 👎 would not prove the handler
  // acknowledged the message first.
  expect(r.reactions).toEqual(["👀", "👎"]);
  // Nothing was downloaded, so the download-failure edit never happened.
  expect(r.edits).toEqual([]);
});

// The check is `>`, not `>=`, so exactly at the cap must pass the guard. Proven by
// where it stops instead: the "Downloading" reply, then the download-failure edit.
test("a video exactly at the cap passes the size guard", async () => {
  const r = rec();
  await handleVideo(makeCtx({ file_id: "v2", file_size: 50 * 1024 * 1024 }, r));
  expect(r.replies).toEqual(["📹 Downloading video..."]);
  expect(r.edits).toEqual(["❌ Failed to download video."]);
});
```

- [ ] **Step 2: Run them**

Run: `bun test src/handlers/video.test.ts`
Expected: **all three PASS.** The third does not throw — `handleVideo` catches the
`downloadVideo` rejection at `src/handlers/video.ts:65-74`, marks failure, edits the status
message and returns normally. That caught path is exactly what the assertions read, which is
why the test can prove the boundary without stubbing a module.

- [ ] **Step 3: No implementation change**

This task adds tests only. `video.ts` is not modified. If a test reveals a defect, stop and
raise it rather than folding a fix into a coverage task.

- [ ] **Step 4: Confirm the coverage row now exists**

Run: `bun test --coverage 2>&1 | grep 'handlers/video.ts'`
Expected: a row appears where there was none. Record its two percentages in the register.

- [ ] **Step 5: Mutation-test**

Change `>` to `>=` at `src/handlers/video.ts:48`, confirm the boundary test fails, restore.
Then change the cap constant at `:19` to `500 * 1024 * 1024`, confirm the oversized test
fails, restore. Verify each mutant applied and compiles before believing either result.

- [ ] **Step 6: Codex review, then commit**

```bash
git status --short
git commit -m "Cover the video handler's guard clauses" -- src/handlers/video.test.ts
```

---

## Task 3: Correct the register and the one wrong comment

**Files:**
- Modify: `ask_user_mcp/server.ts:42-45`
- Modify: `docs/open-questions-2026-07-31.md`, the "Tier 3 — remaining" table

No behaviour changes. Two separate problems, one commit each.

- [ ] **Step 1: Correct the "cannot be" overclaim**

`ask_user_mcp/server.ts:42-45` currently asserts astral default-ignorables "are NOT covered
and cannot be". The spike disproves the second half. Replace with:

```
 * Astral default-ignorables (U+E0100 and friends) are NOT covered. Not because a pattern
 * cannot reach them — without the `u` flag it matches UTF-16 code units, so
 * `(?:[^<blanks>󠄀-\uDDEF]|\uDB40(?![\uDD00-\uDDEF])|(?<!\uDB40)[\uDD00-\uDDEF])`
 * rejects a VS17-only label while still accepting emoji and U+1F100. It needs lookbehind,
 * which ECMA-262 specifies but not every JSON Schema validator implements, and this schema
 * is published to MCP clients. That is an untested portability risk, not a measured
 * failure — no third-party client was tried. It is still the wrong trade: a client that
 * cannot compile the pattern loses the whole tool, while the cost of leaving this uncovered
 * is one blank button. A pattern rather than a refinement precisely so the published schema
 * and the enforced rule stay the same object.
```

- [ ] **Step 2: Run the gate**

Run: `bun run typecheck && bun test` — comment-only, so the figure must be **unchanged from
whatever tasks 1-2 left** (5 new tests, so expect ~415 pass). Do not compare against 410; that
baseline is stale once task 1 lands.

- [ ] **Step 3: Commit**

```bash
git commit -m "Say why astral ignorables are uncovered, not that they cannot be" -- ask_user_mcp/server.ts
```

- [ ] **Step 4: Rewrite the "Tier 3 — remaining" table**

The table is stale, and omits 25 entirely — 25 lives in the "Found while working tier 3"
table, not in this one. Replace rows 14-23 with the verdicts from *Findings
that changed the plan* above, carrying each item's evidence (file:line, or the command and its
output). Keep every "Why it was left" note that is still true; do not delete the section
banners.

The three already-done rows are **not** in that findings table — take them from here:

| # | Disposition | Evidence |
|---|---|---|
| 17 | Done, no code change | Settled by the live pass; two unacknowledged `/restart` messages produced exactly two restarts, then flat 45 s. Already written up under "Also settled by the live pass" |
| 21 | Done | `ce60a64` — "Write an audit record only through a descriptor proved private" |
| 22 | Done | Merged 2026-07-31. Not one SHA: `main` was fast-forwarded to the branch tip `214ab9a`, then merged with `origin/main` twice as Renovate landed lockfile PRs #52-#54 mid-push. `git merge-base --is-ancestor 214ab9a` is true for both merge commits; the pushed tip is `3d11819`. Cite the branch tip and the pushed tip, not a single merge |

- [ ] **Step 5: Update the gate line**

The gate history sits under "Working rules for whoever picks this up" in
`docs/open-questions-2026-07-31.md`. Append the new figure once tasks 1-2 have landed.

- [ ] **Step 6: Commit**

```bash
git commit -m "Record what the tier-3 remainder turned out to be" -- docs/open-questions-2026-07-31.md
```

---

## Task 4: Codex auth rots silently in the pod

**Files:**
- Modify: `~/source-code/homelab/apps/claude-telegram/deployment.yaml` (the restart-card block near line 152)

Codex auth was dead from ~Jul 6 to Jul 31 and nothing said so — it surfaced only when the bot
complained mid-task. The seed is `only if absent`, so a stale PVC copy shadows the secret on
every restart and no restart ever repairs it. The restart card already reports CLI, SDK and
Codex versions; adding auth status turns a month of silence into a line you see each restart.

- [ ] **Step 1: Read the current card construction**

Run: `grep -n 'CLI=\$' -A 16 ~/source-code/homelab/apps/claude-telegram/deployment.yaml`
It builds `MSG` from `CLI`, `SDK`, `CODEX` via `printf` into a markdown table. Anchored on
the code, not a line range — this file grows, and the range this step first carried had
already stopped covering the block by the time the step was done.

- [ ] **Step 2: Capture auth status alongside the version**

```bash
CODEX=$(codex --version 2>/dev/null || echo "missing")
# Capture first, then branch on emptiness. `cmd | head -1 || echo` cannot work: the
# pipeline's status is head's, and head succeeds on empty input, so the fallback never
# fires and a blank cell ships instead of the warning that is the whole point.
CODEX_AUTH=$(codex login status 2>/dev/null | head -1)
[ -n "$CODEX_AUTH" ] || CODEX_AUTH="NOT LOGGED IN"
```

Add a `| Codex auth | \`%s\` |` row to the `printf` format and pass `"$CODEX_AUTH"`.

- [ ] **Step 2b: Prove the fallback actually fires**

Run both branches locally before committing — an untested fallback is how this rotted in the
first place:

```bash
CODEX_AUTH=$(codex login status 2>/dev/null | head -1); [ -n "$CODEX_AUTH" ] || CODEX_AUTH="NOT LOGGED IN"; echo "[$CODEX_AUTH]"
CODEX_AUTH=$(nonexistent-command 2>/dev/null | head -1); [ -n "$CODEX_AUTH" ] || CODEX_AUTH="NOT LOGGED IN"; echo "[$CODEX_AUTH]"
```
Expected: `[NOT LOGGED IN]` from the second. The first prints `[Logged in using ChatGPT]`
only where `codex` is on `PATH` — it is in the pod, and was **not** in the shell this was
verified in, which is why both lines returned the fallback there. For contrast, the broken
form returns `[]`:

```bash
BAD=$(nonexistent-command 2>/dev/null | head -1 || echo "NOT LOGGED IN"); echo "[$BAD]"   # -> []
```
Both forms were run; the empty result above is observed output, not a prediction.

- [ ] **Step 3: Validate before committing**

```bash
cd ~/source-code/homelab
yamllint apps/claude-telegram/deployment.yaml
out=$(mktemp); kustomize build --enable-helm apps > "$out"
yq eval 'del(.sops)' "$out" | kubeconform -strict -ignore-missing-schemas \
  -kubernetes-version 1.36.2 -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' -summary
rm -f "$out"
```
Expected: yamllint exit 0 (four pre-existing line-length warnings at lines 91-159 are not
yours), kubeconform `Valid: 215, Invalid: 0`.

- [ ] **Step 4: Commit, push, reconcile, verify**

```bash
git status --short
git commit -m 'Report codex auth status on the restart card'
git push origin main
flux reconcile kustomization apps --with-source --timeout=4m
kubectl -n claude-telegram rollout status deploy/claude-telegram --timeout=300s
```
Then confirm the new row appears in the Telegram restart card, and that it reads
`Logged in using ChatGPT` rather than the fallback.

---

## Task 5: Dockerfile ARG drift

**Files:**
- Modify: `Dockerfile:30` (`KUBECTL_VERSION`)

Renovate does not manage `ARG`s, so these drift silently. `KUBECTL_VERSION` is `v1.36.1`
against a `v1.36.2+k3s1` cluster. `FLUX_VERSION` is `2.9.2` against cluster `2.9.0` — the
client is *ahead*, which is the supported direction. Both are minor-matched, so this is
within the stated policy; it is hygiene, not a fix.

- [ ] **Step 1: Confirm the live cluster versions rather than trusting this document**

```bash
kubectl version -o json | jq -r '.serverVersion.gitVersion'
flux version --client=false 2>/dev/null | head -3
```

- [ ] **Step 2: Bump only kubectl**

Set `ARG KUBECTL_VERSION=v1.36.2` in `Dockerfile:30`. Leave `FLUX_VERSION` alone and say why
in the commit body if the repo's style allows one — a client ahead of the server is fine.

- [ ] **Step 3: This ships with the next image, not on its own**

Do not build an image solely for this. Fold it into the next release; the build procedure is
in the homelab memory `project_claude_telegram.md` under the local escape hatch, and GHA is
still billing-dead (`steps=0`).

- [ ] **Step 4: Commit**

```bash
git commit -m "Match the kubectl pin to the cluster's minor" -- Dockerfile
```

---

## Decisions for the owner — not mine to make

**Both were decided on 2026-07-31, as recommended.** D1: the repo's own two MCP servers are
enabled in `mcp-config.example.ts`; the third-party entries stay commented. D2: the Bash
denylist is left alone and item 19 stays open as a standing ceiling. The reasoning below is
what was put to the owner, kept as written.

**D1 — Item 23: `mcp-config.example.ts` hides the repo's own two servers.** Copy the example
and `ask_user`/`send_file` are silently absent, sitting commented out beside third-party
entries that need external setup. It is an outward-facing product default. Options: enable
both by default (they need no external setup and are the repo's own), or leave commented and
add a line to the README saying so. **Recommendation: enable both** — a feature the repo
ships and tests should not be off by default.

**D2 — Item 19: extend the Bash denylist, or leave the ceiling documented?** The register
says "real gap **when** `BASH_SANDBOX_ENABLED=false`". That is production:
homelab `deployment.yaml` sets `BASH_SANDBOX_ENABLED=false` because bubblewrap needs user namespaces the pod's
`seccompProfile: RuntimeDefault` blocks. So `tee`, `dd of=`, `cp`, `mv`, `find -delete` are
unparsed in the deployed configuration.

**Recommendation: leave it, and correct the register's wording — but keep it open as a
standing ceiling, not closed.** For *this* deployment the compensating control is real and
deliberate: `readOnlyRootFilesystem` confines writes to mounted paths, caps are dropped, egress
is policed, and the only writable surfaces (the home PVC and `/tmp`) are already inside
`ALLOWED_PATHS` and `TEMP_PATHS`. `rbac.yaml`'s own header states the bot is
cluster-admin-equivalent by design, so an in-process denylist is not the boundary and cannot be
made into one. Extending it means parsing target arguments for five more commands with awkward
shapes (`mv a b c dir`, `cp -r`, `find … -delete`), and a false positive blocks legitimate work
inside `ALLOWED_PATHS`.

**But that reasoning is deployment-specific and must not be written up as a general
resolution.** Anyone running this bot outside a container, or with the sandbox off and no
equivalent confinement, still has an unparsed write path. `SECURITY.md:116` already says the
denylist is "best-effort only and trivially bypassable by construction… Real containment comes
from Layers 3, 4 and 5, plus running the bot in a container" — the register should point at
that sentence rather than restate the gap as conditional on a flag. Record it as an accepted
ceiling **for the containerised deployment**, and leave the item standing.

---

## Not in this plan

- **GitHub billing.** Excluded at your instruction. Until it is fixed every ship is a manual
  local build; the procedure is recorded in homelab memory.
- **`document.ts` at 16.63 % of lines.** The largest untested surface in the repo (597 lines)
  and a bigger gap than anything item 20 names. Deliberately out of scope — it is a new
  item, not a register remainder. Raise it as item 27.
- **Astral-ignorable pattern.** Spiked and working; not shipped, for the client-validator
  reason in task 3.

---

## Task 6 (deferred): audio and video transcription — needs its own plan

Raised mid-session. This is a **new subsystem, not a register remainder**, and it is larger
than everything above put together. Recorded here so the investigation is not lost, but it
should be planned separately — mixing it in would make every task above wait on it.

### What the investigation found

- **`video.ts:4` promises something that does not exist.** Its docstring says videos are
  "passed to video-processing skill for transcription". The pod carries **41 skills and not
  one** matching video/audio/whisper/transcribe/media. The handler writes
  `Please transcribe it for me.` into the prompt and hands over a path, with no tool in the
  image able to do it. ✅ verified in-pod
- **Audio and voice have no handler at all.** `src/index.ts` replies inline that
  speech-to-text is unsupported (per `AGENTS.md`). So this is one feature with two entry
  points, only one of which is even wired up.
- **musl is the binding constraint, exactly as you said.** Spiked against
  `oven/bun:1.3-alpine`:

  | Package | Result |
  |---|---|
  | `ffmpeg` | **`6.1.2-r2`, packaged** — one `apk add`, no build |
  | `whisper` | **not packaged** |
  | `py3-torch` | **absent** — so `openai-whisper` and `faster-whisper` are both out; their wheels are manylinux and neither publishes musllinux |
  | `cmake` / `g++` / `make` | `3.31.7-r1` / `14.2.0-r6` / `4.4.1-r3` — present |

  **whisper.cpp is the only musl-native option**: C/C++, no Python, builds in a stage that
  the runtime image does not keep.

- **Resources.** The `claude-telegram` container is limited to **2 CPU / 2Gi** today
  (requests 100m/256Mi). Node headroom is ample — `worker-node` 32 CPU/64 GB, `worker-node-2`
  16 CPU/31 GB, both at ~17 % memory. Raising the limit is a scheduling question, not a
  capacity one. ✅ verified
- **Egress is open on 80/443** (`networkpolicy.yaml`, `0.0.0.0/0` with RFC1918 `except`), so
  fetching a model at runtime **is** possible. I had assumed it was blocked; it is not. Both
  bake-into-image and download-to-PVC are viable. ✅ verified

### Assumptions still to spike before building

| Confidence | Claim |
|---|---|
| ✅ | Everything in the two lists above. |
| 🟡 | whisper.cpp compiles cleanly against musl with only `cmake`/`g++`/`make`. Widely reported, **not built here yet** — this is the first thing to spike, and it decides the whole approach. |
| ⚠ | RAM per model (`base.en` ≈ 142 MB on disk, `small.en` ≈ 466 MB, `medium.en` ≈ 1.5 GB) and the inference overhead on top. Untested. `medium` will not fit 2Gi; `base` should. Numbers from recollection — **measure, do not trust these**. |
| ⚠ | Transcription wall-clock at 2 CPU. Unknown. A long clip may outlast Telegram's patience and the bot's own status-message cadence, which would change the design from synchronous to job-plus-callback. |

### Shape of the work, once spiked

1. **Spike first:** build whisper.cpp in an alpine container, transcribe a 30 s sample, record
   peak RSS and wall-clock. That single probe decides model size, CPU limit and whether the
   handler can stay synchronous.
2. Dockerfile: `apk add ffmpeg`, plus a build stage for whisper.cpp; copy only the binary and
   one model into the runtime image. Current image is 616 MB — note the GHCR anonymous-pull
   throttle that caused a 28-minute outage at 742 MB, now mitigated by `imagePullSecrets` but
   still a reason not to bake `medium`.
3. `deployment.yaml`: raise the `claude-telegram` limits. Set them from the measured peak, not
   from a guess.
4. Bot: an audio/voice handler mirroring `video.ts`, registered in `src/index.ts`, replacing
   the current "unsupported" reply.
5. A skill that actually wraps `ffmpeg | whisper-cli` so the docstring in `video.ts:4` becomes
   true — or correct that docstring if the design ends up calling the binary directly.

**Recommendation:** do the spike in step 1 before writing the plan. Its numbers determine
almost every other decision, and it is an afternoon's work to get wrong by guessing.

## Execution record — where reality differed from the plan

Written after executing tasks 1-5 on 2026-07-31. Four steps did not survive contact.

| Task | Plan said | What shipped, and why |
|---|---|---|
| 1 | Add `"/private/var/folders/"` beside the bare entry | **Rejected in review, correctly.** That prefix also opens `/private/var/folders/<hash>/C`, the user's cache directory, which is not temp. The per-user hash makes a narrow static prefix impossible, so `TEMP_PATHS` now carries the canonical `tmpdir()` computed once at module eval, and the dead `/var/folders/` entry is gone rather than completed. Two tests, one per direction: TMPDIR allowed, the `C` sibling denied |
| 1 | — | The catch-branch comment was wrong twice before it was right. "Matches nothing" is false: `resolvePhysical` preserves a missing tail, so `TMPDIR=/nonexistent/foo` **does** match its own descendants. "Agree until it becomes a symlink" is also too narrow: a missing path under macOS's symlinked `/var` disagrees immediately. Both spiked, not reasoned |
| 2 | The at-cap test proves the size guard was passed | **False, and proven false.** Deleting the guard outright by exact-string match leaves that test passing — it discriminates `>` from `>=`, nothing more. The oversized test is the one that covers deletion. Comments and test names now say which is which |
| 4 | `codex login status 2>/dev/null \| head -1` | **Would have shipped a card that always read `NOT LOGGED IN`.** `codex login status` writes its answer to **stderr**; stdout is empty. Verified in-pod both ways before committing: `2>&1` yields `Logged in using ChatGPT`, `2>/dev/null` yields nothing. The plan's own warning about untested fallbacks applied to the plan |
| 5 | Bump kubectl only — flux client 2.9.2 is *ahead* of cluster 2.9.0 | **Premise was stale.** Live `flux version --client=false` is **2.9.3**, so the pinned client was *behind*. Both pins bumped: `KUBECTL_VERSION=v1.36.2`, `FLUX_VERSION=2.9.3`. All four upstream artifacts (binary, sha256, tarball, checksums) confirmed reachable before committing |

## Execution order

Tasks 1 and 2 are independent and can run in either order. Task 3 depends on both, since it
records their coverage figures and gate numbers. Tasks 4 and 5 are homelab-side and depend on
nothing here — task 4 deploys on its own, task 5 waits for the next image.
