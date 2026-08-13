#!/usr/bin/env bash

acquire_release_lock() {
  local requested_lock="$release_directory/operation.lock"
  operation_lock="$requested_lock"
  if command -v flock >/dev/null 2>&1; then
    if [[ -d "$requested_lock" ]]; then
      echo "Another CannaBeats release, rollback, or coordinated backup is active; inspect $requested_lock" >&2
      return 1
    fi
    exec {operation_lock_fd}>"$requested_lock"
    if ! flock -n "$operation_lock_fd"; then
      exec {operation_lock_fd}>&-
      unset operation_lock_fd
      echo "Another CannaBeats release, rollback, or coordinated backup is active; inspect $requested_lock" >&2
      return 1
    fi
    operation_lock_mode="flock"
  else
    local owner_file="$requested_lock/owner" owner_pid owner_started live_started live_status
    if ! mkdir -- "$requested_lock" 2>/dev/null; then
      owner_pid="$(awk -F= '$1=="pid" { print $2; exit }' "$owner_file" 2>/dev/null || true)"
      owner_started="$(awk -F= '$1=="process-start" { sub(/^[^=]*=/,""); print; exit }' \
        "$owner_file" 2>/dev/null || true)"
      live_started="$(ps -o lstart= -p "$owner_pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
      live_status="$(ps -o stat= -p "$owner_pid" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
      if [[ -n "$owner_pid" && -n "$owner_started" ]] \
          && [[ "$live_started" != "$owner_started" || "$live_status" == Z* ]]; then
        rm -f -- "$owner_file"
        rmdir -- "$requested_lock" 2>/dev/null || true
      fi
      if ! mkdir -- "$requested_lock" 2>/dev/null; then
        echo "Another CannaBeats release, rollback, or coordinated backup is active; inspect $requested_lock" >&2
        return 1
      fi
    fi
    operation_lock_mode="directory"
    printf 'pid=%s\nprocess-start=%s\ncreated-at=%s\n' "$$" \
      "$(ps -o lstart= -p "$$" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$owner_file"
  fi
}

release_lock_cleanup() {
  if [[ "${operation_lock_mode:-}" == "flock" && -n "${operation_lock_fd:-}" ]]; then
    flock -u "$operation_lock_fd" 2>/dev/null || true
    exec {operation_lock_fd}>&-
  elif [[ "${operation_lock_mode:-}" == "directory" && -n "${operation_lock:-}" ]]; then
    rm -f -- "$operation_lock/owner"
    rmdir -- "$operation_lock" 2>/dev/null || true
  fi
}

schema_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

validate_schema_contract() {
  local minimum="$1" maximum="$2" target="$3" label="$4"
  if ! schema_integer "$minimum" || ! schema_integer "$maximum" || ! schema_integer "$target" \
      || (( minimum > target || target > maximum )); then
    echo "$label schema contract is invalid: min=$minimum target=$target max=$maximum" >&2
    return 1
  fi
}

record_schema_value() {
  local record="$1" key="$2"
  awk -v wanted="  $key:" '
    index($0, wanted) == 1 {
      value = substr($0, length(wanted) + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      print value
      exit
    }
  ' "$record"
}

record_release_value() {
  record_schema_value "$1" "$2"
}

load_record_state_contract() {
  local record="$1" label="$2"
  local state_cutover_count
  state_cutover_count="$(awk '/^  state-cutover:/ { count++ } END { print count+0 }' "$record")"
  if [[ "$state_cutover_count" != "1" ]]; then
    echo "$label state contract must contain exactly one state-cutover value" >&2
    return 1
  fi
  record_state_cutover="$(record_release_value "$record" state-cutover)"
  if [[ "$record_state_cutover" == "false" ]]; then
    record_state_schema_min=0
    record_state_schema_max=0
    record_state_protocol_min=0
    record_state_protocol_max=0
    record_state_http_contract=0
    record_release_epoch=""
    return
  fi
  if [[ "$record_state_cutover" != "true" ]]; then
    echo "$label state-cutover value must be true or false" >&2
    return 1
  fi
  record_state_schema_min="$(record_release_value "$record" state-schema-min-generation)"
  record_state_schema_max="$(record_release_value "$record" state-schema-max-generation)"
  record_state_protocol_min="$(record_release_value "$record" state-protocol-min-version)"
  record_state_protocol_max="$(record_release_value "$record" state-protocol-max-version)"
  record_state_http_contract="$(record_release_value "$record" state-http-contract-version)"
  record_release_epoch="$(record_release_value "$record" release-epoch)"
  if ! schema_integer "$record_state_schema_min" || ! schema_integer "$record_state_schema_max" \
      || ! schema_integer "$record_state_protocol_min" || ! schema_integer "$record_state_protocol_max" \
      || ! schema_integer "$record_state_http_contract" \
      || (( record_state_schema_min > record_state_schema_max \
        || record_state_protocol_min > record_state_protocol_max \
        || record_state_http_contract < 1 )) \
      || [[ ! "$record_release_epoch" =~ ^[A-Za-z0-9._:-]{1,160}$ ]]; then
    echo "$label state contract is invalid" >&2
    return 1
  fi
}

state_contract_in_range() {
  local generation="$1" protocol="$2" minimum_generation="$3" maximum_generation="$4"
  local minimum_protocol="$5" maximum_protocol="$6"
  schema_in_range "$generation" "$minimum_generation" "$maximum_generation" \
    && schema_in_range "$protocol" "$minimum_protocol" "$maximum_protocol"
}

state_readiness_json() {
  curl --fail --silent --show-error "http://127.0.0.1:${CANNABEATS_STATE_PORT:-3010}/ready"
}

state_readiness_field() {
  local json="$1" expression="$2"
  node -e '
    const value = JSON.parse(process.argv[1]);
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (current !== undefined && current !== null) process.stdout.write(String(current));
  ' "$json" "$expression"
}

state_set_admission() {
  local open="$1" generation="$2"
  local token_file="${STATE_OPERATOR_TOKEN_HOST_FILE:-./secrets/state-operator-token}"
  local token command_id body
  token="$(tr -d '\r\n' < "$token_file")"
  command_id="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  body="$(printf '{"commandId":"%s","open":%s,"expectedGeneration":%s}' \
    "$command_id" "$open" "$generation")"
  curl --fail --silent --show-error --max-time 30 --request POST \
    --header 'Content-Type: application/json' --data "$body" \
    --config - "http://127.0.0.1:${CANNABEATS_STATE_PORT:-3010}/v1/admin/admission" <<EOF
header = "Authorization: Bearer $token"
EOF
}

load_record_schema_contract() {
  local record="$1" label="$2"
  record_schema_min="$(record_schema_value "$record" schema-min-version)"
  record_schema_max="$(record_schema_value "$record" schema-max-version)"
  record_schema_target="$(record_schema_value "$record" schema-target-version)"
  validate_schema_contract "$record_schema_min" "$record_schema_max" "$record_schema_target" "$label"
}

schema_in_range() {
  local version="$1" minimum="$2" maximum="$3"
  schema_integer "$version" && (( version >= minimum && version <= maximum ))
}

database_schema_version() {
  local override="$1" version
  version="$(docker compose -f compose.yaml -f "$override" --profile operations run --rm --no-deps \
    --entrypoint node backup -e '
      const { DatabaseSync } = require("node:sqlite");
      const path = `file:${process.env.DATABASE_PATH}?immutable=1`;
      const db = new DatabaseSync(path, { readOnly: true });
      try { process.stdout.write(String(db.prepare("PRAGMA user_version").get().user_version)); }
      finally { db.close(); }
    ')"
  if ! schema_integer "$version"; then
    echo "Could not determine the CannaBeats database schema version" >&2
    return 1
  fi
  printf '%s\n' "$version"
}

load_bootstrap_schema_contract() {
  bootstrap_schema_min="${CANNABEATS_BOOTSTRAP_SCHEMA_MIN_VERSION:?Set the reviewed bootstrap schema minimum}"
  bootstrap_schema_max="${CANNABEATS_BOOTSTRAP_SCHEMA_MAX_VERSION:?Set the reviewed bootstrap schema maximum}"
  bootstrap_schema_target="${CANNABEATS_BOOTSTRAP_SCHEMA_TARGET_VERSION:?Set the observed bootstrap schema version}"
  validate_schema_contract \
    "$bootstrap_schema_min" "$bootstrap_schema_max" "$bootstrap_schema_target" bootstrap
}

annotate_legacy_override() {
  local source="$1" destination="$2"
  cat > "$destination" <<EOF
x-cannabeats-release:
  schema-min-version: $bootstrap_schema_min
  schema-max-version: $bootstrap_schema_max
  schema-target-version: $bootstrap_schema_target
  state-cutover: false
EOF
  cat -- "$source" >> "$destination"
  chmod 0644 "$destination"
}
