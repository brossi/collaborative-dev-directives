#!/usr/bin/env bash
set -Eeuo pipefail

compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
keep="${CANNABEATS_BACKUP_KEEP:-14}"
release_override="${CANNABEATS_RELEASE_OVERRIDE:-/var/lib/cannabeats/releases/current-compose.yaml}"
release_directory="${CANNABEATS_RELEASE_DIR:-$(dirname -- "$release_override")}"
timeout_seconds="${CANNABEATS_BACKUP_TIMEOUT_SECONDS:-1500}"
timeout_command="${CANNABEATS_TIMEOUT_COMMAND:-/usr/bin/timeout}"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-common.sh
source "$script_directory/release-common.sh"

if [[ ! "$keep" =~ ^[0-9]+$ ]] || (( keep < 2 || keep > 365 )); then
  echo "CANNABEATS_BACKUP_KEEP must be an integer between 2 and 365" >&2
  exit 2
fi
if [[ ! "$timeout_seconds" =~ ^[0-9]+$ ]] || (( timeout_seconds < 60 || timeout_seconds > 7200 )); then
  echo "CANNABEATS_BACKUP_TIMEOUT_SECONDS must be an integer between 60 and 7200" >&2
  exit 2
fi
if [[ ! -f "$compose_directory/compose.yaml" ]]; then
  echo "CannaBeats compose file was not found in $compose_directory" >&2
  exit 2
fi

cd -- "$compose_directory"
install -d -m 0755 "$release_directory"
trap release_lock_cleanup EXIT
acquire_release_lock
compose=(docker compose -f compose.yaml)
profiles=(--profile operations)
if [[ -f "$release_override" ]] && grep -Eq '^  state-cutover:[[:space:]]+true$' "$release_override"; then
  [[ -f compose.state-cutover.yaml ]] || { echo "State cutover override is missing" >&2; exit 2; }
  release_epoch="$(awk '/^  release-epoch:/ { sub(/^  release-epoch:[[:space:]]*/, ""); print; exit }' "$release_override")"
  [[ "$release_epoch" =~ ^[A-Za-z0-9._:-]{1,160}$ ]] \
    || { echo "State release epoch is invalid" >&2; exit 2; }
  export CANNABEATS_RELEASE_EPOCH="$release_epoch"
  compose+=(-f compose.state-cutover.yaml)
  profiles=(--profile state-cutover --profile operations)
fi
if [[ -f "$release_override" ]]; then compose+=(-f "$release_override"); fi
exec "$timeout_command" --foreground --kill-after=30s "${timeout_seconds}s" \
  "${compose[@]}" "${profiles[@]}" run --rm backup run --keep "$keep"
