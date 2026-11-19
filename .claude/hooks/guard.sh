#!/bin/sh
# PreToolUse: block edits to secrets and machine-generated files.
f=$(sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
case "$f" in
  */.env|*/.env.*|*/package-lock.json|*/actions.lock)
    echo "Blocked: $f is a secret or generated file." >&2
    exit 2 ;;
esac
exit 0
