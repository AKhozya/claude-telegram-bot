# Bash containment (audit #12) — 2026-07-06

Closes the last audit item: replace the fail-open regex denylist as the *sole* deletion/exfil
control with a fail-closed OS boundary. Plan ref: `docs/superpowers/plans/2026-07-05-audit-hardening.md` #12.

## Threat model (unchanged)
Bot grants ONE trusted user Claude Code under `permissionMode: bypassPermissions`. The control is
defense-in-depth vs **prompt injection** — a malicious PDF/webpage/archive steering Claude to
delete or exfil *outside* `ALLOWED_PATHS`. Not vs the user. The injection surface is Claude's
**Bash**; that is what this contains.

## Decision
**Two independent layers.**

1. **Primary — SDK native command sandbox** (`query({ sandbox })`), configured in `session.ts` from
   `config.ts`. macOS = Seatbelt (built-in), container = bubblewrap. Fail-closed both envs. One code path.
2. **Layer 2 — container-native hardening** in the homelab GitOps repo (separate deliverable):
   `readOnlyRootFilesystem`, drop ALL caps, `seccompProfile: RuntimeDefault`, default-deny
   NetworkPolicy. Survives a bubblewrap bypass/disable; the pod stays contained even if layer 1 fails.

The demoted regex (`checkCommandSafety` + the `evaluateToolUse` PreToolUse hook) **stays** as a
best-effort speed-bump — runs before the sandbox, gives cleaner rejection messages, and is the only
gate on hosts where a sandbox spike is still pending.

### Rejected
| Alternative | Why not |
|---|---|
| Hand-rolled `sandbox-exec` Seatbelt profile (macOS) | Re-implements what the SDK already generates. Rung-4 native feature. |
| Restricted-user + RO bind-mounts (container only) | Lives only in homelab repo, splits the control across two mechanisms + two repos, doesn't hide env-secrets from Bash. Kept as *Layer 2*, not the primary. |
| Per-session microVM (Firecracker) | Strictly safest (hypervisor isolation) but re-architects the bot: breaks `/resume` state + the dual-env single code path. Overkill for one trusted user. |

## Layer 1 — SDK sandbox config

Built once at startup in `config.ts` (no new *required* env vars — derives from existing config +
a startup env scan), consumed in `session.ts` `query()` options.

Two `query()` options work together — env sanitization (primary secret control) and the sandbox
(OS execution boundary):

```
// (a) options.env — PRIMARY env-secret control. Scrub secrets so Claude Code AND every Bash/MCP
//     subprocess it spawns never inherit them. OS-enforced, platform-independent, and works even
//     if the sandbox's own credentials.envVars turns out to be a no-op. The bot currently passes
//     NO curated env, so today the child inherits every secret — this closes that.
env: sanitizedEnv,   // {...process.env} minus keys matching /(_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL)/i,
                     // KEEPING operational vars Claude Code needs (PATH, HOME, auth) — calibrated in spike

// (b) sandbox — OS execution boundary for Bash.
sandbox: {
  enabled: true,
  failIfUnavailable: true,          // fail-closed: bot errors rather than run Bash unsandboxed
  allowUnsandboxedCommands: false,  // no per-command escape
  autoAllowBashIfSandboxed: true,   // sandbox is the boundary (redundant under bypass, set for clarity)
  filesystem: {
    allowWrite: [ ...ALLOWED_PATHS, SANDBOX_SCRATCH ],   // allowlist → all else NOT writable. NOT ~/.claude, NOT all of /tmp
    denyWrite:  [ ~/.claude, **/.claude/settings*.json, **/.claude/hooks/** ],  // write == code-exec; deny even inside ALLOWED_PATHS
    allowRead:  [ ...ALLOWED_PATHS, SANDBOX_SCRATCH ],  // re-allow work dirs within denyRead regions ONLY
    // Reads are NOT fail-closed: the inline sandbox's allowRead only re-allows within denyRead, and
    // allowManagedReadPathsOnly is honored solely from managed policy settings, not the query() option
    // (BOTH probe-verified 2026-07-06). Read containment = this denyRead blocklist + Layer-2 egress.
    denyRead:   [ ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker, ~/.config, ~/.claude/.credentials*,
                  ~/.netrc, ~/.git-credentials, ~/.npmrc, ~/.pypirc, ~/.pgpass, **/.env ],
  },
  // SANDBOX_SCRATCH = one dedicated per-run dir (e.g. /tmp/ctb-sandbox-<pid>/), NOT the broad temp roots.
  credentials: {                    // defense-in-depth only — (a) options.env is the real guarantee
    envVars: [ secret-shaped process.env keys, mode:"deny" ],
  },
  network: {
    // Starts minimal — no useful static bad-domain list exists for a general dev bot. The real
    // network control is Layer 2's CIDR NetworkPolicy now + a domain allowlist later (see Ceiling).
    deniedDomains: [],
  },
}
```

**Rationale for the non-obvious choices:**
- `allowWrite` is an **allowlist** — everything not listed is read-only. That is the fail-closed
  deletion/overwrite boundary replacing the regex. `WORKING_DIR` is intentionally *not* blanket-added
  (it defaults to `$HOME`); real project dirs come in via `ALLOWED_PATHS`.
- **`~/.claude` is NOT in `allowWrite` — and is explicitly `denyWrite`.** The repo loads
  `settingSources: ["user","project"]` (`session.ts:244`), so Claude Code reads `~/.claude/settings.json`
  *and* project `.claude/settings.json`, both of which can define **hooks that execute shell commands**.
  A write primitive there = persistent code execution that runs **outside** the sandbox on the next tool
  call. Critically, **project `.claude/` lives inside `ALLOWED_PATHS`** (legitimately writable for normal
  work), so `denyWrite` must carve out `**/.claude/settings*.json` + `**/.claude/hooks/**` even within the
  allowed tree — not just `~/.claude`. Claude Code's own shell-snapshot writes go to a minimal subpath
  added back in `allowWrite` only if the calibration spike shows the Bash tool needs it.
- **Scratch is a dedicated dir, not all of `/tmp`.** `SANDBOX_SCRATCH` (e.g. `/tmp/ctb-sandbox-<pid>/`)
  is the only temp path in `allowWrite`/`allowRead`. Blanket `/tmp`+`/var/folders` would be a large
  outside-`ALLOWED_PATHS` read/write exception — exposing other processes' temp files AND the bot's own
  session/audit/download files in `/tmp` (readable + corruptible). A scoped scratch dir removes both. The
  bot's own `/tmp` runtime files stay owned by the unsandboxed bot process, outside the scratch dir.
- **Reads are a `denyRead` blocklist, NOT fail-closed (empirical correction, 2026-07-06).** The intent
  was fail-closed reads via an `allowRead` allowlist, but a runtime probe showed the inline sandbox does
  **not** support that: `allowRead` only re-allows paths *within* `denyRead` regions, and
  `allowManagedReadPathsOnly` (the "only allowRead is readable" switch) is honored solely from managed
  policy settings — not the `query()` `sandbox` option. Both were tested; a canary outside every allow
  path was still readable until it was explicitly `denyRead`. So read containment is a **blocklist** of
  known credential stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, the whole `~/.config`
  XDG tree, `~/.claude/.credentials*`, `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`,
  `~/.pgpass`, `**/.env`) plus **Layer-2 network egress** to stop a read secret from leaving. A blocklist
  is inherently incomplete — an unlisted store is a documented **ceiling**, not silently softened.
  Writes remain fail-closed (the `allowWrite` allowlist), which is the primary deletion/overwrite control
  the plan asked for. Fully fail-closed reads would require driving the sandbox from a managed policy
  settings file (`allowManagedReadPathsOnly`) — larger change, tracked as future work.
- **Env secrets: primary control is `options.env`, not `credentials.envVars`.** Both scrub by scanning
  `process.env` at startup for secret-shaped keys (future-proof vs a new token var), but `options.env`
  is the enforced guarantee — the child process is *spawned without* the secrets, so it holds whether or
  not the sandbox honors `credentials.envVars`, and it also denies them to **MCP subprocesses** (which
  run unsandboxed — see Ceiling). `credentials.envVars` stays as a second layer. The scrub must keep the
  vars Claude Code needs to authenticate/operate (calibrated in spike) — omitting one silently breaks auth.
- **Network split:** the SDK sandbox network config is **domain-level** (its Linux model is a MITM
  proxy — `httpProxyPort`/`tlsTerminate`). **IP/CIDR egress control** (cloud metadata `169.254.169.254`,
  RFC1918, loopback) is enforced better by the **Layer 2 NetworkPolicy**, which is CIDR-native. Blanket
  RFC1918 deny would break in-cluster `kubectl`/`flux` from Bash, so it belongs in a *scoped* NetworkPolicy
  (allow DNS + the cluster API + the bot's real egress), not a blunt sandbox rule.

## Layer 2 — container hardening (homelab GitOps repo)

Separate deliverable in the homelab repo (documented here, applied there). Pod spec:

```yaml
securityContext:
  readOnlyRootFilesystem: true      # writable emptyDir/PVC mounts only for ALLOWED_PATHS + /tmp
  runAsNonRoot: true                # already uid 1000
  capabilities: { drop: ["ALL"] }
  seccompProfile: { type: RuntimeDefault }
# + default-deny NetworkPolicy, egress allowlist: DNS, cluster API, Telegram/Anthropic/OpenAI, registries
```

Wrinkle to verify: `readOnlyRootFilesystem` + bubblewrap both need writable scratch — bwrap builds
tmpfs mounts. Confirm the emptyDir at `/tmp` satisfies bwrap, or add a dedicated writable mount.

## Dockerfile
`apk add --no-cache bubblewrap socat`. The Linux sandbox needs `bubblewrap` for filesystem/process
isolation **and** `socat` for its network-proxy plumbing; with `failIfUnavailable:true`, a missing dep
makes the bot fail-closed (won't run), so both must be present. Spike 3 verifies the full dependency set
against the built image — do not assume this list is complete. (Info-ZIP `unzip` from #4 already added.)

## Mandatory spikes (before trusting fail-closed)
1. **Which knobs bite.** The SDK JSDoc contradicts itself: the `sandbox` option's doc-comment says
   filesystem/network restrictions come from `Read`/`Edit`/`WebFetch` *permission rules*, yet
   `SandboxSettings` carries `filesystem`/`network`/`credentials` sub-objects. Verify empirically which
   layer actually enforces, with repros, before relying on it. In particular confirm whether
   `credentials.envVars` scrubs the Bash env — if it's a no-op, `options.env` (spike 4) is the only guard.
2. **`allowWrite`/`denyWrite`/`denyRead` calibration.** Run real Claude Code Bash flows (git, build,
   shell snapshots) and confirm: nothing legit breaks, `denyWrite` blocks writes to `~/.claude/settings.json`
   AND project `./.claude/settings.json` (the in-tree escape), nothing sensitive stays readable.
3. **Container feasibility.** Verify unprivileged user namespaces are enabled on the k3s nodes and not
   blocked by PSA/Kyverno, **and** that the full Linux sandbox dependency set (`bubblewrap`, `socat`, plus
   whatever else the SDK requires) is present and functional in the built image — test sandbox init in the
   container, don't infer from docs. If blocked → homelab node/policy change first (fail-closed: bot won't
   run there until fixed).
4. **`options.env` scrub set.** Determine exactly which env vars Claude Code needs to authenticate/operate
   (so the scrub doesn't silently break auth) vs which secrets to strip. Confirm the child truly cannot
   see `OPENAI_API_KEY`/`TELEGRAM_BOT_TOKEN` after scrubbing.
5. **Read model (RESOLVED 2026-07-06 — reads are a blocklist).** Probe confirmed the inline sandbox
   cannot fail-close reads (see the reads bullet above). So calibrate `denyRead` to cover known credential
   stores and confirm two things by probe: (a) real Claude Code Bash work (git/bun/node/file-read) still
   passes, and (b) a canary under a `denyRead` path (e.g. `~/.config/x`) returns `Operation not permitted`.
   Both verified on macOS; re-confirm in-container at rollout.
6. **Symlink TOCTOU through an allowed dir.** Create a symlink inside an `ALLOWED_PATH` pointing at a
   `denyRead`/outside-allowlist file and confirm sandboxed Bash still can't read/write through it (property
   of the sandbox runtime, not this config — verify empirically).

## Verification (the proof — repros, not just unit tests)
| Check | Expect |
|---|---|
| Bash writes outside `ALLOWED_PATHS` (e.g. `>~/evil` or `rm ~/x`) | blocked |
| Bash writes inside `ALLOWED_PATHS` | works |
| Bash writes `~/.claude/settings.json` OR project `./.claude/settings.json` | blocked (hook-injection escape) |
| **native Write** tool writes `.mcp.json` / project `.claude/settings.json` / `.claude/hooks/*` | blocked by the app hook (`evaluateToolUse`) |
| Bash `cat`s a file under a `denyRead` path (e.g. `~/.config/x`) | blocked (`Operation not permitted`) |
| Bash `cat`s an ordinary file outside `ALLOWED_PATHS` not in `denyRead` | **readable** (reads are a blocklist, not fail-closed — ceiling) |
| `echo $OPENAI_API_KEY` inside Bash | empty |
| `cat ~/.claude/.credentials.json` inside Bash | denied |
| Sandbox deps missing (simulate) | bot emits error result, does NOT run bare (fail-closed) |
| Claude Code normal auth + `/resume` | unaffected (parent process) |

Plus a **canary unit test**: asserts the sandbox config stays `enabled` + `failIfUnavailable`, so a
later refactor can't silently drop the boundary (same pattern as the #1 tool-gate canary).

## Ceiling (documented → future items)
- **Same kernel.** bubblewrap/Seatbelt share the host kernel; a kernel LPE or sandbox-escape defeats
  layer 1. Layer 2 caps blast radius; only a microVM removes the shared kernel.
- **Reads are a blocklist, not fail-closed.** An unlisted credential store outside `ALLOWED_PATHS` is
  readable by injected Bash. Real fail-closed reads need managed policy settings (future work); today the
  containment is the `denyRead` list + Layer-2 egress stopping the read data from leaving.
- **Only Bash is contained.** The bot process keeps the secrets + broad network (it's the trusted
  parent). **`WebFetch` and MCP tool calls run in the bot process, unsandboxed** — a full read→exfil
  chain (`Read` a secret, `WebFetch` it out) touches Bash never once. On the container, Layer-2 NetworkPolicy
  is pod-scoped and catches this regardless of originating process; **on macOS there is no NetworkPolicy
  equivalent, so WebFetch-based exfil is unmitigated there today.** (WebFetch SSRF *into* internal targets
  is separately blocked by `evaluateToolUse`.) Track as a separate item.
- **`~/.kube` etc. are `denyRead`-adjacent functional gaps.** kubeconfig is deliberately NOT read-allowed,
  so Claude-invoked `kubectl`/`flux` via Bash will fail. The fix when that bites is a scoped/short-lived
  service-account token, NOT adding `~/.kube` to a read-allow (which would reopen credential exposure).
- **Network denylist now, allowlist later.** Graduating `deniedDomains` → strict `allowedDomains` (and
  the scoped egress NetworkPolicy) is the follow-up that closes arbitrary-host exfil.
