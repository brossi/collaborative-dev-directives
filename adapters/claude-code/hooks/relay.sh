#!/bin/sh
# Forward a Claude Code hook payload to the adapter's Unix socket.
# Invoked by ~/.claude/settings.json hook entries:
#
#   {
#     "hooks": {
#       "UserPromptSubmit": [{ "matcher": "*", "hooks": [
#         { "type": "command", "command": "$HOME/.agent-orchestrator/hooks/relay.sh UserPromptSubmit" }
#       ]}],
#       "Stop": [...],
#       "SessionStart": [...]
#     }
#   }
#
# Claude Code passes the hook JSON on stdin; we prepend `"hook":` and forward.
set -e
HOOK="$1"
SOCK="$HOME/.agent-orchestrator/claude-code.sock"
if [ ! -S "$SOCK" ]; then
  # Adapter not running — don't block the user's session.
  exit 0
fi
# Merge { "hook": "<name>", ...stdin } into a single line on the socket.
STDIN_JSON=$(cat)
if [ -z "$STDIN_JSON" ]; then STDIN_JSON='{}'; fi
printf '%s' "$STDIN_JSON" \
  | sed "s/^{/{\"hook\":\"$HOOK\",/" \
  | nc -U -N "$SOCK" >/dev/null 2>&1 || true
