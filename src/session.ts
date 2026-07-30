/**
 * Session management for Claude Telegram Bot.
 *
 * ClaudeSession wraps the Agent SDK query() stream: one process-wide session,
 * persisted to SESSION_FILE so /resume survives a restart.
 */

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, renameSync } from "fs";
import { randomUUID } from "node:crypto";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  MCP_SERVERS,
  SAFETY_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  WORKING_DIR,
} from "./config";
import { describeError, formatToolStatus } from "./formatting";
import { buildSandboxSettings, sanitizeEnv, ensureScratchDir, bashSandboxEnabled } from "./sandbox";
import {
  checkPendingAskUserRequests,
  checkPendingSendFileRequests,
} from "./handlers/streaming";
import { evaluateToolUse, DENIED_TOOLS } from "./security";
import type {
  SavedSession,
  SessionHistory,
  StatusCallback,
  TokenUsage,
} from "./types";

/**
 * Thinking config for a message. Exported so the "never disabled" invariant is testable:
 * the deployment pins effortLevel "xhigh", and the API 400s on xhigh + thinking disabled.
 */
export function getThinkingConfig(message: string): NonNullable<Options["thinking"]> {
  const budget = getThinkingLevel(message);
  return budget === 0
    ? { type: "adaptive" }
    : { type: "enabled", budgetTokens: budget };
}

function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();

  // A deep keyword can contain a normal one ("ultrathink" contains "think"), so
  // testing deep first is what stops it being shadowed. Both lists are env-set,
  // so the containment is a property of the defaults, not a guarantee.
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 50000;
  }

  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) {
    return 10000;
  }

  return 0;
}

/**
 * Write JSON to disk atomically: write to a unique temp file, then rename.
 * Rename is atomic on the same filesystem, so a crash mid-write can't leave
 * a truncated/corrupted file at `path`, and concurrent callers can't clobber
 * each other's temp file.
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

const MAX_SESSIONS = 5;

class ClaudeSession {
  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;

  private abortController: AbortController | null = null;
  private isQueryRunning = false;
  private stopRequested = false;
  private _isProcessing = false;
  private _wasInterruptedByNewMessage = false;

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this.isQueryRunning || this._isProcessing;
  }

  /**
   * Check if the last stop was triggered by a new message interrupt (! prefix).
   * Resets the flag when called. Also clears stopRequested so new messages can proceed.
   */
  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) {
      this.stopRequested = false;
    }
    return was;
  }

  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /** Returns the cleanup function; the caller must invoke it when done. */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Stop the currently running query or mark for cancellation.
   * Returns: "stopped" if query was aborted, "pending" if processing will be cancelled, false if nothing running
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    if (this.isQueryRunning && this.abortController) {
      this.stopRequested = true;
      this.abortController.abort();
      console.log("Stop requested - aborting current query");
      return "stopped";
    }

    if (this._isProcessing) {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  /**
   * Interrupt a running query because a NEW user message is arriving (button tap,
   * ! prefix). Marks the stop as an interrupt so the preempted query's handler stays
   * silent (no spurious "🛑 Query stopped."), then clears stopRequested so the
   * incoming message is not itself cancelled at query start. No-op if nothing runs.
   *
   * Canonical dance — call this everywhere a new message preempts a query rather than
   * re-inlining it; callback.ts drifted from this and dropped the mark + clear.
   */
  async interruptForNewMessage(): Promise<void> {
    if (!this.isRunning) return;
    this.markInterrupt();
    await this.stop();
    // Brief settle so the abort propagates before the new message starts a query.
    await Bun.sleep(100);
    this.clearStopRequested();
  }

  /** @param ctx - grammY context, needed only to render ask_user buttons. */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    // Set chat context for ask_user MCP tool
    if (chatId) {
      process.env.TELEGRAM_CHAT_ID = String(chatId);
    }

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "adaptive", 10000: "normal", 50000: "deep" }[thinkingTokens] ||
      String(thinkingTokens);

    // Inject current date/time at session start so Claude doesn't need to call a tool for it
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString(
        "en-US",
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        }
      )}]\n\n`;
      messageToSend = datePrefix + message;
    }

    // OS-level Bash containment: confine Claude's shell to ALLOWED_PATHS at the sandbox layer
    // (Seatbelt / bubblewrap), fail-closed. env is scrubbed of secrets so the child never inherits
    // them. This backs the regex denylist, which stays as a pre-sandbox speed-bump. The env scrub and
    // strictMcpConfig below are independent of the sandbox and stay on even where bwrap can't run.
    const sandboxEnabled = bashSandboxEnabled();
    if (sandboxEnabled) ensureScratchDir();

    const options: Options = {
      cwd: WORKING_DIR,
      ...(sandboxEnabled ? { sandbox: buildSandboxSettings() } : {}),
      env: sanitizeEnv(),
      settingSources: ["user", "project"],
      // Load MCP servers ONLY from the mcpServers option above — ignore project .mcp.json, user
      // settings, plugins, and agent frontmatter. A .mcp.json spawns its command from the parent
      // process (unsandboxed); injected content must not be able to introduce one on disk.
      strictMcpConfig: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Hard-block dangerous exec/publish/scheduling tools at the SDK layer too —
      // the PreToolUse hook (evaluateToolUse) denies them as well, but this stops
      // the model from ever emitting them. Single source of truth in security.ts.
      disallowedTools: [...DENIED_TOOLS],
      systemPrompt: SAFETY_PROMPT,
      mcpServers: MCP_SERVERS,
      thinking: getThinkingConfig(message),
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                const verdict = await evaluateToolUse(
                  input.tool_name,
                  (input.tool_input ?? {}) as Record<string, unknown>
                );
                if (verdict.allowed) return {};
                console.warn(`HOOK BLOCKED ${input.tool_name}: ${verdict.reason}`);
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: verdict.reason,
                  },
                };
              },
            ],
          },
        ],
      },
    };

    // Required for standalone builds: the compiled binary can't resolve the CLI
    // through node_modules, so the launcher passes its path in.
    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }

    if (this.sessionId && !isNewSession) {
      console.log(
        `RESUMING session ${this.sessionId.slice(
          0,
          8
        )}... (thinking=${thinkingLabel})`
      );
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
    }

    if (this.stopRequested) {
      console.log(
        "Query cancelled before starting (stop was requested during processing)"
      );
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    this.abortController = new AbortController();
    this.isQueryRunning = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let askUserTriggered = false;

    try {
      // Use V1 query() API - supports all options including cwd, mcpServers, etc.
      const queryInstance = query({
        prompt: messageToSend,
        options: {
          ...options,
          abortController: this.abortController,
        },
      });

      for await (const event of queryInstance) {
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        // `/clear`, plan-mode exit and fresh-session flows reset the conversation, leaving
        // the id we hold pointing at a transcript the user just abandoned. Re-arm the
        // capture below instead of adopting new_conversation_id — whether the SDK accepts
        // that as a `resume:` token is untested.
        if (event.type === "conversation_reset") {
          console.log("conversation_reset: dropping stale session_id");
          this.sessionId = null;
          this.conversationTitle = null;
          continue; // load-bearing: this event still carries the PRE-reset id
        }

        // Set-once: later events carry the same id, and adopting a mid-stream one
        // would re-point `/resume` at a transcript branch the user never saw.
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          await this.saveSession();
        }

        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "thinking") {
              const thinkingText = block.thinking;
              if (thinkingText) {
                console.log(`THINKING BLOCK: ${thinkingText.slice(0, 100)}...`);
                await statusCallback("thinking", thinkingText);
              }
            }

            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              // Backstop only — the PreToolUse hook already blocked this before
              // execution. Notify and skip; never throw here, or the turn aborts
              // instead of letting Claude see the denial and decline.
              const verdict = await evaluateToolUse(toolName, toolInput);
              if (!verdict.allowed) {
                console.warn(`BLOCKED (hook already denied): ${verdict.reason}`);
                await statusCallback("tool", `🚫 Blocked: ${verdict.reason}`);
                continue;
              }

              // Segment ends when tool starts
              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);

              // Don't show tool status for ask_user/send_file - they handle their own UI
              if (
                !toolName.startsWith("mcp__ask-user") &&
                !toolName.startsWith("mcp__send-file")
              ) {
                await statusCallback("tool", toolDisplay);
              }

              if (toolName.startsWith("mcp__ask-user") && ctx && chatId) {
                // The MCP server writes its request file out-of-band, so the
                // event can land before the file exists. Poll rather than assume.
                await new Promise((resolve) => setTimeout(resolve, 200));

                for (let attempt = 0; attempt < 3; attempt++) {
                  const buttonsSent = await checkPendingAskUserRequests(
                    ctx,
                    chatId
                  );
                  if (buttonsSent) {
                    askUserTriggered = true;
                    break;
                  }
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
              }

              if (toolName.startsWith("mcp__send-file") && ctx && chatId) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                for (let attempt = 0; attempt < 3; attempt++) {
                  const sent = await checkPendingSendFileRequests(ctx, chatId);
                  if (sent) break;
                  if (attempt < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                }
                // NO break — Claude continues generating
              }
            }

            if (block.type === "text") {
              responseParts.push(block.text);
              currentSegmentText += block.text;

              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback(
                  "text",
                  currentSegmentText,
                  currentSegmentId
                );
                lastTextUpdate = now;
              }
            }
          }

          // The user now owns the turn — draining further events would emit
          // messages behind the buttons they are still looking at.
          if (askUserTriggered) {
            break;
          }
        }

        if (event.type === "result") {
          console.log("Response complete");
          queryCompleted = true;

          if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            const u = this.lastUsage;
            console.log(
              `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${
                u.cache_read_input_tokens || 0
              } cache_create=${u.cache_creation_input_tokens || 0}`
            );
          }
        }
      }

      // V1 query completes automatically when the generator ends
    } catch (error) {
      const errorStr = String(error).toLowerCase();
      const isCleanupError =
        errorStr.includes("cancel") || errorStr.includes("abort");

      if (
        isCleanupError &&
        (queryCompleted || askUserTriggered || this.stopRequested)
      ) {
        console.warn(`Suppressed post-completion error: ${error}`);
      } else {
        console.error(`Error in query: ${error}`);
        this.lastError = describeError(error, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      this.isQueryRunning = false;
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // The turn ends here; the button tap arrives as a fresh message via callback.ts.
    if (askUserTriggered) {
      await statusCallback("done", "");
      return "[Waiting for user selection]";
    }

    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "");

    return responseParts.join("") || "No response from Claude.";
  }

  async kill(): Promise<void> {
    this.sessionId = null;
    this.lastActivity = null;
    this.conversationTitle = null;
    console.log("Session cleared");
  }

  /** Rewrites the whole history file — this is the only writer of SESSION_FILE. */
  async saveSession(): Promise<void> {
    if (!this.sessionId) return;

    try {
      const history = this.loadSessionHistory();

      const newSession: SavedSession = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: WORKING_DIR,
        title: this.conversationTitle || "Untitled session",
      };

      // Update in place rather than re-prepend, so a re-save cannot duplicate an id.
      // Consequence: position is insertion order, NOT recency — an old entry that is
      // still being written to keeps its slot and the slice below can still evict it.
      const existingIndex = history.sessions.findIndex(
        (s) => s.session_id === this.sessionId
      );
      if (existingIndex !== -1) {
        history.sessions[existingIndex] = newSession;
      } else {
        history.sessions.unshift(newSession);
      }

      history.sessions = history.sessions.slice(0, MAX_SESSIONS);

      await writeJsonAtomic(SESSION_FILE, history);
      console.log(`Session saved to ${SESSION_FILE}`);
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  private loadSessionHistory(): SessionHistory {
    try {
      const file = Bun.file(SESSION_FILE);
      if (!file.size) {
        return { sessions: [] };
      }

      const text = readFileSync(SESSION_FILE, "utf-8");
      return JSON.parse(text) as SessionHistory;
    } catch {
      return { sessions: [] };
    }
  }

  getSessionList(): SavedSession[] {
    const history = this.loadSessionHistory();
    // Entries written before working_dir existed have none; treat those as ours
    // rather than hiding them, or an upgrade silently empties /resume.
    return history.sessions.filter(
      (s) => !s.working_dir || s.working_dir === WORKING_DIR
    );
  }

  resumeSession(sessionId: string): [success: boolean, message: string] {
    const history = this.loadSessionHistory();
    const sessionData = history.sessions.find((s) => s.session_id === sessionId);

    if (!sessionData) {
      return [false, "Session not found"];
    }

    if (sessionData.working_dir && sessionData.working_dir !== WORKING_DIR) {
      return [
        false,
        `Session for a different directory: ${sessionData.working_dir}`,
      ];
    }

    this.sessionId = sessionData.session_id;
    this.conversationTitle = sessionData.title;
    this.lastActivity = new Date();

    console.log(
      `Resumed session ${sessionData.session_id.slice(0, 8)}... - "${sessionData.title}"`
    );

    return [
      true,
      `Resumed session: "${sessionData.title}"`,
    ];
  }

}

// Process-wide singleton: one Claude conversation per bot, shared by all handlers.
export const session = new ClaudeSession();
