/**
 * Configuration for Claude Telegram Bot.
 *
 * All environment variables, paths, constants, and safety settings.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { resolve, dirname } from "path";
import type { McpServerConfig } from "./types";

// ============== Environment Setup ==============

const HOME = homedir();

// Ensure necessary paths are available for Claude's bash commands
// LaunchAgents don't inherit the full shell environment
const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(":");

// ============== Core Configuration ==============

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS: number[] = (
  process.env.TELEGRAM_ALLOWED_USERS || ""
)
  .split(",")
  .filter((x) => x.trim())
  .map((x) => parseInt(x.trim(), 10))
  .filter((x) => !isNaN(x));

export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;

// ============== MCP Configuration ==============

/**
 * Load `mcp-config.ts`, or explain why there are no MCP servers.
 *
 * Absent, unparseable and exporting-the-wrong-thing are three distinct outcomes and each
 * gets its own message. Only the first is a normal choice; the other two are mistakes. They
 * used to be one silent path: the import was wrapped in `.catch(() => null)`, which
 * swallowed a syntax error in the config exactly as if the file were missing and stopped
 * any import rejection from reaching the `catch` below it — so a typo in the config started
 * a bot with no MCP servers and printed nothing at all. The bot still runs without them;
 * that is a valid degraded mode, not a reason to exit.
 */
export async function loadMcpServers(
  path: string
): Promise<Record<string, McpServerConfig>> {
  if (!existsSync(path)) {
    console.log("No mcp-config.ts found - running without MCPs");
    return {};
  }
  try {
    const mcpModule = await import(path);
    if (!mcpModule.MCP_SERVERS) {
      console.error(`${path} exports no MCP_SERVERS - running without MCPs`);
      return {};
    }
    console.log(
      `Loaded ${Object.keys(mcpModule.MCP_SERVERS).length} MCP servers from mcp-config.ts`
    );
    return mcpModule.MCP_SERVERS;
  } catch (error) {
    console.error(`${path} failed to load - running without MCPs:`, error);
    return {};
  }
}

const MCP_SERVERS = await loadMcpServers(
  resolve(dirname(import.meta.dir), "mcp-config.ts")
);

export { MCP_SERVERS };

// ============== Security Configuration ==============

const defaultAllowedPaths = [
  WORKING_DIR,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
  `${HOME}/Desktop`,
  `${HOME}/.claude`, // Claude Code data (plans, settings)
];

const allowedPathsStr = process.env.ALLOWED_PATHS || "";
export const ALLOWED_PATHS: string[] = allowedPathsStr
  ? allowedPathsStr
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
  : defaultAllowedPaths;

function buildSafetyPrompt(allowedPaths: string[]): string {
  const pathsList = allowedPaths
    .map((p) => `   - ${p} (and subdirectories)`)
    .join("\n");

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

OUTPUT FORMATTING:
Telegram renders rich GitHub-Flavored Markdown. Format every reply as structured markdown, never walls of prose:
- Use ## / ### headings to separate sections.
- Use tables for any tabular or comparative data (status lists, before/after, option trade-offs).
- Use bullet or numbered lists for enumerable items; nest where it adds structure.
- Wrap commands, file paths, values, and identifiers in \`inline code\`; use fenced code blocks for multi-line output or commands.
- Bold the single key term, not whole sentences.
Prefer a table or list over a paragraph whenever the content is enumerable. Keep replies scannable.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}

export const SAFETY_PROMPT = buildSafetyPrompt(ALLOWED_PATHS);

export const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "sudo rm",
  ":(){ :|:& };:", // Fork bomb
  "> /dev/sd",
  "mkfs.",
  "dd if=",
];

// ============== Thinking Keywords ==============

const thinkingKeywordsStr =
  process.env.THINKING_KEYWORDS || "think,pensa,ragiona";
const thinkingDeepKeywordsStr =
  process.env.THINKING_DEEP_KEYWORDS || "ultrathink,think hard,pensa bene";

export const THINKING_KEYWORDS = thinkingKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());
export const THINKING_DEEP_KEYWORDS = thinkingDeepKeywordsStr
  .split(",")
  .map((k) => k.trim().toLowerCase());

// ============== Media Group Settings ==============

export const MEDIA_GROUP_TIMEOUT = 1000; // ms to wait for more photos in a group

// ============== Telegram Message Limits ==============

export const TELEGRAM_MESSAGE_LIMIT = 4096; // Max characters per message
export const TELEGRAM_SAFE_LIMIT = 4000; // Safe limit with buffer for formatting
export const STREAMING_THROTTLE_MS = 500; // Throttle streaming updates
export const BUTTON_LABEL_MAX_LENGTH = 30; // Max chars for inline button labels

// Bot API caption cap, identical on sendPhoto/Video/Audio/Document. Over it the whole
// send is rejected, so an unclipped caption loses the file it was attached to.
export const TELEGRAM_CAPTION_LIMIT = 1024;

// Rich messages allow up to 32768 UTF-8 chars (plain messages cap at 4096).
export const TELEGRAM_RICH_LIMIT = 32768;

// ============== Audit Logging ==============

export const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH || "/tmp/claude-telegram-audit.log";
export const AUDIT_LOG_JSON =
  (process.env.AUDIT_LOG_JSON || "false").toLowerCase() === "true";

// ============== Rate Limiting ==============

export const RATE_LIMIT_ENABLED =
  (process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
export const RATE_LIMIT_REQUESTS = parseInt(
  process.env.RATE_LIMIT_REQUESTS || "20",
  10
);
export const RATE_LIMIT_WINDOW = parseInt(
  process.env.RATE_LIMIT_WINDOW || "60",
  10
);

// ============== HTTP Trigger ==============

// HTTP trigger lets external systems (e.g. cron, CI) inject a prompt as if
// the first allowed user sent it. Disabled unless TRIGGER_SECRET is set.
export const TRIGGER_SECRET = process.env.TRIGGER_SECRET || "";
export const TRIGGER_PORT = parseInt(process.env.TRIGGER_PORT || "8080", 10);
export const TRIGGER_HOST = process.env.TRIGGER_HOST || "127.0.0.1";
export const TRIGGER_ENABLED = !!TRIGGER_SECRET;

// ============== File Paths ==============

export const SESSION_FILE =
  process.env.SESSION_FILE_PATH || "/tmp/claude-telegram-session.json";
export const RESTART_FILE =
  process.env.RESTART_FILE_PATH || "/tmp/claude-telegram-restart.json";
export const TEMP_DIR = process.env.TEMP_DIR || "/tmp/telegram-bot";

export const TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

/**
 * `Number`, not `parseInt`: parseInt("12abc") is 12, so a typo'd interval or retention
 * would be silently accepted as a plausible number rather than falling back.
 */
export function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`${name}="${raw}" is not a positive number - using ${fallback}`);
    return fallback;
  }
  return parsed;
}

// Nothing else clears TEMP_DIR. In-cluster /tmp is an emptyDir that lives as long as
// the pod, so media accumulates for the pod's whole lifetime without this sweep.
export const TEMP_REAP_INTERVAL_MS = positiveNumberEnv(
  "TEMP_REAP_INTERVAL_MS",
  60 * 60 * 1000
);
// An ask_user pause holds a downloaded file open until the user taps a button, and
// Claude re-reads it then. A pause outlasting this window loses the file.
export const TEMP_RETENTION_MS =
  positiveNumberEnv("TEMP_RETENTION_HOURS", 24) * 60 * 60 * 1000;

// How long an MCP request file may sit unread before the bot treats it as orphaned.
// `pollFor` in `session.ts` gives a new file 400 ms of sleeps across three checks and
// never looks again for that call, so one written after the last check waits for the poll
// of a LATER ask_user call. This window is what that poll then decides: under it the old
// question arrives beside the new one, over it the file is dropped — a query whose child
// died with the bot must not put live buttons under a dead question. Not configurable.
export const IPC_PENDING_TTL_MS = 5 * 60 * 1000;

// Bun.write creates missing parent dirs, so this is how TEMP_DIR gets made.
await Bun.write(`${TEMP_DIR}/.keep`, "");

// ============== Validation ==============

if (!TELEGRAM_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

if (ALLOWED_USERS.length === 0) {
  console.error(
    "ERROR: TELEGRAM_ALLOWED_USERS environment variable is required"
  );
  process.exit(1);
}

console.log(
  `Config loaded: ${ALLOWED_USERS.length} allowed users, working dir: ${WORKING_DIR}`
);
