#!/usr/bin/env bash
set -Eeuo pipefail

root="${CANNABEATS_INSTALL_ROOT:-}"
if [[ -z "$root" && "${EUID:-$(id -u)}" != 0 ]]; then
  printf '%s\n' host_initialization_privilege_required >&2
  exit 1
fi
data_dir="$root/var/lib/cannabeats"
caddy_root="$root/var/lib/cannabeats-caddy"
backup_dir="$root/var/backups/cannabeats/sqlite"
releases_dir="$root/opt/cannabeats/releases"
secrets_dir="$root/etc/cannabeats/secrets"
caddy_data_dir="$caddy_root/data"
caddy_config_dir="$caddy_root/config"
lock_parent="$root/run/lock"
lock_directory="$lock_parent/cannabeats-operations.lock"
temporary=""
lock_acquired=false

finite_fail() {
  printf '%s\n' "host_initialization_$1" >&2
  exit 1
}

if [[ -z "$root" ]]; then
  install -d -m 0755 "$lock_parent"
  exec 9>"$lock_directory"
  flock --nonblock 9 || finite_fail busy
fi

for path in "$data_dir" "$caddy_root" "$backup_dir" "$releases_dir" "$secrets_dir" \
  "$caddy_data_dir" "$caddy_config_dir" "$lock_parent"; do
  if [[ -L "$path" || ( -e "$path" && ! -d "$path" ) ]]; then finite_fail path_conflict; fi
done

install -d -m 0755 "$lock_parent"
if [[ -n "$root" ]]; then
  mkdir -m 0700 "$lock_directory" 2>/dev/null || finite_fail busy
  lock_acquired=true
fi
cleanup() {
  [[ -z "$temporary" || ! -e "$temporary" ]] || rm -- "$temporary"
  [[ "$lock_acquired" != true ]] || rmdir "$lock_directory" 2>/dev/null || true
}
trap cleanup EXIT

install -d -m 0750 "$data_dir" "$backup_dir" "$releases_dir"
install -d -m 0700 "$secrets_dir"
install -d -m 0750 "$caddy_data_dir" "$caddy_config_dir"
if [[ "${EUID:-$(id -u)}" == 0 ]]; then
  chown 10001:10001 "$data_dir"
  chown 0:0 "$backup_dir" "$releases_dir" "$secrets_dir" \
    "$caddy_data_dir" "$caddy_config_dir"
fi

valid_token() {
  [[ -f "$1" && ! -L "$1" ]] || return 1
  [[ "$(stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1")" == 640 ]] || return 1
  local expected_uid expected_gid actual_uid actual_gid
  if [[ -z "$root" ]]; then expected_uid=0; expected_gid=10001
  else expected_uid="$(id -u)"; expected_gid="$(id -g)"
  fi
  actual_uid="$(stat -f '%u' "$1" 2>/dev/null || stat -c '%u' "$1")"
  actual_gid="$(stat -f '%g' "$1" 2>/dev/null || stat -c '%g' "$1")"
  [[ "$actual_uid" == "$expected_uid" && "$actual_gid" == "$expected_gid" ]] || return 1
  local value
  value="$(<"$1")"
  [[ "$value" =~ ^[A-Za-z0-9_-]{43}$ ]]
}

create_or_preserve_token() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    valid_token "$path" || finite_fail secret_conflict
    return
  fi
  temporary="$(mktemp "$secrets_dir/.token.XXXXXX")"
  chmod 0640 "$temporary"
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' >"$temporary"
  [[ "$(wc -c <"$temporary" | tr -d ' ')" == 43 ]] || finite_fail secret_generation
  if [[ "${EUID:-$(id -u)}" == 0 ]]; then chown 0:10001 "$temporary"; fi
  mv "$temporary" "$path" || finite_fail secret_conflict
  temporary=""
}

ingest="$secrets_dir/relay-ingest-token"
listen="$secrets_dir/relay-listen-token"
operator="$secrets_dir/operator-token"
create_or_preserve_token "$ingest"
create_or_preserve_token "$listen"
create_or_preserve_token "$operator"
[[ "$(<"$ingest")" != "$(<"$listen")" \
  && "$(<"$ingest")" != "$(<"$operator")" \
  && "$(<"$listen")" != "$(<"$operator")" ]] || finite_fail secret_conflict

printf '%s\n' host_initialization_ready
