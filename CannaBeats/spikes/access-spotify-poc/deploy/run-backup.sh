#!/usr/bin/env bash
set -Eeuo pipefail

compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
keep="${CANNABEATS_BACKUP_KEEP:-14}"
release_override="${CANNABEATS_RELEASE_OVERRIDE:-/var/lib/cannabeats/releases/current-compose.yaml}"

if [[ ! "$keep" =~ ^[0-9]+$ ]] || (( keep < 2 || keep > 365 )); then
  echo "CANNABEATS_BACKUP_KEEP must be an integer between 2 and 365" >&2
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
exec "${compose[@]}" --profile operations run --rm backup run --keep "$keep"
