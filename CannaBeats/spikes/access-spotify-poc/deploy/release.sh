#!/usr/bin/env bash
set -Eeuo pipefail

application_version="${1:?usage: release.sh APPLICATION_VERSION CATALOG_VERSION}"
catalog_version="${2:?usage: release.sh APPLICATION_VERSION CATALOG_VERSION}"
compose_directory="${CANNABEATS_COMPOSE_DIR:?Set CANNABEATS_COMPOSE_DIR to the deployed CannaBeats compose directory}"
release_directory="${CANNABEATS_RELEASE_DIR:-/var/lib/cannabeats/releases}"
web_directory="${CANNABEATS_WEB_DIR:-$compose_directory/../../web}"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_directory="$(cd -- "$script_directory/.." && pwd)"
state_tool="$project_directory/operations/release-state.mjs"

# shellcheck source=release-common.sh
source "$script_directory/release-common.sh"
# shellcheck source=schema-compatibility.env
source "$script_directory/schema-compatibility.env"
candidate_schema_min="$CANNABEATS_SCHEMA_MIN_VERSION"
candidate_schema_max="$CANNABEATS_SCHEMA_MAX_VERSION"
candidate_schema_target="$CANNABEATS_SCHEMA_TARGET_VERSION"
validate_schema_contract "$candidate_schema_min" "$candidate_schema_max" "$candidate_schema_target" candidate

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
if [[ ! -d "$web_directory" ]]; then
  echo "CannaBeats web directory was not found at $web_directory" >&2
  exit 2
fi
manifest_file="$web_directory/data/catalog-manifest.json"
if [[ ! -f "$manifest_file" ]]; then
  echo "Catalog manifest was not found at $manifest_file" >&2
  exit 2
fi
manifest_catalog_version="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(manifest.catalogVersion ?? ""));
' "$manifest_file")"
if [[ "$catalog_version" != "$manifest_catalog_version" ]]; then
  echo "Requested catalog identity does not match the checked-in manifest" >&2
  exit 2
fi

install -d -m 0755 "$release_directory"
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
used_versions="$release_directory/used-application-versions"

temporary_file() {
  generated_temporary_file="$(mktemp "$release_directory/$1.XXXXXX.yaml")"
  temporary_files+=("$generated_temporary_file")
}

write_override() {
  local path="$1" app_image="$2" game_image="$3" version="$4" catalog="$5"
  local schema_min="$6" schema_max="$7" schema_target="$8"
  cat > "$path" <<EOF
x-cannabeats-release:
  application-version: "$version"
  catalog-version: "$catalog"
  schema-min-version: $schema_min
  schema-max-version: $schema_max
  schema-target-version: $schema_target
services:
  app:
    image: $app_image
    environment:
      CANNABEATS_APP_VERSION: "$version"
      CANNABEATS_CATALOG_VERSION: "$catalog"
      CANNABEATS_SCHEMA_MIN_VERSION: "$schema_min"
      CANNABEATS_SCHEMA_MAX_VERSION: "$schema_max"
      CANNABEATS_SCHEMA_TARGET_VERSION: "$schema_target"
  game:
    image: $game_image
    environment:
      CANNABEATS_APP_VERSION: "$version"
      CANNABEATS_CATALOG_VERSION: "$catalog"
      CANNABEATS_SCHEMA_MIN_VERSION: "$schema_min"
      CANNABEATS_SCHEMA_MAX_VERSION: "$schema_max"
      CANNABEATS_SCHEMA_TARGET_VERSION: "$schema_target"
  backup:
    image: $app_image
    environment:
      CANNABEATS_APP_VERSION: "$version"
      CANNABEATS_CATALOG_VERSION: "$catalog"
      CANNABEATS_SCHEMA_MIN_VERSION: "$schema_min"
      CANNABEATS_SCHEMA_MAX_VERSION: "$schema_max"
      CANNABEATS_SCHEMA_TARGET_VERSION: "$schema_target"
EOF
  chmod 0644 "$path"
}

container_environment() {
  local container="$1" name="$2"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" \
    | awk -F= -v key="$name" '$1 == key { sub(/^[^=]*=/, ""); print; exit }'
}

cd -- "$compose_directory"
base=(docker compose -f compose.yaml)

if [[ -L "$release_directory/active" ]]; then
  node "$state_tool" adopt "$release_directory"
elif [[ -f "$current" ]]; then
  load_bootstrap_schema_contract
  temporary_file legacy-current
  legacy_current="$generated_temporary_file"
  annotate_legacy_override "$current" "$legacy_current"
  legacy_previous=""
  if [[ -f "$previous" ]]; then
    temporary_file legacy-previous
    legacy_previous="$generated_temporary_file"
    annotate_legacy_override "$previous" "$legacy_previous"
  fi
  node "$state_tool" adopt "$release_directory" "$legacy_current" "$legacy_previous"
else
  load_bootstrap_schema_contract
  bootstrap_app_image="$(docker inspect --format '{{.Image}}' cannabeats-access-poc)"
  bootstrap_game_image="$(docker inspect --format '{{.Image}}' cannabeats-game)"
  bootstrap_app_version="$(container_environment cannabeats-access-poc CANNABEATS_APP_VERSION)"
  bootstrap_game_version="$(container_environment cannabeats-game CANNABEATS_APP_VERSION)"
  bootstrap_app_catalog="$(container_environment cannabeats-access-poc CANNABEATS_CATALOG_VERSION)"
  bootstrap_game_catalog="$(container_environment cannabeats-game CANNABEATS_CATALOG_VERSION)"
  if [[ ! "$bootstrap_app_image" =~ ^sha256:[0-9a-f]{64}$ \
      || ! "$bootstrap_game_image" =~ ^sha256:[0-9a-f]{64}$ \
      || -z "$bootstrap_app_version" \
      || "$bootstrap_app_version" != "$bootstrap_game_version" \
      || ! "$bootstrap_app_catalog" =~ ^sha256:[0-9a-f]{64}$ \
      || "$bootstrap_app_catalog" != "$bootstrap_game_catalog" ]]; then
    echo "Cannot establish an exact rollback record from the running CannaBeats containers" >&2
    exit 2
  fi
  temporary_file bootstrap
  bootstrap="$generated_temporary_file"
  write_override "$bootstrap" "$bootstrap_app_image" "$bootstrap_game_image" \
    "$bootstrap_app_version" "$bootstrap_app_catalog" \
    "$bootstrap_schema_min" "$bootstrap_schema_max" "$bootstrap_schema_target"
  node "$state_tool" bootstrap "$release_directory" "$bootstrap"
fi

if [[ -f "$used_versions" ]] && grep -Fqx -- "$application_version" "$used_versions"; then
  echo "Application release identity is immutable and already recorded: $application_version" >&2
  exit 2
fi

load_record_schema_contract "$current" current
current_schema_min="$record_schema_min"
current_schema_max="$record_schema_max"
current_database_schema="$(database_schema_version "$current")"
if ! schema_in_range "$current_database_schema" "$candidate_schema_min" "$candidate_schema_max"; then
  echo "Database schema version $current_database_schema is not supported by candidate range $candidate_schema_min-$candidate_schema_max" >&2
  exit 2
fi
if ! schema_in_range "$candidate_schema_target" "$current_schema_min" "$current_schema_max"; then
  echo "Candidate schema target $candidate_schema_target cannot be rolled back to current range $current_schema_min-$current_schema_max" >&2
  exit 2
fi

npm --prefix "$web_directory" run catalog:check
"${base[@]}" -f "$current" --profile operations run --rm backup run

temporary_file build
build_override="$generated_temporary_file"
write_override "$build_override" \
  "cannabeats/access-spotify-poc:${application_version}" \
  "cannabeats/game:${application_version}" \
  "$application_version" "$catalog_version" \
  "$candidate_schema_min" "$candidate_schema_max" "$candidate_schema_target"
build_deployment=(docker compose -f compose.yaml -f "$build_override")
"${build_deployment[@]}" config --quiet
"${build_deployment[@]}" build app game

app_image_id="$(docker image inspect --format '{{.Id}}' "cannabeats/access-spotify-poc:${application_version}")"
game_image_id="$(docker image inspect --format '{{.Id}}' "cannabeats/game:${application_version}")"
if [[ ! "$app_image_id" =~ ^sha256:[0-9a-f]{64}$ || ! "$game_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Built image IDs could not be pinned" >&2
  exit 1
fi

temporary_file candidate
candidate="$generated_temporary_file"
write_override "$candidate" "$app_image_id" "$game_image_id" "$application_version" "$catalog_version" \
  "$candidate_schema_min" "$candidate_schema_max" "$candidate_schema_target"
deployment=(docker compose -f compose.yaml -f "$candidate")
"${deployment[@]}" config --quiet

rollback() {
  trap - ERR
  echo "CannaBeats release checks failed; restoring the exact previous application images" >&2
  docker compose -f compose.yaml -f "$current" up -d --no-deps app game
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
    false
  fi
done

deployed_database_schema="$(database_schema_version "$candidate")"
if [[ "$deployed_database_schema" != "$candidate_schema_target" ]]; then
  echo "Candidate readiness reported schema $deployed_database_schema; expected target $candidate_schema_target" >&2
  false
fi

node "$state_tool" promote "$release_directory" "$candidate" "$application_version"
trap - ERR
echo "Released CannaBeats application=${application_version} catalog=${catalog_version} schema=${deployed_database_schema}"
