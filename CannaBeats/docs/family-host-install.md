# Install or upgrade CannaBeats Host

CannaBeats Host is delivered directly as a signed and notarized DMG. Use only
the DMG and SHA-256 file sent by the family operator. Do not use an interim app,
the retired iPhone project, or a copy received from another source.

## Install

1. Keep the DMG and its `.sha256` file in the same folder. In Terminal, change
   to that folder and run `shasum -a 256 -c <checksum-file>`.
2. Open the DMG and drag **CannaBeats Host** to **Applications**.
3. Eject the DMG, then open **CannaBeats Host** from Applications. The first
   launch should identify it as software from the CannaBeats Developer ID
   publisher; do not bypass Gatekeeper if macOS rejects it.
4. When the Host first controls Spotify, allow Automation access. When shared
   audio first starts, allow system-audio capture. CannaBeats does not request
   microphone capture and does not install an audio driver.

## Upgrade

Quit CannaBeats Host, open the newer verified DMG, and replace the existing app
in Applications. The bundle ID remains `social.cannabeats.host`, so macOS
can associate the upgrade with the same application only when the Developer ID
team and designated signing requirement also remain unchanged. The release
verifier enforces those relationships. The enrolled device key and application
session live in this Mac's Keychain, outside the app bundle, and must remain
available after replacement; the second-Mac upgrade rehearsal is still the
required real proof.

If the server reports that an upgrade is required, the old build stops before
creating or resuming a game. Install the current DMG and reopen the Host.

## Remove or replace a Mac

Moving the app to Trash does not silently revoke the Mac because its device key
is deliberately stored in Keychain. Before retiring or transferring a Mac,
revoke that Host device from an authorized Host. Reinstalling on the same Mac
may recover the retained enrollment; a revoked device must be enrolled again.

## Operator recovery during release creation

The release command never overwrites a retained version/build directory. If it
reports `fr9_release_busy`, first confirm that no `release-host.sh`,
`xcodebuild`, `codesign`, or `notarytool` process is still running. Only after
that read-only check may the operator remove the stale ignored directory
`macos/.build/fr9-release.lock` and retry.

If `macos/.build/releases/<version>-<build>` exists without all four expected
files (DMG, checksum, accepted `notary-result.json`, and source revision), keep
it for diagnosis or move that exact directory aside. Do not merge, repair, or
overwrite it; rerun with a new build number. The SHA-256 file is the acceptance
marker only when the shared verifier also passes.
