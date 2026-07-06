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
// Auth vars the Claude Code child process needs to reach the API. Kept in the child env so auth
// works, but still denied to sandboxed Bash (secretEnvNames returns them too). Harmless if unset —
// oauth via ~/.claude uses none of these.
const AUTH_KEEP = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);

// Every secret-shaped env key — hidden from sandboxed Bash via credentials.envVars. Deliberately
// includes AUTH_KEEP vars: the parent process needs them, sandboxed Bash must never read them.
export function secretEnvNames(src: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(src).filter((k) => SECRET_ENV_RE.test(k));
}

// Child env with secret-shaped keys removed — the primary env-exfil control — EXCEPT the auth vars
// the child needs to authenticate (those stay, but are hidden from Bash via secretEnvNames above).
// Non-secret operational vars (PATH, HOME, TELEGRAM_CHAT_ID, ...) pass through unchanged.
export function sanitizeEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (SECRET_ENV_RE.test(k) && !AUTH_KEEP.has(k)) continue;
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
