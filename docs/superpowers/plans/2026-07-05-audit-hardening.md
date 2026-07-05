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
- [ ] **#2 P1 — checkCommandSafety rm bypass.** First-rm-only, strips after `;|&`, skips `$`/`*`/`?`/backtick args.
  `rm /ok; rm /out/of/tree` + `rm -rf $VAR` pass. Fix: scan all rm; deny (not skip) unresolvable args.
- [ ] **#3 P1 — session singleton race.** callback.ts stop→sleep→restart without await/clearStopRequested;
  callbacks bypass sequentialize. Lost button + corrupted abortController/sessionId + spurious stop.
  Fix: await settle, markInterrupt, clearStopRequested (mirror checkInterrupt).
- [ ] **#4 P2 — archive traversal.** extractArchive zip-slip (no member containment) + extractArchiveContent
  symlink-follow read. Feature niche + likely broken (no `unzip` in image). DECISION: delete vs harden.
- [ ] **#5 P2 — formatting $$/$& corruption.** String.replace treats `$$`/`$&` as patterns → NUL leak.
  Fix: replacement function.
- [ ] **#6 P3 — over-broad `.claude` read exemption.** `.includes("/.claude/")` matches any dir; redundant.
  Fix: `startsWith(HOME + "/.claude/")` or drop.
- [ ] **#7 P3 — request_id traversal (LOW).** Sanitize charset in callback.ts.
- [ ] **#8 P3 — dead code ~86 lines.** auditLogAuth/Tool/Error, CLAUDE_CLI_PATH+findClaudeCli,
  RateLimiter.getStatus, session.resumeLast.
- [ ] **#9 P3 — misc.** ask-user /tmp leak (streaming.ts), video.ts:32 identical ternary, trigger.ts `as any`.

## Bloat (optional, non-defect)
Drop archive feature (kills #4); auth check → grammY middleware (~50 lines); voice≈audio dedup (~60).
