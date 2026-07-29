/**
 * Formatting module for Claude Telegram Bot.
 *
 * Markdown conversion and tool status display formatting.
 */

import {
  ORG_POLICY_LIMIT_PREFIXES,
  USAGE_LIMIT_ERROR_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";

// Only these two tables can reach a `catch`. USAGE_WARNING_PREFIXES and
// USAGE_TRANSITION_PREFIXES are toast-only in the CLI and are never thrown.
const LIMIT_PREFIXES = [
  ...USAGE_LIMIT_ERROR_PREFIXES,
  ...ORG_POLICY_LIMIT_PREFIXES,
];

/**
 * Trim an error down to the part worth reading on a phone.
 *
 * A usage-limit sentence arrives buried in a wrapped error — `Error: API Error: 429
 * {"type":"error",...,"message":"You've hit your monthly spend limit. Run /usage-credits
 * ..."}}`. Truncating that from the left shows only the wrapper, so find the sentence and
 * start there. Matched with `includes` because a thrown Error puts the wrapper first;
 * `startsWith` would only work for the rarer case of a bare limit string.
 */
export function describeError(error: unknown, max = 200): string {
  const raw = String(error);
  const hit = LIMIT_PREFIXES.find((p) => raw.includes(p));
  if (!hit) return raw.slice(0, max);

  // The sentence sits inside a JSON string, so the closing quote ends it — but only an
  // UNESCAPED one. A sentence that quotes a flag or command reaches us as \" and must not
  // be cut there. Counting backslashes in PAIRS is what makes that precise: a lone
  // `(?<!\\)"` also skips the real terminator after a literal backslash (`C:\\"`), which
  // then leaks the JSON envelope into the user's error message.
  const at = raw.indexOf(hit);
  const tail = raw.slice(at, at + max);
  const end = /(?<!\\)(?:\\\\)*"/.exec(tail);
  return end ? tail.slice(0, end.index + end[0].length - 1) : tail;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert standard markdown to Telegram-compatible HTML.
 *
 * HTML is more reliable than Telegram's Markdown which breaks on special chars.
 * Telegram HTML supports: <b>, <i>, <code>, <pre>, <a href="">
 */
export function convertMarkdownToHtml(text: string): string {
  // Store code blocks temporarily to avoid processing their contents
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  text = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(code);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push(code);
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`;
  });

  text = escapeHtml(text);

  // Headers: ## Header -> <b>Header</b>
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>\n");

  // Bold: **text** -> <b>text</b>
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Also handle *text* as bold (single asterisk)
  text = text.replace(/(?<!\*)\*(.+?)\*(?!\*)/g, "<b>$1</b>");

  // Double underscore: __text__ -> <b>text</b>
  text = text.replace(/__([^_]+)__/g, "<b>$1</b>");

  // Italic: _text_ -> <i>text</i> (but not __text__)
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, "<i>$1</i>");

  // Blockquotes: &gt; text -> <blockquote>text</blockquote>
  text = convertBlockquotes(text);

  // Bullet lists: - item or * item -> • item
  text = text.replace(/^[-*] /gm, "• ");

  // Horizontal rules: --- or *** -> blank line
  text = text.replace(/^[-*]{3,}$/gm, "");

  // Links: [text](url) -> <a href="url">text</a>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks. Use a replacement FUNCTION, not a string — a string
  // replacement interprets `$$`/`$&`/`` $` ``/`$'` in the code as special patterns
  // (e.g. code `$&` would re-insert the placeholder), corrupting the output.
  for (let i = 0; i < codeBlocks.length; i++) {
    const escapedCode = escapeHtml(codeBlocks[i]!);
    text = text.replace(`\x00CODEBLOCK${i}\x00`, () => `<pre>${escapedCode}</pre>`);
  }

  // Restore inline code (same `$`-in-replacement hazard — use a function).
  for (let i = 0; i < inlineCodes.length; i++) {
    const escapedCode = escapeHtml(inlineCodes[i]!);
    text = text.replace(
      `\x00INLINECODE${i}\x00`,
      () => `<code>${escapedCode}</code>`
    );
  }

  text = text.replace(/\n{3,}/g, "\n\n");

  return text;
}

function convertBlockquotes(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inBlockquote = false;
  const blockquoteLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("&gt; ") || line === "&gt;") {
      if (line === "&gt;") {
        blockquoteLines.push("");
      } else {
        // Remove '&gt; ' and strip # from hashtags (Telegram mobile bug workaround)
        const content = line.slice(5).replace(/#/g, "");
        blockquoteLines.push(content);
      }
      inBlockquote = true;
    } else {
      if (inBlockquote) {
        result.push(
          "<blockquote>" + blockquoteLines.join("\n") + "</blockquote>"
        );
        blockquoteLines.length = 0;
        inBlockquote = false;
      }
      result.push(line);
    }
  }

  // Handle blockquote at end
  if (inBlockquote) {
    result.push("<blockquote>" + blockquoteLines.join("\n") + "</blockquote>");
  }

  return result.join("\n");
}

// ============== Tool Status Formatting ==============

function shortenPath(path: string): string {
  if (!path) return "file";
  const parts = path.split("/");
  if (parts.length >= 2) {
    return parts.slice(-2).join("/");
  }
  return parts[parts.length - 1] || path;
}

function truncate(text: string, maxLen = 60): string {
  if (!text) return "";
  // A newline would break the single-line tool-status message.
  const cleaned = text.replace(/\n/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + "...";
}

function code(text: string): string {
  return `<code>${escapeHtml(text)}</code>`;
}

export function formatToolStatus(
  toolName: string,
  toolInput: Record<string, unknown>
): string {
  const emojiMap: Record<string, string> = {
    Read: "📖",
    Write: "📝",
    Edit: "✏️",
    Bash: "▶️",
    Glob: "🔍",
    Grep: "🔎",
    WebSearch: "🔍",
    WebFetch: "🌐",
    Task: "🎯",
    TodoWrite: "📋",
    mcp__: "🔧",
  };

  // Substring match, so the "mcp__" key catches every MCP tool. Insertion order
  // decides ties — "mcp__" sits last so a named tool wins over the generic icon.
  let emoji = "🔧";
  for (const [key, val] of Object.entries(emojiMap)) {
    if (toolName.includes(key)) {
      emoji = val;
      break;
    }
  }

  if (toolName === "Read") {
    const filePath = String(toolInput.file_path || "file");
    const shortPath = shortenPath(filePath);
    const imageExtensions = [
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".bmp",
      ".svg",
      ".ico",
    ];
    if (imageExtensions.some((ext) => filePath.toLowerCase().endsWith(ext))) {
      return "👀 Viewing";
    }
    return `${emoji} Reading ${code(shortPath)}`;
  }

  if (toolName === "Write") {
    const filePath = String(toolInput.file_path || "file");
    return `${emoji} Writing ${code(shortenPath(filePath))}`;
  }

  if (toolName === "Edit") {
    const filePath = String(toolInput.file_path || "file");
    return `${emoji} Editing ${code(shortenPath(filePath))}`;
  }

  if (toolName === "Bash") {
    const cmd = String(toolInput.command || "");
    const desc = String(toolInput.description || "");
    if (desc) {
      return `${emoji} ${escapeHtml(desc)}`;
    }
    return `${emoji} ${code(truncate(cmd, 50))}`;
  }

  if (toolName === "Grep") {
    const pattern = String(toolInput.pattern || "");
    const path = String(toolInput.path || "");
    if (path) {
      return `${emoji} Searching ${code(truncate(pattern, 30))} in ${code(
        shortenPath(path)
      )}`;
    }
    return `${emoji} Searching ${code(truncate(pattern, 40))}`;
  }

  if (toolName === "Glob") {
    const pattern = String(toolInput.pattern || "");
    return `${emoji} Finding ${code(truncate(pattern, 50))}`;
  }

  if (toolName === "WebSearch") {
    const query = String(toolInput.query || "");
    return `${emoji} Searching: ${escapeHtml(truncate(query, 50))}`;
  }

  if (toolName === "WebFetch") {
    const url = String(toolInput.url || "");
    return `${emoji} Fetching ${code(truncate(url, 50))}`;
  }

  if (toolName === "Task") {
    const desc = String(toolInput.description || "");
    if (desc) {
      return `${emoji} Agent: ${escapeHtml(desc)}`;
    }
    return `${emoji} Running agent...`;
  }

  if (toolName === "Skill") {
    const skillName = String(toolInput.skill || "");
    if (skillName) {
      return `💭 Using skill: ${escapeHtml(skillName)}`;
    }
    return `💭 Using skill...`;
  }

  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    if (parts.length >= 3) {
      const server = parts[1]!;
      let action = parts[2]!;
      // mcp__exa__exa_search would otherwise render as "exa exa search".
      if (action.startsWith(`${server}_`)) {
        action = action.slice(server.length + 1);
      }
      action = action.replace(/_/g, " ");

      const summary =
        toolInput.title ||
        toolInput.query ||
        toolInput.content ||
        toolInput.text ||
        toolInput.id ||
        "";

      if (summary) {
        return `🔧 ${server} ${action}: ${escapeHtml(
          truncate(String(summary), 40)
        )}`;
      }
      return `🔧 ${server}: ${action}`;
    }
    return `🔧 ${escapeHtml(toolName)}`;
  }

  return `${emoji} ${escapeHtml(toolName)}`;
}
