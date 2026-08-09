#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
spike_dir="$(cd "$script_dir/.." && pwd)"
app_path="$spike_dir/.build/CannaBeats Host PoC.app"
contents_path="$app_path/Contents"

swift build --package-path "$spike_dir" -c release

rm -rf "$app_path"
mkdir -p "$contents_path/MacOS"
cp "$spike_dir/.build/release/CannaBeatsHostPoC" "$contents_path/MacOS/CannaBeatsHostPoC"
cp "$spike_dir/Resources/Info.plist" "$contents_path/Info.plist"

codesign --force --sign - \
  --entitlements "$spike_dir/Resources/HostPoC.entitlements" \
  --options runtime \
  "$app_path"
codesign --verify --deep --strict "$app_path"

echo "$app_path"
