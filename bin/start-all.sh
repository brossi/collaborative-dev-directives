#!/bin/sh
# Launch the broker plus all four adapters in a tmux session.
# Assumes pnpm install has already been run.
set -e
SESSION="agent-orchestrator"
cd "$(dirname "$0")/.."

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists. Attach with: tmux attach -t $SESSION"
  exit 0
fi

tmux new-session  -d -s "$SESSION" -n broker      'pnpm broker'
tmux new-window   -t "$SESSION"    -n claude-code 'pnpm adapter:claude-code'
tmux new-window   -t "$SESSION"    -n codex       'pnpm adapter:codex'
tmux new-window   -t "$SESSION"    -n antigravity 'pnpm adapter:antigravity'
tmux new-window   -t "$SESSION"    -n cursor      'pnpm adapter:cursor'
tmux select-window -t "$SESSION":broker

echo "Started. Attach with: tmux attach -t $SESSION"
