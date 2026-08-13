#!/usr/bin/env bash
set -Eeuo pipefail

compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
release_override="${CANNABEATS_RELEASE_OVERRIDE:-/var/lib/cannabeats/releases/current-compose.yaml}"
timeout_seconds="${CANNABEATS_OPERATIONS_TIMEOUT_SECONDS:-60}"
timeout_command="${CANNABEATS_TIMEOUT_COMMAND:-/usr/bin/timeout}"

if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]] || (( timeout_seconds < 10 || timeout_seconds > 600 )); then
  echo "CANNABEATS_OPERATIONS_TIMEOUT_SECONDS must be an integer between 10 and 600" >&2
  exit 2
fi
if [[ ! -f "$compose_directory/compose.yaml" ]]; then
  echo "CannaBeats compose file was not found in $compose_directory" >&2
  exit 2
fi

cd -- "$compose_directory"
compose=(docker compose -f compose.yaml)
if [[ -f "$compose_directory/compose.state-cutover.yaml" ]]; then
  compose+=(-f compose.state-cutover.yaml)
fi
if [[ -f "$release_override" ]]; then
  compose+=(-f "$release_override")
fi
exec "$timeout_command" --foreground --kill-after=10s "${timeout_seconds}s" \
  "${compose[@]}" --profile operations run --rm --no-deps operator operator-status --format json --fail-on unavailable
