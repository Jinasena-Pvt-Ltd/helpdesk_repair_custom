#!/bin/bash
# .claude/hooks/track_file.sh
# Fires on PostToolUse for Write|Edit|MultiEdit — records which files were touched.

set -euo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TOOL_NAME=$(echo "$INPUT"  | jq -r '.tool_name // "unknown"')

FILE_PATH=$(echo "$INPUT" | jq -r '
  .tool_input.file_path //
  .tool_input.path //
  "unknown"')

TEMP_DIR="/tmp/claude_hooks"
mkdir -p "$TEMP_DIR"

ENTRY="$TOOL_NAME: $FILE_PATH"
TRACKED="$TEMP_DIR/files_${SESSION_ID}.txt"

if ! grep -qxF "$ENTRY" "$TRACKED" 2>/dev/null; then
  echo "$ENTRY" >> "$TRACKED"
fi

exit 0
