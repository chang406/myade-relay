#!/usr/bin/env bash
# myade - launches `claude` while registering this terminal/pane with the
# local myade server (starting the server first if it isn't already
# running). All actual logic lives in register.js so this file stays
# tiny and easy to trust.
#
# Usage: myade.sh [any claude CLI arguments]
# Optional: MYADE_LABEL=my-label ./myade.sh   to name this pane
# Optional: MYADE_PORT=1234 ./myade.sh        to use a non-default port

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MYADE_PANE_ID="$(node "$SCRIPT_DIR/register.js" start)"

claude "$@"

if [ -n "$MYADE_PANE_ID" ]; then
  node "$SCRIPT_DIR/register.js" end "$MYADE_PANE_ID"
fi
