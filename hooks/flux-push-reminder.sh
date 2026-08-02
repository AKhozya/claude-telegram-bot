#!/bin/bash
# PostToolUse: Remind to reconcile Flux after git push
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if echo "$COMMAND" | grep -qE 'git\s+push'; then
    echo "[Flux] Push detected. Reconcile: flux reconcile source git flux-system && flux reconcile kustomization <name>" >&2
fi
echo "$INPUT"
exit 0
