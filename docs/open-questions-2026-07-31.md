# Open questions — 2026-07-31

What the `simplify-2026-07` work did not establish. Written at branch tip `986eef5`,
unmerged, gate **345 pass / 1097 expect() / 22 files**, typecheck 0.

Everything here is self-reported by the agent that did the work. Verify against the code
before acting: it was wrong about severity twice — it overstated `ask_user`'s blast radius
and missed the `/tmp` leak underneath it entirely.

Tier 1 was worked on 2026-07-31 and the entries below record what each turned out to be.
That pass makes the point a third time: item 1's headline claim was wrong, and the defect
worth fixing was one nobody had written down. Tiers 2 and 3 are still as first written.

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
