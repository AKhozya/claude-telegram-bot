#!/bin/bash
set -e

cd /Users/linuz90/Dev/claude-telegram-bot-ts

if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

exec /Users/linuz90/.bun/bin/bun run src/index.ts
