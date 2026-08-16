#!/bin/sh
set -eu

: "${S2F_HOST_ROLE:?Set application or source}"
: "${S2F_ALLOWLISTED_PIDS_JSON:?Set the encrypted-manifest PID identity map}"

case "$S2F_HOST_ROLE" in
  application|source) ;;
  *) printf '%s\n' configuration_invalid >&2; exit 1 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' configuration_invalid >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /usr/bin/python3 "$script_dir/s2f-host-sample.py" --host-role "$S2F_HOST_ROLE"
