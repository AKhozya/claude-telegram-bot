// Runs the external Bash safety hook (`hooks/validate-safe-bash.sh`) from inside the
// bot's own PreToolUse gate, instead of wiring it through ~/.claude/settings.json.
//
// Why not settings.json: that file lives on the PVC and the Bash sandbox is off in the
// cluster, so anything the model runs can delete the `hooks` key and the layer is simply
// gone until the next restart. Called from here it is image code on a read-only
// filesystem, and nothing the model can reach disarms it.
//
// The script is a denylist of homelab-specific commands (kubectl apply without
// --dry-run, helm uninstall, Redis FLUSHALL, git filter-branch); BLOCKED_PATTERNS in
// config.ts is eight generic strings. The two barely overlap, which is why this runs in
// addition to evaluateToolUse rather than instead of it.

import { accessSync, constants } from "node:fs";

const TIMEOUT_MS = 5000;
// Grace on top of the child's own timeout so the normal path wins the race and can report
// the script's exit status, rather than every slow run reading as a hang.
const DEADLINE_MS = TIMEOUT_MS + 500;

export interface SafetyHookVerdict {
  allowed: boolean;
  reason?: string;
}

// Test seam: assign over `.spawn`, then assign the original back. Mirrors transcribe.ts.
export const runner = {
  spawn: (cmd: string[], timeoutMs: number) =>
    Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    }),
};

const deny = (reason: string): SafetyHookVerdict => ({ allowed: false, reason });

/**
 * Unset means the layer is off — the macOS standalone build has no image hooks
 * directory, and a local checkout already wires the hook through the developer's own
 * settings. Set means the script is the authority: every way of failing to get a clean
 * exit 0 out of it denies, so a packaging mistake shows up as blocked Bash rather than as
 * silence.
 */
export function safetyHookPath(): string {
  return (process.env.SAFETY_HOOK || "").trim();
}

export async function runSafetyHook(input: unknown): Promise<SafetyHookVerdict> {
  const path = safetyHookPath();
  if (!path) return { allowed: true };

  try {
    // Checked up front because the platforms disagree: Bun.spawn throws for a missing or
    // non-executable binary on macOS but resolves with exit 127 on Linux/musl. Both deny
    // either way, but only this makes them deny for the same stated reason. It reports
    // what was true a moment ago, not what will execute — spawn failing still denies, so
    // the gap costs nothing.
    try {
      accessSync(path, constants.X_OK);
    } catch {
      return deny(`safety hook ${path} could not run: missing or not executable`);
    }

    let proc;
    try {
      proc = runner.spawn([path], TIMEOUT_MS);
    } catch (error) {
      return deny(`safety hook ${path} could not run: ${(error as Error)?.message ?? error}`);
    }

    // Close stdin after writing so a script that reads to EOF terminates instead of
    // sitting until the timeout.
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // Raced against a wall clock, because awaiting the pipes is not bounded by the child's
    // timeout: a grandchild that outlives the killed script inherits the write end and
    // holds it open, so the read never resolves. Observed on Linux with a script whose
    // `sleep` survived it — the turn would have hung for ever.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = (async () => {
      const [, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { stderr, code: await proc.exited };
    })();
    // Losing the race leaves this promise live; without a catch of its own a later
    // rejection would surface as an unhandled rejection long after we returned.
    finished.catch(() => {});
    let outcome;
    try {
      outcome = await Promise.race([
        finished,
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), DEADLINE_MS);
        }),
      ]);
    } finally {
      // In `finally`, not after the race: a rejection from `finished` jumps straight to
      // the outer catch and would otherwise leave the timer live for the full deadline.
      clearTimeout(timer);
    }

    if (outcome === "deadline") {
      try {
        // Only the immediate child. A grandchild it left behind keeps running, and with
        // it the pipe that caused the hang. Killing the process group would need the
        // child to be a group leader, which costs a setsid that macOS does not ship, and
        // the hook shipped in the image backgrounds nothing — so this is the bound worth
        // paying for. The deny below does not depend on the kill succeeding.
        proc.kill(9);
      } catch {
        // Already gone.
      }
      return deny(`safety hook ${path} did not finish within ${DEADLINE_MS}ms`);
    }

    const { stderr, code } = outcome;
    // The child's own timeout kills it, which surfaces as a signal, not an exit status.
    if (proc.signalCode) {
      return deny(`safety hook ${path} killed by ${proc.signalCode} (limit ${TIMEOUT_MS}ms)`);
    }
    if (code === 0) return { allowed: true };
    if (code === 2) return deny(stderr.trim() || "blocked by the safety hook");
    // Any other status means the script could not decide. A hook that cannot evaluate
    // its own patterns must not allow.
    return deny(`safety hook ${path} exited ${code}: ${stderr.trim() || "no output"}`);
  } catch (error) {
    // A throw escaping the PreToolUse callback propagates out of the query loop and
    // kills the turn, so every failure becomes a denial instead.
    return deny(`safety hook ${path} failed: ${(error as Error)?.message ?? error}`);
  }
}
