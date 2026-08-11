#!/usr/bin/env bash
set -Eeuo pipefail

unit="${1:-}"
alert_directory="${CANNABEATS_ALERT_DIRECTORY:-/var/lib/cannabeats/alerts}"
systemctl_command="${CANNABEATS_SYSTEMCTL:-/usr/bin/systemctl}"

if [[ ! "$unit" =~ ^[A-Za-z0-9@_.:-]+\.service$ ]]; then
  echo "A valid systemd service unit is required" >&2
  exit 2
fi

install -d -m 0700 -- "$alert_directory"
result="$("$systemctl_command" show "$unit" --property=Result --value 2>/dev/null || true)"
exit_status="$("$systemctl_command" show "$unit" --property=ExecMainStatus --value 2>/dev/null || true)"
active_state="$("$systemctl_command" show "$unit" --property=ActiveState --value 2>/dev/null || true)"
result="${result:-unknown}"
exit_status="${exit_status:-unknown}"
active_state="${active_state:-unknown}"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
target="$alert_directory/$unit.failed"
temporary="$(mktemp "$alert_directory/.alert.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT

{
  echo "unit=$unit"
  echo "detectedAt=$timestamp"
  echo "result=$result"
  echo "exitStatus=$exit_status"
  echo "activeState=$active_state"
  echo "inspect=journalctl -u $unit --since today --no-pager"
  echo "retry=systemctl start $unit"
  echo "clear=rm -f $target"
} > "$temporary"
chmod 0600 "$temporary"
mv -f -- "$temporary" "$target"
trap - EXIT

printf '{"timestamp":"%s","level":"error","service":"operations-scheduler","event":"scheduler.unit_failed","message":"Scheduled CannaBeats operation failed","reasonCode":"unit_failed","unit":"%s","status":"%s"}\n' \
  "$timestamp" "$unit" "$exit_status" >&2
