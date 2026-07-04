# Fork Hardening + Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 3 high-severity gaps found in the 2026-07-04 fork audit, land pending dependency modernization (Agent SDK 0.3.201, grammy 1.44 / Bot API 10.1), and clear deprecated SDK API usage — smallest diffs that hold.

**Architecture:** Fork is 0 behind upstream, ~25 ahead; upstream near-dormant. All changes are fork-local. Security fixes move enforcement from observational stream checks to the SDK's PreToolUse hook (fires before execution, works under `bypassPermissions`). Modernization is dep-sync plus one deprecation migration; rich-message transport stays hand-rolled (works, tested) with one additive retry fix.

**Tech Stack:** Bun 1.3, TypeScript 5.9, grammY 1.44, @anthropic-ai/claude-agent-sdk ^0.3.195 (floats to 0.3.201), bun test.

## Global Constraints

- TypeScript stays `^5.9.3` — do NOT move to TS 6.0 (typecheck runs via `bun run typecheck`).
- Commit style: single line, no Claude mention, no Co-Authored-By.
- Gate before EVERY commit: `bun run typecheck` && `bun test` green, then codex static review of the staged diff (git-only, one-message verdict), then commit.
- After all commits: restart bot (`launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts` or `bun run start`) and run the live smoke checklist (end of plan).
- Ponytail: no new dependencies, no new abstractions beyond the one extracted gate function.

## Explicitly cut (do not implement)

- Upstream PR #16 (provider switching/i18n/whisper) and #8 (screenshot MCP) — huge, niche; revisit only on demand.
- Denylist pattern expansion in `security.ts` — bypassable by construction; real containment is the PreToolUse gate (Task 2) + container. Documented instead (Task 9).
- Runtime model switching (`streamInput()` + `setModel()`) — medium lift, past 401 saga, no current need. Revisit if user asks for `/model`.
- TS 6, i18n framework, Telegram checklists (business-only), webhook mode.
- Private MCP request-drop dir (audit finding 7): writer side lives in the user's gitignored `mcp-config.ts` scripts, out of repo. Task 3's path validation kills the exfiltration payload; a spoofed ask-user file can only show buttons to the already-authed user. Residual risk accepted; revisit if MCP servers move in-repo.
- Chunk-split on paragraph boundaries (audit finding 12): plain-text fallback already catches broken-HTML chunks; cosmetic loss only, rare (only >32k rich-limit overflows). Add when it visibly annoys.

---

### Task 1: Baseline sync — install bumped deps, verify gates

**Files:**
- Modify: `bun.lock` / `node_modules` only if `bun install` changes them (package.json already bumped: grammy ^1.44.0, @modelcontextprotocol/sdk ^1.29.0, openai ^6.45.0, zod ^4.4.3).

**Interfaces:**
- Produces: node_modules with grammy 1.44.0 AND agent-sdk 0.3.x installed (typed `sendRichMessage`/`sendRichMessageDraft`; hook types for Task 2).

**Gotcha found in review:** local `node_modules` had agent-sdk **0.2.119** while package.json says `^0.3.195` — the running bot was on the old SDK. `bun update` (not `bun install`) if the lockfile still pins 0.2.x.

- [ ] **Step 1: Install and verify versions**

```bash
bun install
grep -m1 '"version"' node_modules/grammy/package.json                       # expect 1.44.0
grep -m1 '"version"' node_modules/@anthropic-ai/claude-agent-sdk/package.json  # expect 0.3.19x+
# if agent-sdk still 0.2.x: bun update @anthropic-ai/claude-agent-sdk && re-check
bun run typecheck && bun test
```
Expected: typecheck clean, 5/5 tests pass.

- [ ] **Step 2: Re-verify hook type surface on the installed 0.3.x SDK** (Task 2's snippets were written against 0.2.119 types — identical names, but confirm):

```bash
rg -n "PreToolUseHookSpecificOutput|permissionDecision|budgetTokens" node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts | head
```
Expected: same shapes (`permissionDecision?: 'allow'|'deny'|'ask'|'defer'`, `budgetTokens`). If renamed, adjust Task 2/7 snippets to match — typecheck is the arbiter.

- [ ] **Step 3: Commit only if lockfile changed**

```bash
git status -s   # if bun.lock dirty:
git add bun.lock && git commit -m "chore: sync lockfile for grammy 1.44 / mcp-sdk 1.29 / openai 6.45 / zod 4.4"
```

**Test-env note (applies to all new test files below):** `src/config.ts` calls `process.exit(1)` without `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALLOWED_USERS`; Bun auto-loads the repo's local `.env`, which is how the existing `rich-message.test.ts` (which transitively imports config) already passes. New tests follow the same pattern — they require the local `.env`. No CI exists; if one is added later, give it dummy env vars.

---

### Task 2: Pre-execution tool gate via PreToolUse hook (audit finding 1, HIGH)

Current stream-side checks (`src/session.ts:303-336`) observe `tool_use` blocks after the CLI already dispatched the tool — a BLOCKED `rm` can still run. The SDK's `hooks.PreToolUse` fires before execution and its `permissionDecision: 'deny'` blocks even under `bypassPermissions`.

**Files:**
- Modify: `src/security.ts` (add `evaluateToolUse`)
- Modify: `src/session.ts` (wire hook into `Options`; keep existing stream checks as belt-and-braces)
- Test: `src/security.test.ts` (new)

**Interfaces:**
- Produces: `evaluateToolUse(toolName: string, input: Record<string, unknown>): { allowed: true } | { allowed: false; reason: string }` exported from `src/security.ts`. Reuses existing `checkCommandSafety`, `isPathAllowed`, `TEMP_PATHS` (import `TEMP_PATHS` from `./config`).

- [ ] **Step 1: Write failing tests** (`src/security.test.ts`)

```typescript
import { describe, expect, test } from "bun:test";
import { evaluateToolUse } from "./security";

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
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test src/security.test.ts
```
Expected: FAIL — `evaluateToolUse` not exported.

- [ ] **Step 3: Implement `evaluateToolUse` in `src/security.ts`**

Port the logic verbatim from `src/session.ts:307-336` (Bash → `checkCommandSafety`; Read/Write/Edit → temp-path exemption then `isPathAllowed`):

The existing inline exemption (`src/session.ts:322-326`) checks the RAW path — `/tmp/../etc/passwd` passes `startsWith("/tmp/")` and `/etc/.claude/../shadow` passes `includes("/.claude/")`. Canonicalize FIRST (same realpath-with-resolve-fallback pattern `isPathAllowed` already uses), then check. Note `isPathAllowed` already allows all of `TEMP_PATHS` internally, so the only extra exemption needed is `.claude` dirs for Read:

```typescript
export type ToolVerdict = { allowed: true } | { allowed: false; reason: string };

/** Canonicalize: expand ~, follow symlinks when the path exists, resolve ../ otherwise. */
function canonicalize(path: string): string {
  const expanded = path.replace(/^~/, process.env.HOME || "");
  try {
    return realpathSync(normalize(expanded));
  } catch {
    return resolve(normalize(expanded));
  }
}

/** Single gate for tool safety — used by the SDK PreToolUse hook and stream checks. */
export function evaluateToolUse(
  toolName: string,
  input: Record<string, unknown>
): ToolVerdict {
  if (toolName === "Bash") {
    const command = String(input.command || "");
    const [isSafe, reason] = checkCommandSafety(command);
    if (!isSafe) return { allowed: false, reason: reason ?? "unsafe command" };
  }

  if (["Read", "Write", "Edit"].includes(toolName)) {
    const filePath = String(input.file_path || "");
    if (filePath) {
      const canonical = canonicalize(filePath);
      const isClaudeDirRead =
        toolName === "Read" && canonical.includes("/.claude/");
      if (!isClaudeDirRead && !isPathAllowed(canonical)) {
        return { allowed: false, reason: `File access outside allowed paths: ${filePath}` };
      }
    }
  }

  return { allowed: true };
}
```

(`realpathSync`, `normalize`, `resolve` are already imported at the top of `src/security.ts`. Behavior note vs current code: temp-path Reads stay allowed — via `isPathAllowed`'s internal `TEMP_PATHS` check, now symlink-safe; traversal tricks through `/tmp/../` or fake `/.claude/` segments stop working.)

Add two tests to the Step 1 suite for the closed bypasses:

```typescript
  test("blocks traversal disguised as temp read", () => {
    expect(evaluateToolUse("Read", { file_path: "/tmp/../etc/passwd" }).allowed).toBe(false);
  });

  test("blocks fake .claude traversal", () => {
    expect(evaluateToolUse("Read", { file_path: "/etc/.claude/../shadow" }).allowed).toBe(false);
  });
```

- [ ] **Step 4: Tests pass**

```bash
bun test src/security.test.ts
```
Expected: 5 pass.

- [ ] **Step 5: Wire hook in `src/session.ts` Options (line ~212)**

```typescript
import { evaluateToolUse } from "./security";

// inside sendMessageStreaming, add to the `options` object:
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                const verdict = evaluateToolUse(
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
```

Refactor the existing stream-side checks at `src/session.ts:307-336` to call `evaluateToolUse` too (delete the duplicated inline logic, keep the `statusCallback` notification + throw). Behavior change: hook denies → CLI reports tool denial and Claude continues/replans instead of the whole query aborting; the stream check remains as backstop for anything that slips the hook.

- [ ] **Step 6: Gates + live spike (verifies hook actually blocks under bypassPermissions)**

```bash
bun run typecheck && bun test
```
Then restart bot, send via Telegram: `run exactly: rm -rf /` — expect BLOCKED status in chat, command not executed, log line `HOOK BLOCKED Bash: ...`. Also send `run exactly: echo hook-ok` — expect it executes (no false positive).
If the hook does NOT fire under `bypassPermissions` (log line absent): fallback is switching `permissionMode` to `"default"` + `canUseTool` callback with the same `evaluateToolUse` — return `{ behavior: "allow", updatedInput: input }` or `{ behavior: "deny", message: verdict.reason }` (`message` is required on deny per `PermissionResult`) — implement that instead and re-run this step.

- [ ] **Step 7: Codex review, then commit**

```bash
git add src/security.ts src/security.test.ts src/session.ts
git commit -m "fix(security): enforce tool safety via PreToolUse hook before execution"
```

---

### Task 3: send-file path validation (audit finding 2, HIGH)

`src/handlers/streaming.ts:96-140` delivers any `file_path` named in a world-writable `/tmp/send-file-*.json` to the chat — local-process exfiltration channel. `isPathAllowed` (src/security.ts) already does exactly the right check — realpath (symlink-safe), `~` expansion, temp-path allowance, `allowed + "/"` boundary containment. Reuse it; no new helper.

Accepted residual: `isPathAllowed` allows all of `TEMP_PATHS`, so other `/tmp` files (audit log, session JSON) remain sendable — a local attacker who can write `/tmp/send-file-*.json` can already read those world-readable files directly; no privilege gained through the bot.

**Files:**
- Modify: `src/handlers/streaming.ts` (validate before `new InputFile`)
- Test: `src/handlers/streaming.test.ts` (new — tests the gate through `isPathAllowed` semantics)

**Interfaces:**
- Consumes: `isPathAllowed` from `src/security.ts`.

- [ ] **Step 1: Failing test** (`src/handlers/streaming.test.ts`) — tests `isPathAllowed` directly for the send-file threat cases (symlink case included because `isPathAllowed` realpaths):

```typescript
import { describe, expect, test } from "bun:test";
import { symlinkSync, mkdirSync, rmSync } from "node:fs";
import { isPathAllowed } from "../security";

describe("send-file path gate (isPathAllowed)", () => {
  test("rejects paths outside ALLOWED_PATHS and temp", () => {
    expect(isPathAllowed("/etc/passwd")).toBe(false);
    expect(isPathAllowed("/Users/other/secret.key")).toBe(false);
  });
  test("accepts bot temp dir", () => {
    expect(isPathAllowed("/tmp/telegram-bot/out.png")).toBe(true);
  });
  test("rejects traversal", () => {
    expect(isPathAllowed("/tmp/telegram-bot/../../etc/passwd")).toBe(false);
  });
  test("rejects /tmp symlink escaping to disallowed target", () => {
    const dir = "/tmp/telegram-bot-test";
    mkdirSync(dir, { recursive: true });
    const link = `${dir}/evil-link`;
    try { rmSync(link, { force: true }); } catch {}
    symlinkSync("/etc/passwd", link);
    try {
      expect(isPathAllowed(link)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it** — `bun test src/handlers/streaming.test.ts`. The first three pass today (documenting current behavior); the symlink test is the one that must pass for the gate to be sound — if it FAILS, `isPathAllowed`'s realpath isn't covering the case and needs fixing in `src/security.ts` before wiring.

- [ ] **Step 3: Wire the gate** — in `checkPendingSendFileRequests`, after the `if (!filePath) { ... }` block add:

```typescript
      if (!isPathAllowed(filePath)) {
        console.warn(`send-file BLOCKED (outside allowed paths): ${filePath}`);
        try { unlinkSync(filepath); } catch { /* ignore */ }
        continue;
      }
```

with `import { isPathAllowed } from "../security";` added to the imports.

- [ ] **Step 4: Gates** — `bun run typecheck && bun test` → all pass.

- [ ] **Step 5: Codex review, commit**

```bash
git add src/handlers/streaming.ts src/handlers/streaming.test.ts
git commit -m "fix(security): validate send-file paths against allowlist before Telegram delivery"
```

---

### Task 4: Atomic, awaited session save (audit finding 3, HIGH)

`src/session.ts:531` fire-and-forgets `Bun.write(SESSION_FILE, ...)` — crash or concurrent save corrupts `/resume` history (loader silently resets to empty).

**Files:**
- Modify: `src/session.ts:531` (saveSession becomes async-safe: tmp file + rename)
- Test: `src/session-store.test.ts` (new — extract pure helper)

**Interfaces:**
- Produces: `writeJsonAtomic(path: string, data: unknown): Promise<void>` exported from `src/session.ts` (or a new `src/session-store.ts` if session.ts imports create test friction — decide at implementation, prefer session.ts export).

- [ ] **Step 1: Failing test**

```typescript
import { describe, expect, test } from "bun:test";
import { writeJsonAtomic } from "./session";

test("writeJsonAtomic writes parseable JSON and leaves no tmp residue", async () => {
  const target = `${process.env.TMPDIR || "/tmp"}/atomic-test-${process.pid}.json`;
  await writeJsonAtomic(target, { sessions: [{ id: 1 }] });
  const parsed = JSON.parse(await Bun.file(target).text());
  expect(parsed.sessions[0].id).toBe(1);
  expect(await Bun.file(`${target}.tmp`).exists()).toBe(false);
});
```

Note: importing `./session` pulls in config — if module side effects (env validation) break the test run, move helper + test to `src/session-store.ts` with zero imports.

- [ ] **Step 2: Verify fails**, then **Step 3: Implement**

```typescript
import { renameSync } from "node:fs";
import { randomUUID } from "node:crypto";

export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`; // unique per call — concurrent saves can't clobber each other's tmp
  await Bun.write(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
```

Update the test's residue assertion to glob: `expect((await Array.fromAsync(new Bun.Glob(`${target}.*.tmp`).scan("/"))).length).toBe(0)` — or simply assert the parsed content and drop the residue check (rename either succeeded or threw).

Replace line 531 with `await writeJsonAtomic(SESSION_FILE, history);` and make `saveSession` async + await its call sites (grep callers: `rg -n "saveSession\(" src/`).

- [ ] **Step 4: Gates** — `bun run typecheck && bun test`.

- [ ] **Step 5: Codex review, commit**

```bash
git add src/session.ts src/session-store.test.ts
git commit -m "fix: atomic awaited session persistence (tmp+rename)"
```

---

### Task 5: Timing-safe trigger auth (audit finding 6, MED)

**Files:**
- Modify: `src/handlers/trigger.ts:55-58`
- Test: `src/handlers/trigger.test.ts` (new — real Bun.serve on port 0, stub bot)

**Interfaces:**
- Consumes: `startTriggerServer(bot)` existing export. Test stubs `bot` as `{ handleUpdate: async () => {} }`.

The change under test is the comparison function, not Bun.serve — unit-test it directly (a server-level test fights module-load-time config constants for no extra coverage).

- [ ] **Step 1: Failing test** (`src/handlers/trigger.test.ts`)

```typescript
import { describe, expect, test } from "bun:test";
import { secretMatches } from "./trigger";

describe("secretMatches", () => {
  test("rejects wrong secret", () => {
    expect(secretMatches("wrong", "right-secret")).toBe(false);
  });
  test("rejects different-length secret without throwing", () => {
    expect(secretMatches("x", "right-secret")).toBe(false);
    expect(secretMatches("", "right-secret")).toBe(false);
  });
  test("accepts exact match", () => {
    expect(secretMatches("right-secret", "right-secret")).toBe(true);
  });
});
```

- [ ] **Step 2: Verify fails** (`secretMatches` not exported), then **implement timing-safe compare** in `src/handlers/trigger.ts`:

```typescript
import { timingSafeEqual } from "node:crypto";

/** Constant-time secret comparison; second param injectable for tests. */
export function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Replace `if (provided !== TRIGGER_SECRET)` (line 56) with `if (!secretMatches(provided, TRIGGER_SECRET))`.

- [ ] **Step 3: Gates, codex review, commit**

```bash
git add src/handlers/trigger.ts src/handlers/trigger.test.ts
git commit -m "fix(security): timing-safe trigger secret comparison"
```

---

### Task 6: Honor Telegram 429 retry_after in rich-message transport (audit finding 8, MED)

Streaming edits every 500ms will eventually hit flood control; today any 429 throws and the status callback swallows it → dropped updates.

**Files:**
- Modify: `src/rich-message.ts:29-53` (`callTelegram`)
- Test: `src/rich-message.test.ts` (extend — stub `globalThis.fetch`)

- [ ] **Step 1: Failing test** (append to existing `src/rich-message.test.ts`, follow its existing style)

```typescript
test("callTelegram retries once after 429 with retry_after", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1)
      return new Response(
        JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } }),
        { status: 429 }
      );
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
  }) as typeof fetch;
  try {
    const msg = await sendRichMessage(123, "hi");
    expect(calls).toBe(2);
    expect((msg as any).message_id).toBe(7);
  } finally {
    globalThis.fetch = realFetch;
  }
});
```

(`retry_after: 0` keeps the test instant. Export `sendRichMessage` already exists; if `callTelegram` needs direct testing, keep it unexported and test through `sendRichMessage`.)

- [ ] **Step 2: Implement** — in `callTelegram`, after parsing `data`:

```typescript
  if (!data.ok && data.error_code === 429) {
    const retryAfter = Number(
      (data as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 1
    );
    await Bun.sleep(Math.min(retryAfter, 30) * 1000);
    return callTelegram<T>(method, payload); // ponytail: single retry via recursion; cap 30s
  }
```

Guard against infinite recursion: add optional `retried = false` parameter, only recurse when `!retried`.

- [ ] **Step 3: Gates, codex review, commit**

```bash
git add src/rich-message.ts src/rich-message.test.ts
git commit -m "fix: honor Telegram 429 retry_after in rich message transport"
```

---

### Task 7: Migrate deprecated maxThinkingTokens → thinking config (SDK deprecation)

`src/session.ts:219` uses `maxThinkingTokens` (deprecated since SDK 0.2.133; `thinking` takes precedence when both set). Behavior-preserving mapping.

**Files:**
- Modify: `src/session.ts:219` and the `thinkingLabel` block at 187-190.

- [ ] **Step 1: Implement**

```typescript
      thinking:
        thinkingTokens === 0
          ? { type: "disabled" as const }
          : { type: "enabled" as const, budgetTokens: thinkingTokens },
```

replacing `maxThinkingTokens: thinkingTokens,`. Verify the exact `ThinkingConfig` member names against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`budgetTokens`, line ~1352) — typecheck enforces.

- [ ] **Step 2: Gates + live smoke** — typecheck, tests, then restart bot and send one "think hard about X" message; expect THINKING BLOCK log lines still appear.

- [ ] **Step 3: Codex review, commit**

```bash
git add src/session.ts
git commit -m "chore: migrate deprecated maxThinkingTokens to thinking config"
```

---

### Task 8: Register bot command menu on startup (upstream PR #9 idea, reimplemented)

**Files:**
- Modify: `src/index.ts` (startup section, after bot construction, before polling starts)

- [ ] **Step 1: Implement**

```typescript
  await bot.api.setMyCommands([
    { command: "new", description: "Start a new Claude session" },
    { command: "stop", description: "Stop the current query" },
    { command: "status", description: "Show session status" },
    { command: "resume", description: "Resume a saved session" },
    { command: "retry", description: "Retry the last message" },
    { command: "restart", description: "Restart the bot process" },
  ]);
```

Match the exact command set registered in `src/index.ts` (`rg 'bot.command' src/index.ts`) — include every registered command except `/start`.

- [ ] **Step 2: Gates + live smoke** — restart bot, type `/` in Telegram → menu lists commands.

- [ ] **Step 3: Codex review, commit**

```bash
git add src/index.ts
git commit -m "feat: register bot command menu on startup"
```

---

### Task 9: Hygiene sweep (audit findings 4, 9, 10, 11, 13)

One commit, mechanical:

**Files:**
- Modify: `src/config.ts:158` — delete unused `QUERY_TIMEOUT_MS` (unbounded-query timeout NOT wired: `/stop` command + abortController already cover hung queries; wiring a timer is new behavior nobody asked for).
- Modify: `src/session.ts:513,594` + any other hits of `rg -n "Sessione|Ripresa|Nessuna" src/` — Italian strings → English ("Untitled session", "Resumed session", "No saved sessions").
- Modify: `src/formatting.ts:132` — delete dead `convertMarkdownForTelegram` export (verify zero refs first: `rg -n "convertMarkdownForTelegram" src/`).
- Modify: `Dockerfile:19` — pin kubectl: replace `stable.txt` fetch with a hard version, e.g. `KUBECTL_VERSION=v1.36.1` (match cluster k3s v1.36.1).
- Modify: `README.md` (Security section) — add two lines: bot runs the Agent SDK with `permissionMode: bypassPermissions`; the enforcing layers are the PreToolUse gate + allowlist + container, and the `BLOCKED_PATTERNS` denylist is best-effort only.

- [ ] **Step 1: Apply all edits** (each is a one-liner; no tests — deletions and copy changes)
- [ ] **Step 2: Gates** — `bun run typecheck && bun test`.
- [ ] **Step 3: Codex review, commit** (explicit paths — `git add -A` would stage unrelated untracked files like this plan)

```bash
git add src/config.ts src/session.ts src/formatting.ts Dockerfile README.md
git commit -m "chore: hygiene — drop dead code, English strings, pin kubectl, document permission model"
```

---

### Task 10 (OPTIONAL — decide before implementing): sendRichMessageDraft streaming preview

Bot API 10.1 `sendRichMessageDraft` streams an ephemeral 30-second draft bubble (no edit rate limits), finalized by one `sendRichMessage`. Would replace the throttled edit loop for in-progress text. grammy 1.44 ships it typed (`ctx.replyWithRichMessageDraft`).

**Recommendation: spike first, separate branch.** UX changes visibly (draft bubble vs growing message); draft expires after 30s so segments longer than that need re-sending cadence; interaction with the existing segment/chunk logic in `streaming.ts` is non-trivial. Not folded into this plan — needs its own small design pass after the fixes above land.

---

## Final live smoke checklist (after last commit, bot restarted)

- [ ] Text message → streamed reply renders rich (headings/code fence).
- [ ] `run exactly: rm -rf /` → BLOCKED in chat, `HOOK BLOCKED` in log.
- [ ] `/resume` → lists sessions (persistence intact post Task 4).
- [ ] `/` in Telegram → command menu shows.
- [ ] Voice note → transcription still works (OpenAI SDK 6.45 bump).
- [ ] `curl -s -X POST -H "x-trigger-secret: $TRIGGER_SECRET" -H 'content-type: application/json' -d '{"prompt":"say ok"}' http://127.0.0.1:$TRIGGER_PORT/trigger` → 202, reply lands in Telegram.
- [ ] `tail -20 /tmp/claude-telegram-bot-ts.err` → no new errors.
