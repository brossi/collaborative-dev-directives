#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
spike_dir="$(cd "$script_dir/.." && pwd)"
dmg_path="${1:-$spike_dir/.build/distribution/CannaBeats-Host-0.5-universal.dmg}"
deploy_host="${CANNABEATS_DEPLOY_HOST:-vw-services}"
remote_directory="/opt/cannabeats-poc/releases"
remote_path="$remote_directory/CannaBeats-Host-interim-universal.dmg"
mount_directory="$(mktemp -d /tmp/cannabeats-interim-release.XXXXXX)"
mounted_device=""

cleanup() {
  if [[ -n "$mounted_device" ]]; then hdiutil detach "$mounted_device" >/dev/null 2>&1 || true; fi
  rmdir "$mount_directory" >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ -f "$dmg_path" ]] || { echo "Interim DMG not found: $dmg_path" >&2; exit 2; }
hdiutil verify "$dmg_path" >/dev/null
mounted_device="$(hdiutil attach -nobrowse -readonly -mountpoint "$mount_directory" "$dmg_path" | awk 'NR == 1 {print $1}')"
app_path="$mount_directory/CannaBeats Host.app"
codesign --verify --deep --strict --verbose=2 "$app_path"
codesign_details="$(codesign -d --verbose=4 "$app_path" 2>&1)"
grep -Fq "Signature=adhoc" <<<"$codesign_details" \
  || { echo "The interim publisher accepts only an ad-hoc signed app." >&2; exit 2; }
architectures="$(lipo -archs "$app_path/Contents/MacOS/CannaBeatsHost")"
[[ "$architectures" == *arm64* && "$architectures" == *x86_64* ]] \
  || { echo "The interim app is not universal: $architectures" >&2; exit 2; }
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app_path/Contents/Info.plist")"
[[ "$version" == "0.5" ]] || { echo "Expected Host version 0.5, found $version" >&2; exit 2; }
checksum="$(shasum -a 256 "$dmg_path" | awk '{print $1}')"

ssh "$deploy_host" "install -d -m 0755 '$remote_directory'"
scp "$dmg_path" "$deploy_host:$remote_path.uploading"
ssh "$deploy_host" "set -e; chmod 0444 '$remote_path.uploading'; mv '$remote_path.uploading' '$remote_path'; test \"\$(sha256sum '$remote_path' | awk '{print \$1}')\" = '$checksum'"

echo "Published interim Host release: $remote_path"
echo "SHA-256: $checksum"
