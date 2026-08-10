#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
spike_dir="$(cd "$script_dir/.." && pwd)"
dmg_path="${1:-$spike_dir/.build/distribution/CannaBeats-Host-0.4-universal.dmg}"
deploy_host="${CANNABEATS_DEPLOY_HOST:-vw-services}"
remote_directory="/opt/cannabeats-poc/releases"
remote_path="$remote_directory/CannaBeats-Host-universal.dmg"

if [[ ! -f "$dmg_path" ]]; then
  echo "Release DMG not found: $dmg_path" >&2
  exit 2
fi

xcrun stapler validate "$dmg_path"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg_path"
local_checksum="$(shasum -a 256 "$dmg_path" | awk '{print $1}')"

ssh "$deploy_host" "install -d -m 0755 '$remote_directory'"
scp "$dmg_path" "$deploy_host:$remote_path.uploading"
ssh "$deploy_host" "set -e; chmod 0444 '$remote_path.uploading'; mv '$remote_path.uploading' '$remote_path'; test \"\$(sha256sum '$remote_path' | awk '{print \$1}')\" = '$local_checksum'"

echo "Published notarized Host release: $remote_path"
echo "SHA-256: $local_checksum"
