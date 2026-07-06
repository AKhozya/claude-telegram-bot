import { homedir } from "os";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ALLOWED_PATHS } from "./config";

const HOME = homedir();

// Dedicated Bash scratch — not the broad temp roots. Blanket /tmp would expose other
// processes' temp files and the bot's own session/audit files. Created at startup in session.ts.
export const SANDBOX_SCRATCH = "/tmp/ctb-sandbox";

// Reads outside ALLOWED_PATHS that Claude Code + git/build/language tools need to function.
// Reads are fail-closed: anything not here (nor ALLOWED_PATHS/scratch) is unreadable. Widen with
// specific vetted paths if a legit read is denied — never fall back to a blocklist.
export const SYSTEM_READ_SET: string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib", // Alpine/musl dynamic linker + libc live here (absent on macOS — harmless)
  "/lib64",
  "/opt",
  "/etc",
  "/private/etc",
  "/var",
  "/dev",
  "/System",
  "/Library",
  `${HOME}/.claude`,
  `${HOME}/.gitconfig`,
  `${HOME}/.config`,
  `${HOME}/.bun`,
  `${HOME}/.local`,
  `${HOME}/.npm`,
  `${HOME}/.cache`,
];

const SECRET_ENV_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL)/i;
// Non-secret operational vars to keep; auth vars get added here only if calibration shows Claude Code needs them.
const ENV_KEEP = new Set(["TELEGRAM_CHAT_ID"]);

// Secret-shaped env keys — hidden from Bash via the sandbox credentials layer.
export function secretEnvNames(src: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(src).filter((k) => SECRET_ENV_RE.test(k) && !ENV_KEEP.has(k));
}

// Child env with secret-shaped keys removed — the primary env-exfil control. The child (Claude Code
// and every Bash/MCP subprocess it spawns) is spawned without the secrets, so the guarantee holds
// regardless of whether the sandbox credentials layer enforces.
export function sanitizeEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (SECRET_ENV_RE.test(k) && !ENV_KEEP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function buildSandboxSettings(
  allowedPaths: readonly string[] = ALLOWED_PATHS
): NonNullable<Options["sandbox"]> {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [...allowedPaths, SANDBOX_SCRATCH],
      // Write here == code execution (settings.json can define hooks). Deny even inside ALLOWED_PATHS,
      // where a project's .claude/ is otherwise writable.
      denyWrite: [`${HOME}/.claude`, "**/.claude/settings*.json", "**/.claude/hooks/**"],
      allowRead: [...allowedPaths, SANDBOX_SCRATCH, ...SYSTEM_READ_SET],
      // Secrets that may live inside an allowed-read tree.
      denyRead: [
        `${HOME}/.ssh`,
        `${HOME}/.claude/.credentials*`,
        `${HOME}/.aws`,
        `${HOME}/.config/gh`,
        `${HOME}/.config/op`,
        "**/.env",
      ],
    },
    credentials: { envVars: secretEnvNames().map((name) => ({ name, mode: "deny" as const })) },
    // Domain-level denylist starts empty; CIDR egress control is the container NetworkPolicy (Layer 2).
    network: { deniedDomains: [] },
  };
}
