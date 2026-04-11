FROM oven/bun:1.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.2-alpine

# System dependencies
RUN apk add --no-cache git openssh-client curl jq ca-certificates bash

# kubectl
RUN curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" \
    -o /usr/local/bin/kubectl && chmod +x /usr/local/bin/kubectl

# flux CLI
RUN curl -fsSL https://fluxcd.io/install.sh | bash

# gh CLI
RUN apk add --no-cache github-cli

# Claude Code CLI (Agent SDK spawns this as subprocess)
RUN apk add --no-cache nodejs npm && \
    npm install -g @anthropic-ai/claude-code && \
    npm cache clean --force

# chezmoi (dotfile sync in init container uses same image)
RUN sh -c "$(curl -fsLS get.chezmoi.io)" -- -b /usr/local/bin

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Non-root user matching K8s securityContext
RUN adduser -D -u 1000 akhozya
USER akhozya

CMD ["bun", "run", "src/index.ts"]
