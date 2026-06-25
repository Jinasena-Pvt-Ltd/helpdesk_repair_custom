#!/bin/bash
# .claude/hooks/capture_prompt.sh
# Fires on UserPromptSubmit — saves the prompt and resets the file tracking list.

set -euo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT"     | jq -r '.prompt // ""')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

TEMP_DIR="/tmp/claude_hooks"
mkdir -p "$TEMP_DIR"

echo "$PROMPT"    > "$TEMP_DIR/prompt_${SESSION_ID}.txt"
echo "$TIMESTAMP" > "$TEMP_DIR/timestamp_${SESSION_ID}.txt"

# Reset touched-files list so each turn starts fresh
rm -f "$TEMP_DIR/files_${SESSION_ID}.txt"

exit 0
