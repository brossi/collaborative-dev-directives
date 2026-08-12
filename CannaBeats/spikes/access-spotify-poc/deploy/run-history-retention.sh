#!/usr/bin/env bash
set -Eeuo pipefail

compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
retention_days="${CANNABEATS_GAME_HISTORY_RETENTION_DAYS:-90}"
release_override="${CANNABEATS_RELEASE_OVERRIDE:-/var/lib/cannabeats/releases/current-compose.yaml}"
timeout_seconds="${CANNABEATS_HISTORY_RETENTION_TIMEOUT_SECONDS:-120}"
timeout_command="${CANNABEATS_TIMEOUT_COMMAND:-/usr/bin/timeout}"

if [[ ! "$retention_days" =~ ^[0-9]+$ ]] || (( retention_days < 1 || retention_days > 365 )); then
  echo "CANNABEATS_GAME_HISTORY_RETENTION_DAYS must be an integer between 1 and 365" >&2
  exit 2
fi
if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]] || (( timeout_seconds < 10 || timeout_seconds > 900 )); then
  echo "CANNABEATS_HISTORY_RETENTION_TIMEOUT_SECONDS must be an integer between 10 and 900" >&2
  exit 2
fi
if [[ ! -f "$compose_directory/compose.yaml" ]]; then
  echo "CannaBeats compose file was not found in $compose_directory" >&2
  exit 2
fi

cd -- "$compose_directory"
compose=(docker compose -f compose.yaml)
if [[ -f "$release_override" ]]; then
  compose+=(-f "$release_override")
fi
exec "$timeout_command" --foreground --kill-after=10s "${timeout_seconds}s" \
  "${compose[@]}" --profile operations run --rm --no-deps history \
    purge --retention-days "$retention_days"
