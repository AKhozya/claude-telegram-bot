import { test, expect } from "bun:test";
import { symlinkSync, mkdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.TELEGRAM_BOT_TOKEN = "x:y";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const {
  buildSandboxSettings,
  sanitizeEnv,
  secretEnvNames,
  ensureScratchDir,
  bashSandboxEnabled,
  SANDBOX_SCRATCH,
} = await import("./sandbox");

// Inject allowed paths explicitly — the module-level ALLOWED_PATHS const is frozen at first import,
// so relying on it here is order-dependent across the full suite. DI keeps the test deterministic.
const ALLOWED = ["/Users/x/Dev", "/Users/x/Documents"];

test("bashSandboxEnabled: default on, disables only on explicit off value", () => {
  expect(bashSandboxEnabled({})).toBe(true);
  expect(bashSandboxEnabled({ BASH_SANDBOX_ENABLED: "true" })).toBe(true);
  expect(bashSandboxEnabled({ BASH_SANDBOX_ENABLED: "false" })).toBe(false);
  expect(bashSandboxEnabled({ BASH_SANDBOX_ENABLED: "off" })).toBe(false);
  expect(bashSandboxEnabled({ BASH_SANDBOX_ENABLED: "0" })).toBe(false);
  expect(bashSandboxEnabled({ BASH_SANDBOX_ENABLED: "no" })).toBe(false);
  // Unrecognized value stays secure (enabled), not silently disabled.
  expect(bashSandboxEnabled({ BASH_SANDBOX_ENABLED: "flase" })).toBe(true);
});

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

test("denyWrite covers ~/.claude + project .claude control files + .mcp.json", () => {
  const dw = buildSandboxSettings().filesystem!.denyWrite!;
  expect(dw.some((p) => p.endsWith("/.claude"))).toBe(true);
  expect(dw).toContain("**/.claude/settings*.json");
  expect(dw).toContain("**/.claude/hooks/**");
  expect(dw).toContain("**/.mcp.json");
});

test("ensureScratchDir refuses a pre-planted symlink at the scratch path", () => {
  const base = join(tmpdir(), `ctb-scr-${Date.now()}-${process.pid}`);
  mkdirSync(base, { recursive: true });
  const link = join(base, "scratch");
  symlinkSync("/etc", link);
  try {
    expect(() => ensureScratchDir(link)).toThrow(/symlink/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ensureScratchDir creates a private dir (no group/other access)", () => {
  const dir = join(tmpdir(), `ctb-scr2-${Date.now()}-${process.pid}`);
  try {
    ensureScratchDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o077).toBe(0); // owner-only
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no allowRead entry — denyRead stays authoritative over ALLOWED_PATHS", () => {
  // allowRead OVERRIDES denyRead per the SDK; it must be empty/absent, else a secret inside an allowed
  // path (a repo's .env, ~/.claude/.credentials when ~/.claude is an allowed path) would be re-opened.
  const fs = buildSandboxSettings(ALLOWED).filesystem!;
  expect(fs.allowRead ?? []).toHaveLength(0);
});

test("denyRead blocklists credential stores incl the broad ~/.config tree", () => {
  const dr = buildSandboxSettings().filesystem!.denyRead!;
  expect(dr).toContain("**/.env");
  expect(dr).toContain("**/.git-credentials");
  expect(dr.some((p) => p.endsWith("/.ssh"))).toBe(true);
  expect(dr.some((p) => p.endsWith("/.config"))).toBe(true);
  expect(dr.some((p) => p.endsWith("/.kube"))).toBe(true);
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

test("sanitizeEnv strips oddly-named tokens (broadened heuristic)", () => {
  const e = sanitizeEnv({ GITHUB_PAT: "x", DOCKER_AUTH_CONFIG: "y", APIKEY: "z", PATH: "/bin", HOME: "/h" });
  expect(e.GITHUB_PAT).toBeUndefined();
  expect(e.DOCKER_AUTH_CONFIG).toBeUndefined();
  expect(e.APIKEY).toBeUndefined();
  expect(e.PATH).toBe("/bin");
  expect(e.HOME).toBe("/h");
});

test("sanitizeEnv strips agent-socket capability vars (not secret-shaped)", () => {
  const e = sanitizeEnv({ SSH_AUTH_SOCK: "/tmp/a.sock", SSH_AGENT_PID: "1", GPG_AGENT_INFO: "x", PATH: "/bin" });
  expect(e.SSH_AUTH_SOCK).toBeUndefined();
  expect(e.SSH_AGENT_PID).toBeUndefined();
  expect(e.GPG_AGENT_INFO).toBeUndefined();
  expect(e.PATH).toBe("/bin");
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
