#!/bin/bash
# Session-start git pull for homelab + chezmoi repos.
# Handles: force-push/rewrite, dirty worktree (stash), unpushed commits (skip).

pull_repo() {
  local repo="$1"
  local branch="$2"

  [ -d "$repo/.git" ] || return 0
  cd "$repo" || return 0

  # If there are unpushed commits, skip — don't clobber in-progress work
  local ahead
  ahead=$(git rev-list --count "origin/${branch}..HEAD" 2>/dev/null || echo 0)
  if [ "$ahead" -gt 0 ]; then
    return 0
  fi

  git fetch origin "$branch" --quiet 2>/dev/null || return 0

  local local_sha remote_sha
  local_sha=$(git rev-parse HEAD 2>/dev/null)
  remote_sha=$(git rev-parse "origin/${branch}" 2>/dev/null)
  [ "$local_sha" = "$remote_sha" ] && return 0

  local stashed=false
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    git stash push -m "session-pull-auto-$(date +%s)" --quiet 2>/dev/null
    stashed=true
  fi

  # Force-align to remote (safe: unpushed-check + stash happened above)
  git checkout -B "$branch" "origin/${branch}" --quiet 2>/dev/null

  if [ "$stashed" = true ]; then
    git stash pop --quiet 2>/dev/null || true
  fi
}

pull_repo "$HOME/source-code/homelab" "main"
pull_repo "$HOME/.local/share/chezmoi" "master"

# Output analysis doc for session context
cat "$HOME/source-code/homelab/docs/HOMELAB_ANALYSIS.md" 2>/dev/null
