#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi
if [[ $# -ne 1 || ! -f $1 || -L $1 ]]; then
  echo "Usage: $0 PREPARED_X11VNC_PASSWORD_FILE" >&2
  exit 1
fi
if [[ ! -s $1 || $(stat -c %s -- "$1") -gt 4096 ]]; then
  echo "The prepared x11vnc password file is invalid" >&2
  exit 1
fi
if ! id cannabeats-source >/dev/null 2>&1; then
  echo "Install the managed-source runtime first" >&2
  exit 1
fi

target=/etc/cannabeats-managed-source/vnc.pass
temporary=/etc/cannabeats-managed-source/.vnc.pass.new
trap 'rm -f -- "$temporary"' EXIT
install -o cannabeats-source -g cannabeats-source -m 0400 -- "$1" "$temporary"
mv -f -- "$temporary" "$target"
trap - EXIT

systemctl enable --now cannabeats-vnc.service
echo "Installed the loopback VNC password file and started cannabeats-vnc.service."
