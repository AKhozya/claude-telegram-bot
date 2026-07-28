# API surface audit — Renovate window 2026-07-06 → 2026-07-28

Scope: every Renovate PR merged in the window (#24, #30, #32–#50 — all titled
"Lock file maintenance"), checked for new grammY / Telegram Bot API / Claude
Agent SDK capability this bot should adopt.

Method: old and new package tarballs fetched with `npm pack`, `.d.ts` surfaces
set-diffed, every adoptable claim proved by a clean `bun run typecheck` against
the installed tree, and every Telegram claim cross-checked against
core.telegram.org/bots/api-changelog.

## What actually moved

Read from `bun.lock` at each merge commit and confirmed against `node_modules`.

| Package | 2026-07-06 (#24) | HEAD (0c38081) | Note |
|---|---|---|---|
| `grammy` | 1.44.0 | **1.45.1** | minor, in-range for `^1.44.0` |
| `@grammyjs/types` | 3.28.0 | **4.0.0** | **major** — Bot API 10.1 → 10.2 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.195 | 0.3.220 | 25 patch releases |
| `@modelcontextprotocol/sdk` | 1.29.0 | 1.29.0 | unchanged |
| `zod` | 4.4.3 | 4.4.3 | unchanged |
| `typescript` | 6.0.3 | 6.0.3 | unchanged |
| `@grammyjs/{runner,files,auto-retry}` | 2.0.3 / 1.2.0 / 2.0.2 | unchanged | unchanged |

TypeScript stays on 6.0.3 by decision — 7.x waits for 7.1, when the linter
ecosystem catches up. Out of scope here.

### How a Bot API major arrived through an automerged lockfile PR

`grammy@1.45.1` pins `"@grammyjs/types": "4.0.0"` **exactly**, so the types major
is carried inside a grammy *minor*. `renovate.json`'s `grammy` group covers
`grammy` + the three plugins but not `@grammyjs/types`, and the `major` rule
(3-day soak, `automerge: false`) never sees it — a transitive exact pin is not a
major *update* in its own right. `lockFileMaintenance` has `automerge: true`, so
PR #47 landed Bot API 10.2 unreviewed.

This is not a misconfiguration to fix — pinning `@grammyjs/types` separately
would break the moment grammy pins a different exact version. It is a **standing
property**: a grammy minor can widen the Telegram surface. The mitigation is
this audit, not a rule.

## Findings

### 1. Native streaming drafts are unadopted — the largest gap ⚠

`sendMessageDraft` (Bot API **9.3**, 2025-12-31) streams a partial message as a
30-second ephemeral preview; you then call `sendMessage` once to persist it.
Telegram built it for exactly what this bot does by hand.

Today `src/handlers/streaming.ts` streams by `editMessageText` on a live message
every `STREAMING_THROTTLE_MS = 500` (`src/config.ts:161`), with
`autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 })` absorbing 429s
(`src/index.ts:38`). Each tick is a real `editMessageText` on a persisted
message; a draft creates nothing and expires on its own. Whether Telegram meters
drafts more loosely than edits is **not documented** — do not assume a rate-limit
win, measure it. The grounded gains are the removed edit/delete churn and a
native streaming affordance instead of a message that visibly re-renders.

Verified signature (compiles clean against the installed tree):

```ts
api.raw.sendMessageDraft({ chat_id: 1, draft_id: 7, text: "partial", parse_mode: "HTML" });
api.raw.sendMessageDraft({ chat_id: 1, draft_id: 7 }); // empty text → "Thinking…" placeholder
```

- `chat_id` is `number` and documented "target private chat" — **private chats
  only**. Auth is by user id (`src/handlers/auth.ts`), not chat type, so a group
  chat is reachable; the existing edit-loop must stay as the fallback path.
- Reusing one `draft_id` animates the change between updates.
- Empty text became legal on 2026-05-08 — that is the "Thinking…" placeholder.
- `sendRichMessageDraft` is the rich-message equivalent.

This has been available for ~7 months and is the highest-value item here — but
claim the right payoff: a purpose-built streaming primitive and no persisted
message to edit, delete, or repair. Any rate-limit improvement is a hypothesis
until measured.

### 2. Rich `blocks` — the bot is on 10.1 markdown, `thinking` is 10.2 🟡

The bot already sends rich messages (`src/handlers/streaming.ts:238`, `:277`)
using the 10.1 shape. What 10.2 added to `InputRichMessage`:

| Field | 3.28.0 (API 10.1) | 4.0.0 (API 10.2) |
|---|---|---|
| `html`, `markdown`, `is_rtl`, `skip_entity_detection` | yes | yes |
| `blocks?: InputRichBlock<F>[]` | — | **new** |
| `media?: InputRichMessageMedia<F>[]` | — | **new** |

`blocks` brings 21 block types, including:

```ts
api.raw.sendRichMessage({
  chat_id: 1,
  rich_message: { blocks: [{ type: "thinking", text: "pondering" }] },
});
```

`InputRichBlockThinking` is a first-class rendering of model thinking — the bot
currently surfaces `block.type === "thinking"` through a generic status callback
(`src/session.ts:369`). `media` lets a rich message bind its own attachments
instead of sending them as separate messages.

Worth doing, but only after (1): the block form is a larger rewrite of
`sendRichWithFallback`, and `markdown` already covers headings/tables/code.

### 3. Ephemeral messages — new, and not applicable ✅

Bot API 10.2 (2026-07-14) added `is_ephemeral` on `BotCommand`,
`Message.ephemeral_message_id` / `receiver_user`, and five methods
(`editEphemeralMessage{Text,Media,Caption,ReplyMarkup}`, `deleteEphemeralMessage`)
— all surfaced on `ctx` by grammy 1.45.1.

The probe shows why it does not apply: `editEphemeralMessageText` requires
`receiver_user_id` alongside `chat_id`. Ephemeral messages are a **group**
feature — "group messages visible only to a specific user and the bot". Their
value is hiding a reply from other members of a shared chat. This bot's
allowlist is a set of user ids, so a group is reachable in principle, but every
authorized user is already trusted with the same Claude session; there is no
second audience to hide output from. No action.

### 4. Communities and subscriptions — not applicable ✅

`Community`, `CommunityChatAdded/Removed`, `ChatFullInfo.community`, and
`Update.subscription` (`BotSubscriptionUpdated`) are all 10.2. Communities are a
multi-chat org feature; `subscription` is paid-bot billing. Neither has a role in
a personal allowlisted bot. No action.

### 5. Claude Agent SDK tool surface — already fully classified ✅

0.3.195 → 0.3.220 added five tool schemas: `ClaudeDesign`, `ProposeSkills`,
`RefreshMcpTools`, `ReportFindings`, `SendFeedback`. All five are already in the
`REVIEWED` snapshot (`src/security.test.ts:714`, inside the tripwire `describe`
at `:694`), classified across the
2026-07-10 and 2026-07-17 audits. `bun test src/security.test.ts` → 122 pass.
`Options` is unchanged at every nesting depth — 63 top-level fields before and
after, no field added or removed anywhere in the block. No action.

The tripwire works, and its snapshot is exact: the installed `sdk-tools.d.ts`
declares 43 `*Input` tool schemas and `REVIEWED` lists 43 — no tool unreviewed,
no stale entry left behind. No tool declares an `*Output` type without a matching
`*Input`, so the regex has no blind spot today.

Two **ceilings**, neither currently biting:

- **Scope.** It reads `sdk-tools.d.ts` only. It does not watch `sdk.d.ts`, so new
  `Options` fields, `HookEvent` members, and `SDKMessage` union members pass
  silently — which is how findings 6–8 below went unnoticed until this audit.
- **Direction.** The assertion is `found − REVIEWED === []`
  (`src/security.test.ts:725`). It catches an SDK tool missing from `REVIEWED`,
  but a `REVIEWED` entry for a tool the SDK has since dropped would never fail.
  Checked by hand here: no stale entry exists.

### 6. Two new stream message types are dropped on the floor 🟡

The loop at `src/session.ts:351` branches on exactly two types —
`"assistant"` (`:366`) and `"result"` (`:480`). Other message types are not
wholly discarded: the abort check and the `session_id` capture at `:352`–`:363`
run for every event regardless of type. But nothing acts on the type itself.
Two additions to the `SDKMessage` union in this window:

- **`SDKConversationResetMessage`** — **a confirmed bug, not a maybe.** See the
  dedicated section below; `session_id` does change across a reset, the bot's
  capture guard never picks the new one up, and a user typing `/clear` in Telegram
  is enough to trigger it.
- **`SDKBackgroundTasksChangedMessage`** (`type: 'system'`,
  `subtype: 'background_tasks_changed'`, REPLACE semantics on a `tasks` array).
  `Bash` is allowed and supports `run_in_background`, so background tasks can
  exist with zero visibility on the phone. `/status` could report them.

Whether `session_id` itself changes on reset is **not verified** — the type only
declares `new_conversation_id`. Confirm before writing a handler.

### 7. Usage-limit errors render as a truncated raw string 🟡

`session.ts` stores `String(error).slice(0, 100)` on failure. The SDK now exports
four prefix tables for exactly this classification:

| Constant | Use |
|---|---|
| `USAGE_LIMIT_ERROR_PREFIXES` | 12 hard-limit strings; these *do* arrive as API errors |
| `USAGE_WARNING_PREFIXES` | approaching-limit; toast/footer only, never an error |
| `USAGE_TRANSITION_PREFIXES` | "now drawing from credits"; toast only, never an error |
| `ORG_POLICY_LIMIT_PREFIXES` | `"This service is disabled for your org"` |

Only the first and last can reach the bot's `catch`. Matching them turns a
mangled 100-char fragment into a clear phone message. Small, self-contained.

### 8. `DirectoryAdded` hook event is new ✅ (no new exposure, worth a note)

`HookEvent` gained `'DirectoryAdded'` with `source: 'slash_command' |
'register_repo_root'`. It does **not** widen this bot's file access, because no
gate in the bot consults the SDK's runtime directory list — every one of them
resolves against the static `ALLOWED_PATHS` constant:

| Surface | Gate | Source |
|---|---|---|
| Bash writes | `sandbox.filesystem.allowWrite`, strict allowlist | `src/sandbox.ts` |
| Native `Read`, `Write`, `Edit`, `NotebookEdit` | `isPathAllowed(canonical)` | `src/security.ts` |
| `Grep`, `Glob` search dir | `isPathAllowed(searchPath)` | `src/security.ts` |
| Bash reads | fail-open by design; `denyRead` blocklist only | `src/sandbox.ts` |

The last row is the pre-existing documented ceiling, and `DirectoryAdded` neither
widens nor narrows it. The bot also never sends a `register_repo_root` control
request. Audit-logging the event is optional.

### 9. Two settings worth considering ⚠ / 🟡

- **`sandbox.network.strictAllowlist`** — resolved by runtime probe, see below.
  The hang risk is **disproven**; a different and more useful fact took its place.
- **`askUserQuestionTimeout`** (`'60s' | '5m' | '10m' | 'never'`, defaults to
  never) — auto-continues Claude's questions after idle. The bot's ask-user flow
  `break`s the stream loop and waits on an inline-keyboard callback
  (`session.ts:474`), so an unanswered question parks the turn indefinitely. This
  option governs the **built-in** `AskUserQuestion` tool, not the bot's
  `mcp__ask-user` server, so it is a partial fit at best.

## Recommended order

| # | Item | Effort | Payoff | Status |
|---|---|---|---|---|
| 1 | `sendMessageDraft` streaming (private chats; keep edit-loop for groups) | medium | purpose-built streaming; drops the edit/delete churn | open — gated on the rate-limit probe |
| 2 | `USAGE_*_PREFIXES` error classification | small | readable limit messages on the phone | **done** — `describeError()` in `src/formatting.ts` |
| 3 | Extend the tripwire to `sdk.d.ts` (Options fields, `HookEvent`, `SDKMessage` union) | small | closes the gap that hid findings 6–8 | open |
| 4 | Handle `conversation_reset` | small | correct `/resume` | **done** — `src/session.ts` stream loop; `new_conversation_id` still unused |
| 4b | Handle `background_tasks_changed` | small | background-task visibility in `/status` | open — a gap, not a bug; nothing is broken today |
| 5 | Rich `blocks` incl. `thinking` | large | native thinking rendering | open |

**Shipped for 2 and 4.** `describeError(error, max)` replaces four copies of
`String(error).slice(0, N)` — one in `session.ts` (`lastError`, surfaced by `/status`) and
three user-facing replies (`text.ts`, `media-group.ts`, `callback.ts`). It matches with
`includes`, not `startsWith`: the limit sentence arrives inside an API error envelope, so it
is never at position 0 of `String(error)`, and truncating from the left showed only the
envelope. Only `USAGE_LIMIT_ERROR_PREFIXES` and `ORG_POLICY_LIMIT_PREFIXES` are consulted —
the warning and transition tables are toast-only in the CLI and never thrown.

The bot still does not adopt `new_conversation_id`, which the SDK's own doc comment says a
surface "should mount a fresh transcript under". Deliberate: whether the SDK accepts it as a
`resume:` token is untested. The fix is strictly better than the old behaviour either way —
before it, the latched guard kept the dead id forever; now the correct id is picked up from
the next event that carries one, and the only degraded case is a reset arriving as the last
event of a turn, which starts fresh rather than wrong.

`src/session-reset.test.ts` drives the real stream loop with a faked `query()` rather than
asserting on a pure helper, because the defect is an *ordering* one. Mutation-checked:
deleting the `continue` fails two of its three cases.

**Two Bun facts that test cost an hour to learn.** `mock.module` is process-global, and Bun's
test-file order is neither lexicographic nor settable — a leaked mock reaches an arbitrary,
changing set of later files. Worse, the obvious cleanups do not work: `mock.restore()` does
**not** undo `mock.module` (1.3.14), and re-mocking from the captured namespace fails too,
because `mock.module` mutates that namespace object in place. Only re-mocking from a shallow
**copy** taken before the first mock restores the real module. A test in the file guards it.

`strictAllowlist` was on this list as "resolve a possible headless hang". The probe
above closed it: there is no hang and no change to make, only a comment recorded in
`src/sandbox.ts`.

## Production incident: `xhigh` effort + thinking disabled

The bot went down at ~20:40 on 2026-07-28, mid-audit. Every message returned:

```
API Error: 400 output_config.effort 'xhigh' is not supported when thinking is
disabled on this model. Use effort 'high' or below, or enable thinking.
```

Two independently reasonable changes collided:

- Homelab `cdce0adf` pinned the deployment to `claude-opus-5` at `effortLevel:
  "xhigh"` — written into `~/.claude/settings.json` on the PVC *and* set as
  `CLAUDE_CODE_EFFORT_LEVEL`. The bot loads it via `settingSources: ["user", …]`.
- `session.ts` sent `thinking: { type: "disabled" }` for any message without a
  thinking keyword — the default path, so nearly every message.

Neither is wrong alone; the pairing is rejected. Only "think"/"ultrathink" messages
still worked, which is why it read as a total outage.

Reproduced and fixed by probe, `model=claude-opus-5`:

| effort | thinking | result |
|---|---|---|
| `xhigh` | `disabled` | **400** — exact production error |
| `xhigh` | `adaptive` | OK |
| `xhigh` | `enabled` (budget) | OK |
| `high` | `disabled` | OK |

Fix: the keyword-free default became `{ type: "adaptive" }` — "Claude decides when
and how much to think (Opus 4.6+)", accepted at every effort level. `disabled` was
a holdover from older models. Keyword paths still pin a fixed budget, unchanged.

The invariant is **never emit `disabled`**, not "the default is adaptive" — so
`getThinkingConfig()` is exported and `src/session.test.ts` asserts it directly.
Mutation-checked: restoring `disabled` fails the test.

`effortLevel` is a *settings* field, not an `Options` field, so the bot cannot
override it from `query()`. That asymmetry is the durable lesson — deployment-level
settings reach into the SDK by a path the bot's own options cannot correct.

## Resolved: `conversation_reset` silently strands `/resume`

Types alone could not say whether `session_id` changes across a reset, so the event
was triggered and the stream logged. It does change, and there are **three** distinct
ids in play:

```
conversation_reset  session_id=70ee9fe6
    new_conversation_id=af3eeebf     (neither the old nor the new session id)
system/init         session_id=5fb6c5fb   <-- CHANGED
assistant           session_id=5fb6c5fb
result/success      session_id=5fb6c5fb
```

The CLI binary's own schema and description confirm the intent — "Emitted by
`/clear`, plan-mode exit, and fresh-session flows. The surface should mount a fresh
transcript under `new_conversation_id` and reset any cached session title."
`conversation_reset` appears nowhere in the SDK's `sdk.mjs`; it originates in the
vendored CLI.

**The bug.** `session.ts:367` captures the id under `if (!this.sessionId && …)`, so
once set it is never replaced. After a reset the bot keeps the pre-reset id, persists
it to the session history, and passes it as `resume:` — reattaching to the
conversation the user just cleared.

**Reachability is not theoretical.** Only seven commands are registered
(`src/index.ts:68-74`); `bot.on("message:text")` catches everything else, and
`handleText` applies no slash filtering before forwarding to Claude. A user typing
**`/clear`** in Telegram has it passed through verbatim — the exact sequence probed
above. Plan-mode exit is a second path (`EnterPlanMode`/`ExitPlanMode` are not in
`DENIED_TOOLS`), though that one is possible-not-demonstrated.

**Fix, and the trap in it** — shipped, `src/session.ts`:

```ts
if (event.type === "conversation_reset") {
  this.sessionId = null;
  this.conversationTitle = null;
  continue; // MUST skip: this event still carries the PRE-reset id
}
```

The `continue` is load-bearing. Without it the generic capture branch runs in the
same iteration and immediately re-adopts the stale id — the fix would look right and
change nothing. Review caught that; the first draft had it wrong.

Rejected alternative: "always take the latest `session_id`". Simpler, but it does not
clear the cached title, and it diverges on a terminal reset — it would keep the dead
id rather than abandoning it.

Known edge, accepted: if a reset is the last event of a turn, `sessionId` stays null
and the next message starts fresh. For `/clear` that is the correct reading of user
intent. Not stored: `new_conversation_id`. Whether the SDK accepts it as a `resume:`
token is untested — do not assume it does.

## Runtime probe: sandbox egress and `strictAllowlist`

Type reads could not settle what the sandbox does with no `allowedDomains` set, so
it was measured. Each row ran the same command —
`curl -sS -m 8 -o /dev/null -w 'HTTP:%{http_code}' https://example.com` — through
`query()` with `buildSandboxSettings()`, `permissionMode: "bypassPermissions"`,
and only `network` varied. A 90s timeout made a blocking prompt observable as a
distinct outcome.

| `allowedDomains` | `strictAllowlist` | `deniedDomains` | `permissionMode` | Result |
|---|---|---|---|---|
| unset (**current bot config**) | unset | `[]` | bypass | HTTP 200 — open |
| `api.anthropic.com` | **true** | `[]` | bypass | **denied** (curl 56, CONNECT 403) |
| `api.anthropic.com` | unset | `[]` | bypass | HTTP 200 — **allowlist inert** (ran twice) |
| `api.anthropic.com` | unset | `[]` | `default` | **denied** |
| `api.anthropic.com` | unset | `[]` | `acceptEdits` | **denied** |
| `example.com` | true | `[]` | bypass | HTTP 200 — deny is selective |
| `example.com` | true | `example.com` | bypass | **denied** — `deniedDomains` wins |
| unset | unset | `example.com` | bypass | **denied** — no pairing needed |

Three conclusions:

1. **No hang.** The current config never prompts; egress is simply open, exactly as
   the Layer-2 NetworkPolicy design intends. The earlier concern was wrong.
2. **`strictAllowlist` is honored through the `query()` option.** Worth stating
   because `sandbox.ts` documents the opposite for `allowManagedReadPathsOnly` —
   the "user/managed/CLI settings only" caveat in the SDK docs does *not* apply
   uniformly, so per-field probing is the only reliable read.
3. **A bare `allowedDomains` is a no-op here** — the trap, and rows 3–5 isolate
   why. Holding the network config fixed and changing only the permission mode
   flips the outcome: `bypassPermissions` allows, `default` and `acceptEdits` deny.
   That matches the SDK's own wording — without `strictAllowlist` the runtime
   *prompts* rather than denies, and bypass auto-approves the prompt. So an
   allowlist added here without `strictAllowlist: true` looks like egress control
   and enforces nothing. Recorded at the `network` field in `src/sandbox.ts` so the
   next person to add a domain rule hits it.

The causal claim in (3) was flagged as unsupported in review — rows 4 and 5 were
run afterwards to settle it, as was the last row for `deniedDomains` standing alone.

No config change: the empty denylist is a deliberate choice (Layer-2 CIDR control),
and an allowlist would break the registries and docs sites Claude legitimately needs.

## Is the types major actually breaking?

Everything above studies what was *added*. A major version demands the opposite
question, so it was checked separately across all 19 `.d.ts` files:

| Backward-compat check, 3.28.0 → 4.0.0 | Result |
|---|---|
| Exported types/interfaces/namespaces removed | **none** (483 → 512, all additive) |
| Fields removed from any interface | **none** |
| Fields that went optional → required | **none** |
| Bot API methods removed | **none** (180 → 185) |

One genuine breaking change, and it is why the major was cut:
`InputRichMessage` gained a type parameter. Naming it bare now fails —

```
error TS2314: Generic type 'InputRichMessage<F>' requires 1 type argument(s).
```

The bot never names that type (it passes an object literal to
`ctx.api.sendRichMessage`), so it is unaffected.

Verified green on HEAD: `bun run typecheck` exits 0, and `bun test` gives
**179 pass / 0 fail across 13 files**. Nothing in this window breaks the bot.

## Confidence

| Claim | Tier | Evidence |
|---|---|---|
| Version deltas across the window | ✅ | `bun.lock` per merge commit + `node_modules` |
| Bot API method/type additions | ✅ | `.d.ts` set-diff + core.telegram.org changelog |
| Streaming/rich/ephemeral signatures | ✅ | clean `bun run typecheck` probe |
| SDK tool surface fully classified | ✅ | 43 `*Input` schemas vs 43 `REVIEWED`, both directions |
| `@grammyjs/types` 4.0.0 is additive-only | ✅ | removal/optionality sweep over all 19 `.d.ts` |
| Nothing in the window breaks the bot | ✅ | `bun run typecheck` 0; `bun test` 179 pass / 0 fail |
| New `SDKMessage` types unhandled | ✅ | union diff + `session.ts:351` read |
| `session_id` changes across `conversation_reset` | ✅ | event stream logged from a triggered reset — three distinct ids |
| `/clear` from Telegram reaches Claude unfiltered | ✅ | 7 registered commands; `message:text` catches the rest, no slash filter |
| Current sandbox config cannot hang on egress | ✅ | runtime probe, 8-case matrix |
| `allowedDomains` is inert without `strictAllowlist` | ✅ | same probe, repeated to rule out flake |
| …and `bypassPermissions` is *why* | ✅ | network config held fixed, permission mode varied |
| Drafts are metered more loosely than edits | ⚠ | **claim withdrawn** — undocumented, unmeasured; `scripts/probe-draft-rate-limit.sh` measures it, not yet run |
| Draft/rich/ephemeral methods exist on the live server | ✅ | `scripts/probe-bot-api-methods.sh`, run 2026-07-28 — all four 400 (implemented), fake method 404 |

## Live server check — all four methods confirmed

Types are generated from Telegram's published docs, so typechecking proves nothing
about what the server implements. `scripts/probe-bot-api-methods.sh` asks it
directly, using `chat_id: 0` — invalid, so nothing can be delivered to anyone. It
calibrates against that server first by calling `getMe` and a deliberately fake
method, rather than assuming what each verdict looks like.

Run 2026-07-28 against the live bot token:

```
controls ok: real method -> 200; unknown method -> 404 "Not Found"
sendMessageDraft           http=400  implemented   Bad Request: chat not found
sendRichMessageDraft       http=400  implemented   Bad Request: chat not found
sendRichMessage            http=400  implemented   Bad Request: chat not found
editEphemeralMessageText   http=400  implemented   Bad Request: invalid receiver_user_id specified
```

All four are **implemented server-side**. The controls make that readable: a method
this server does not have returns 404 "Not Found", and none of the four did.

The error text carries more than existence. "chat not found" means each call parsed
its parameters and got as far as resolving the chat — so the request *shapes* are
accepted too, not just the method names. `editEphemeralMessageText` got further
still, into per-field validation of `receiver_user_id`, which independently confirms
the ephemeral-message signature from finding 3.

Finding 1 is therefore safe to build on: `sendMessageDraft` is live, and so is the
rich-message path behind finding 2.
