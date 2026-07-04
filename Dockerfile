FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
# BUILD_TS busts cache on bi-weekly scheduled rebuilds. `bun update` (not
# `bun install`) refreshes deps to the newest version in each package.json
# range — bun install pins to bun.lock, which froze the SDK at build-time of
# the lock. bunfig.toml carries minimumReleaseAge (7d supply-chain gate).
ARG BUILD_TS=local
RUN echo "build: $BUILD_TS"
COPY package.json bun.lock* bunfig.toml ./
RUN bun update

FROM oven/bun:1.2-alpine

ARG BUILD_TS=local

# System dependencies
RUN apk add --no-cache git openssh-client curl jq ca-certificates bash

# kubectl
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

# flux CLI
RUN curl -fsSL https://fluxcd.io/install.sh | bash

# gh CLI
RUN apk add --no-cache github-cli

# node + npm for plugin hooks / MCP servers spawned at runtime. No separate
# Claude Code CLI install: the Agent SDK vendors the CLI binary in its
# platform package (@anthropic-ai/claude-agent-sdk-linux-x64-musl), so the
# engine version is exactly the SDK version — one source of truth.
RUN apk add --no-cache nodejs npm

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
