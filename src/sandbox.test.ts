import { test, expect } from "bun:test";

process.env.TELEGRAM_BOT_TOKEN = "x:y";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { buildSandboxSettings, sanitizeEnv, secretEnvNames, SANDBOX_SCRATCH } = await import("./sandbox");

// Inject allowed paths explicitly — the module-level ALLOWED_PATHS const is frozen at first import,
// so relying on it here is order-dependent across the full suite. DI keeps the test deterministic.
const ALLOWED = ["/Users/x/Dev", "/Users/x/Documents"];

test("sandbox is fail-closed", () => {
  const s = buildSandboxSettings();
  expect(s.enabled).toBe(true);
  expect(s.failIfUnavailable).toBe(true);
  expect(s.allowUnsandboxedCommands).toBe(false);
});

test("allowWrite = ALLOWED_PATHS + scratch, not all of /tmp", () => {
  const fs = buildSandboxSettings(ALLOWED).filesystem!;
  expect(fs.allowWrite).toContain("/Users/x/Dev");
  expect(fs.allowWrite).toContain(SANDBOX_SCRATCH);
  expect(fs.allowWrite).not.toContain("/tmp");
});

test("denyWrite covers ~/.claude + project .claude control files", () => {
  const dw = buildSandboxSettings().filesystem!.denyWrite!;
  expect(dw.some((p) => p.endsWith("/.claude"))).toBe(true);
  expect(dw).toContain("**/.claude/settings*.json");
  expect(dw).toContain("**/.claude/hooks/**");
});

test("reads fail-closed: allowRead is an allowlist incl ALLOWED_PATHS + scratch", () => {
  const fs = buildSandboxSettings(ALLOWED).filesystem!;
  expect(fs.allowRead).toContain("/Users/x/Dev");
  expect(fs.allowRead).toContain(SANDBOX_SCRATCH);
});

test("denyRead lists known secret stores", () => {
  const dr = buildSandboxSettings().filesystem!.denyRead!;
  expect(dr).toContain("**/.env");
  expect(dr.some((p) => p.endsWith("/.ssh"))).toBe(true);
});

test("sanitizeEnv strips secret-shaped keys, keeps operational vars", () => {
  const e = sanitizeEnv({
    PATH: "/bin",
    HOME: "/h",
    OPENAI_API_KEY: "sk",
    TELEGRAM_BOT_TOKEN: "x:y",
    TELEGRAM_CHAT_ID: "42",
    GH_TOKEN: "gh",
  });
  expect(e.PATH).toBe("/bin");
  expect(e.HOME).toBe("/h");
  expect(e.TELEGRAM_CHAT_ID).toBe("42");
  expect(e.OPENAI_API_KEY).toBeUndefined();
  expect(e.TELEGRAM_BOT_TOKEN).toBeUndefined();
  expect(e.GH_TOKEN).toBeUndefined();
});

test("secretEnvNames feeds credentials.envVars deny list", () => {
  const names = secretEnvNames({ OPENAI_API_KEY: "x", PATH: "/bin", TELEGRAM_CHAT_ID: "1" });
  expect(names).toContain("OPENAI_API_KEY");
  expect(names).not.toContain("PATH");
  expect(names).not.toContain("TELEGRAM_CHAT_ID");
});

test("auth vars stay in child env but are still denied to Bash", () => {
  // ANTHROPIC_API_KEY must reach the Claude Code child (else auth breaks) yet never be readable
  // by sandboxed Bash. So sanitizeEnv keeps it, secretEnvNames (→ credentials.envVars) denies it.
  const src = { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai", PATH: "/bin" };
  expect(sanitizeEnv(src).ANTHROPIC_API_KEY).toBe("sk-ant");
  expect(sanitizeEnv(src).OPENAI_API_KEY).toBeUndefined(); // not an auth var → stripped
  expect(secretEnvNames(src)).toContain("ANTHROPIC_API_KEY"); // still hidden from Bash
});

test("credentials.envVars entries use mode deny", () => {
  process.env.SPToken_PROBE_SECRET = "zzz";
  const ev = buildSandboxSettings().credentials!.envVars!;
  expect(ev.every((e) => e.mode === "deny")).toBe(true);
  delete process.env.SPToken_PROBE_SECRET;
});
