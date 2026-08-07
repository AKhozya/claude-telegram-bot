#!/bin/bash
# Safety hook to block dangerous Bash operations
# Returns: 0 = allow, 2 = block with reason
#
# The pod runs THIS copy, from the read-only image, wired by SAFETY_HOOK. A near-identical
# copy lives in the dotfiles repo for the Mac. They are separate files and will drift — a
# rule added in one does not reach the other.

set -e

INPUT=$(cat)

# Claude Code passes the Bash tool's command as tool_input.command.
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# If no command found, allow (not a Bash tool call or jq failed)
if [ -z "$COMMAND" ]; then
    exit 0
fi

# Resolved here, at top level, NOT inline in the grep below: that grep is a pipeline
# element, so a `${HOME:?}` expanding there aborts only its own subshell. grep would
# never run, the `if` would read false, and an empty HOME would silently switch the
# catastrophic-deletion rule off — the exact failure the guard is for.
HOME_DIR="${HOME:?HOME must be set}"
# Escaped before it goes into an ERE: an unescaped metacharacter in the path (HOME=/tmp/u[
# is legal) makes grep exit 2 for a bad pattern, and because grep runs as an `if`
# condition that reads as "no match" and the rule falls open.
HOME_RE=$(printf '%s' "$HOME_DIR" | sed 's/[][\.^$*+?(){}|\\]/\\&/g')

# === DANGEROUS PATTERNS ===

# Block catastrophic deletions (only exact targets, not subdirectories)
# Matches: rm -rf / | rm -rf ~ | rm -rf $HOME | rm -rf <the home directory itself>
# But allows: rm -rf /some/path | rm -rf ~/subdir | rm -rf <a path under home>
# The home path is interpolated OUTSIDE the single quotes so the shell expands it; left
# inside, $HOME would stay literal and `$` would read as an anchor.
if echo "$COMMAND" | grep -qE 'rm\s+(-[^-]*r[^-]*f|-[^-]*f[^-]*r)\s+(/|~|\$HOME|'"$HOME_RE"')(\s|;|$|&&|\|)'; then
    echo "BLOCKED: Catastrophic deletion detected (rm -rf / or home directory)" >&2
    exit 2
fi

# Block kubectl delete namespace (extra layer beyond settings.json deny)
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s+namespace'; then
    echo "BLOCKED: Namespace deletion requires manual confirmation. Use kubectl directly if needed." >&2
    exit 2
fi

# Block force deletion of database pods (PostgreSQL, MySQL, CouchDB, Redis)
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s+pod.*--force.*--grace-period=0.*(postgres|mysql|couchdb|redis)'; then
    echo "BLOCKED: Force deletion of database pods can cause data loss. Use 'kubectl delete pod <name>' without --force." >&2
    exit 2
fi
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s+pod.*(postgres|mysql|couchdb|redis).*--force.*--grace-period=0'; then
    echo "BLOCKED: Force deletion of database pods can cause data loss. Use 'kubectl delete pod <name>' without --force." >&2
    exit 2
fi

# Block SQL DROP commands
if echo "$COMMAND" | grep -qiE '(DROP\s+TABLE|DROP\s+DATABASE)'; then
    echo "BLOCKED: Direct DROP TABLE/DATABASE detected. Use Kubernetes CRDs for database management." >&2
    exit 2
fi

# Block direct kubectl apply -f (GitOps violation)
# Allow dry-run variants
if echo "$COMMAND" | grep -qE 'kubectl\s+apply\s+-f' && ! echo "$COMMAND" | grep -qE '\-\-dry-run'; then
    echo "BLOCKED: Direct 'kubectl apply -f' violates GitOps workflow. Commit to Git and let Flux reconcile, or use --dry-run=server." >&2
    exit 2
fi

# Block kubectl delete pvc (data loss)
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s+(pvc|persistentvolumeclaim)'; then
    echo "BLOCKED: PVC deletion causes permanent data loss. Delete the owning workload first, then manually delete the PVC if needed." >&2
    exit 2
fi

# Block kubectl delete statefulset (cascading data loss)
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s+statefulset'; then
    echo "BLOCKED: StatefulSet deletion can cascade to pods and PVCs. Use Flux teardown pattern or delete manually." >&2
    exit 2
fi

# Block git push --force / -f to main/master (overwrites remote history)
# Allows: git push, git push origin feature-branch --force, git push --force-with-lease
if echo "$COMMAND" | grep -qE 'git\s+push\s+.*(-f|--force)\b' && ! echo "$COMMAND" | grep -qE '\-\-force-with-lease'; then
    echo "BLOCKED: Force push detected. Use --force-with-lease for safety, or push without force." >&2
    exit 2
fi

# Block git reset --hard (discards uncommitted work)
if echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard'; then
    echo "BLOCKED: 'git reset --hard' discards uncommitted changes. Use 'git stash' or 'git reset --soft' instead." >&2
    exit 2
fi

# Block git clean -f (permanently deletes untracked files)
if echo "$COMMAND" | grep -qE 'git\s+clean\s+(-[a-zA-Z]*f|--force)'; then
    echo "BLOCKED: 'git clean -f' permanently deletes untracked files. Use 'git clean -n' (dry-run) first." >&2
    exit 2
fi

# Block git checkout -- . or git restore . (discards all working tree changes)
if echo "$COMMAND" | grep -qE 'git\s+(checkout\s+--\s+\.|restore\s+\.)'; then
    echo "BLOCKED: Discarding all working tree changes. Use 'git stash' or target specific files." >&2
    exit 2
fi

# === FILESYSTEM DESTRUCTIVE ===

# Block dd writing to device targets (disk/partition overwrite)
if echo "$COMMAND" | grep -qE '\bdd\s+.*of=/dev/'; then
    echo "BLOCKED: 'dd' writing to device target detected. This overwrites disks/partitions." >&2
    exit 2
fi

# Block mkfs (filesystem formatting = instant data loss)
if echo "$COMMAND" | grep -qE '\bmkfs\b'; then
    echo "BLOCKED: 'mkfs' formats filesystems causing instant data loss." >&2
    exit 2
fi

# Block shred (irrecoverable file destruction)
if echo "$COMMAND" | grep -qE '\bshred\b'; then
    echo "BLOCKED: 'shred' irrecoverably destroys files by overwriting with random data." >&2
    exit 2
fi

# === KUBERNETES GITOPS VIOLATIONS ===

# Block kubectl edit (live editing bypasses GitOps)
if echo "$COMMAND" | grep -qE 'kubectl\s+edit\b'; then
    echo "BLOCKED: 'kubectl edit' bypasses GitOps. Edit the manifest in Git and let Flux reconcile." >&2
    exit 2
fi

# Block kubectl patch (live patching bypasses GitOps)
# Allow --dry-run variants
if echo "$COMMAND" | grep -qE 'kubectl\s+patch\b' && ! echo "$COMMAND" | grep -qE '\-\-dry-run'; then
    echo "BLOCKED: 'kubectl patch' bypasses GitOps. Edit the manifest in Git, or use --dry-run=server." >&2
    exit 2
fi

# Block kubectl replace (bypasses GitOps)
if echo "$COMMAND" | grep -qE 'kubectl\s+replace\b'; then
    echo "BLOCKED: 'kubectl replace' bypasses GitOps. Commit changes to Git and let Flux reconcile." >&2
    exit 2
fi

# Block helm uninstall/delete (use Flux teardown pattern)
if echo "$COMMAND" | grep -qE 'helm\s+(uninstall|delete)\b'; then
    echo "BLOCKED: 'helm uninstall/delete' bypasses GitOps. Use Flux teardown pattern instead." >&2
    exit 2
fi

# Block kubectl delete crd (cascading deletion of ALL custom resources)
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s+(crd|customresourcedefinition)\b'; then
    echo "BLOCKED: CRD deletion cascades to ALL custom resources of that type." >&2
    exit 2
fi

# Block kubectl delete node (removes node from cluster)
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s+node\b'; then
    echo "BLOCKED: Node deletion removes it from the cluster. Use 'kubectl drain' and 'kubectl cordon' for maintenance." >&2
    exit 2
fi

# Block kubectl delete deployment (kills all pods)
if echo "$COMMAND" | grep -qE 'kubectl\s+delete\s+deployment\b'; then
    echo "BLOCKED: Deployment deletion kills all pods. Use Flux teardown pattern or scale to 0." >&2
    exit 2
fi

# === SQL/DATABASE DESTRUCTIVE ===

# Block TRUNCATE TABLE (instant all-row deletion, no WHERE clause)
if echo "$COMMAND" | grep -qiE '\bTRUNCATE\b'; then
    echo "BLOCKED: TRUNCATE detected. This instantly deletes all rows without possibility of WHERE clause." >&2
    exit 2
fi

# Block ALTER TABLE ... DROP (destructive schema changes)
if echo "$COMMAND" | grep -qiE 'ALTER\s+.*DROP'; then
    echo "BLOCKED: ALTER...DROP detected. Destructive schema changes should be done via migration scripts." >&2
    exit 2
fi

# === REDIS DESTRUCTIVE ===

# Block FLUSHALL (wipes ALL Redis databases)
if echo "$COMMAND" | grep -qiE '\bFLUSHALL\b'; then
    echo "BLOCKED: FLUSHALL wipes ALL Redis databases. This is irreversible." >&2
    exit 2
fi

# Block FLUSHDB (wipes current Redis database)
if echo "$COMMAND" | grep -qiE '\bFLUSHDB\b'; then
    echo "BLOCKED: FLUSHDB wipes the current Redis database. This is irreversible." >&2
    exit 2
fi

# === COUCHDB DESTRUCTIVE ===

# Block curl -X DELETE to CouchDB (deletes databases)
if echo "$COMMAND" | grep -qE 'curl.*-X\s*DELETE.*(5984|couchdb)'; then
    echo "BLOCKED: HTTP DELETE to CouchDB detected. This deletes databases. Use Kubernetes CRDs for management." >&2
    exit 2
fi

# === MONGODB DESTRUCTIVE (future-proofing) ===

# Block dropDatabase
if echo "$COMMAND" | grep -qiE '\bdropDatabase\b'; then
    echo "BLOCKED: dropDatabase detected. This drops the entire database." >&2
    exit 2
fi

# Block dropCollection
if echo "$COMMAND" | grep -qiE '\bdropCollection\b'; then
    echo "BLOCKED: dropCollection detected. This drops the entire collection." >&2
    exit 2
fi

# === GIT ADDITIONAL ===

# Block git branch -D (force-deletes unmerged branch)
# Allow: git branch -d (lowercase, safe delete of merged branches)
if echo "$COMMAND" | grep -qE 'git\s+branch\s+-D\b'; then
    echo "BLOCKED: 'git branch -D' force-deletes branches even if unmerged. Use 'git branch -d' for safe deletion." >&2
    exit 2
fi

# Block git filter-branch (rewrites entire repo history)
if echo "$COMMAND" | grep -qE 'git\s+filter-branch'; then
    echo "BLOCKED: 'git filter-branch' rewrites entire repository history. This is rarely needed and dangerous." >&2
    exit 2
fi

# Block git reflog expire (removes reflog safety net)
if echo "$COMMAND" | grep -qE 'git\s+reflog\s+expire'; then
    echo "BLOCKED: 'git reflog expire' removes the reflog safety net for recovery." >&2
    exit 2
fi

# === TIER 2: COMPLEX PATTERNS (hook only, too complex for glob deny) ===

# Block pipe-to-shell (curl/wget ... | bash/sh - remote code execution)
if echo "$COMMAND" | grep -qE '(curl|wget)\s+.*\|.*\b(bash|sh)\b'; then
    echo "BLOCKED: Piping remote content to shell detected. Download and inspect scripts before executing." >&2
    exit 2
fi

# Block find ... -delete (mass file deletion)
if echo "$COMMAND" | grep -qE 'find\s+.*\s-delete\b'; then
    echo "BLOCKED: 'find -delete' can mass-delete files. Use 'find -print' first to verify, then delete manually." >&2
    exit 2
fi

# Block find ... -exec rm (mass deletion via exec)
if echo "$COMMAND" | grep -qE 'find\s+.*-exec\s.*\brm\b'; then
    echo "BLOCKED: 'find -exec rm' can mass-delete files. Use 'find -print' first to verify." >&2
    exit 2
fi

# Block dangerous chmod (000 removes all access, 777 makes world-writable)
if echo "$COMMAND" | grep -qE '\bchmod\s+.*\b(000|777)\b'; then
    echo "BLOCKED: chmod with dangerous permissions (000/777). Use specific permission values." >&2
    exit 2
fi

# Block writing to device files (data destruction / device manipulation)
# Exclude safe targets: /dev/null, /dev/stdout, /dev/stderr, /dev/fd/
if echo "$COMMAND" | grep -qE '>\s*/dev/' && ! echo "$COMMAND" | grep -qE '>\s*/dev/(null|stdout|stderr|fd/)'; then
    echo "BLOCKED: Writing to device files detected. This can destroy data or manipulate devices." >&2
    exit 2
fi

# Block killall (kills processes by name, could hit DB processes)
if echo "$COMMAND" | grep -qE '\bkillall\b'; then
    echo "BLOCKED: 'killall' kills all processes matching a name. Use 'kill <pid>' for specific processes." >&2
    exit 2
fi

# Block pkill (pattern-based kill, could hit DB processes)
if echo "$COMMAND" | grep -qE '\bpkill\b'; then
    echo "BLOCKED: 'pkill' kills processes matching a pattern. Use 'kill <pid>' for specific processes." >&2
    exit 2
fi

# Allow all other commands
exit 0
