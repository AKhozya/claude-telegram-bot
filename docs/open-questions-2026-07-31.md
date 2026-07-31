# Open questions — 2026-07-31

What the `simplify-2026-07` work did not establish. Written at branch tip `986eef5`,
unmerged, gate **345 pass / 1097 expect() / 22 files**, typecheck 0.

Everything here is self-reported by the agent that did the work. Verify against the code
before acting: it was wrong about severity twice — it overstated `ask_user`'s blast radius
and missed the `/tmp` leak underneath it entirely.

## Tier 1 — could mean the work does not do what it claims

### 1. The rewritten MCP servers may not be wired into anything

`mcp-config.ts` does not exist on this host, so `config.ts:52` falls back to
`No mcp-config.ts found - running without MCPs`. In `mcp-config.example.ts` the `ask_user`
and `send_file` entries are **commented out** (lines 23, 30).

The `registerTool` rewrite and its ~45 mutations were all validated against servers the
tests spawn themselves as `bun <path>/server.ts`.

**Spike:** find the real `mcp-config.ts` — deployment manifests, the ClaudeBot macOS app
bundle, whichever host runs the bot. Confirm both servers are registered, the exact spawn
command and env, and whether the standalone `bun build --compile` path launches them
differently. If production spawns them another way, the protocol tests prove less than
claimed.

### 2. The bot was never started

No `bun run start` at any point, no `.env`, no token, no LaunchAgent on this host. Every
claim rests on typecheck plus in-process tests. `AGENTS.md` says to restart the bot after
code changes; that never happened.

**Spike:** run it with a real token and execute the live-bot pass at the end of
[simplification-plan-2026-07.md](simplification-plan-2026-07.md). That checklist is the
deliverable for the branch and has never been run.

### 3. `bun test` on a host running the bot can delete that bot's request files

The poller tests call `checkPendingAskUserRequests(ctx, CHAT)` directly, and the reap inside
it globs **every** `/tmp/ask-user-*.json`, not only the test's own. A real `sent` file older
than `TEMP_RETENTION_HOURS`, whose buttons are still live in the user's chat, is deleted by
a test run. The tests isolate by `chat_id` for their assertions; the reap does not.

Introduced by this branch. Either scope the reap to a directory the tests can override, or
accept it and say so in `AGENTS.md`.

### 4. The "tdlib never trims" proof rests on an unread tail

The empty-versus-blank conclusion, and the whole `RENDERS_SOMETHING` class, come from
reading `clean_input_string` in tdlib `td/telegram/misc.cpp` — but the fetched output was
**truncated mid-function** at `// remove \`. The remainder was never read. If it trims
trailing whitespace, the blank-label guard solves a non-problem.

**Spike:** read the whole function. Also check whether `telegram-bot-api`'s `Client.cpp`
pre-validates button text before tdlib sees it.

## Tier 2 — invented values and unverified reasoning

| # | Item |
|---|---|
| 5 | `IPC_PENDING_TTL_MS = 5 min` was chosen from nothing — no measurement of how long a legitimate `pending` file lives. A bot down longer than that now has queued prompts reaped rather than delivered. Possibly right, never justified |
| 5b | The reap only runs when a poller runs, so a bot that never calls an MCP tool still accumulates request files forever. Documented in neither the code nor `AGENTS.md` |
| 6 | The BMP `Default_Ignorable_Code_Point` ranges in `RENDERS_SOMETHING` were recalled from memory, then checked against a probe list **also** written from memory. Never diffed against Unicode's `DerivedCoreProperties.txt`. "U+2800 renders blank in every font" is unverifiable as stated |
| 7 | The reap clock is mtime, and `Bun.write` rewrites the file when status flips to `sent` — so the 24h retention restarts on delivery, not creation. Whether `created_at` is the right clock for that half was never considered |
| 8 | One reviewer throughout. Every "NO FINDINGS" is Codex alone, on evidence files the agent curated. It was right ~24 of 27 and caught real defects every round — including two the agent's own fixes introduced — but no second reviewer saw any of this diff |
| 9 | Batch 6's "no cases lost" proof (66=66, 62=62) came from a comparison script the same agent wrote, after three buggy iterations of it |
| 10 | `fileAgeMs` and `reapIfOlderThan` in `streaming.ts` are exported for tests only. Justified by the `withMessageText` precedent, but it is new API surface |
| 11 | Docker numbers are linux/arm64 on one Mac, and the "before" image was **reconstructed** by copying untracked `.bun-build` artifacts into a worktree — not the original build |

## Tier 3 — deliberately not done

| # | Item | Why it was left |
|---|---|---|
| 12 | `send_file` caption over 1024 chars is unbounded | Fails visibly and self-heals. Out of spec per Bot API "0-1024", never observed failing |
| 13 | `send_file` queues a non-empty but unreadable file (probed: size 7, `text()` throws `EACCES`) | Same — visible failure, self-healing |
| 14 | The `send_file` MCP server validates no paths; `isPathAllowed` runs only in the bot | Noted in the plan as load-bearing, never questioned as a defense-in-depth gap |
| 15 | Astral default-ignorables (U+E0100) still make blank buttons | A JSON Schema `pattern` carries no `u` flag; closing it breaks advertised-equals-enforced. A test pins the acceptance |
| 16 | Archive feature kept on inconclusive evidence | The stated way to reopen — `grep -c ARCHIVE "$AUDIT_LOG_PATH"` against the running bot — was never run |
| 17 | `/restart`'s 500 ms sleep | Batch 7 could not settle statically whether it stops a redelivered `/restart` looping. Needs a live run against the supervisor |
| 18 | `net.BlockList` for the SSRF classifier | Rejected; would need a differential fuzz test as the gate |
| 19 | Denylist misses `tee`, `dd of=`, `cp`, `mv`, `find -delete` | Real gap when `BASH_SANDBOX_ENABLED=false`. Self-documented as an accepted ceiling at `security.ts:144-149` |
| 20 | `photo.ts` and `video.ts` remain the only untested handlers | — |
| 21 | The audit log is written **unredacted** under `AUDIT_LOG_JSON`; document prompts carry whole file bodies, and the `0o600` fix fails **open** when chmod fails | Recorded as an open security question, never resolved |
| 22 | Merge to `main` | Never discussed |

## Working rules for whoever picks this up

- Verify each item against the code before acting. Push back with evidence rather than
  fixing on faith.
- `bun run typecheck && bun test`, never below **345 / 1097**.
- Mutation-test every fix against the exact scenario it claims to close. Two fixes last
  session passed review and killed nothing.
- One single-line commit per item. `git status --short` first.
  1Password is locked — use `git -c commit.gpgsign=false commit`.
