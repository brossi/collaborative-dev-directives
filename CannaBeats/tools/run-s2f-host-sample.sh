#!/bin/sh
set -eu

: "${CANNABEATS_GAME_IMAGE:?Set the exact candidate Game image}"
: "${S2F_HOST_ROLE:?Set application or source}"
: "${S2F_ALLOWLISTED_PIDS_JSON:?Set the encrypted-manifest PID identity map}"

case "$S2F_HOST_ROLE" in
  application|source) ;;
  *) printf '%s\n' configuration_invalid >&2; exit 1 ;;
esac

exec docker run --rm --network none --pid host --read-only --cap-drop ALL \
  --security-opt no-new-privileges --memory 128m --cpus 0.1 --pids-limit 32 \
  -e S2F_ALLOWLISTED_PIDS_JSON \
  --entrypoint node "$CANNABEATS_GAME_IMAGE" \
  /app/tools/s2f-evidence.mjs host-sample --host-role "$S2F_HOST_ROLE"
