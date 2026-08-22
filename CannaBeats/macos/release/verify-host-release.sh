#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/release-lib.sh"

[[ $# -eq 6 ]] || fr9_fail invalid_arguments
dmg_path="$1"
checksum_path="$2"
source_revision_path="$3"
version="$4"
build_number="$5"
identity="$6"
team_id="6Z9D2757FY"

fr9_validate_version "$version"
fr9_validate_build "$build_number"
fr9_validate_identity "$identity"
[[ "$dmg_path" == /* && -f "$dmg_path" && ! -L "$dmg_path" ]] || fr9_fail invalid_dmg
[[ "$checksum_path" == /* && -f "$checksum_path" && ! -L "$checksum_path" ]] \
  || fr9_fail invalid_checksum
[[ "$source_revision_path" == /* && -f "$source_revision_path" \
  && ! -L "$source_revision_path" ]] || fr9_fail invalid_revision
source_revision="$(sed -n '1p' "$source_revision_path" 2>/dev/null || true)"
[[ "$(wc -l <"$source_revision_path" 2>/dev/null | tr -d ' ' || true)" == 1 ]] \
  || fr9_fail invalid_revision
fr9_validate_revision "$source_revision"
expected_name="CannaBeats-Host-${version}-${build_number}-universal.dmg"
[[ "$(basename "$dmg_path")" == "$expected_name" ]] || fr9_fail artifact_conflict
[[ "$(basename "$checksum_path")" == "${expected_name}.sha256" ]] \
  || fr9_fail artifact_conflict

actual_checksum="$(shasum -a 256 "$dmg_path" 2>/dev/null | awk '{print $1}' || true)"
expected_checksum="$(awk 'NF == 2 {print $1 "  " $2}' "$checksum_path" 2>/dev/null || true)"
[[ "$expected_checksum" == "$actual_checksum  $expected_name" ]] \
  || fr9_fail checksum_conflict

codesign --verify --strict --verbose=2 "$dmg_path" >/dev/null 2>&1 \
  || fr9_fail dmg_signature_invalid
xcrun stapler validate "$dmg_path" >/dev/null 2>&1 || fr9_fail ticket_invalid
spctl --assess --type open --context context:primary-signature "$dmg_path" >/dev/null 2>&1 \
  || fr9_fail dmg_rejected
hdiutil verify "$dmg_path" >/dev/null 2>&1 || fr9_fail dmg_corrupt

mount_path=""
mounted=false
entitlements=""
cleanup() {
  if [[ -n "$entitlements" ]]; then rm -f "$entitlements"; fi
  if [[ "$mounted" == true ]]; then hdiutil detach "$mount_path" >/dev/null 2>&1 || true; fi
  rmdir "$mount_path" >/dev/null 2>&1 || true
}
trap cleanup EXIT
mount_path="$(mktemp -d "${TMPDIR:-/tmp}/cannabeats-fr9-verify.XXXXXX" 2>/dev/null)" \
  || fr9_fail staging_unavailable
hdiutil attach -nobrowse -readonly -mountpoint "$mount_path" "$dmg_path" >/dev/null 2>&1 \
  || fr9_fail dmg_mount_failed
mounted=true

app_path="$mount_path/CannaBeats Host.app"
executable_path="$app_path/Contents/MacOS/CannaBeats Host"
[[ -d "$app_path" && ! -L "$app_path" && -f "$executable_path" && ! -L "$executable_path" ]] \
  || fr9_fail app_omitted
[[ -L "$mount_path/Applications" && "$(readlink "$mount_path/Applications")" == /Applications ]] \
  || fr9_fail applications_link_invalid
root_entries="$(find "$mount_path" -mindepth 1 -maxdepth 1 -print 2>/dev/null \
  | sed "s|$mount_path/||" | LC_ALL=C sort || true)"
[[ "$root_entries" == $'Applications\nCannaBeats Host.app' ]] || fr9_fail dmg_domain_invalid
contents_entries="$(find "$app_path/Contents" -mindepth 1 -maxdepth 1 -print 2>/dev/null \
  | sed "s|$app_path/Contents/||" | LC_ALL=C sort || true)"
[[ "$contents_entries" == $'Info.plist\nMacOS\nPkgInfo\n_CodeSignature' ]] \
  || fr9_fail app_domain_invalid
executable_entries="$(find "$app_path/Contents/MacOS" -mindepth 1 -maxdepth 1 -print 2>/dev/null \
  | sed "s|$app_path/Contents/MacOS/||" | LC_ALL=C sort || true)"
[[ "$executable_entries" == 'CannaBeats Host' ]] || fr9_fail executable_domain_invalid

codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null 2>&1 \
  || fr9_fail app_signature_invalid
if ! signature="$(codesign -d --verbose=4 "$app_path" 2>&1)"; then
  fr9_fail signature_metadata_invalid
fi
[[ "$signature" == *"Authority=$identity"* ]] || fr9_fail identity_conflict
[[ "$signature" == *"TeamIdentifier=$team_id"* ]] || fr9_fail team_conflict
[[ "$signature" == *"flags=0x10000(runtime)"* ]] || fr9_fail hardened_runtime_omitted
spctl --assess --type execute "$app_path" >/dev/null 2>&1 || fr9_fail app_rejected

info="$app_path/Contents/Info.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$info" 2>/dev/null || true)" == \
  'CannaBeats Host' ]] || fr9_fail executable_identity_conflict
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' "$info" 2>/dev/null || true)" == \
  APPL ]] || fr9_fail package_type_conflict
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info" 2>/dev/null || true)" == \
  social.cannabeats.host ]] || fr9_fail bundle_identity_conflict
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info" 2>/dev/null || true)" == \
  "$version" ]] || fr9_fail version_conflict
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$info" 2>/dev/null || true)" == "$build_number" ]] \
  || fr9_fail build_conflict
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CannaBeatsSourceRevision' "$info" 2>/dev/null || true)" == \
  "$source_revision" ]] || fr9_fail source_identity_conflict
[[ "$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$info" 2>/dev/null || true)" == 14.2 ]] \
  || fr9_fail minimum_system_conflict
[[ -n "$(/usr/libexec/PlistBuddy -c 'Print :NSAppleEventsUsageDescription' "$info" 2>/dev/null || true)" ]] \
  || fr9_fail apple_events_usage_omitted
[[ -n "$(/usr/libexec/PlistBuddy -c 'Print :NSAudioCaptureUsageDescription' "$info" 2>/dev/null || true)" ]] \
  || fr9_fail audio_capture_usage_omitted
privacy_keys="$(plutil -p "$info" 2>/dev/null \
  | sed -n 's/^  "\(NS[^\"]*UsageDescription\)" =>.*$/\1/p' | LC_ALL=C sort || true)"
[[ "$privacy_keys" == $'NSAppleEventsUsageDescription\nNSAudioCaptureUsageDescription' ]] \
  || fr9_fail privacy_domain_invalid
architectures="$(lipo -archs "$executable_path" 2>/dev/null || true)"
[[ "$architectures" == "arm64 x86_64" || "$architectures" == "x86_64 arm64" ]] \
  || fr9_fail architecture_conflict

entitlements="$(mktemp "${TMPDIR:-/tmp}/cannabeats-fr9-entitlements.XXXXXX" 2>/dev/null)" \
  || fr9_fail staging_unavailable
codesign -d --entitlements :- "$app_path" >"$entitlements" 2>/dev/null \
  || fr9_fail entitlements_unavailable
apple_events="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.automation.apple-events' "$entitlements" 2>/dev/null || true)"
network_client="$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.network.client' "$entitlements" 2>/dev/null || true)"
[[ "$apple_events" == true && "$network_client" == true ]] || fr9_fail entitlements_conflict
entitlement_keys="$(plutil -p "$entitlements" 2>/dev/null \
  | sed -n 's/^  "\([^"]*\)" =>.*$/\1/p' | LC_ALL=C sort || true)"
[[ "$entitlement_keys" == $'com.apple.security.automation.apple-events\ncom.apple.security.network.client' ]] \
  || fr9_fail entitlements_conflict
final_checksum="$(shasum -a 256 "$dmg_path" 2>/dev/null | awk '{print $1}' || true)"
[[ "$final_checksum" == "$actual_checksum" ]] || fr9_fail checksum_conflict

printf 'fr9_release_verified %s %s\n' "$version" "$build_number"
