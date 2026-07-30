// Loaded once per test process by bunfig.toml's `[test] preload`, before any test file
// evaluates. config.ts reads both at module-eval time and exits the process when the token
// is missing; `bun test` shares one module registry across files, so whichever file imports
// config first is the one that binds them. That file is not fixed — Bun's test-file order is
// neither lexicographic nor settable — so setting these per-file only worked by having all
// of them agree. Setting them here removes the ordering dependency entirely.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";
