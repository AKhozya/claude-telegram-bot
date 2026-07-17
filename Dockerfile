FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
# BUILD_TS busts this layer each scheduled rebuild. bun update, not install:
# install pins to bun.lock and rebuilds refresh nothing (froze SDK at 0.2.119).
# bunfig.toml = minimumReleaseAge supply-chain gate.
ARG BUILD_TS=local
RUN echo "build: $BUILD_TS"
COPY package.json bun.lock* bunfig.toml ./
RUN bun update

FROM oven/bun:1.3-alpine

ARG BUILD_TS=local

# System dependencies. poppler-utils = pdftotext (text layer) + pdftocairo
# (page->PNG render for image/scanned/print PDFs, read via Claude vision).
# unzip = Info-ZIP (supports `unzip -Z1` member listing); BusyBox's applet does not,
# so zip archives need this to be listed/validated and extracted in the container.
# bubblewrap + socat = the Linux Bash sandbox deps (bwrap = filesystem/process isolation,
# socat = its network proxy). With the sandbox's failIfUnavailable, a missing dep makes the
# bot fail-closed (won't run) rather than execute Bash unconfined.
# github-cli = gh. nodejs + npm = runtime plugin hooks / MCP servers — no CLI install,
# the Agent SDK vendors the engine binary in its platform package (…-linux-x64-musl).
# chezmoi = dotfile/skills sync (init container uses same image).
# apk deliberately unpinned: alpine drops old package versions from the index, and the
# pinned base image + bi-weekly rebuild keep these fresh.
RUN apk add --no-cache git openssh-client curl jq ca-certificates bash poppler-utils unzip \
    bubblewrap socat github-cli nodejs npm chezmoi

# kubectl (pinned — match cluster k3s version; bump deliberately). Checksum-verified.
ARG KUBECTL_VERSION=v1.36.1
RUN curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl \
    && echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256")  /usr/local/bin/kubectl" | sha256sum -c - \
    && chmod +x /usr/local/bin/kubectl

# flux CLI (pinned — match cluster flux minor; bump deliberately). Checksum-verified.
ARG FLUX_VERSION=2.9.2
RUN set -o pipefail && cd /tmp \
    && curl -fsSLO "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_linux_amd64.tar.gz" \
    && curl -fsSLO "https://github.com/fluxcd/flux2/releases/download/v${FLUX_VERSION}/flux_${FLUX_VERSION}_checksums.txt" \
    && grep " flux_${FLUX_VERSION}_linux_amd64.tar.gz\$" "flux_${FLUX_VERSION}_checksums.txt" | sha256sum -c - \
    && tar -xzf "flux_${FLUX_VERSION}_linux_amd64.tar.gz" -C /usr/local/bin flux \
    && rm -f "flux_${FLUX_VERSION}_linux_amd64.tar.gz" "flux_${FLUX_VERSION}_checksums.txt"

# Codex CLI (pre-commit review gate). The linux-x64 platform dep ships codex's
# static musl binary (codex publishes musl-only for linux) — alpine-safe.
# Installs to /usr/bin, outside the /home/akhozya PVC shadow.
# Latest on each scheduled rebuild (BUILD_TS busts the layer); --before mirrors
# bunfig's minimumReleaseAge — only versions published ≥7 days ago.
RUN echo "codex refresh: ${BUILD_TS}" \
    && BEFORE="$(node -e 'console.log(new Date(Date.now()-7*864e5).toISOString())')" \
    && test -n "$BEFORE" \
    && npm install -g @openai/codex --before="$BEFORE" \
    && codex --version

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# oven/bun:alpine already has UID 1000 as 'bun' user.
# Create akhozya as alias + home dir for K8s securityContext (runAsUser: 1000)
RUN deluser bun && adduser -D -u 1000 -h /home/akhozya akhozya

RUN chown -R akhozya:akhozya /app
USER akhozya

CMD ["bun", "run", "src/index.ts"]
