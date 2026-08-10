#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location \
  https://dl.google.com/linux/linux_signing_key.pub \
  | gpg --dearmor --yes --output /etc/apt/keyrings/google-chrome.gpg
printf '%s\n' \
  'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
  > /etc/apt/sources.list.d/google-chrome.list

curl --fail --silent --show-error --location \
  https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
  --output /etc/apt/keyrings/tailscale-archive-keyring.gpg
printf '%s\n' \
  'deb [signed-by=/etc/apt/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main' \
  > /etc/apt/sources.list.d/tailscale.list

apt-get update
apt-get install --yes --no-install-recommends \
  alsa-utils \
  dbus-x11 \
  google-chrome-stable \
  libportaudio2 \
  openbox \
  pulseaudio \
  pulseaudio-utils \
  python3-venv \
  sudo \
  tailscale \
  x11vnc \
  xvfb

if ! getent group cannabeats-audio >/dev/null 2>&1; then
  groupadd --system cannabeats-audio
fi
if ! id cannabeats-source >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/cannabeats-source \
    --shell /usr/sbin/nologin cannabeats-source
fi
if ! id cannabeats-relay >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/cannabeats-relay \
    --shell /usr/sbin/nologin cannabeats-relay
fi
if ! id cannabeats-controller >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/cannabeats-controller \
    --shell /usr/sbin/nologin cannabeats-controller
fi
usermod --append --groups cannabeats-audio cannabeats-source
usermod --append --groups cannabeats-audio cannabeats-relay
chmod 0700 /var/lib/cannabeats-source
chmod 0700 /var/lib/cannabeats-relay
chmod 0700 /var/lib/cannabeats-controller
install -d -o root -g root -m 0755 /etc/cannabeats-managed-source

if [[ ! -e /swapfile ]]; then
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '%s\n' '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -m 0644 infra/cannabeats-display.service /etc/systemd/system/
install -m 0644 infra/cannabeats-audio.service /etc/systemd/system/
install -m 0644 infra/cannabeats-browser.service /etc/systemd/system/
install -m 0644 infra/cannabeats-vnc.service /etc/systemd/system/
install -m 0644 infra/cannabeats-source-agent.service /etc/systemd/system/
install -m 0644 infra/cannabeats-source-controller.service /etc/systemd/system/
install -m 0644 infra/cannabeats-relay-push.service /etc/systemd/system/
install -o root -g root -m 0440 infra/cannabeats-controller.sudoers /etc/sudoers.d/cannabeats-controller
visudo -cf /etc/sudoers.d/cannabeats-controller

systemctl daemon-reload
systemctl enable --now tailscaled
systemctl enable --now \
  cannabeats-display.service \
  cannabeats-audio.service \
  cannabeats-source-agent.service \
  cannabeats-source-controller.service \
  cannabeats-browser.service \
  cannabeats-vnc.service

echo "Runtime installed. Enroll Tailscale with:"
echo "  tailscale up --ssh --hostname=cannabeats-audio-source-poc"
