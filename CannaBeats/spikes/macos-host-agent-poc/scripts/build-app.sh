#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
spike_dir="$(cd "$script_dir/.." && pwd)"
repo_dir="$(cd "$spike_dir/../.." && pwd)"
distribution_dir="$spike_dir/.build/distribution"
app_path="$distribution_dir/CannaBeats Host.app"
contents_path="$app_path/Contents"
executable_path="$contents_path/MacOS/CannaBeatsHost"
dmg_path="$distribution_dir/CannaBeats-Host-0.4-universal.dmg"
artwork_path="${CANNABEATS_ICON_SOURCE:-$repo_dir/web/public/cannabeats-logo.jpg}"
codesign_identity="${CANNABEATS_CODESIGN_IDENTITY:--}"

swift build --package-path "$spike_dir" -c release --triple arm64-apple-macosx14.2
swift build --package-path "$spike_dir" -c release --triple x86_64-apple-macosx14.2

rm -rf "$app_path"
mkdir -p "$contents_path/MacOS" "$contents_path/Resources" "$distribution_dir"
lipo -create \
  "$spike_dir/.build/arm64-apple-macosx/release/CannaBeatsHostPoC" \
  "$spike_dir/.build/x86_64-apple-macosx/release/CannaBeatsHostPoC" \
  -output "$executable_path"
test "$(lipo -archs "$executable_path")" = "x86_64 arm64" \
  || test "$(lipo -archs "$executable_path")" = "arm64 x86_64"
cp "$spike_dir/Resources/Info.plist" "$contents_path/Info.plist"

iconset_dir="$(mktemp -d)/CannaBeatsHost.iconset"
mkdir -p "$iconset_dir"
while read -r filename pixels; do
  sips -s format png -z "$pixels" "$pixels" "$artwork_path" --out "$iconset_dir/$filename" >/dev/null
done <<'SIZES'
icon_16x16.png 16
icon_16x16@2x.png 32
icon_32x32.png 32
icon_32x32@2x.png 64
icon_128x128.png 128
icon_128x128@2x.png 256
icon_256x256.png 256
icon_256x256@2x.png 512
icon_512x512.png 512
icon_512x512@2x.png 1024
SIZES
iconutil -c icns "$iconset_dir" -o "$contents_path/Resources/CannaBeatsHost.icns"
rm -rf "$(dirname "$iconset_dir")"

codesign --force --sign "$codesign_identity" \
  --entitlements "$spike_dir/Resources/HostPoC.entitlements" \
  --options runtime \
  "$app_path"
codesign --verify --deep --strict "$app_path"
lipo -archs "$executable_path"

dmg_stage="$(mktemp -d)"
ditto "$app_path" "$dmg_stage/CannaBeats Host.app"
ln -s /Applications "$dmg_stage/Applications"
rm -f "$dmg_path"
hdiutil create -quiet -volname "CannaBeats Host" -srcfolder "$dmg_stage" -ov -format UDZO "$dmg_path"
rm -rf "$dmg_stage"

echo "$app_path"
echo "$dmg_path"
