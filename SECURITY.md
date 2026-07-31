# Security Model

## Permission Mode: Full Bypass

**This bot runs Claude Code with all permission prompts disabled.**

```typescript
// src/session.ts
permissionMode: "bypassPermissions"
allowDangerouslySkipPermissions: true
```

This means Claude can:
- **Read and write files** without asking for confirmation
- **Execute shell commands** without permission prompts
- **Use all tools** (Bash, Edit, Write, etc.) autonomously

This is intentional. The bot is designed for personal use from mobile, where confirming every file read or command would be impractical.

**This is not configurable** - the bot always runs in bypass mode. If you need permission prompts, use Claude Code directly instead.

## Threat Model

The bot is designed for **personal use by trusted users**. The primary threats we defend against:

1. **Unauthorized access** - Someone discovers or steals your bot token
2. **Prompt injection** - Malicious content in messages tries to manipulate Claude
3. **Accidental damage** - Legitimate users accidentally running destructive commands
4. **Credential exposure** - Attempts to extract API keys, passwords, or secrets

## Defense in Depth

### Layer 1: User Allowlist

Only Telegram users whose IDs are in `TELEGRAM_ALLOWED_USERS` can interact with the bot.

```
User sends message → Check user ID in allowlist → Reject if not authorized
```

- User IDs are numeric and cannot be spoofed in Telegram
- Get your ID from [@userinfobot](https://t.me/userinfobot)
- Unauthorized attempts are logged

### Layer 2: Rate Limiting

Token bucket rate limiting prevents abuse even if credentials are compromised.

```
Default: 20 requests per 60 seconds per user
```

Configure via:
- `RATE_LIMIT_ENABLED` - Enable/disable (default: true)
- `RATE_LIMIT_REQUESTS` - Requests per window (default: 20)
- `RATE_LIMIT_WINDOW` - Window in seconds (default: 60)

### Layer 3: Pre-Execution Tool Gate

A `PreToolUse` SDK hook (`src/session.ts`, backed by `evaluateToolUse` in `src/security.ts`) runs before every tool call and returns `permissionDecision: "deny"` for anything it rejects. Under `bypassPermissions` this is the enforcing control for native tools — nothing else stops a Read, Write, Edit or Bash call.

It denies:
- Tools in `DENIED_TOOLS` (also passed to the SDK as `disallowedTools`, so the model rarely emits them)
- `WebFetch` with a non-string `url`, and — when `url` is a non-empty string — a non-`http(s)` scheme, an unparseable URL, `localhost` / `*.localhost` / `*.local` / `*.internal` / `metadata.google.internal`, or a host resolving into `0/8`, `10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `::1`, `::`, `fe80::/10` or `fc00::/7`. Domain names are resolved and every returned address re-checked, so `evil.example.com A 169.254.169.254` is caught; resolution failure blocks. **Not** a full public/private classifier — CGNAT (`100.64/10`) and other reserved ranges are not covered, and active DNS rebinding needs IP pinning the SDK does not expose. Egress policy is the backstop.
- `Bash` commands failing the command-safety checks in Layer 6
- `Read`/`Write`/`Edit`/`NotebookEdit` on paths outside `ALLOWED_PATHS` **and** outside the three `TEMP_PATHS` (see Layer 5 — temp is allowed for read *and* write). One exemption: a native `Read` under `$HOME/.claude/` is allowed even when that directory is not in `ALLOWED_PATHS`, so Claude can load its own config and skills. It fails closed if `HOME` is unset.
- Within those same four tools, denied by name even inside an allowed path: credential stores (read and write), and the bot's own session, restart and audit files (read and write — reading exfils conversations, writing is DoS)
- Code-execution control files (`settings*.json`, `.claude/hooks/**`, `.mcp.json`) — **write only**. `Read` is deliberately exempt so Claude can inspect its own config; the sandbox's `denyWrite` covers the Bash path separately
- `Grep`/`Glob` with a search path outside the allowlist. Note this branch checks `isPathAllowed` only; the named runtime-file denials above do not apply to it

The hook does **not** bind Bash syscalls. That is Layer 4's job, and the two are deliberately separate.

### Layer 4: OS Bash Sandbox

Bash runs inside an OS-level sandbox — Seatbelt on macOS, bubblewrap on Linux (`src/sandbox.ts`). Writes are confined to `ALLOWED_PATHS` plus one scratch dir (`/tmp/ctb-sandbox`); credential directories and the bot's own session/restart/audit files are read-denied.

Fail-closed and **on by default**. An unrecognized value keeps it on; only an explicit `false`/`0`/`off`/`no` disables it:

```bash
BASH_SANDBOX_ENABLED=false
```

Set that **only** where bubblewrap cannot get unprivileged user namespaces — a hardened container (`seccompProfile: RuntimeDefault`, caps dropped), where the pod itself is the sandbox. Leaving it on there makes every Bash command fail closed.

With the sandbox off, Layer 6's pattern matching is the only *filesystem* containment left on Bash — a real gap, not a redundancy. The env scrub (`sanitizeEnv`) and `strictMcpConfig` are independent of the sandbox and stay on either way.

### Layer 5: Path Validation

File operations are restricted to explicitly allowed directories.

```
Default allowed paths:
- CLAUDE_WORKING_DIR (or $HOME if unset)
- ~/Documents
- ~/Downloads
- ~/Desktop
- ~/.claude
```

Customize via `ALLOWED_PATHS` (comma-separated). Setting it **overrides** the defaults — include `~/.claude` if you want plan mode to work.

**Validation uses proper path containment checks:**
- Symlinks are resolved before checking
- Path traversal attacks (../) are prevented
- Only exact directory matches are allowed

**Exception for temp files:**
- `/tmp/`, `/private/tmp/` and `/var/folders/` are allowed, for **write as well as read** — `isPathAllowed` checks them before `ALLOWED_PATHS` and returns early
- This enables handling of Telegram-downloaded files and the `ask_user` IPC files
- Named exceptions still apply inside them: `Read`/`Write`/`Edit`/`NotebookEdit` on the session, restart and audit files are denied by path. `Grep`/`Glob` are not covered by that denial — a search rooted in `/tmp` can still match them

### Layer 6: Command Safety

Dangerous shell commands are blocked as defense-in-depth.

**This denylist is best-effort only and trivially bypassable by construction** — an attacker who controls the command string has many spellings for the same effect. Real containment comes from Layers 3, 4 and 5, plus running the bot in a container. Treat this layer as a guard against accidents, not against an adversary.

#### Completely Blocked Patterns

These patterns are **always rejected**, regardless of context:

| Pattern | Reason |
|---------|--------|
| `rm -rf /` | System destruction |
| `rm -rf ~` | Home directory wipe |
| `rm -rf $HOME` | Home directory wipe |
| `sudo rm` | Privileged deletion |
| `:(){ :\|:& };:` | Fork bomb |
| `> /dev/sd` | Disk overwrite |
| `mkfs.` | Filesystem formatting |
| `dd if=` | Raw disk operations |

#### Path-Validated Commands

`rm` commands (that don't match blocked patterns above) are **allowed but path-validated**:

```bash
rm file.txt              # Allowed if in ALLOWED_PATHS
rm /etc/passwd           # Blocked - outside ALLOWED_PATHS
rm -rf ./node_modules    # Allowed if cwd is in ALLOWED_PATHS
rm -r /tmp/mydir         # Allowed - /tmp is always permitted
```

Every non-flag target is checked, not just the first — one out-of-bounds target rejects the whole command. Tokens starting with `-` are skipped as flags.

### Layer 7: System Prompt

Claude receives a safety prompt that instructs it to:

1. **Never delete files without explicit confirmation** - Must ask "Are you sure?"
2. **Only access allowed directories** - Refuse operations outside them
3. **Never run dangerous commands** - Even if asked
4. **Ask for confirmation on destructive actions**

**This layer is advisory, not enforcing.** A prompt cannot stop a tool call, and prompt injection targets it directly. The pre-execution gate (Layer 3) and the OS sandbox (Layer 4) are what actually deny; the prompt only makes compliance the default path.

### Layer 8: Audit Logging

Logging of every interaction is attempted; see the limits below for when a record is dropped
instead.

```
Log location: /tmp/claude-telegram-audit.log (configurable)
```

Logged events:
- `message` - User messages and Claude responses
- `auth` - Authorization attempts
- `tool_use` - Claude tool usage
- `error` - Errors during processing
- `rate_limit` - Rate limit events

Enable JSON format for easier parsing: `AUDIT_LOG_JSON=true`

**Under `AUDIT_LOG_JSON` the record is unredacted** — the whole Telegram message and Claude's
whole reply, where the text format truncates both at 500 characters. So the log is opened
with `O_NOFOLLOW | O_NONBLOCK`, and each record is written only after the open descriptor is
confirmed to be a regular file, owned by this process's uid, with no group or other
permission bits. A file that fails is chmod'd once; if it still fails, **the record is
dropped** and the reason printed to stderr. That is deliberate: on a shared host the default
path sits in `/tmp`, where anyone can leave a symlink, a FIFO, or a pre-created
world-readable file, and a log written into one is both a leak and not the record its
operator thinks they have.

Three limits worth knowing:

- **Audit availability is deniable.** A local user who pre-creates the path in a way that
  fails the check suppresses every record — dropping beats leaking, but "all interactions are
  logged" then stops being true. Set `AUDIT_LOG_PATH` somewhere only this user can write.
- A chmod repairs the mode but not a descriptor somebody already holds on that inode. Rotate
  a log that was ever world-readable rather than trusting the repair.
- Mode bits say nothing about extended ACLs.

## What This Doesn't Protect Against

1. **Malicious authorized users** - If you add someone to the allowlist, they have full access
2. **Zero-day vulnerabilities** - Unknown bugs in Claude, the SDK, or dependencies
3. **Physical access** - Someone with access to the machine running the bot
4. **Network interception** - Though Telegram uses encryption

## Recommendations

1. **Keep the allowlist small** - Only add users you fully trust
2. **Use a dedicated working directory** - Don't point at `/` or `~`
3. **Review audit logs periodically** - Look for suspicious patterns
4. **Keep dependencies updated** - Security patches for the SDK and Telegram library
5. **Use a dedicated API key** - Create a separate Anthropic API key for the bot
6. **Enable email alerts** - Get notified when new sessions start

## Incident Response

If you suspect unauthorized access:

1. **Stop the bot**: `launchctl unload ~/Library/LaunchAgents/com.claude-telegram-ts.plist`
2. **Revoke the Telegram bot token**: Message @BotFather and create a new token
3. **Review audit logs**: Check `/tmp/claude-telegram-audit.log`
4. **Check for file changes**: Review recent activity in allowed directories
5. **Update credentials**: Rotate any API keys that may have been exposed

## Security Updates

If you discover a security issue:

1. **Don't open a public GitHub issue**
2. Contact the maintainer privately
3. Allow time for a fix before disclosure
