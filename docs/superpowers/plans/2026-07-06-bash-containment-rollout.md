# Bash containment (#12) — rollout + Layer 2 handoff

The Layer-1 sandbox is fail-closed: mis-calibration can lock Claude out of its own working dir or
stop the bot from starting. These are the brick-risk steps, deliberately left for a human to run
after merge. Spec: `../specs/2026-07-06-bash-containment-design.md`. Impl plan: `2026-07-06-bash-containment-impl.md`.

## What's already verified (macOS, dev)
Calibration probe ran real Claude Code Bash work (git, file read, bun/node/git version, PATH resolve)
under the exact shipped config — all passed, auth intact with the env scrub. `SYSTEM_READ_SET` is
sufficient on macOS. `/lib`+`/lib64` added for Alpine musl but NOT yet exercised in-container.

## Pre-flight (both environments)
- [ ] `ALLOWED_PATHS` covers every dir Claude actually works in. With fail-closed writes, anything
      outside `ALLOWED_PATHS` + the scratch dir is read-only; outside the read-allowlist it's invisible.
      The bot's cwd (`CLAUDE_WORKING_DIR`) must sit inside `ALLOWED_PATHS` or Claude can't write its cwd.
- [ ] Rollback plan: `git revert` the sandbox commits + redeploy. There is no runtime kill-switch (by design).

## macOS (launchd `com.claude-telegram-ts`)
- [ ] Pull the merged main, rebuild if running the compiled binary.
- [ ] Restart: `launchctl kickstart -k gui/$(id -u)/com.claude-telegram-ts`
- [ ] Smoke via Telegram — send messages that make Claude run Bash:
  - reads a file **inside** `ALLOWED_PATHS` → works
  - writes a file **inside** `ALLOWED_PATHS` → works
  - `cat ~/.ssh/id_*` or any secret → **blocked** (`Operation not permitted`)
  - `echo $OPENAI_API_KEY` → **empty**
- [ ] Watch `/tmp/claude-telegram-bot-ts.err` for sandbox-init errors on startup.

## Container (k3s)
- [ ] Rebuild the image (now installs `bubblewrap` + `socat`); confirm both present:
      `docker run --rm <img> sh -c 'command -v bwrap socat'`
- [ ] Verify unprivileged user namespaces are enabled on the node kernel and not blocked by PSA/Kyverno
      (bubblewrap needs them). If blocked, that's a node/policy change first — fail-closed means the bot
      won't start until it's real.
- [ ] Deploy, watch logs for `failIfUnavailable` sandbox-init errors.
- [ ] Re-run the read-allowlist calibration **in-container** (the macOS probe can't cover Alpine paths):
      if a legit tool fails with `Operation not permitted`, add the specific path to `SYSTEM_READ_SET`
      (`src/sandbox.ts`) — widen with vetted paths, never a blocklist. `/lib`+`/lib64` already added.
- [ ] Smoke the same 4 checks as macOS.

## Layer 2 — homelab GitOps repo (separate change, belt-and-suspenders)

Survives a bubblewrap bypass/disable. Add to the bot Deployment/pod spec:

```yaml
securityContext:                 # pod or container level
  runAsNonRoot: true             # already uid 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
volumeMounts:                    # writable mounts ONLY where the app needs to write
  - { name: work, mountPath: /work }        # = ALLOWED_PATHS
  - { name: scratch, mountPath: /tmp }       # bot runtime + SANDBOX_SCRATCH (/tmp/ctb-sandbox)
volumes:
  - { name: work, persistentVolumeClaim: { claimName: <bot-work-pvc> } }
  - { name: scratch, emptyDir: {} }
```

- [ ] `readOnlyRootFilesystem: true` + bubblewrap both need writable scratch — bwrap builds tmpfs mounts.
      Verify the `/tmp` emptyDir satisfies bwrap; if not, add a dedicated writable mount for it.
- [ ] Scoped default-deny NetworkPolicy: egress allowlist = DNS, the cluster API, Telegram/Anthropic/OpenAI,
      package registries. (The repo already runs default-deny NetworkPolicies — mirror the pattern.)
- [ ] `bwrap` under a container with `drop: ["ALL"]` relies on unprivileged userns, not caps — confirm the
      node allows it (same check as above).

## Follow-ups (tracked, not in this PR)
- Graduate the sandbox network from empty denylist → strict domain allowlist once egress is understood.
- Unsandboxed **MCP tools** run in the bot process (env scrub covers their secrets; filesystem/network do not) — separate item.
