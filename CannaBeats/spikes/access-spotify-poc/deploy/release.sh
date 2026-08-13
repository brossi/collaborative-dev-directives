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
state_cutover="${CANNABEATS_STATE_CUTOVER:-false}"
state_schema_min="${CANNABEATS_STATE_SCHEMA_MIN_GENERATION:-3}"
state_schema_max="${CANNABEATS_STATE_SCHEMA_MAX_GENERATION:-3}"
state_protocol_min="${CANNABEATS_STATE_PROTOCOL_MIN_VERSION:-4}"
state_protocol_max="${CANNABEATS_STATE_PROTOCOL_MAX_VERSION:-4}"
state_http_contract="${CANNABEATS_STATE_HTTP_CONTRACT_VERSION:-1}"
release_epoch="${CANNABEATS_RELEASE_EPOCH:-$application_version}"
validate_schema_contract "$candidate_schema_min" "$candidate_schema_max" "$candidate_schema_target" candidate
if [[ "$state_cutover" != "true" && "$state_cutover" != "false" ]]; then
  echo "CANNABEATS_STATE_CUTOVER must be true or false" >&2; exit 2
fi
if [[ "$state_cutover" == "true" ]] && { ! schema_integer "$state_schema_min" \
    || ! schema_integer "$state_schema_max" || ! schema_integer "$state_protocol_min" \
    || ! schema_integer "$state_protocol_max" || ! schema_integer "$state_http_contract" \
    || (( state_schema_min > state_schema_max || state_protocol_min > state_protocol_max \
      || state_http_contract < 1 )) || [[ ! "$release_epoch" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; }; then
  echo "Candidate state contract is invalid" >&2; exit 2
fi
if [[ "$state_cutover" == "true" ]]; then
  export CANNABEATS_RELEASE_EPOCH="$release_epoch"
fi

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
if [[ "$state_cutover" == "true" && ! -f "$compose_directory/compose.state-cutover.yaml" ]]; then
  echo "State cutover Compose override was not found in $compose_directory" >&2
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
  local state_image="${9:-}"
  local record_state_cutover="${10:-$state_cutover}"
  cat > "$path" <<EOF
x-cannabeats-release:
  application-version: "$version"
  catalog-version: "$catalog"
  schema-min-version: $schema_min
  schema-max-version: $schema_max
  schema-target-version: $schema_target
  state-cutover: $record_state_cutover
  state-schema-min-generation: $([[ "$record_state_cutover" == true ]] && echo "$state_schema_min" || echo 0)
  state-schema-max-generation: $([[ "$record_state_cutover" == true ]] && echo "$state_schema_max" || echo 0)
  state-protocol-min-version: $([[ "$record_state_cutover" == true ]] && echo "$state_protocol_min" || echo 0)
  state-protocol-max-version: $([[ "$record_state_cutover" == true ]] && echo "$state_protocol_max" || echo 0)
  state-http-contract-version: $([[ "$record_state_cutover" == true ]] && echo "$state_http_contract" || echo 0)
  release-epoch: $release_epoch
services:
  app:
    image: $app_image
    environment:
      CANNABEATS_APP_VERSION: "$version"
      CANNABEATS_CATALOG_VERSION: "$catalog"
      CANNABEATS_SCHEMA_MIN_VERSION: "$schema_min"
      CANNABEATS_SCHEMA_MAX_VERSION: "$schema_max"
      CANNABEATS_SCHEMA_TARGET_VERSION: "$schema_target"
      CANNABEATS_RELEASE_EPOCH: "$release_epoch"
  game:
    image: $game_image
    environment:
      CANNABEATS_APP_VERSION: "$version"
      CANNABEATS_CATALOG_VERSION: "$catalog"
      CANNABEATS_SCHEMA_MIN_VERSION: "$schema_min"
      CANNABEATS_SCHEMA_MAX_VERSION: "$schema_max"
      CANNABEATS_SCHEMA_TARGET_VERSION: "$schema_target"
      CANNABEATS_RELEASE_EPOCH: "$release_epoch"
  backup:
    image: $app_image
    environment:
      CANNABEATS_APP_VERSION: "$version"
      CANNABEATS_CATALOG_VERSION: "$catalog"
      CANNABEATS_SCHEMA_MIN_VERSION: "$schema_min"
      CANNABEATS_SCHEMA_MAX_VERSION: "$schema_max"
      CANNABEATS_SCHEMA_TARGET_VERSION: "$schema_target"
      CANNABEATS_RELEASE_EPOCH: "$release_epoch"
  operator:
    image: $app_image
    environment:
      CANNABEATS_APP_VERSION: "$version"
      CANNABEATS_CATALOG_VERSION: "$catalog"
      CANNABEATS_RELEASE_EPOCH: "$release_epoch"
EOF
  if [[ "$record_state_cutover" == "true" ]]; then
    cat >> "$path" <<EOF
  state:
    image: $state_image
    environment:
      CANNABEATS_RELEASE_EPOCH: "$release_epoch"
EOF
  fi
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
    "$bootstrap_schema_min" "$bootstrap_schema_max" "$bootstrap_schema_target" "" false
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
load_record_state_contract "$current" current
current_state_cutover="$record_state_cutover"
current_release_epoch="$record_release_epoch"
if [[ "$current_state_cutover" == "true" && "$state_cutover" != "true" ]]; then
  echo "A post-admission-capable state release cannot be replaced by a pre-cutover release" >&2
  exit 2
fi
if ! schema_in_range "$current_database_schema" "$candidate_schema_min" "$candidate_schema_max"; then
  echo "Database schema version $current_database_schema is not supported by candidate range $candidate_schema_min-$candidate_schema_max" >&2
  exit 2
fi
if ! schema_in_range "$candidate_schema_target" "$current_schema_min" "$current_schema_max"; then
  echo "Candidate schema target $candidate_schema_target cannot be rolled back to current range $current_schema_min-$current_schema_max" >&2
  exit 2
fi

npm --prefix "$web_directory" run catalog:check
if [[ "$current_state_cutover" == "true" ]]; then
  CANNABEATS_RELEASE_EPOCH="$current_release_epoch" docker compose -f compose.yaml \
    -f compose.state-cutover.yaml -f "$current" --profile state-cutover --profile operations \
    run --rm backup run
else
  "${base[@]}" -f "$current" --profile operations run --rm backup run
fi

temporary_file build
build_override="$generated_temporary_file"
write_override "$build_override" \
  "cannabeats/access-spotify-poc:${application_version}" \
  "cannabeats/game:${application_version}" \
  "$application_version" "$catalog_version" \
  "$candidate_schema_min" "$candidate_schema_max" "$candidate_schema_target" \
  "cannabeats/state-service:${application_version}"
build_deployment=(docker compose -f compose.yaml -f "$build_override")
"${build_deployment[@]}" config --quiet
if [[ "$state_cutover" == "true" ]]; then
  build_deployment=(docker compose -f compose.yaml -f compose.state-cutover.yaml -f "$build_override" --profile state-cutover)
  "${build_deployment[@]}" config --quiet
  "${build_deployment[@]}" build app game state
else
  "${build_deployment[@]}" config --quiet
  "${build_deployment[@]}" build app game
fi

app_image_id="$(docker image inspect --format '{{.Id}}' "cannabeats/access-spotify-poc:${application_version}")"
game_image_id="$(docker image inspect --format '{{.Id}}' "cannabeats/game:${application_version}")"
state_image_id=""
if [[ "$state_cutover" == "true" ]]; then
  state_image_id="$(docker image inspect --format '{{.Id}}' "cannabeats/state-service:${application_version}")"
fi
if [[ ! "$app_image_id" =~ ^sha256:[0-9a-f]{64}$ || ! "$game_image_id" =~ ^sha256:[0-9a-f]{64}$ \
    || ( "$state_cutover" == "true" && ! "$state_image_id" =~ ^sha256:[0-9a-f]{64}$ ) ]]; then
  echo "Built image IDs could not be pinned" >&2
  exit 1
fi

temporary_file candidate
candidate="$generated_temporary_file"
write_override "$candidate" "$app_image_id" "$game_image_id" "$application_version" "$catalog_version" \
  "$candidate_schema_min" "$candidate_schema_max" "$candidate_schema_target" "$state_image_id"
if [[ "$state_cutover" == "true" ]]; then
  deployment=(docker compose -f compose.yaml -f compose.state-cutover.yaml -f "$candidate" --profile state-cutover)
else
  deployment=(docker compose -f compose.yaml -f "$candidate")
fi
"${deployment[@]}" config --quiet

record_promoted=false
admission_was_open=false
rollback() {
  trap - ERR
  echo "CannaBeats release checks failed; restoring the exact previous application images" >&2
  if [[ "$record_promoted" == "true" ]]; then
    node "$state_tool" rollback "$release_directory" || true
    record_promoted=false
  fi
  if [[ "$current_state_cutover" == "true" ]]; then
    CANNABEATS_RELEASE_EPOCH="$current_release_epoch" docker compose -f compose.yaml \
      -f compose.state-cutover.yaml -f "$current" --profile state-cutover \
      up -d --no-deps state app game
    if [[ "$admission_was_open" == "true" ]]; then
      state_ready="$(state_readiness_json 2>/dev/null || true)"
      generation="$(state_readiness_field "$state_ready" authority.admission.generation)"
      [[ -z "$generation" ]] || state_set_admission true "$generation" >/dev/null 2>&1 || true
    fi
  else
    docker compose -f compose.yaml -f "$current" up -d --no-deps app game
    if [[ "$state_cutover" == "true" ]]; then
      "${deployment[@]}" stop state
    fi
  fi
  return 1
}
trap rollback ERR

if [[ "$current_state_cutover" == "true" ]]; then
  state_ready="$(state_readiness_json)"
  admission_was_open="$(state_readiness_field "$state_ready" authority.admission.open)"
  if [[ "$admission_was_open" == "true" ]]; then
    admission_generation="$(state_readiness_field "$state_ready" authority.admission.generation)"
    state_set_admission false "$admission_generation" >/dev/null
  fi
  CANNABEATS_RELEASE_EPOCH="$current_release_epoch" docker compose -f compose.yaml \
    -f compose.state-cutover.yaml -f "$current" --profile state-cutover stop app game
else
  docker compose -f compose.yaml -f "$current" stop app game
fi

if [[ "$state_cutover" == "true" ]]; then
  "${deployment[@]}" up -d --no-deps state
fi

if [[ "$state_cutover" == "true" && "$current_state_cutover" != "true" ]]; then
  activation_command_id="${CANNABEATS_STATE_ACTIVATION_COMMAND_ID:-}"
  activation_source_digest="${CANNABEATS_STATE_SOURCE_DIGEST:-}"
  activation_candidate_digest="${CANNABEATS_STATE_CANDIDATE_DIGEST:-}"
  if [[ "${CANNABEATS_STATE_ACTIVATE:-false}" != "true" \
      || ! "$activation_command_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ \
      || ! "$activation_source_digest" =~ ^[0-9a-f]{64}$ \
      || ! "$activation_candidate_digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "First state cutover requires reviewed activation command and migration digests" >&2
    false
  fi
  "${deployment[@]}" exec -T state node -e '
    const fs = require("node:fs");
    const [commandId,source,candidate,generation,protocol,epoch] = process.argv.slice(1);
    const token = fs.readFileSync(process.env.CANNABEATS_STATE_ACTIVATION_TOKEN_FILE,"utf8").trim();
    fetch("http://127.0.0.1:3010/v1/admin/activate",{
      method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
      body:JSON.stringify({commandId,expectedSourceDigest:source,expectedCandidateDigest:candidate,
        expectedSchemaGeneration:Number(generation),expectedProtocolVersion:Number(protocol),releaseEpoch:epoch}),
    }).then(async response=>{ if(!response.ok) throw new Error(`activation status ${response.status}`); })
      .catch(error=>{ console.error(error.message);process.exit(1); });
  ' "$activation_command_id" "$activation_source_digest" "$activation_candidate_digest" \
    "$state_schema_min" "$state_protocol_min" "$release_epoch"
fi

if [[ "$state_cutover" == "true" ]]; then
  state_ready="$(state_readiness_json)"
  deployed_state_generation="$(state_readiness_field "$state_ready" schemaGeneration)"
  deployed_state_protocol="$(state_readiness_field "$state_ready" protocolVersion)"
  deployed_state_http="$(state_readiness_field "$state_ready" httpContractVersion)"
  deployed_state_epoch="$(state_readiness_field "$state_ready" authority.release_epoch)"
  if ! state_contract_in_range "$deployed_state_generation" "$deployed_state_protocol" \
      "$state_schema_min" "$state_schema_max" "$state_protocol_min" "$state_protocol_max" \
      || [[ "$deployed_state_http" != "$state_http_contract" \
        || "$deployed_state_epoch" != "$release_epoch" ]]; then
    echo "Deployed State contract does not match candidate release metadata" >&2
    false
  fi
fi

node "$state_tool" promote "$release_directory" "$candidate" "$application_version"
record_promoted=true
if [[ "${CANNABEATS_TEST_KILL_AFTER_RELEASE_RECORD:-false}" == "true" ]]; then kill -KILL "$$"; fi
if [[ "$state_cutover" == "true" ]]; then
  "${deployment[@]}" up -d --no-deps app game
else
  "${deployment[@]}" up -d --no-deps app game
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
    echo "Readiness failed for $endpoint" >&2
    false
  fi
done

if [[ "$state_cutover" == "true" ]]; then
  state_ready="$(state_readiness_json)"
  deployed_state_generation="$(state_readiness_field "$state_ready" schemaGeneration)"
  deployed_state_protocol="$(state_readiness_field "$state_ready" protocolVersion)"
  deployed_state_http="$(state_readiness_field "$state_ready" httpContractVersion)"
  deployed_state_epoch="$(state_readiness_field "$state_ready" authority.release_epoch)"
  if ! state_contract_in_range "$deployed_state_generation" "$deployed_state_protocol" \
      "$state_schema_min" "$state_schema_max" "$state_protocol_min" "$state_protocol_max" \
      || [[ "$deployed_state_http" != "$state_http_contract" \
        || "$deployed_state_epoch" != "$release_epoch" ]]; then
    echo "Deployed State contract does not match candidate release metadata" >&2
    false
  fi
fi

deployed_database_schema="$(database_schema_version "$candidate")"
expected_deployed_schema="$candidate_schema_target"
if (( current_database_schema > expected_deployed_schema )); then
  expected_deployed_schema="$current_database_schema"
fi
if [[ "$deployed_database_schema" != "$expected_deployed_schema" ]]; then
  echo "Candidate readiness reported schema $deployed_database_schema; expected non-downgraded schema $expected_deployed_schema" >&2
  false
fi

if [[ "$state_cutover" == "true" ]]; then
  state_ready="$(state_readiness_json)"
  admission_open="$(state_readiness_field "$state_ready" authority.admission.open)"
  admission_generation="$(state_readiness_field "$state_ready" authority.admission.generation)"
  if [[ "$admission_open" != "true" ]]; then
    state_set_admission true "$admission_generation" >/dev/null
  fi
  state_ready="$(state_readiness_json)"
  if [[ "$(state_readiness_field "$state_ready" authority.admission.open)" != "true" ]]; then
    echo "Release record was promoted, but State admission remains closed" >&2
    exit 1
  fi
fi
trap - ERR
echo "Released CannaBeats application=${application_version} catalog=${catalog_version} schema=${deployed_database_schema}"
