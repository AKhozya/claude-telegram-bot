import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { runSafetyHook, runner } = await import("./safety-hook");

// Real scripts on disk: the thing under test is a real spawn, and mocking it away would
// leave the exit-code contract — the entire point of the module — unexercised.
const scratch = mkdtempSync(join(tmpdir(), "safety-hook-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const realSpawn = runner.spawn;
const savedEnv = process.env.SAFETY_HOOK;
afterEach(() => {
  runner.spawn = realSpawn;
  if (savedEnv === undefined) delete process.env.SAFETY_HOOK;
  else process.env.SAFETY_HOOK = savedEnv;
});

function script(name: string, body: string, mode = 0o755): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, mode);
  process.env.SAFETY_HOOK = path;
  return path;
}

const INPUT = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };

test("unset SAFETY_HOOK leaves the layer off", async () => {
  delete process.env.SAFETY_HOOK;
  expect(await runSafetyHook(INPUT)).toEqual({ allowed: true });
});

test("blank SAFETY_HOOK leaves the layer off", async () => {
  process.env.SAFETY_HOOK = "   ";
  expect(await runSafetyHook(INPUT)).toEqual({ allowed: true });
});

test("exit 0 allows", async () => {
  script("ok.sh", "exit 0");
  expect(await runSafetyHook(INPUT)).toEqual({ allowed: true });
});

test("exit 2 denies and carries the script's stderr as the reason", async () => {
  script("block.sh", 'echo "BLOCKED: no" >&2\nexit 2');
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toBe("BLOCKED: no");
});

test("exit 2 with no stderr still denies, with a fallback reason", async () => {
  script("silent-block.sh", "exit 2");
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toBe("blocked by the safety hook");
});

// The script aborts on `${HOME:?}` this way, which must never read as "allow".
test("exit 1 denies — a hook that cannot decide must not allow", async () => {
  script("broken.sh", 'echo "HOME must be set" >&2\nexit 1');
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toContain("exited 1");
});

test("a missing script denies rather than disabling the layer", async () => {
  process.env.SAFETY_HOOK = join(scratch, "does-not-exist.sh");
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toContain("could not run");
});

test("a non-executable script denies", async () => {
  script("noexec.sh", "exit 0", 0o644);
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toContain("could not run");
});

test("a hung script denies once the timeout kills it", async () => {
  script("hang.sh", "sleep 30");
  runner.spawn = (cmd: string[]) =>
    Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 200 });
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toContain("killed by");
});

test("a spawn that throws denies instead of escaping the callback", async () => {
  script("ok.sh", "exit 0");
  runner.spawn = () => {
    throw new Error("boom");
  };
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toContain("boom");
});

test("a throw after spawn still denies rather than rejecting", async () => {
  script("ok.sh", "exit 0");
  runner.spawn = () =>
    ({
      stdin: {
        write() {
          throw new Error("stdin exploded");
        },
        end() {},
      },
    }) as unknown as ReturnType<typeof runner.spawn>;
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.allowed).toBe(false);
  expect(verdict.reason).toContain("stdin exploded");
});

// Closing stdin is what lets a script that reads to EOF finish at all; without it this
// test would hit the timeout instead of returning the command it read.
test("the hook input reaches the script on stdin, and stdin is closed", async () => {
  script("echo-stdin.sh", 'cmd=$(jq -r ".tool_input.command")\necho "saw:$cmd" >&2\nexit 2');
  const verdict = await runSafetyHook(INPUT);
  expect(verdict.reason).toBe("saw:ls");
});
