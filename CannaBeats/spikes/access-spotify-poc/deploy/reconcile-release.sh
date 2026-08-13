#!/usr/bin/env bash
set -Eeuo pipefail

compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
release_directory="${CANNABEATS_RELEASE_DIR:-/var/lib/cannabeats/releases}"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-common.sh
source "$script_directory/release-common.sh"

[[ -f "$compose_directory/compose.yaml" && -f "$release_directory/current-compose.yaml" ]] \
  || { echo "The base Compose file and current release record are required" >&2; exit 2; }
trap release_lock_cleanup EXIT
acquire_release_lock
current="$release_directory/current-compose.yaml"
load_record_state_contract "$current" current
cd -- "$compose_directory"

if [[ "$record_state_cutover" == "true" ]]; then
  [[ -f compose.state-cutover.yaml ]] || { echo "State cutover override is missing" >&2; exit 2; }
  export CANNABEATS_RELEASE_EPOCH="$record_release_epoch"
  docker compose -f compose.yaml -f compose.state-cutover.yaml -f "$current" \
    --profile state-cutover up -d --no-deps state app game
else
  docker compose -f compose.yaml -f "$current" up -d --no-deps app game
fi

for endpoint in http://127.0.0.1:3002/api/ready http://127.0.0.1:3003/game/api/ready; do
  ready=false
  for _attempt in {1..30}; do
    if curl --fail --silent --show-error "$endpoint" >/dev/null; then ready=true; break; fi
    sleep 2
  done
  [[ "$ready" == "true" ]] || { echo "Recorded release readiness failed for $endpoint" >&2; exit 1; }
done

if [[ "$record_state_cutover" == "true" ]]; then
  state_ready="$(state_readiness_json)"
  [[ "$(state_readiness_field "$state_ready" authority.release_epoch)" == "$record_release_epoch" ]] \
    || { echo "Recorded release epoch does not match State authority" >&2; exit 1; }
  admission_open="$(state_readiness_field "$state_ready" authority.admission.open)"
  if [[ "$admission_open" != "true" ]]; then
    generation="$(state_readiness_field "$state_ready" authority.admission.generation)"
    state_set_admission true "$generation" >/dev/null
  fi
fi
echo "Reconciled containers and admission to the durable current release record"
