#!/bin/sh
# PostToolUse: type-check after TypeScript edits.
f=$(sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
case "$f" in
  *.ts)
    cd "$CLAUDE_PROJECT_DIR/app" 2>/dev/null || exit 0
    out=$(npx tsc --noEmit 2>&1) || { echo "$out" | head -20 >&2; exit 2; } ;;
esac
exit 0
