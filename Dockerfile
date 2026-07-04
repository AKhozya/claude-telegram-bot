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
RUN apk add --no-cache git openssh-client curl jq ca-certificates bash poppler-utils

# kubectl (pinned — match cluster k3s version; bump deliberately)
ARG KUBECTL_VERSION=v1.36.1
RUN curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

# flux CLI
RUN curl -fsSL https://fluxcd.io/install.sh | bash

# gh CLI
RUN apk add --no-cache github-cli

# node + npm for runtime plugin hooks / MCP servers. No CLI install — the
# Agent SDK vendors the engine binary in its platform package (…-linux-x64-musl).
RUN apk add --no-cache nodejs npm

# Codex CLI (pre-commit review gate). The linux-x64 platform dep ships codex's
# static musl binary (codex publishes musl-only for linux) — alpine-safe.
# Installs to /usr/bin, outside the /home/akhozya PVC shadow. Pinned; bump deliberately.
ARG CODEX_VERSION=0.142.5
RUN npm install -g "@openai/codex@${CODEX_VERSION}" && codex --version

# chezmoi (dotfile sync in init container uses same image)
RUN sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# oven/bun:alpine already has UID 1000 as 'bun' user.
# Create akhozya as alias + home dir for K8s securityContext (runAsUser: 1000)
RUN deluser bun && adduser -D -u 1000 -h /home/akhozya akhozya

RUN chown -R akhozya:akhozya /app
USER akhozya

CMD ["bun", "run", "src/index.ts"]
