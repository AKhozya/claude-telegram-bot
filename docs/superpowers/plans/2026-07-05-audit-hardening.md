# Audit hardening — 2026-07-05

Findings from whole-repo audit (ecc typescript + security reviewers, ponytail-audit,
Codex static verify, own repros). All triple-verified REAL. Branch `feat/audit-hardening-2026-07`.

Per-item loop: TDD test → fix → self-review → Codex static review → iterate → commit.

## Threat model
Bot grants ONE trusted user full Claude Code under `permissionMode: bypassPermissions`.
Bash is a shell by design. Path/command controls = defense-in-depth vs **prompt injection**
(malicious PDF/photo/webpage steering Claude), NOT vs the user. That is why #1 is P0.

## Items (severity order)

- [x] **#1 P0 — tool-gate default-allow.** `evaluateToolUse` (security.ts) gates only 7 tools;
  SDK 0.3.195 ships ungated `WebFetch`(SSRF), `REPL`, `Monitor`, `Workflow`, `Artifact`.
  Under bypassPermissions the PreToolUse hook is the only gate. No allowedTools/disallowedTools set.
  Fix: deny dangerous exec/publish/schedule tools in the hook + SDK `disallowedTools`; SSRF-gate WebFetch;
  canary test that fails on a new unclassified SDK tool (kills the recurrence).
  Round-3 follow-up: `Agent` (subagent spawn) was default-allowed — a second Bash/file exec surface the
  local PreToolUse hook never reaches, and `isolation:"remote"` runs off-host. Added to `DENIED_TOOLS`.
- [x] **#2 P1 — checkCommandSafety rm bypass.** First-rm-only, strips after `;|&`, skips `$`/`*`/`?`/backtick args.
  `rm /ok; rm /out/of/tree` + `rm -rf $VAR` pass. Fixed: split on shell operators, scan every rm
  segment, fail-closed on `$`/backtick/brace, glob prefix-check + post-glob `..` reject, dequote args.
  Codex round-1 + ecc:security-reviewer surfaced 4 more (quoted abs path, leading redirect, post-glob `..`,
  redirect-write `rm ok >/etc/passwd`). Full-PR codex found 2 MORE (`rm>/dev/null` glued redirect skipped the
  `\brm\s+` match; `>|` clobber split on `|`) + a false-block (`cat /tmp/rm x`). Fixed: fold `>|`→`>`,
  anchor rm to the command word `^[\s({]*(VAR=..)*rm\b`. All regression-tested (68 tests). ~21 rm tests.
  Round-3 codex+ecc found the command-word detector was still fail-open to obfuscation: `$(rm ..)` /
  backtick / `x=$(rm ..)` (rm inside command substitution), `\rm` (backslash escape), `env rm` (bare
  exec-wrapper), `xargs rm` (stdin targets). Fixed: extract `$(...)`/backtick bodies as pseudo-segments,
  widen the leading-strip class to `[\s({\\'"]`, peel bare exec-wrappers, fail-closed on `xargs rm`.
  Remaining ceiling is unbounded (interpreters, wrappers-with-args, non-rm deleters) → see #12.
- [x] **#10 P2 — redirect write-anywhere (non-rm).** `echo x >/etc/passwd` returned safe=true: the
  redirect-target validation from #2 only ran inside the rm block (outer `/\brm\b/` gate). Fix: extracted
  `checkRedirectTargets()` and run it on EVERY command segment (hoisted the normalize/subst-extract/split
  parse out of the rm gate). Skips fd-dups/std-sinks/process-subst `>(cmd)`; fail-closed on `$`/`` ` ``/`{}`
  targets. Ceiling (fail-closed over-block): literal `>` in quotes, `[[ a > b ]]`, heredoc body lines → #12.
  11 tests (security.test.ts).
- [x] **#11 P2 — WebFetch SSRF via DNS rebinding.** `isBlockedFetchTarget` checked the literal host/IP only;
  a domain resolving to 127.0.0.1 / 169.254.169.254 passed. Fix: for a domain name, `dns.lookup(host,{all})`
  then re-check each resolved IP (fail-closed on resolution error). Extracted `isBlockedV6()` (reused for
  literal + resolved v6). `isBlockedFetchTarget`/`evaluateToolUse` now async; both session.ts call sites
  await (already in async contexts). Ceiling: ACTIVE rebinding (flip between our lookup and WebFetch's own)
  needs IP-pinning the SDK doesn't expose → egress policy / #12. 6 tests (dns/promises mocked).
- [x] **#3 P1 — session singleton race.** callback.ts stop→sleep→restart without markInterrupt/
  clearStopRequested; callbacks bypass sequentialize. `stop()` left `stopRequested=true`, so the button's
  new message hit session.ts:285 `throw "Query cancelled"` (dropped selection); no markInterrupt → spurious
  "🛑 Query stopped." on the preempted query. Fix: extracted `session.interruptForNewMessage()` (the exact
  mark→stop→settle→clear dance already in utils.ts checkInterrupt), called from callback.ts + checkInterrupt.
  Kills the divergence that caused the drift. Unit-tested (session.test.ts). commands.ts /new,/stop keep
  their own clearStopRequested (explicit stops, no markInterrupt — correct).
- [ ] **#4 P2 — archive traversal.** extractArchive zip-slip (no member containment) + extractArchiveContent
  symlink-follow read. Feature niche + likely broken (no `unzip` in image). DECISION: delete vs harden.
- [x] **#5 P2 — formatting $$/$& corruption.** String.replace treated `$$`/`$&`/`` $` `` in restored
  code as replacement patterns. Fixed: replacement FUNCTION in convertMarkdownToHtml (formatting.ts). Tested.
- [x] **#6 P3 — over-broad `.claude` read exemption.** `.includes("/.claude/")` matched any dir named
  .claude (`/etc/x/.claude/secret`). Fixed: `startsWith($HOME/.claude/)`. isPathAllowed stays the real gate. Tested.
- [x] **#7 P3 — request_id traversal (LOW).** callback.ts now charset-validates request_id (`^[A-Za-z0-9_-]+$`)
  before interpolating it into the /tmp ask-user path.
- [x] **#8 P3 — dead code.** Removed auditLogAuth/Tool/Error (utils.ts), findClaudeCli+CLAUDE_CLI_PATH
  (config.ts), RateLimiter.getStatus (security.ts), session.resumeLast. Net −69 lines.
- [~] **#9 P3 — misc.** Done: video.ts dead `?"mp4":"mp4"` ternary collapsed, trigger.ts `as any` →
  `as unknown as Update`. DEFERRED: ask-user /tmp leak (streaming.ts) — unanswered request files accumulate;
  a correct TTL-sweep fix has late-tap edge cases, not trivial. Track separately (low value, /tmp clears on reboot).

- [ ] **#12 P2 — OS-level Bash containment (the real deletion/exfil control).** `checkCommandSafety` is a
  fail-open regex denylist; 3 review rounds each surfaced new command-word/deleter spellings (`$(rm)`, `\rm`,
  `env rm`, `xargs rm`, and out of reach: `sh -c`, `eval`, `find -delete`, `truncate`, `: >f`, `mv x /dev/null`).
  The obfuscation/deleter space is unbounded — no static parse wins. Real fix: run Claude's Bash under OS
  containment (restricted user + read-only bind mounts outside ALLOWED_PATHS, or a sandbox-exec profile on
  macOS). Then checkCommandSafety reverts to a best-effort speed-bump, not the sole control. Larger change;
  decide scope with user.

## Bloat (optional, non-defect)
Drop archive feature (kills #4); auth check → grammY middleware (~50 lines); voice≈audio dedup (~60).
