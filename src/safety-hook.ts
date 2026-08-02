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

const TIMEOUT_MS = 5000;

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
    let proc;
    try {
      proc = runner.spawn([path], TIMEOUT_MS);
    } catch (error) {
      // Bun.spawn throws rather than resolving when the path is missing or not executable.
      return deny(`safety hook ${path} could not run: ${(error as Error)?.message ?? error}`);
    }

    // Close stdin after writing so a script that reads to EOF terminates instead of
    // sitting until the timeout.
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;

    // The timeout kills the child, which surfaces as a signal rather than an exit status.
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
