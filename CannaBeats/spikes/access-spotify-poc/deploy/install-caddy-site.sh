#!/usr/bin/env bash
set -Eeuo pipefail

expected_checksum="${1:?expected Caddyfile SHA-256 is required}"
candidate="${2:-/etc/caddy/Caddyfile.cannabeats-candidate}"
active_config="/etc/caddy/Caddyfile"

actual_checksum="$(sha256sum "$active_config" | awk '{print $1}')"
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  echo "Caddyfile changed after the baseline was captured; refusing to overwrite it." >&2
  exit 2
fi

caddy validate --config "$candidate"
backup="$(mktemp /etc/caddy/Caddyfile.pre-cannabeats.XXXXXX)"
cp --preserve=mode,ownership,timestamps "$active_config" "$backup"

rollback() {
  echo "CannaBeats Caddy check failed; restoring $backup" >&2
  install -o root -g root -m 0644 "$backup" "$active_config"
  caddy validate --config "$active_config"
  systemctl reload caddy
}
trap rollback ERR

install -o root -g root -m 0644 "$candidate" "$active_config"
caddy validate --config "$active_config"
systemctl reload caddy
systemctl is-active --quiet caddy
curl --fail --silent --show-error https://office.vw-inc.com/ >/dev/null

trap - ERR
echo "backup=$backup"
echo "active_checksum=$(sha256sum "$active_config" | awk '{print $1}')"
