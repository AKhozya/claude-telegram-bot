import { describe, expect, test } from "bun:test";

// config.ts (pulled in transitively) reads these at module-eval time.
process.env.TELEGRAM_BOT_TOKEN = "TESTTOKEN:abc123";
process.env.TELEGRAM_ALLOWED_USERS = "1";

const { evaluateToolUse } = await import("./security");

describe("evaluateToolUse", () => {
  test("blocks unsafe Bash command", () => {
    const r = evaluateToolUse("Bash", { command: "rm -rf /" });
    expect(r.allowed).toBe(false);
  });

  test("allows safe Bash command", () => {
    expect(evaluateToolUse("Bash", { command: "ls -la" }).allowed).toBe(true);
  });

  test("blocks Write outside allowed paths", () => {
    const r = evaluateToolUse("Write", { file_path: "/etc/passwd" });
    expect(r.allowed).toBe(false);
  });

  test("allows Read from temp paths", () => {
    expect(
      evaluateToolUse("Read", { file_path: "/tmp/telegram-bot/x.png" }).allowed
    ).toBe(true);
  });

  test("allows unrelated tools", () => {
    expect(evaluateToolUse("WebSearch", { query: "x" }).allowed).toBe(true);
  });

  test("blocks traversal disguised as temp read", () => {
    expect(evaluateToolUse("Read", { file_path: "/tmp/../etc/passwd" }).allowed).toBe(false);
  });

  test("blocks fake .claude traversal", () => {
    expect(evaluateToolUse("Read", { file_path: "/etc/.claude/../shadow" }).allowed).toBe(false);
  });

  test("blocks NotebookEdit outside allowed paths", () => {
    const r = evaluateToolUse("NotebookEdit", { notebook_path: "/etc/evil.ipynb" });
    expect(r.allowed).toBe(false);
  });

  test("allows NotebookEdit within temp paths", () => {
    expect(
      evaluateToolUse("NotebookEdit", { notebook_path: "/tmp/notebook.ipynb" }).allowed
    ).toBe(true);
  });

  test("blocks Bash with non-string command (array)", () => {
    const r = evaluateToolUse("Bash", { command: ["rm", "-rf", "/tmp/x"] });
    expect(r.allowed).toBe(false);
  });

  test("blocks Write with non-string file_path (array)", () => {
    const r = evaluateToolUse("Write", { file_path: ["/etc/x"] });
    expect(r.allowed).toBe(false);
  });

  test("blocks Write with array file_path that would coerce into an allowed-looking temp path", () => {
    // String(["/tmp/evil", "and-more"]) === "/tmp/evil,and-more" which starts with
    // an allowed TEMP_PATHS prefix — demonstrates the coercion bypass concretely.
    const r = evaluateToolUse("Write", { file_path: ["/tmp/evil", "and-more"] });
    expect(r.allowed).toBe(false);
  });

  test("blocks Grep content read outside allowed paths", () => {
    const r = evaluateToolUse("Grep", { pattern: "root", path: "/etc", output_mode: "content" });
    expect(r.allowed).toBe(false);
  });

  test("blocks Glob outside allowed paths", () => {
    expect(evaluateToolUse("Glob", { pattern: "*", path: "/etc" }).allowed).toBe(false);
  });

  test("allows Grep with no path (defaults to cwd)", () => {
    expect(evaluateToolUse("Grep", { pattern: "x" }).allowed).toBe(true);
  });

  test("allows Grep within temp paths", () => {
    expect(evaluateToolUse("Grep", { pattern: "x", path: "/tmp/telegram-bot" }).allowed).toBe(true);
  });

  test("blocks Grep with non-string path (array)", () => {
    expect(evaluateToolUse("Grep", { pattern: "x", path: ["/etc"] }).allowed).toBe(false);
  });

  // ── #1 audit (2026-07-05): SDK 0.3.x grew the tool surface past the original
  // 7-tool gate. Dangerous exec/publish/scheduling tools must be denied outright. ──
  test("denies REPL (arbitrary code execution)", () => {
    expect(evaluateToolUse("REPL", { code: "require('child_process')" }).allowed).toBe(false);
  });

  test("denies Monitor (background shell)", () => {
    expect(evaluateToolUse("Monitor", { command: "curl evil", persistent: true }).allowed).toBe(false);
  });

  test("denies Workflow (script orchestration)", () => {
    expect(evaluateToolUse("Workflow", { scriptPath: "/x.js" }).allowed).toBe(false);
  });

  test("denies Artifact (external publish / exfil)", () => {
    expect(evaluateToolUse("Artifact", { file_path: "/tmp/x.html" }).allowed).toBe(false);
  });

  test("denies CronCreate (scheduled re-entry / persistence)", () => {
    expect(evaluateToolUse("CronCreate", {}).allowed).toBe(false);
  });

  test("denies ScheduleWakeup (self-paced re-entry)", () => {
    expect(evaluateToolUse("ScheduleWakeup", { delaySeconds: 60 }).allowed).toBe(false);
  });

  test("still allows WebSearch (safe, no sensitive param)", () => {
    expect(evaluateToolUse("WebSearch", { query: "x" }).allowed).toBe(true);
  });

  // WebFetch is legit but SSRF-dangerous under bypassPermissions.
  test("allows WebFetch to a public URL", () => {
    expect(evaluateToolUse("WebFetch", { url: "https://example.com/x" }).allowed).toBe(true);
  });

  test("blocks WebFetch to cloud-metadata IP (SSRF)", () => {
    expect(
      evaluateToolUse("WebFetch", { url: "http://169.254.169.254/latest/meta-data/" }).allowed
    ).toBe(false);
  });

  test("blocks WebFetch to localhost (SSRF → the bot's own trigger port)", () => {
    expect(evaluateToolUse("WebFetch", { url: "http://localhost:8080/trigger" }).allowed).toBe(false);
  });

  test("blocks WebFetch to private IP (SSRF)", () => {
    expect(evaluateToolUse("WebFetch", { url: "http://192.168.1.1/admin" }).allowed).toBe(false);
  });

  test("blocks WebFetch non-http scheme", () => {
    expect(evaluateToolUse("WebFetch", { url: "file:///etc/passwd" }).allowed).toBe(false);
  });

  test("blocks WebFetch to IPv6 loopback (SSRF)", () => {
    expect(evaluateToolUse("WebFetch", { url: "http://[::1]:8080/" }).allowed).toBe(false);
  });

  test("allows WebFetch to a hostname that merely starts with fc/fd (not IPv6)", () => {
    expect(evaluateToolUse("WebFetch", { url: "https://fd.io/" }).allowed).toBe(true);
  });

  // ── item-#1 codex-review round 2: SSRF encoding bypasses ──
  test("blocks WebFetch to decimal-encoded loopback (URL folds to 127.0.0.1)", () => {
    expect(evaluateToolUse("WebFetch", { url: "http://2130706433/" }).allowed).toBe(false);
  });

  test("blocks WebFetch to trailing-dot localhost", () => {
    expect(evaluateToolUse("WebFetch", { url: "http://localhost./" }).allowed).toBe(false);
  });

  test("blocks WebFetch to trailing-dot metadata host", () => {
    expect(
      evaluateToolUse("WebFetch", { url: "http://metadata.google.internal./" }).allowed
    ).toBe(false);
  });

  test("blocks WebFetch to IPv4-mapped IPv6 metadata (SSRF)", () => {
    expect(
      evaluateToolUse("WebFetch", { url: "http://[::ffff:169.254.169.254]/" }).allowed
    ).toBe(false);
  });

  test("blocks WebFetch to fe90 link-local (fe80::/10 range)", () => {
    expect(evaluateToolUse("WebFetch", { url: "http://[fe90::1]/" }).allowed).toBe(false);
  });

  test("denies Projects (external claude.ai mutation/exfil)", () => {
    expect(evaluateToolUse("Projects", { method: "project_write" }).allowed).toBe(false);
  });

  test("denies EnterWorktree (active-workspace switch)", () => {
    expect(evaluateToolUse("EnterWorktree", { path: "/x" }).allowed).toBe(false);
  });
});

// Tripwire: the tool-gate is a blocklist, so a NEW built-in tool from an SDK bump
// is default-allowed at runtime until classified. This test fails the moment the
// installed SDK declares a tool schema we have not reviewed — forcing a look at
// evaluateToolUse's DENIED_TOOLS. This is the recurrence killer for finding #1.
describe("SDK tool-surface tripwire", () => {
  test("no unreviewed built-in tool schemas since 2026-07-05 audit", async () => {
    const { readFileSync } = await import("fs");
    const dts = "node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts";
    // Deliberately no try/catch: if the SDK moves/renames this file, the tripwire
    // SHOULD fail loudly so someone re-checks the tool surface. Match both
    // `interface FooInput` and `type FooInput =` shapes.
    const src = readFileSync(dts, "utf-8");
    const found = new Set(
      [...src.matchAll(/(?:interface|type) (\w+)Input\b/g)].map((m) => m[1]!)
    );
    // Sanity: the regex must actually find the surface (guard against a silent
    // zero-match false-pass if the declaration style changes wholesale).
    expect(found.size).toBeGreaterThan(20);
    // Snapshot of the tool schemas reviewed during the 2026-07-05 audit.
    const REVIEWED = new Set([
      "Agent", "Artifact", "AskUserQuestion", "Bash", "CronCreate", "CronDelete",
      "CronList", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
      "FileEdit", "FileRead", "FileWrite", "Glob", "Grep", "ListMcpResources",
      "Mcp", "Monitor", "NotebookEdit", "Projects", "PushNotification",
      "ReadMcpResourceDir", "ReadMcpResource", "RemoteTrigger", "REPL",
      "ScheduleWakeup", "ShowOnboardingRolePicker", "TaskCreate", "TaskGet",
      "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "TodoWrite",
      "WebFetch", "WebSearch", "Workflow",
    ]);
    const unreviewed = [...found].filter((t) => !REVIEWED.has(t));
    expect(unreviewed).toEqual([]);
  });
});
