#!/bin/bash

fr9_fail() {
  printf 'fr9_%s\n' "$1" >&2
  exit 2
}

fr9_validate_version() {
  [[ "$1" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] \
    || fr9_fail invalid_version
}

fr9_validate_build() {
  [[ "$1" =~ ^[1-9][0-9]{0,8}$ ]] || fr9_fail invalid_build
}

fr9_validate_identity() {
  [[ "$1" == Developer\ ID\ Application:*" (6Z9D2757FY)" ]] \
    || fr9_fail invalid_identity
  [[ "$1" != *$'\n'* && ${#1} -le 160 ]] || fr9_fail invalid_identity
}

fr9_validate_revision() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || fr9_fail invalid_revision
}

fr9_write_pid() {
  printf '%s\n' "$$" >"$1"
}

fr9_acquire_lock() {
  local lock_path="$1"
  mkdir "$lock_path" 2>/dev/null || fr9_fail release_busy
  if ! fr9_write_pid "$lock_path/pid" 2>/dev/null; then
    rm -f "$lock_path/pid" >/dev/null 2>&1 || true
    rmdir "$lock_path" >/dev/null 2>&1 || true
    fr9_fail lock_unavailable
  fi
}

fr9_require_space() {
  local path="$1" minimum_kib="$2" available
  available="$(df -Pk "$path" 2>/dev/null | awk 'NR == 2 {print $4}' || true)"
  [[ "$available" =~ ^[0-9]+$ ]] || fr9_fail space_unavailable
  (( available >= minimum_kib )) || fr9_fail insufficient_space
}

fr9_require_clean_source() {
  local repo_root="$1" status
  if ! status="$(git -C "$repo_root" status --porcelain --untracked-files=normal 2>/dev/null)"; then
    fr9_fail source_unavailable
  fi
  [[ -z "$status" ]] || fr9_fail source_dirty
}

fr9_publish_release() {
  local final_dir="$1" dmg_path="$2" checksum_path="$3" notary_result="$4"
  local source_revision_path="$5" expected_name="$6"
  mkdir "$final_dir" 2>/dev/null || fr9_fail output_conflict
  install -m 0444 "$dmg_path" "$final_dir/$expected_name" 2>/dev/null \
    || fr9_fail publication_failed
  install -m 0444 "$notary_result" "$final_dir/notary-result.json" 2>/dev/null \
    || fr9_fail publication_failed
  install -m 0444 "$source_revision_path" "$final_dir/source-revision.txt" 2>/dev/null \
    || fr9_fail publication_failed
  install -m 0444 "$checksum_path" "$final_dir/${expected_name}.sha256" 2>/dev/null \
    || fr9_fail publication_failed
}
