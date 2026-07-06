import { homedir } from "os";
import { lstatSync, mkdirSync } from "fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ALLOWED_PATHS, AUDIT_LOG_PATH, SESSION_FILE, RESTART_FILE } from "./config";

const HOME = homedir();

// Dedicated Bash scratch — not the broad temp roots. Blanket /tmp would expose other
// processes' temp files and the bot's own session/audit files. Created via ensureScratchDir().
export const SANDBOX_SCRATCH = "/tmp/ctb-sandbox";

// Create the scratch dir private (0700), refusing a pre-planted symlink at the path — a local
// process could otherwise redirect sandbox reads/writes through it. Idempotent.
export function ensureScratchDir(dir: string = SANDBOX_SCRATCH): void {
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      throw new Error(`refusing to use sandbox scratch ${dir}: pre-existing symlink`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// Credential stores denied to sandboxed Bash. The inline sandbox does NOT fail-close reads (probe-
// verified: allowRead only re-allows within denyRead regions, and allowManagedReadPathsOnly is honored
// only from managed policy settings, not the query() option). So read containment is this BLOCKLIST +
// Layer-2 network egress. A blocklist is inherently incomplete — an unlisted store is a documented
// ceiling (see spec). Broad dirs (~/.config) are denied wholesale to catch unknown stores under them.
const READ_DENY: string[] = [
  `${HOME}/.ssh`,
  `${HOME}/.aws`,
  `${HOME}/.gnupg`,
  `${HOME}/.kube`,
  `${HOME}/.docker`,
  `${HOME}/.config`, // gh, op, gcloud, and any other credential store under XDG config
  `${HOME}/.claude/.credentials*`,
  `${HOME}/.netrc`,
  `${HOME}/.git-credentials`,
  `${HOME}/.npmrc`,
  `${HOME}/.pypirc`,
  `${HOME}/.pgpass`,
  "**/.env",
  "**/.git-credentials",
  "**/.npmrc",
  // The bot's own runtime files (live in /tmp, which is otherwise a scratch-writable path). Reading the
  // audit log exfils past conversation content; the media TEMP_DIR is intentionally NOT here.
  AUDIT_LOG_PATH,
  SESSION_FILE,
  RESTART_FILE,
];

// Broad on purpose: substring match on KEY/TOKEN/SECRET/AUTH/... catches oddly-named tokens
// (GITHUB_PAT, APIKEY, DOCKER_AUTH_CONFIG) that an anchored regex misses. Over-matching a non-secret
// (e.g. PUBLIC_KEY_ID) only over-strips it from the sandboxed child — safe; AUTH_KEEP re-admits the
// few vars Claude Code genuinely needs. Ceiling: a secret with none of these tokens in its name.
const SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|_PAT\b|AUTH)/i;
// Auth vars the Claude Code child process needs to reach the API. Kept in the child env so auth
// works, but still denied to sandboxed Bash (secretEnvNames returns them too). Harmless if unset —
// oauth via ~/.claude uses none of these.
const AUTH_KEEP = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);

// Capability-bearing vars that are NOT secret-shaped (no key material) but hand sandboxed Bash live
// auth: an agent socket lets `ssh`/`gpg` act as the real user without ever reading a key file —
// invisible to both the path denylist and the name regex. Always stripped from the child.
const CAP_STRIP = new Set(["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO"]);

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
    if (CAP_STRIP.has(k)) continue;
    if (SECRET_ENV_RE.test(k) && !AUTH_KEEP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// The Linux backend is bubblewrap, which needs unprivileged user namespaces. A locked-down pod
// (seccompProfile: RuntimeDefault, no CAP_SYS_ADMIN) blocks those, so a fail-closed bwrap can't start
// and every Bash command would fail. Set BASH_SANDBOX_ENABLED=false in that environment — the pod is
// the sandbox there (readOnlyRootFilesystem already confines writes to the mounted paths, caps dropped,
// egress NetworkPolicy). Default ON, and an unrecognized value stays ON (secure default) — only an
// explicit off value disables. macOS Seatbelt has no userns dependency, so it stays enabled.
export function bashSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.BASH_SANDBOX_ENABLED ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(v);
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
      // Writes ARE fail-closed: allowWrite is a strict allowlist (probe-verified) — the real control
      // against injected deletion/overwrite outside ALLOWED_PATHS.
      allowWrite: [...allowedPaths, SANDBOX_SCRATCH],
      // Write here == code execution loaded outside the sandbox (settings.json/hooks define hooks,
      // .mcp.json spawns a subprocess). Denied even inside ALLOWED_PATHS. The native Write/Edit tools
      // are gated separately in security.ts — this denyWrite only binds Bash.
      denyWrite: [
        `${HOME}/.claude`,
        "**/.claude/settings*.json",
        "**/.claude/hooks/**",
        "**/.mcp.json",
        SESSION_FILE, // corrupting it breaks /resume (DoS)
        RESTART_FILE,
        AUDIT_LOG_PATH, // tampering with the audit trail
      ],
      // No allowRead: the SDK gives allowRead PRECEDENCE over denyRead for matching paths, so
      // re-allowing ALLOWED_PATHS (which defaults to include $HOME + ~/.claude) would re-open a repo's
      // own .env and ~/.claude/.credentials living inside them. Reads are fail-open by default anyway, so
      // ALLOWED_PATHS stays readable without an allowRead entry — leaving denyRead authoritative.
      denyRead: READ_DENY,
    },
    credentials: { envVars: secretEnvNames().map((name) => ({ name, mode: "deny" as const })) },
    // Domain-level denylist starts empty; CIDR egress control is the container NetworkPolicy (Layer 2).
    network: { deniedDomains: [] },
  };
}
