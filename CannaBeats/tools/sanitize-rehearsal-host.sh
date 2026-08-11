#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  sanitize-rehearsal-host.sh --role application|managed-source \
    --expected-hostname HOSTNAME [--source-id UUID] [--execute]

Prepare a disposable CannaBeats rehearsal host for capture as a reusable base
image. The default is a dry run. --execute requires root and an exact hostname
match. The application role accepts --source-id so it can revoke the disposable
managed-source registration before deleting the rehearsal database.

For automated tests only, --test-root ABSOLUTE_DIRECTORY confines filesystem
changes to that directory and suppresses host service commands.
EOF
}

die() {
  printf 'sanitize-rehearsal-host: %s\n' "$*" >&2
  exit 1
}

role=''
expected_hostname=''
source_id=''
execute=0
test_root=''

while (($#)); do
  case "$1" in
    --role)
      (($# >= 2)) || die '--role requires a value'
      role=$2
      shift 2
      ;;
    --expected-hostname)
      (($# >= 2)) || die '--expected-hostname requires a value'
      expected_hostname=$2
      shift 2
      ;;
    --source-id)
      (($# >= 2)) || die '--source-id requires a value'
      source_id=$2
      shift 2
      ;;
    --execute)
      execute=1
      shift
      ;;
    --test-root)
      (($# >= 2)) || die '--test-root requires a value'
      test_root=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

case "$role" in
  application|managed-source) ;;
  '') die '--role is required' ;;
  *) die '--role must be application or managed-source' ;;
esac

[[ -n "$expected_hostname" ]] || die '--expected-hostname is required'
[[ "$expected_hostname" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] \
  || die '--expected-hostname contains invalid characters'

if [[ -n "$source_id" ]]; then
  [[ "$role" == application ]] || die '--source-id is valid only for the application role'
  [[ "$source_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || die '--source-id must be a lowercase UUID'
fi

if [[ -n "$test_root" ]]; then
  [[ "$test_root" == /* ]] || die '--test-root must be absolute'
  [[ "$test_root" != / ]] || die '--test-root cannot be /'
  mkdir -p "$test_root"
  test_root=$(cd "$test_root" && pwd -P)
fi

if ((execute)) && [[ -z "$test_root" ]]; then
  [[ $(id -u) -eq 0 ]] || die '--execute must run as root'
  actual_hostname=$(hostname)
  [[ "$actual_hostname" == "$expected_hostname" ]] \
    || die "hostname mismatch: expected $expected_hostname, found $actual_hostname"
fi

root_path() {
  local logical=$1
  [[ "$logical" == /* ]] || die "internal path is not absolute: $logical"
  if [[ -n "$test_root" ]]; then
    printf '%s%s\n' "$test_root" "$logical"
  else
    printf '%s\n' "$logical"
  fi
}

show_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

host_command() {
  show_command "$@"
  if ((execute)) && [[ -z "$test_root" ]]; then
    "$@"
  fi
}

secure_unlink() {
  local target=$1
  if [[ -L "$target" ]]; then
    unlink "$target"
  elif [[ -f "$target" ]]; then
    chmod u+w "$target" 2>/dev/null || true
    if command -v shred >/dev/null 2>&1; then
      shred -n 1 -z -u -- "$target"
    else
      : > "$target"
      rm -f -- "$target"
    fi
  else
    rm -f -- "$target"
  fi
}

wipe_logical_path() {
  local logical=$1
  local target
  target=$(root_path "$logical")
  printf 'wipe %s\n' "$logical"
  ((execute)) || return 0
  [[ -e "$target" || -L "$target" ]] || return 0
  if [[ -d "$target" && ! -L "$target" ]]; then
    while IFS= read -r -d '' file; do
      secure_unlink "$file"
    done < <(find "$target" -xdev -type f -print0)
    find "$target" -xdev -depth -delete
  else
    secure_unlink "$target"
  fi
}

wipe_rehearsal_temp() {
  local temp_root target logical
  temp_root=$(root_path /var/tmp)
  printf 'wipe /var/tmp/cannabeats-* and /var/tmp/p2e-*\n'
  ((execute)) || return 0
  [[ -d "$temp_root" ]] || return 0
  while IFS= read -r -d '' target; do
    logical=${target#"$test_root"}
    if [[ -d "$target" && ! -L "$target" ]]; then
      while IFS= read -r -d '' file; do
        secure_unlink "$file"
      done < <(find "$target" -xdev -type f -print0)
      find "$target" -xdev -depth -delete
    else
      secure_unlink "$target"
    fi
    printf 'wiped %s\n' "$logical"
  done < <(find "$temp_root" -xdev -mindepth 1 -maxdepth 1 \
    \( -name 'cannabeats-*' -o -name 'p2e-*' \) -print0)
}

reset_service_home() {
  local logical=$1 owner=$2 group=$3
  local target
  wipe_logical_path "$logical"
  ((execute)) || return 0
  target=$(root_path "$logical")
  if [[ -n "$test_root" ]]; then
    mkdir -p "$target"
    chmod 0700 "$target"
  else
    install -d -o "$owner" -g "$group" -m 0700 "$target"
  fi
}

remove_rehearsal_line() {
  local logical=$1 pattern=$2
  local target temporary
  target=$(root_path "$logical")
  printf 'remove marker %s from %s\n' "$pattern" "$logical"
  ((execute)) || return 0
  [[ -f "$target" ]] || return 0
  temporary="${target}.sanitize.$$"
  grep -Fv -- "$pattern" "$target" > "$temporary" || true
  chmod --reference="$target" "$temporary" 2>/dev/null || true
  mv -f -- "$temporary" "$target"
}

disable_unit_if_present() {
  local unit=$1
  if [[ -z "$test_root" ]] && systemctl cat "$unit" >/dev/null 2>&1; then
    host_command systemctl disable --now "$unit"
  else
    show_command systemctl disable --now "$unit"
  fi
}

stop_unit_if_present() {
  local unit=$1
  if [[ -z "$test_root" ]] && systemctl cat "$unit" >/dev/null 2>&1; then
    host_command systemctl stop "$unit"
  else
    show_command systemctl stop "$unit"
  fi
}

remove_container_if_present() {
  local container=$1
  show_command docker container rm --force "$container"
  if ((execute)) && [[ -z "$test_root" ]] \
    && docker container inspect "$container" >/dev/null 2>&1; then
    docker container rm --force "$container"
  fi
}

remove_volume_if_present() {
  local volume=$1
  show_command docker volume rm "$volume"
  if ((execute)) && [[ -z "$test_root" ]] \
    && docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume rm "$volume"
  fi
}

sanitize_application() {
  local compose_dir=/opt/cannabeats/CannaBeats/spikes/access-spotify-poc

  if [[ -n "$source_id" ]]; then
    show_command docker compose --project-directory "$compose_dir" exec -T app \
      node cli.mjs managed-source disable --source-id "$source_id"
    if ((execute)) && [[ -z "$test_root" ]]; then
      docker compose --project-directory "$compose_dir" exec -T app \
        node cli.mjs managed-source disable --source-id "$source_id"
    fi
  fi

  disable_unit_if_present cannabeats-backup.timer
  disable_unit_if_present cannabeats-operations-check.timer
  stop_unit_if_present cannabeats-p2e-game-proxy.service
  remove_container_if_present cannabeats-access-poc
  remove_container_if_present cannabeats-game
  remove_container_if_present cannabeats-p2e-unrelated-sentinel
  wipe_logical_path /var/lib/docker/volumes/cannabeats_poc_data/_data
  if ((execute)); then
    install -d -m 0755 "$(root_path /var/lib/docker/volumes/cannabeats_poc_data/_data)"
  fi
  remove_volume_if_present cannabeats_poc_data
  wipe_logical_path /var/lib/docker/volumes/cannabeats_poc_data

  wipe_logical_path "$compose_dir/secrets"
  wipe_logical_path "$compose_dir/backups"
  wipe_logical_path "$compose_dir/.env"
  wipe_logical_path /etc/cannabeats/backup.env
  wipe_logical_path /var/lib/cannabeats
  wipe_logical_path /root/p2e-game-control.json
  wipe_logical_path /etc/systemd/system/docker.service.d/p2e-proxy.conf
  wipe_rehearsal_temp
}

sanitize_managed_source() {
  local unit
  for unit in \
    cannabeats-vnc.service \
    cannabeats-source-controller.service \
    cannabeats-source-agent.service \
    cannabeats-browser.service \
    cannabeats-audio.service \
    cannabeats-display.service; do
    disable_unit_if_present "$unit"
  done
  stop_unit_if_present cannabeats-relay-push.service
  stop_unit_if_present cannabeats-p2e-relay-proxy.service

  host_command tailscale logout
  stop_unit_if_present tailscaled.service
  host_command systemctl enable tailscaled.service
  host_command systemctl disable --now privoxy.service

  wipe_logical_path /etc/cannabeats-managed-source/source-token
  wipe_logical_path /etc/cannabeats-managed-source/relay-ingest-token
  wipe_logical_path /etc/cannabeats-managed-source/vnc.pass
  wipe_logical_path /etc/cannabeats-managed-source/source.env
  reset_service_home /var/lib/cannabeats-source cannabeats-source cannabeats-source
  reset_service_home /var/lib/cannabeats-relay cannabeats-relay cannabeats-relay
  reset_service_home /var/lib/cannabeats-controller cannabeats-controller cannabeats-controller
  wipe_logical_path /var/lib/tailscale
  if ((execute)); then
    local tailscale_state
    tailscale_state=$(root_path /var/lib/tailscale)
    if [[ -n "$test_root" ]]; then
      install -d -m 0700 "$tailscale_state"
    else
      install -d -o root -g root -m 0700 "$tailscale_state"
    fi
  fi
  wipe_logical_path /etc/systemd/system/cannabeats-browser.service.d/p2e-proxy.conf
  wipe_logical_path /etc/systemd/system/tailscaled.service.d/p2e-proxy.conf
  wipe_logical_path /etc/apt/apt.conf.d/99cannabeats-p2e-proxy
  remove_rehearsal_line /etc/hosts ' # cannabeats-p2e-relay'
  remove_rehearsal_line /etc/privoxy/config 'forward-socks5t / 127.0.0.1:1080 .'
  wipe_rehearsal_temp
}

sanitize_common_host_identity() {
  wipe_logical_path /root/.ssh
  wipe_logical_path /root/.bash_history
  printf 'wipe /etc/ssh/ssh_host_*\n'
  if ((execute)); then
    local ssh_root target
    ssh_root=$(root_path /etc/ssh)
    if [[ -d "$ssh_root" ]]; then
      while IFS= read -r -d '' target; do
        secure_unlink "$target"
      done < <(find "$ssh_root" -xdev -mindepth 1 -maxdepth 1 \
        -name 'ssh_host_*' -print0)
    fi
  fi

  host_command journalctl --rotate
  host_command journalctl --vacuum-time=1s
  host_command cloud-init clean --logs --machine-id
  host_command systemctl daemon-reload
  host_command sync
  host_command fstrim --all --verbose
}

printf 'Mode: %s\n' "$([[ $execute -eq 1 ]] && printf execute || printf dry-run)"
printf 'Role: %s\n' "$role"
printf 'Expected hostname: %s\n' "$expected_hostname"
[[ -z "$test_root" ]] || printf 'Test root: %s\n' "$test_root"

case "$role" in
  application) sanitize_application ;;
  managed-source) sanitize_managed_source ;;
esac
sanitize_common_host_identity

if ((execute)); then
  printf 'Sanitization complete. Verify the manifest before powering off and imaging.\n'
else
  printf 'Dry run complete. No changes were made. Re-run with --execute after review.\n'
fi
