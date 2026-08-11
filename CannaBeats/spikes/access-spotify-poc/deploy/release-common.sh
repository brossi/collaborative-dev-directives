#!/usr/bin/env bash

acquire_release_lock() {
  local requested_lock="$release_directory/operation.lock"
  if ! mkdir -- "$requested_lock" 2>/dev/null; then
    echo "Another CannaBeats release or rollback is active; inspect $requested_lock" >&2
    return 1
  fi
  operation_lock="$requested_lock"
  printf 'pid=%s\nstarted=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$operation_lock/owner"
}

release_lock_cleanup() {
  if [[ -n "${operation_lock:-}" && -d "$operation_lock" ]]; then
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
      const db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
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
EOF
  cat -- "$source" >> "$destination"
  chmod 0644 "$destination"
}
