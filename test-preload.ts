// Loaded once per test process by bunfig.toml's `[test] preload`, before any test file
// evaluates. config.ts reads both at module-eval time and exits the process when the token
// is missing; `bun test` shares one module registry across files, so whichever file imports
// config first is the one that binds them. That file is not fixed — Bun's test-file order is
// neither lexicographic nor settable — so setting these per-file only worked by having all
// of them agree. Setting them here removes the ordering dependency entirely.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

// Bound at config module-eval like the two above, and for the same reason it belongs here:
// left unset, any test that drives a handler to completion appends to the default
// /tmp/claude-telegram-audit.log — the running bot's own audit trail on a dev machine.
// utils.test.ts still sets it per-subprocess; this covers the in-process callers.
process.env.AUDIT_LOG_PATH = `${process.env.TMPDIR || "/tmp"}/claude-telegram-audit-test.log`;
