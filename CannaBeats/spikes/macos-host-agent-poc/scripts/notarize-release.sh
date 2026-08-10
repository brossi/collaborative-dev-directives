#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
spike_dir="$(cd "$script_dir/.." && pwd)"
dmg_path="$spike_dir/.build/distribution/CannaBeats-Host-0.5-universal.dmg"
app_path="$spike_dir/.build/distribution/CannaBeats Host.app"
codesign_identity="${CANNABEATS_CODESIGN_IDENTITY:-}"
notary_profile="${CANNABEATS_NOTARY_PROFILE:-}"

if [[ -z "$codesign_identity" || "$codesign_identity" == "-" ]]; then
  echo "Set CANNABEATS_CODESIGN_IDENTITY to the full Developer ID Application identity." >&2
  exit 2
fi
if [[ "$codesign_identity" != Developer\ ID\ Application:* ]]; then
  echo "The signing identity must be a Developer ID Application certificate." >&2
  exit 2
fi
if [[ -z "$notary_profile" ]]; then
  echo "Set CANNABEATS_NOTARY_PROFILE to a notarytool Keychain profile." >&2
  exit 2
fi
if ! security find-identity -v -p codesigning | grep -Fq "\"$codesign_identity\""; then
  echo "The requested Developer ID Application identity is not installed in this Keychain." >&2
  exit 2
fi
if ! xcrun notarytool history --keychain-profile "$notary_profile" >/dev/null; then
  echo "The requested notarytool Keychain profile could not authenticate." >&2
  exit 2
fi

CANNABEATS_CODESIGN_IDENTITY="$codesign_identity" "$script_dir/build-app.sh"
codesign --verify --deep --strict --verbose=2 "$app_path"
codesign --verify --verbose=2 "$dmg_path"

xcrun notarytool submit "$dmg_path" --keychain-profile "$notary_profile" --wait
xcrun stapler staple "$dmg_path"
xcrun stapler validate "$dmg_path"
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg_path"
shasum -a 256 "$dmg_path"

echo "Notarized release: $dmg_path"
