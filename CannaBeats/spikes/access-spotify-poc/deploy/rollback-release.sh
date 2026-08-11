#!/usr/bin/env bash
set -Eeuo pipefail

compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
release_directory="${CANNABEATS_RELEASE_DIR:-/var/lib/cannabeats/releases}"
current="$release_directory/current-compose.yaml"
previous="$release_directory/previous-compose.yaml"

if [[ ! -f "$compose_directory/compose.yaml" || ! -f "$current" || ! -f "$previous" ]]; then
  echo "A base compose file and both current/previous CannaBeats release records are required" >&2
  exit 2
fi

cd -- "$compose_directory"
docker compose -f compose.yaml -f "$previous" config --quiet

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
    echo "Rollback readiness failed for $endpoint; release records were not changed" >&2
    exit 1
  fi
done

swap="$(mktemp "$release_directory/rollback.XXXXXX.yaml")"
trap 'rm -- "$swap"' EXIT
install -m 0644 "$current" "$swap"
install -m 0644 "$previous" "$current"
install -m 0644 "$swap" "$previous"
trap - ERR
echo "Rolled CannaBeats back; current and previous release records were swapped"
