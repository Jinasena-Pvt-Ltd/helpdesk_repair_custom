#!/bin/bash
# .claude/hooks/commit_and_push.sh
# Fires on Stop — writes the changelog entry and pushes one commit per turn.

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
CWD=$(echo "$INPUT"        | jq -r '.cwd // "."')

TEMP_DIR="/tmp/claude_hooks"
PROMPT_FILE="$TEMP_DIR/prompt_${SESSION_ID}.txt"
FILES_FILE="$TEMP_DIR/files_${SESSION_ID}.txt"
TIMESTAMP_FILE="$TEMP_DIR/timestamp_${SESSION_ID}.txt"

# Nothing to do if no files were changed this turn
if [[ ! -f "$FILES_FILE" ]] || [[ ! -s "$FILES_FILE" ]]; then
  exit 0
fi

PROMPT=$(cat "$PROMPT_FILE" 2>/dev/null || echo "(prompt not captured)")
TIMESTAMP=$(cat "$TIMESTAMP_FILE" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
FILES=$(cat "$FILES_FILE")

# ── Write changelog entry ─────────────────────────────────────────────────────
LOG_DIR="$CWD/.claude_changelog"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/session_${SESSION_ID}.md"

cat >> "$LOG_FILE" <<MDEOF

---

## Change — $TIMESTAMP

**Prompt:**
\`\`\`
$PROMPT
\`\`\`

**Files touched:**
$(echo "$FILES" | sed 's/^/- /')

MDEOF

# ── Git commit and push ───────────────────────────────────────────────────────
cd "$CWD"

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Not a git repo, skipping push." >&2
  exit 0
fi

git add -A

if git diff --cached --quiet; then
  exit 0
fi

# Commit message: first 80 chars of prompt + file count
SHORT_PROMPT=$(echo "$PROMPT" | head -c 80 | tr '\n' ' ')
FILE_COUNT=$(echo "$FILES" | wc -l | tr -d ' ')
git commit -m "[claude] $SHORT_PROMPT | $FILE_COUNT file(s) changed"
git push

exit 0
