#!/bin/sh
# Claude supplies its complete shell command as one argument. Never evaluate it here.
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 125
exec uv run --quiet --script "$SCRIPT_DIR/remote_sandbox_exec.py" "$@"
