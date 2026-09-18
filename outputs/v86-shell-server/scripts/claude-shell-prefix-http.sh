#!/bin/sh
# Legacy buffered HTTP client. Claude's complete command stays one argument.
SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 125
exec node "$SCRIPT_DIR/api-exec.mjs" "$@"
