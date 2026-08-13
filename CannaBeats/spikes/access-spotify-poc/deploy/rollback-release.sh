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
load_record_state_contract "$current" current
current_state_cutover="$record_state_cutover"
current_release_epoch="$record_release_epoch"
load_record_state_contract "$previous" previous
previous_state_cutover="$record_state_cutover"
previous_state_schema_min="$record_state_schema_min"
previous_state_schema_max="$record_state_schema_max"
previous_state_protocol_min="$record_state_protocol_min"
previous_state_protocol_max="$record_state_protocol_max"
previous_state_http_contract="$record_state_http_contract"
previous_release_epoch="$record_release_epoch"
if [[ "$current_state_cutover" == "true" ]]; then
  state_ready="$(state_readiness_json)"
  active_state_generation="$(state_readiness_field "$state_ready" schemaGeneration)"
  active_state_protocol="$(state_readiness_field "$state_ready" protocolVersion)"
  active_state_epoch="$(state_readiness_field "$state_ready" authority.release_epoch)"
  first_admitted_at="$(state_readiness_field "$state_ready" authority.first_admitted_at)"
  if [[ "$previous_state_cutover" != "true" && -n "$first_admitted_at" ]]; then
    echo "Pre-cutover rollback is forbidden after the first state-owned lobby is admitted" >&2
    exit 2
  fi
  if [[ "$previous_state_cutover" == "true" ]] && ! state_contract_in_range \
      "$active_state_generation" "$active_state_protocol" \
      "$previous_state_schema_min" "$previous_state_schema_max" \
      "$previous_state_protocol_min" "$previous_state_protocol_max"; then
    echo "Active State contract is not supported by the previous release" >&2
    exit 2
  fi
  if [[ "$previous_state_cutover" == "true" && "$previous_release_epoch" != "$active_state_epoch" ]]; then
    echo "Previous release does not belong to the active State recovery epoch" >&2
    exit 2
  fi
fi
database_schema="$(database_schema_version "$current")"
if ! schema_in_range "$database_schema" "$previous_schema_min" "$previous_schema_max"; then
  echo "Database schema version $database_schema is not supported by previous range $previous_schema_min-$previous_schema_max" >&2
  exit 2
fi

admission_was_open=false
record_switched=false
restore_current() {
  trap - ERR
  echo "Rollback checks failed; restoring the recorded current CannaBeats containers" >&2
  if [[ "$record_switched" == "true" ]]; then
    node "$state_tool" rollback "$release_directory" || true
    record_switched=false
  fi
  if [[ "$current_state_cutover" == "true" ]]; then
    CANNABEATS_RELEASE_EPOCH="$current_release_epoch" docker compose -f compose.yaml \
      -f compose.state-cutover.yaml -f "$current" --profile state-cutover \
      up -d --no-deps state app game
    if [[ "$admission_was_open" == "true" ]]; then
      for _attempt in {1..30}; do
        if state_ready="$(state_readiness_json 2>/dev/null)"; then
          generation="$(state_readiness_field "$state_ready" authority.admission.generation)"
          state_set_admission true "$generation" >/dev/null 2>&1 && break
        fi
        sleep 2
      done
    fi
  else
    docker compose -f compose.yaml -f "$current" up -d --no-deps app game
  fi
  return 1
}
trap restore_current ERR

if [[ "$current_state_cutover" == "true" ]]; then
  state_ready="$(state_readiness_json)"
  admission_was_open="$(state_readiness_field "$state_ready" authority.admission.open)"
  admission_generation="$(state_readiness_field "$state_ready" authority.admission.generation)"
  if [[ "$admission_was_open" == "true" ]]; then
    state_set_admission false "$admission_generation" >/dev/null
  fi
  state_ready="$(state_readiness_json)"
  first_admitted_at="$(state_readiness_field "$state_ready" authority.first_admitted_at)"
  if [[ "$previous_state_cutover" != "true" && -n "$first_admitted_at" ]]; then
    echo "Pre-cutover rollback is forbidden after the first state-owned lobby is admitted" >&2
    false
  fi
fi

if [[ "$current_state_cutover" == "true" ]]; then
  CANNABEATS_RELEASE_EPOCH="$current_release_epoch" docker compose -f compose.yaml \
    -f compose.state-cutover.yaml -f "$current" --profile state-cutover stop app game
else
  docker compose -f compose.yaml -f "$current" stop app game
fi
node "$state_tool" rollback "$release_directory"
record_switched=true
if [[ "${CANNABEATS_TEST_KILL_AFTER_ROLLBACK_RECORD:-false}" == "true" ]]; then kill -KILL "$$"; fi

if [[ "$previous_state_cutover" == "true" ]]; then
  export CANNABEATS_RELEASE_EPOCH="$previous_release_epoch"
  docker compose -f compose.yaml -f compose.state-cutover.yaml -f "$current" \
    --profile state-cutover up -d --no-deps state app game
else
  docker compose -f compose.yaml -f "$current" up -d --no-deps app game
  if [[ "$current_state_cutover" == "true" ]]; then
    CANNABEATS_RELEASE_EPOCH="$current_release_epoch" docker compose -f compose.yaml \
      -f compose.state-cutover.yaml -f "$current" --profile state-cutover stop state
  fi
fi

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

if [[ "$previous_state_cutover" == "true" ]]; then
  state_ready="$(state_readiness_json)"
  rolled_state_generation="$(state_readiness_field "$state_ready" schemaGeneration)"
  rolled_state_protocol="$(state_readiness_field "$state_ready" protocolVersion)"
  rolled_state_http="$(state_readiness_field "$state_ready" httpContractVersion)"
  rolled_state_epoch="$(state_readiness_field "$state_ready" authority.release_epoch)"
  if ! state_contract_in_range "$rolled_state_generation" "$rolled_state_protocol" \
      "$previous_state_schema_min" "$previous_state_schema_max" \
      "$previous_state_protocol_min" "$previous_state_protocol_max" \
      || [[ "$rolled_state_http" != "$previous_state_http_contract" \
        || "$rolled_state_epoch" != "$previous_release_epoch" ]]; then
    echo "Rolled-back State service is incompatible with active authority" >&2
    false
  fi
  if [[ "$admission_was_open" == "true" ]]; then
    rolled_admission_generation="$(state_readiness_field "$state_ready" authority.admission.generation)"
    state_set_admission true "$rolled_admission_generation" >/dev/null
  fi
fi

rolled_back_schema="$(database_schema_version "$current")"
if ! schema_in_range "$rolled_back_schema" "$previous_schema_min" "$previous_schema_max"; then
  echo "Rolled-back application cannot read database schema $rolled_back_schema" >&2
  false
fi

trap - ERR
echo "Rolled CannaBeats back at database schema $rolled_back_schema; release state switched atomically"
