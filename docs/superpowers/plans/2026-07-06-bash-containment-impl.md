# Bash Containment (audit #12) — Layer 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, autonomous run). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Confine Claude's Bash to `ALLOWED_PATHS` at the OS layer via the Agent SDK's native command sandbox, replacing the fail-open regex denylist as the sole deletion/exfil control.

**Architecture:** Add `src/sandbox.ts` that builds `SandboxSettings` + a scrubbed child env from existing config; wire both into `session.ts`'s `query()` call. macOS = Seatbelt, container = bubblewrap+socat. Fail-closed. Spike 1 (probe, 2026-07-06) PROVED the inline `query({sandbox})` filesystem/credentials/env knobs enforce with no permission-rule denies needed.

**Tech Stack:** Bun, TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.195, grammY.

## Global Constraints
- Spec: `docs/superpowers/specs/2026-07-06-bash-containment-design.md`. Every task traces to it.
- **Fail-closed:** `enabled:true`, `failIfUnavailable:true`, `allowUnsandboxedCommands:false`. No runtime kill-switch (rollback = git revert).
- **Away-run safety boundary:** implement + review + PR + CI green. DO NOT merge, DO NOT restart/redeploy the prod launchd service. Rollout is the user's step (checklist in Task 5).
- Worktree `ctb-wt-audit12`, branch `feat/audit-12-sandbox`. Signed single-line commits. Review gate (Codex + ecc:security-reviewer) before PR.
- Test env: `TELEGRAM_BOT_TOKEN=x:y TELEGRAM_ALLOWED_USERS=1 bun test`; `bun run typecheck`.

---

### Task 1: `src/sandbox.ts` — build SandboxSettings + scrubbed env

**Files:**
- Create: `src/sandbox.ts`
- Test: `src/sandbox.test.ts`

**Interfaces:**
- Consumes: `ALLOWED_PATHS` from `./config`.
- Produces: `buildSandboxSettings(): NonNullable<Options["sandbox"]>`, `sanitizeEnv(src?): Record<string,string>`, `secretEnvNames(src?): string[]`, `SANDBOX_SCRATCH: string`.

- [ ] **Step 1: Write failing tests** (`src/sandbox.test.ts`)

```ts
import { test, expect } from "bun:test";
process.env.TELEGRAM_BOT_TOKEN = "x:y";
process.env.TELEGRAM_ALLOWED_USERS = "1";
process.env.ALLOWED_PATHS = "/Users/x/Dev,/Users/x/Documents";
const { buildSandboxSettings, sanitizeEnv, secretEnvNames, SANDBOX_SCRATCH } = await import("./sandbox");

test("sandbox is fail-closed", () => {
  const s = buildSandboxSettings();
  expect(s.enabled).toBe(true);
  expect(s.failIfUnavailable).toBe(true);
  expect(s.allowUnsandboxedCommands).toBe(false);
});

test("allowWrite = ALLOWED_PATHS + scratch, not all of /tmp", () => {
  const fs = buildSandboxSettings().filesystem!;
  expect(fs.allowWrite).toContain("/Users/x/Dev");
  expect(fs.allowWrite).toContain(SANDBOX_SCRATCH);
  expect(fs.allowWrite).not.toContain("/tmp");
});

test("denyWrite covers ~/.claude + project .claude control files", () => {
  const dw = buildSandboxSettings().filesystem!.denyWrite!;
  expect(dw.some((p) => p.endsWith("/.claude"))).toBe(true);
  expect(dw).toContain("**/.claude/settings*.json");
  expect(dw).toContain("**/.claude/hooks/**");
});

test("reads fail-closed: allowRead is an allowlist incl ALLOWED_PATHS", () => {
  const fs = buildSandboxSettings().filesystem!;
  expect(fs.allowRead).toContain("/Users/x/Dev");
  expect(fs.allowRead).toContain(SANDBOX_SCRATCH);
});

test("sanitizeEnv strips secret-shaped keys, keeps operational vars", () => {
  const e = sanitizeEnv({ PATH: "/bin", HOME: "/h", OPENAI_API_KEY: "sk", TELEGRAM_BOT_TOKEN: "x:y", TELEGRAM_CHAT_ID: "42", GH_TOKEN: "gh" });
  expect(e.PATH).toBe("/bin");
  expect(e.HOME).toBe("/h");
  expect(e.TELEGRAM_CHAT_ID).toBe("42");
  expect(e.OPENAI_API_KEY).toBeUndefined();
  expect(e.TELEGRAM_BOT_TOKEN).toBeUndefined();
  expect(e.GH_TOKEN).toBeUndefined();
});

test("secretEnvNames feeds credentials.envVars deny list", () => {
  const names = secretEnvNames({ OPENAI_API_KEY: "x", PATH: "/bin", TELEGRAM_CHAT_ID: "1" });
  expect(names).toContain("OPENAI_API_KEY");
  expect(names).not.toContain("PATH");
  expect(names).not.toContain("TELEGRAM_CHAT_ID");
});
```

- [ ] **Step 2: Run — expect FAIL** (`cannot find module ./sandbox`)

Run: `cd /Users/akhozya/source-code/ctb-wt-audit12 && TELEGRAM_BOT_TOKEN=x:y TELEGRAM_ALLOWED_USERS=1 bun test src/sandbox.test.ts`

- [ ] **Step 3: Implement `src/sandbox.ts`**

```ts
import { homedir } from "os";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ALLOWED_PATHS } from "./config";

const HOME = homedir();

// Dedicated Bash scratch — NOT the broad temp roots (avoids exposing other procs' /tmp files
// and the bot's own session/audit files). Created at startup in session.ts.
export const SANDBOX_SCRATCH = "/tmp/ctb-sandbox";

// Reads outside ALLOWED_PATHS that Claude Code + git/build/language tools need to FUNCTION.
// Fail-closed: anything not here (nor ALLOWED_PATHS/scratch) is unreadable. Calibrated in Task 4 —
// widen with vetted paths, never drop to a blocklist.
export const SYSTEM_READ_SET: string[] = [
  "/usr", "/bin", "/sbin", "/opt", "/etc", "/private/etc", "/var", "/dev",
  "/System", "/Library",
  `${HOME}/.claude`, `${HOME}/.gitconfig`, `${HOME}/.config`,
  `${HOME}/.bun`, `${HOME}/.local`, `${HOME}/.npm`, `${HOME}/.cache`,
];

const SECRET_ENV_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL)/i;
const ENV_KEEP = new Set(["TELEGRAM_CHAT_ID"]); // non-secret; auth vars added if Task 4 shows needed

export function secretEnvNames(src: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(src).filter((k) => SECRET_ENV_RE.test(k) && !ENV_KEEP.has(k));
}

export function sanitizeEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (SECRET_ENV_RE.test(k) && !ENV_KEEP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function buildSandboxSettings(): NonNullable<Options["sandbox"]> {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [...ALLOWED_PATHS, SANDBOX_SCRATCH],
      denyWrite: [`${HOME}/.claude`, "**/.claude/settings*.json", "**/.claude/hooks/**"],
      allowRead: [...ALLOWED_PATHS, SANDBOX_SCRATCH, ...SYSTEM_READ_SET],
      denyRead: [`${HOME}/.ssh`, `${HOME}/.claude/.credentials*`, `${HOME}/.aws`, `${HOME}/.config/gh`, `${HOME}/.config/op`, "**/.env"],
    },
    credentials: { envVars: secretEnvNames().map((name) => ({ name, mode: "deny" as const })) },
    network: { deniedDomains: [] },
  };
}
```

- [ ] **Step 4: Run — expect PASS.** Same command as Step 2. Then `bun run typecheck`.

- [ ] **Step 5: Commit** — `git add src/sandbox.ts src/sandbox.test.ts && git commit -m "Add SDK sandbox settings + env scrub builder (#12)"`

---

### Task 2: Wire sandbox + scrubbed env into `session.ts`

**Files:**
- Modify: `src/session.ts` (the `query()` options block ~line 240-290; startup)

**Interfaces:** Consumes Task 1 exports.

- [ ] **Step 1: Create scratch dir at module load** — after imports in `session.ts`:

```ts
import { buildSandboxSettings, sanitizeEnv, SANDBOX_SCRATCH } from "./sandbox";
import { mkdirSync } from "fs";
mkdirSync(SANDBOX_SCRATCH, { recursive: true });
```

- [ ] **Step 2: Add to the `options` object** passed to `query()` — AFTER the `process.env.TELEGRAM_CHAT_ID = ...` line (so the scrub sees it), set:

```ts
      sandbox: buildSandboxSettings(),
      env: sanitizeEnv(),
```

- [ ] **Step 3: Typecheck** — `bun run typecheck` (expect clean; `sandbox`/`env` are valid Options fields).

- [ ] **Step 4: Smoke** — `TELEGRAM_BOT_TOKEN=x:y TELEGRAM_ALLOWED_USERS=1 bun test` (full suite green; no behavior regressions).

- [ ] **Step 5: Commit** — `git commit -am "Enable Bash sandbox + env scrub in session (#12)"`

---

### Task 3: Dockerfile — bubblewrap + socat

**Files:** Modify: `Dockerfile:19`

- [ ] **Step 1:** add `bubblewrap socat` to the `apk add` line:

```dockerfile
RUN apk add --no-cache git openssh-client curl jq ca-certificates bash poppler-utils unzip bubblewrap socat
```

- [ ] **Step 2:** update the adjacent comment to note both are the Linux sandbox deps (bubblewrap = fs/proc isolation, socat = network proxy) and that `failIfUnavailable` makes a missing dep fail-closed.

- [ ] **Step 3: Commit** — `git commit -am "Add bubblewrap+socat for container Bash sandbox (#12)"`

---

### Task 4: allowRead calibration probe (spike 5 — highest risk) + env keep-set (spike 4)

Not a code step — a throwaway `query()` probe (like spike 1) run from the worktree against fake paths.

- [ ] **Step 1:** Write a probe that runs `query()` with `buildSandboxSettings()` + `sanitizeEnv()` and has Bash do REAL work Claude Code needs: `git status`, `git log -1`, read a repo file, run `bun --version`, `node --version`, resolve a tool via PATH. Point `cwd`/`ALLOWED_PATHS` at a scratch git repo.
- [ ] **Step 2:** If any legit op fails with `Operation not permitted`, note the path from the error and ADD it to `SYSTEM_READ_SET` (vetted, specific) — never widen to a blocklist. Re-run until clean.
- [ ] **Step 3:** Confirm `sanitizeEnv()` didn't strip an auth var Claude Code needs (query authenticated + ran). If auth broke, add the exact var to `ENV_KEEP` and re-run.
- [ ] **Step 4:** If a fail-closed read allowlist proves unreachable without opening large swaths, STOP — record the exact residual in the PR body and flag it for user decision at rollout (per spec: escalate, don't silently soften). Delete the probe.
- [ ] **Step 5: Commit** any `SYSTEM_READ_SET`/`ENV_KEEP` refinements — `git commit -am "Calibrate sandbox read allowlist + env keep-set (#12)"`

---

### Task 5: Rollout checklist + Layer 2 homelab handoff (docs)

**Files:** Create: `docs/superpowers/plans/2026-07-06-bash-containment-rollout.md`

- [ ] **Step 1:** Write the rollout checklist for the USER (the brick-risk steps I deliberately don't run):
  - Verify `ALLOWED_PATHS` in the launchd plist covers real work dirs (else fail-closed locks Claude out of its cwd).
  - macOS: restart the service (`launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts`); send a test message that reads a repo file + writes inside ALLOWED_PATHS + confirms a write outside is blocked.
  - Container: rebuild image (bubblewrap+socat), verify `bwrap`/`socat` present, verify unprivileged userns enabled on the k3s node (spike 3) + not blocked by PSA/Kyverno; deploy; smoke the same 3 checks.
  - Rollback = `git revert` the sandbox commits + redeploy.
- [ ] **Step 2:** Write the Layer 2 manifest snippet for the homelab GitOps repo (RO-rootfs, drop ALL caps, seccomp RuntimeDefault, writable mounts only for ALLOWED_PATHS+scratch, scoped default-deny NetworkPolicy). Note the `readOnlyRootFilesystem` + bwrap writable-scratch interaction to verify.
- [ ] **Step 3: Commit** — `git commit -am "Add #12 rollout checklist + Layer 2 homelab handoff (#12)"`

---

### Review gate (before PR — NOT a merge)
- [ ] Self-review the full diff (`git diff main...HEAD`).
- [ ] Codex static review (codex-rescue, git-only, hard-cap, one-message verdict) on the diff.
- [ ] ecc:security-reviewer on the diff.
- [ ] Process findings via superpowers:receiving-code-review — verify, push back on wrong/YAGNI, fix severity order, re-test each.
- [ ] Push branch, open PR (`--repo AKhozya/claude-telegram-bot --base main`), CI green.
- [ ] STOP. Leave merge + rollout to the user. Post spike results + rollout checklist in the PR body.

## Self-review notes
- Spec coverage: Layer 1 (Tasks 1-3), read/env calibration spikes (Task 4), rollout + Layer 2 (Task 5), review gate. Layer 2 itself is applied in the homelab repo by the user (out of this repo's scope by design).
- The demoted regex (`checkCommandSafety`/`evaluateToolUse`) stays untouched — still runs as the pre-sandbox speed-bump; no code change needed.
