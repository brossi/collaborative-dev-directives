#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
source "$script_dir/release-lib.sh"

[[ $# -eq 2 ]] || fr9_fail invalid_arguments
version="$1"
build_number="$2"
identity="${CANNABEATS_CODESIGN_IDENTITY:-}"
notary_profile="${CANNABEATS_NOTARY_PROFILE:-cannabeats-notary}"
team_id="6Z9D2757FY"
release_root="$repo_root/macos/.build/releases"
final_dir="$release_root/${version}-${build_number}"
lock_path="$repo_root/macos/.build/fr9-release.lock"
expected_name="CannaBeats-Host-${version}-${build_number}-universal.dmg"

fr9_validate_version "$version"
fr9_validate_build "$build_number"
fr9_validate_identity "$identity"
[[ "$notary_profile" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$ ]] || fr9_fail invalid_profile
git_root="$(git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null || true)"
source_prefix="$(git -C "$repo_root" rev-parse --show-prefix 2>/dev/null || true)"
[[ -n "$git_root" && -d "$git_root" ]] || fr9_fail source_unavailable
fr9_require_clean_source "$git_root"
source_revision="$(git -C "$git_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null || true)"
fr9_validate_revision "$source_revision"
mkdir -p "$release_root" 2>/dev/null || fr9_fail output_unavailable
[[ ! -e "$final_dir" ]] || fr9_fail output_conflict
fr9_acquire_lock "$lock_path"

work_path=""
source_path=""
source_attached=false
cleanup() {
  if [[ "$source_attached" == true ]]; then
    git -C "$git_root" worktree remove --force "$source_path" >/dev/null 2>&1 || true
  fi
  if [[ -n "$work_path" ]]; then rm -rf "$work_path"; fi
  rm -f "$lock_path/pid"
  rmdir "$lock_path" >/dev/null 2>&1 || true
}
trap cleanup EXIT
work_path="$(mktemp -d "${TMPDIR:-/tmp}/cannabeats-fr9-release.XXXXXX" 2>/dev/null)" \
  || fr9_fail staging_unavailable
source_path="$work_path/source"
source_project_path="$(fr9_snapshot_project_path "$source_path" "$source_prefix")"
git -C "$git_root" worktree add --detach "$source_path" "$source_revision" \
  >"$work_path/worktree.log" 2>&1 || fr9_fail source_snapshot_failed
source_attached=true
source_project="$source_project_path/macos/CannaBeatsHost.xcodeproj"
snapshot_verifier="$source_project_path/macos/release/verify-host-release.sh"
fr9_require_snapshot_paths "$source_path" "$source_project" "$snapshot_verifier"
printf '%s\n' "$source_revision" >"$work_path/source-revision.txt" \
  || fr9_fail source_identity_unavailable
fr9_require_space "$repo_root" 2097152

security find-identity -v -p codesigning 2>/dev/null | grep -Fq "\"$identity\"" \
  || fr9_fail identity_unavailable
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun notarytool history --keychain-profile "$notary_profile" >/dev/null 2>&1 \
  || fr9_fail notary_authentication_failed

archive_path="$work_path/CannaBeatsHost.xcarchive"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild archive \
  -quiet -project "$source_project" \
  -scheme CannaBeatsHostRelease -configuration Release -destination 'generic/platform=macOS' \
  -archivePath "$archive_path" MARKETING_VERSION="$version" \
  CURRENT_PROJECT_VERSION="$build_number" CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$identity" DEVELOPMENT_TEAM="$team_id" \
  CANNABEATS_SOURCE_REVISION="$source_revision" \
  OTHER_CODE_SIGN_FLAGS=--timestamp >"$work_path/archive.log" 2>&1 \
  || fr9_fail archive_failed

app_path="$archive_path/Products/Applications/CannaBeats Host.app"
[[ -d "$app_path" ]] || fr9_fail app_omitted
codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null 2>&1 \
  || fr9_fail app_signature_invalid

stage_path="$work_path/dmg-stage"
mkdir "$stage_path" 2>/dev/null || fr9_fail staging_unavailable
ditto "$app_path" "$stage_path/CannaBeats Host.app" >/dev/null 2>&1 \
  || fr9_fail staging_failed
ln -s /Applications "$stage_path/Applications" 2>/dev/null \
  || fr9_fail staging_failed
dmg_path="$work_path/$expected_name"
hdiutil create -quiet -volname "CannaBeats Host ${version}" -srcfolder "$stage_path" \
  -ov -format UDZO "$dmg_path" >/dev/null 2>&1 || fr9_fail dmg_creation_failed
codesign --force --sign "$identity" --timestamp "$dmg_path" >/dev/null 2>&1 \
  || fr9_fail dmg_signing_failed

notary_result="$work_path/notary-result.json"
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun notarytool submit "$dmg_path" --keychain-profile "$notary_profile" --wait \
  --output-format json >"$notary_result" 2>"$work_path/notary.log" \
  || fr9_fail notarization_failed
[[ "$(plutil -extract status raw -o - "$notary_result" 2>/dev/null || true)" == Accepted ]] \
  || fr9_fail notarization_rejected
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun stapler staple "$dmg_path" \
  >/dev/null 2>&1 || fr9_fail staple_failed

checksum_path="$work_path/${expected_name}.sha256"
checksum="$(shasum -a 256 "$dmg_path" 2>/dev/null | awk '{print $1}' || true)"
[[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || fr9_fail checksum_unavailable
printf '%s  %s\n' "$checksum" "$expected_name" >"$checksum_path" \
  || fr9_fail checksum_unavailable
"$snapshot_verifier" \
  "$dmg_path" "$checksum_path" "$work_path/source-revision.txt" \
  "$version" "$build_number" "$identity" >/dev/null

fr9_publish_release \
  "$final_dir" "$dmg_path" "$checksum_path" "$notary_result" \
  "$work_path/source-revision.txt" "$expected_name"
printf 'fr9_release_created %s\n' "$final_dir"
