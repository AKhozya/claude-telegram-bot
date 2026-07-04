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
});
