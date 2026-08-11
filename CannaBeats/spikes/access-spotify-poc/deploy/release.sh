#!/usr/bin/env bash
set -Eeuo pipefail

application_version="${1:?usage: release.sh APPLICATION_VERSION CATALOG_VERSION}"
catalog_version="${2:?usage: release.sh APPLICATION_VERSION CATALOG_VERSION}"
compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
release_directory="${CANNABEATS_RELEASE_DIR:-/var/lib/cannabeats/releases}"

if [[ ! "$application_version" =~ ^[A-Za-z0-9._-]{7,80}$ ]]; then
  echo "Application version must be a safe 7-80 character release identifier" >&2
  exit 2
fi
if [[ ! "$catalog_version" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Catalog version must be the sha256 value from catalog-manifest.json" >&2
  exit 2
fi
if [[ ! -f "$compose_directory/compose.yaml" ]]; then
  echo "CannaBeats compose file was not found in $compose_directory" >&2
  exit 2
fi

install -d -m 0755 "$release_directory"
candidate="$(mktemp "$release_directory/candidate.XXXXXX.yaml")"
current="$release_directory/current-compose.yaml"
previous="$release_directory/previous-compose.yaml"

cleanup() {
  if [[ -e "$candidate" ]]; then
    rm -- "$candidate"
  fi
}
trap cleanup EXIT

cat > "$candidate" <<EOF
services:
  app:
    image: cannabeats/access-spotify-poc:${application_version}
    environment:
      CANNABEATS_APP_VERSION: "${application_version}"
      CANNABEATS_CATALOG_VERSION: "${catalog_version}"
  game:
    image: cannabeats/game:${application_version}
    environment:
      CANNABEATS_APP_VERSION: "${application_version}"
      CANNABEATS_CATALOG_VERSION: "${catalog_version}"
  backup:
    image: cannabeats/access-spotify-poc:${application_version}
    environment:
      CANNABEATS_APP_VERSION: "${application_version}"
      CANNABEATS_CATALOG_VERSION: "${catalog_version}"
EOF
chmod 0644 "$candidate"

cd -- "$compose_directory"
base=(docker compose -f compose.yaml)
if [[ -f "$current" ]]; then
  "${base[@]}" -f "$current" --profile operations run --rm backup run
else
  "${base[@]}" --profile operations run --rm backup run
fi

deployment=(docker compose -f compose.yaml -f "$candidate")
"${deployment[@]}" config --quiet
"${deployment[@]}" build app game

rollback() {
  trap - ERR
  echo "CannaBeats release checks failed; restoring the previous application containers" >&2
  if [[ -f "$current" ]]; then
    docker compose -f compose.yaml -f "$current" up -d --no-deps app game
  else
    echo "No previous CannaBeats release record exists; manual recovery is required" >&2
  fi
}
trap rollback ERR

"${deployment[@]}" up -d --no-deps app game

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
    echo "Readiness failed for $endpoint" >&2
    exit 1
  fi
done

if [[ -f "$current" ]]; then
  install -m 0644 "$current" "$previous"
fi
install -m 0644 "$candidate" "$current"
trap - ERR
echo "Released CannaBeats application=${application_version} catalog=${catalog_version}"
