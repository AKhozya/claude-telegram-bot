# AGENTS.md - Claude Telegram Bot

Standing context for AI agents working in this repo. Claude Code also reads it through `CLAUDE.md`.

## Commands

```bash
bun run start      # Run the bot
bun run dev        # Run with auto-reload (--watch)
bun run typecheck  # Run TypeScript type checking
bun test           # Run the test suite (CI gates on this)
bun install        # Install dependencies
```

## Architecture

This is a Telegram bot that lets you control Claude Code from your phone via text, photos, and documents. Built with Bun and grammY. ~3,600 code lines in `src/` excluding its tests, ~6,100 across the repo including them and the two MCP servers (`tokei`).

### Message Flow

```
Telegram message → Handler → Auth check → Rate limit → Claude session → Streaming response → Audit log
```

### Key Modules

- **`src/index.ts`** - Entry point, registers handlers, starts polling
- **`src/config.ts`** - Environment parsing, MCP loading, safety prompts
- **`src/session.ts`** - `ClaudeSession` class wrapping the Agent SDK with streaming, session persistence (`/tmp/claude-telegram-session.json`), and the `PreToolUse` hook that enforces the safety checks
- **`src/security.ts`** - `RateLimiter` (token bucket), path validation, command safety, `evaluateToolUse` tool gate
- **`src/sandbox.ts`** - OS-level Bash sandbox (Seatbelt / bubblewrap), env sanitizing, credential read-denies
- **`src/retry.ts`** - API retry policy. Bounds the `HttpError` retry `autoRetry` runs unbounded, and installs both halves together
- **`src/transcribe.ts`** - ffmpeg → whisper.cpp pipeline, plus duration probing and scene-change frame extraction for video. ffmpeg is mandatory: whisper.cpp cannot read Telegram's opus and exits 0 while failing, so empty output is the failure signal, not the exit code. Audio whose peak sits at or below `WHISPER_SILENCE_DB` is refused before whisper runs — given silence the model invents words instead of returning nothing
- **`src/formatting.ts`** - Markdown→HTML conversion for Telegram, tool status emoji formatting
- **`src/utils.ts`** - Audit logging, typing indicators
- **`src/types.ts`** - Shared TypeScript types

### Handlers (`src/handlers/`)

Message-type handlers:
- **`commands.ts`** - `/start`, `/new`, `/stop`, `/status`, `/resume`, `/restart`, `/retry`
- **`text.ts`** - Text messages; a `!` prefix interrupts the running query, `!stop` is a `/stop` alias
- **`photo.ts`** - Image analysis with media group buffering (1s timeout for albums)
- **`document.ts`** - PDF extraction (pdftotext CLI), text files, archives. Media sent as a file attachment never reaches it: a dispatcher registered ahead of it in `index.ts` routes `video/*` and `audio/*` MIME types to the handlers below
- **`video.ts`** - Video messages, video notes, and videos sent as documents. The audio track is transcribed and up to 8 frames are extracted at scene changes, falling back to evenly spaced stills when no cut is detected. Claude has no video tool, so the frames are the only way the picture reaches it
- **`audio.ts`** - Voice notes and audio files. Transcribes with whisper.cpp and sends the transcript on as if it had been typed, so thinking keywords work spoken
- **`callback.ts`** - Inline keyboard button handling for ask_user MCP
- **`streaming.ts`** - Shared `StreamingState` and status callback factory

Supporting modules in the same directory:
- **`auth.ts`** - `authGate` middleware, the single choke point for the user allowlist
- **`media-group.ts`** - Generic album buffer; rate-limits once per album, not per item
- **`download.ts`** - Shared file download via the files plugin (honours `TELEGRAM_API_ROOT`)
- **`reactions.ts`** - Best-effort 👀/👌/👎 message reactions
- **`trigger.ts`** - HTTP endpoint that injects a prompt as if the first allowed user sent it. Binds `TRIGGER_HOST` (default `127.0.0.1`); disabled unless `TRIGGER_SECRET` is set

### Security Layers

1. User allowlist (`TELEGRAM_ALLOWED_USERS`)
2. Rate limiting (token bucket, configurable)
3. `PreToolUse` hook (`evaluateToolUse`) — the enforcing gate under `bypassPermissions`
4. OS Bash sandbox (`BASH_SANDBOX_ENABLED`, on by default, fail-closed)
5. Path validation (`ALLOWED_PATHS`)
6. Command safety (blocked patterns — best-effort, trivially bypassable)
7. External Bash denylist (`SAFETY_HOOK` → `hooks/validate-safe-bash.sh`)
8. System prompt constraints (advisory only)
9. Audit logging

Full detail in [SECURITY.md](SECURITY.md).

### `hooks/`

Claude Code hook scripts shipped in the image. In the cluster they are the only copies:
chezmoi ignores `.claude/hooks` and `.claude/settings.json` on Linux, so a copy on the
PVC has nothing to heal it, and the Bash sandbox is off there.

`validate-safe-bash.sh` runs as layer 7 above, through `src/safety-hook.ts`, not through
`settings.json` — that file is on the PVC and anything the model runs could delete its
`hooks` key. `SAFETY_HOOK` names the script; unset means the layer is off (the macOS
standalone build), set means every failure to get exit 0 out of it denies the Bash call.
Its rules are homelab-specific (`kubectl apply` without `--dry-run`, `helm uninstall`,
Redis `FLUSHALL`) and barely overlap `BLOCKED_PATTERNS`, which is why both run.

A near-identical `validate-safe-bash.sh` lives in the dotfiles repo for the Mac. Separate
files: a rule added to one does not reach the other.

The other three are wired through `settings.json` by the deployment's init container and
are conveniences, not controls — losing one until the next restart degrades context or a
reminder, and denies nothing.

### Configuration

All config via `.env` (copy from `.env.example`). Every configuration variable the code reads — OS-supplied ones (`HOME`, `PATH`, `TMPDIR`) excluded:

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Required. From @BotFather |
| `TELEGRAM_ALLOWED_USERS` | Required. Comma-separated numeric user IDs |
| `TELEGRAM_API_ROOT` | Alternate Bot API server |
| `CLAUDE_WORKING_DIR` | Working directory for Claude |
| `CLAUDE_CODE_PATH` | Explicit path to the Claude CLI (auto-detected otherwise) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` | Consumed by the SDK child, not by this code. `sandbox.ts` `AUTH_KEEP` passes them through to the child while still hiding them from sandboxed Bash |
| `ALLOWED_PATHS` | Directories Claude can access — overrides all defaults |
| `BASH_SANDBOX_ENABLED` | OS Bash sandbox; on unless explicitly `false`/`0`/`off`/`no` |
| `SAFETY_HOOK` | Absolute path to the external Bash denylist. Unset disables that layer; set makes every failure to run it a deny |
| `RATE_LIMIT_ENABLED`, `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_WINDOW` | Token bucket |
| `THINKING_KEYWORDS`, `THINKING_DEEP_KEYWORDS` | Extended-thinking triggers |
| `WHISPER_MODEL` | Path to the ggml model; baked into the image at `/usr/local/share/whisper/ggml-small.bin` |
| `WHISPER_THREADS` | Threads for whisper.cpp, default 2. Must track the CPU limit — `nproc` reports the node's count inside a capped pod |
| `TRANSCRIBE_MAX_DURATION_SECONDS` | Longest clip accepted, default 600. Size does not bound transcription time |
| `WHISPER_SILENCE_DB` | Peak dBFS at or below which audio counts as silent, default -76. Model-specific — whisper invents words on silence rather than returning nothing, and each model starts doing so at a different level, so this moves with `WHISPER_MODEL` |
| `AUDIT_LOG_PATH`, `AUDIT_LOG_JSON` | Audit log location and format |
| `SESSION_FILE_PATH`, `RESTART_FILE_PATH`, `TEMP_DIR` | Runtime file overrides |
| `TEMP_REAP_INTERVAL_MS`, `TEMP_RETENTION_HOURS` | Temp-dir sweep cadence (default 1h) and file age (default 24h). Nothing else clears `TEMP_DIR`. The retention is also the age at which the pollers in `streaming.ts` drop an MCP request file in `/tmp`. It is not a bound on one: the pollers run only while Claude is calling `ask_user` or `send_file`, so an idle bot sweeps nothing |
| `TRIGGER_SECRET`, `TRIGGER_PORT`, `TRIGGER_HOST` | HTTP trigger; disabled without a secret |
| `TELEGRAM_CHAT_ID` | Not user config — `session.ts` sets it so the MCP servers know the recipient |

MCP servers defined in `mcp-config.ts` (copy from `mcp-config.example.ts`; absent means no MCPs).
The example enables this repo's own `ask-user` and `send-file` and leaves the third-party
entries commented — those need an account, a key, or a checkout.
`mcp-config.ts` is gitignored, so the Dockerfile copies the example in as the image default
and `.dockerignore` drops any local copy. Without that a CI-built image ran with no MCP
servers while a locally built one baked whichever config that machine happened to have.

### Runtime Files

| Path | Purpose | Override |
|---|---|---|
| `/tmp/claude-telegram-session.json` | Session persistence for `/resume` | `SESSION_FILE_PATH` |
| `/tmp/claude-telegram-restart.json` | Chat/message ids so `/restart` can edit its own status message | `RESTART_FILE_PATH` |
| `/tmp/claude-telegram-audit.log` | Audit log | `AUDIT_LOG_PATH` |
| `/tmp/telegram-bot/` | Downloaded photos, documents, audio and video, plus the `.wav` transcription derives from a media file and up to 8 `.frame-N.jpg` stills per video | `TEMP_DIR` |
| `/tmp/ctb-sandbox` | Bash sandbox scratch dir — the only writable path outside `ALLOWED_PATHS` | — |
| `/tmp/ask-user-<uuid>.json` | IPC file for one `ask_user` round trip. Deleted when the button is tapped; otherwise swept by the poller on the next `ask_user` call — `pending` after 5 min, anything after `TEMP_RETENTION_HOURS` | — |
| `/tmp/send-file-<uuid>.json` | IPC file for one `send_file` request; polled and deleted by `streaming.ts`, swept on the same terms — on the next `send_file` call, not on a timer | — |

## Patterns

**Adding a command**: Create handler in `commands.ts`, register in `index.ts` with `bot.command("name", handler)`

**Adding a message handler**: Create in `handlers/`, import it directly in `src/index.ts`, register with the appropriate filter

**Streaming pattern**: All handlers use `createStatusCallback()` from `streaming.ts` and `session.sendMessageStreaming()` for live updates.

**Before committing**: `bun run typecheck && bun test`. A green typecheck does not prove the bot runs — the suite is the gate that matters, and neither covers the Telegram wire.

**Test env**: `bunfig.toml` preloads `test-preload.ts`, which sets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USERS`. `config.ts` reads both at module-eval time and exits without them, so no test file needs to set them itself.

**MCP server tests**: `ask_user_mcp/server.test.ts` and `send_file_mcp/server.test.ts` spawn their server as a child process and drive it with a real MCP `Client` over stdio — the only tests here that speak the protocol. They write to `/tmp` under a chat id no real chat uses, and clean up after themselves.

**After code changes**: Restart the bot so changes can be tested. Use `launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts` if running as a service, or `bun run start` for manual runs.

## Standalone Build

The bot can be compiled to a standalone binary with `bun build --compile`. This is used by the ClaudeBot macOS app wrapper.

### External Dependencies

PDF extraction uses `pdftotext` CLI instead of an npm package (to avoid bundling issues):

```bash
brew install poppler  # Provides pdftotext
```

Transcription needs two more:

```bash
brew install ffmpeg whisper-cpp  # transcription; whisper-cpp provides whisper-cli
```

brew does not install a model. Point `WHISPER_MODEL` at one downloaded by hand — the container
image bakes one in, a host run does not.

### PATH Requirements

When running as a standalone binary (especially from a macOS app), the PATH may not include Homebrew. The launcher must ensure PATH includes:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)

Without this, `pdftotext` won't be found and PDF parsing will fail silently with an error message.

## Commit Style

Do not add "Generated with Claude Code" footers or "Co-Authored-By" trailers to commit messages.

## Running as Service (macOS)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# Edit plist with your paths
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist

# Logs
tail -f /tmp/claude-telegram-bot-ts.log
tail -f /tmp/claude-telegram-bot-ts.err
```
