#!/usr/bin/env bash
set -Eeuo pipefail

compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
release_directory="${CANNABEATS_RELEASE_DIR:-/var/lib/cannabeats/releases}"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_directory="$(cd -- "$script_directory/.." && pwd)"
state_tool="$project_directory/operations/release-state.mjs"

# shellcheck source=release-common.sh
source "$script_directory/release-common.sh"

if [[ ! -f "$compose_directory/compose.yaml" || ! -d "$release_directory" ]]; then
  echo "A base Compose file and initialized CannaBeats release directory are required" >&2
  exit 2
fi

temporary_files=()
cleanup() {
  for path in "${temporary_files[@]}"; do
    [[ ! -e "$path" ]] || rm -- "$path"
  done
  release_lock_cleanup
}
trap cleanup EXIT
acquire_release_lock

current="$release_directory/current-compose.yaml"
previous="$release_directory/previous-compose.yaml"
if [[ -L "$release_directory/active" ]]; then
  node "$state_tool" adopt "$release_directory"
elif [[ -f "$current" ]]; then
  load_bootstrap_schema_contract
  legacy_current="$(mktemp "$release_directory/rollback-current.XXXXXX.yaml")"
  temporary_files+=("$legacy_current")
  annotate_legacy_override "$current" "$legacy_current"
  legacy_previous=""
  if [[ -f "$previous" ]]; then
    legacy_previous="$(mktemp "$release_directory/rollback-previous.XXXXXX.yaml")"
    temporary_files+=("$legacy_previous")
    annotate_legacy_override "$previous" "$legacy_previous"
  fi
  node "$state_tool" adopt "$release_directory" "$legacy_current" "$legacy_previous"
fi
if [[ ! -f "$current" || ! -f "$previous" ]]; then
  echo "Both current and previous CannaBeats release records are required" >&2
  exit 2
fi

cd -- "$compose_directory"
docker compose -f compose.yaml -f "$previous" config --quiet
load_record_schema_contract "$previous" previous
previous_schema_min="$record_schema_min"
previous_schema_max="$record_schema_max"
database_schema="$(database_schema_version "$current")"
if ! schema_in_range "$database_schema" "$previous_schema_min" "$previous_schema_max"; then
  echo "Database schema version $database_schema is not supported by previous range $previous_schema_min-$previous_schema_max" >&2
  exit 2
fi

restore_current() {
  trap - ERR
  echo "Rollback checks failed; restoring the recorded current CannaBeats containers" >&2
  docker compose -f compose.yaml -f "$current" up -d --no-deps app game
}
trap restore_current ERR

docker compose -f compose.yaml -f "$previous" up -d --no-deps app game

for endpoint in http://127.0.0.1:3002/api/ready http://127.0.0.1:3003/game/api/ready; do
  ready=false
  for _attempt in {1..30}; do
    if curl --fail --silent --show-error "$endpoint" >/dev/null; then
      ready=true
      break
    fi
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    echo "Rollback readiness failed for $endpoint; release state was not changed" >&2
    false
  fi
done

rolled_back_schema="$(database_schema_version "$previous")"
if ! schema_in_range "$rolled_back_schema" "$previous_schema_min" "$previous_schema_max"; then
  echo "Rolled-back application cannot read database schema $rolled_back_schema" >&2
  false
fi

node "$state_tool" rollback "$release_directory"
trap - ERR
echo "Rolled CannaBeats back at database schema $rolled_back_schema; release state switched atomically"
