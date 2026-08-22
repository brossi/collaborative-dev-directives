#!/usr/bin/env bash
set -Eeuo pipefail

readonly NODE_VERSION="24.7.0"
readonly NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
readonly NODE_SHA256="2fb405154d017f04d21b3d2273cc1cdfa824cfeffbd4225976454d06d5e381a4"
readonly NODE_BINARY_SHA256="0a60ee85e22e52daede22c3cd27d3185becbdab180cf3c3c935130ce7b117d45"
readonly NODE_ORIGIN="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
readonly RECEIPT_PATH="/opt/cannabeats/install-receipt"

fail() {
  printf '%s\n' "production_host_install_$1" >&2
  exit 1
}

[[ "${EUID:-$(id -u)}" == 0 ]] || fail privilege_required
[[ "$(uname -m)" == x86_64 ]] || fail unsupported_architecture
[[ -r /etc/os-release ]] || fail unsupported_system
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || fail unsupported_system

repository_root="${CANNABEATS_REPOSITORY_ROOT:-}"
source_revision="${CANNABEATS_SOURCE_REVISION:-}"
[[ -n "$repository_root" && -d "$repository_root/.git" ]] || fail source_invalid
[[ "$source_revision" =~ ^[0-9a-f]{40}$ ]] || fail revision_invalid
[[ "$(GIT_NO_REPLACE_OBJECTS=1 git -C "$repository_root" \
  rev-parse "$source_revision^{commit}" 2>/dev/null)" \
  == "$source_revision" ]] || fail revision_invalid
GIT_NO_REPLACE_OBJECTS=1 git -C "$repository_root" \
  cat-file -e "$source_revision:CannaBeats/release/scripts" \
  2>/dev/null || fail source_invalid

install -d -m 0755 /run/lock || fail lock_unavailable
exec 9>/run/lock/cannabeats-install.lock
flock --nonblock 9 || fail busy

temporary="$(mktemp -d)" || fail dependency_install
operator_staging=""
node_staging=""
cleanup() {
  rm -rf -- "$temporary" 2>/dev/null || true
  [[ -z "$operator_staging" || ! -e "$operator_staging" ]] \
    || rm -rf -- "$operator_staging" 2>/dev/null || true
  [[ -z "$node_staging" || ! -e "$node_staging" ]] || rm -f -- "$node_staging" 2>/dev/null || true
}
trap cleanup EXIT

if [[ -e /opt/cannabeats || -L /opt/cannabeats ]]; then
  [[ -d /opt/cannabeats && ! -L /opt/cannabeats \
    && "$(stat -c '%a:%u:%g' /opt/cannabeats)" == 755:0:0 ]] || fail retained_corrupt
else
  install -d -m 0755 /opt/cannabeats || fail operator_install
fi
operator_staging="$(mktemp -d /opt/cannabeats/.operator.XXXXXX)" || fail operator_install
GIT_NO_REPLACE_OBJECTS=1 git -C "$repository_root" \
  archive --format=tar "$source_revision:CannaBeats" \
  | tar -xf - -C "$operator_staging" || fail source_invalid
[[ -z "$(find "$operator_staging" -type l -print -quit)" ]] || fail source_invalid
printf '%s\n' "$source_revision" >"$operator_staging/.source-revision" || fail operator_install
chown -R root:root "$operator_staging" || fail operator_install
chmod -R go-w "$operator_staging" || fail operator_install
chmod 0440 "$operator_staging/.source-revision" || fail operator_install

metadata_digest() {
  find "$1" -printf '%P\0%y\0%m\0%U\0%G\0' \
    | LC_ALL=C sort -z | sha256sum | cut -d ' ' -f 1
}

exact_operator() {
  [[ -d /opt/cannabeats/operator && ! -L /opt/cannabeats/operator \
    && -z "$(find /opt/cannabeats/operator -type l -print -quit)" \
    && -f /opt/cannabeats/operator/.source-revision \
    && "$(cat /opt/cannabeats/operator/.source-revision)" == "$source_revision" ]] \
    && diff --brief --recursive --no-dereference "$operator_staging" /opt/cannabeats/operator \
      >/dev/null \
    && [[ "$(metadata_digest "$operator_staging")" == "$(metadata_digest /opt/cannabeats/operator)" ]]
}

valid_token() {
  [[ -f "$1" && ! -L "$1" && "$(stat -c '%a:%u:%g' "$1")" == 640:0:10001 \
    && "$(cat "$1")" =~ ^[A-Za-z0-9_-]{43}$ ]]
}

valid_directory() {
  [[ -d "$1" && ! -L "$1" && "$(stat -c '%a:%u:%g' "$1")" == "$2" ]]
}

render_receipt() {
  local -a lines
  mapfile -t lines <"$RECEIPT_PATH"
  [[ "${#lines[@]}" == 5 && "${lines[0]}" == version=1 \
    && "${lines[1]}" == "revision=$source_revision" \
    && "${lines[2]}" == "node_sha256=$NODE_BINARY_SHA256" \
    && "${lines[3]}" =~ ^docker=[0-9A-Za-z.+~-]{1,64}$ \
    && "${lines[4]}" =~ ^compose=[0-9A-Za-z.+~-]{1,64}$ ]] || return 1
  printf '%s\n' production_host_install_ready
  printf '%s\n' "node=v${NODE_VERSION} ${lines[3]} ${lines[4]} revision=${source_revision}"
}

complete_installation() {
  local -a receipt
  [[ -f "$RECEIPT_PATH" && ! -L "$RECEIPT_PATH" \
    && "$(stat -c '%a:%u:%g' "$RECEIPT_PATH")" == 440:0:0 ]] || return 1
  render_receipt >/dev/null || return 1
  mapfile -t receipt <"$RECEIPT_PATH"
  exact_operator || return 1
  [[ -f /usr/bin/node && ! -L /usr/bin/node \
    && "$(stat -c '%a:%u:%g' /usr/bin/node)" == 755:0:0 \
    && "$(sha256sum /usr/bin/node | cut -d ' ' -f 1)" == "$NODE_BINARY_SHA256" ]] || return 1
  local unit
  for unit in cannabeats-reconcile.service cannabeats-backup.service cannabeats-backup.timer; do
    [[ -f "/etc/systemd/system/$unit" && ! -L "/etc/systemd/system/$unit" \
      && "$(stat -c '%a:%u:%g' "/etc/systemd/system/$unit")" == 444:0:0 ]] || return 1
    cmp --silent "/opt/cannabeats/operator/release/deploy/$unit" "/etc/systemd/system/$unit" \
      || return 1
  done
  systemctl is-enabled --quiet cannabeats-reconcile.service || return 1
  systemctl is-enabled --quiet cannabeats-backup.timer || return 1
  systemctl is-enabled --quiet docker.service || return 1
  systemctl is-active --quiet docker.service || return 1
  [[ "$(docker version --format '{{.Server.Version}}')" == "${receipt[3]#docker=}" \
    && "$(docker compose version --short)" == "${receipt[4]#compose=}" ]] || return 1
  valid_directory /run/lock 755:0:0 || return 1
  valid_directory /var/lib/cannabeats 750:10001:10001 || return 1
  valid_directory /var/lib/cannabeats-caddy 755:0:0 || return 1
  valid_directory /var/lib/cannabeats-caddy/data 750:0:0 || return 1
  valid_directory /var/lib/cannabeats-caddy/config 750:0:0 || return 1
  valid_directory /var/backups/cannabeats/sqlite 750:0:0 || return 1
  valid_directory /opt/cannabeats/releases 750:0:0 || return 1
  valid_directory /etc/cannabeats/secrets 700:0:0 || return 1
  valid_token /etc/cannabeats/secrets/relay-ingest-token || return 1
  valid_token /etc/cannabeats/secrets/relay-listen-token || return 1
  valid_token /etc/cannabeats/secrets/operator-token || return 1
  [[ "$(cat /etc/cannabeats/secrets/relay-ingest-token)" \
      != "$(cat /etc/cannabeats/secrets/relay-listen-token)" \
    && "$(cat /etc/cannabeats/secrets/relay-ingest-token)" \
      != "$(cat /etc/cannabeats/secrets/operator-token)" \
    && "$(cat /etc/cannabeats/secrets/relay-listen-token)" \
      != "$(cat /etc/cannabeats/secrets/operator-token)" ]] || return 1
}

if [[ -e "$RECEIPT_PATH" || -L "$RECEIPT_PATH" ]]; then
  complete_installation || fail retained_corrupt
  render_receipt || fail retained_corrupt
  exit 0
fi

if [[ -e /opt/cannabeats/operator || -L /opt/cannabeats/operator ]]; then
  exact_operator || fail operator_conflict
else
  mv -T "$operator_staging" /opt/cannabeats/operator || fail operator_conflict
  operator_staging=""
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || fail dependency_install
apt-get install -y --no-install-recommends \
  ca-certificates curl docker.io docker-compose-v2 xz-utils || fail dependency_install
systemctl enable --now docker.service || fail dependency_install

curl --fail --silent --show-error --location "$NODE_ORIGIN" -o "$temporary/$NODE_ARCHIVE" \
  || fail dependency_install
printf '%s  %s\n' "$NODE_SHA256" "$temporary/$NODE_ARCHIVE" | sha256sum --check --status \
  || fail dependency_corrupt
tar -xJf "$temporary/$NODE_ARCHIVE" -C "$temporary" || fail dependency_corrupt
node_source="$temporary/node-v${NODE_VERSION}-linux-x64/bin/node"
node_digest="$(sha256sum "$node_source" | cut -d ' ' -f 1)" || fail dependency_corrupt
[[ "$node_digest" == "$NODE_BINARY_SHA256" ]] || fail dependency_corrupt
installed_digest=""
if [[ -f /usr/bin/node && ! -L /usr/bin/node ]]; then
  installed_digest="$(sha256sum /usr/bin/node | cut -d ' ' -f 1)" || fail dependency_corrupt
fi
if [[ "$installed_digest" != "$node_digest" ]]; then
  node_staging="$(mktemp /usr/bin/.cannabeats-node.XXXXXX)" || fail dependency_install
  install -m 0755 "$node_source" "$node_staging" || fail dependency_install
  mv -T "$node_staging" /usr/bin/node || fail dependency_install
  node_staging=""
fi
[[ "$(/usr/bin/node --version)" == "v${NODE_VERSION}" ]] || fail dependency_install

for unit in cannabeats-reconcile.service cannabeats-backup.service cannabeats-backup.timer; do
  install -m 0444 "/opt/cannabeats/operator/release/deploy/$unit" "/etc/systemd/system/$unit" \
    || fail unit_install
done
/opt/cannabeats/operator/release/scripts/initialize-host.sh || fail initialization
systemctl daemon-reload || fail unit_install
systemctl enable cannabeats-reconcile.service cannabeats-backup.timer || fail unit_install

docker_version="$(docker version --format '{{.Server.Version}}')"
compose_version="$(docker compose version --short)"
[[ "$docker_version" =~ ^[0-9A-Za-z.+~-]{1,64}$ \
  && "$compose_version" =~ ^[0-9A-Za-z.+~-]{1,64}$ ]] || fail dependency_corrupt
receipt_staging="$(mktemp /opt/cannabeats/.install-receipt.XXXXXX)" || fail operator_install
printf '%s\n' version=1 "revision=$source_revision" "node_sha256=$NODE_BINARY_SHA256" \
  "docker=$docker_version" "compose=$compose_version" >"$receipt_staging" || fail operator_install
chmod 0440 "$receipt_staging" || fail operator_install
chown root:root "$receipt_staging" || fail operator_install
mv -T "$receipt_staging" "$RECEIPT_PATH" || fail operator_install
sync -f /opt/cannabeats || fail operator_install
render_receipt || fail retained_corrupt
