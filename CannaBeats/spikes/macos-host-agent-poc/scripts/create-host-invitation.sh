#!/bin/bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: $0 \"Display name\" [hours] [downloads]" >&2
  exit 2
fi

display_name="$1"
hours="${2:-48}"
downloads="${3:-5}"
deploy_host="${CANNABEATS_DEPLOY_HOST:-vw-services}"

if [[ -z "$display_name" || ${#display_name} -gt 60 ]]; then
  echo "Display name must contain between 1 and 60 characters." >&2
  exit 2
fi
if [[ ! "$hours" =~ ^[0-9]+$ ]] || (( hours < 1 || hours > 168 )); then
  echo "Invitation lifetime must be between 1 and 168 hours." >&2
  exit 2
fi
if [[ ! "$downloads" =~ ^[0-9]+$ ]] || (( downloads < 1 || downloads > 20 )); then
  echo "Maximum downloads must be between 1 and 20." >&2
  exit 2
fi

encoded_name="$(printf '%s' "$display_name" | base64 | tr -d '\n')"
ssh "$deploy_host" bash -s -- "$hours" "$downloads" "$encoded_name" <<'REMOTE'
set -euo pipefail
hours="$1"
downloads="$2"
display_name="$(printf '%s' "$3" | base64 --decode)"
cd /opt/cannabeats-poc
docker compose exec -T app node cli.mjs host-onboarding \
  --name "$display_name" \
  --hours "$hours" \
  --downloads "$downloads" \
  --format text
REMOTE
