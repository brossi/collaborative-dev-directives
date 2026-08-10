# CannaBeats macOS host-agent PoC

This spike proves that a separately packaged macOS application can be approved
by an existing passkey-authenticated CannaBeats host account and subsequently
prove possession of its own device signing key. It then uses that proof to
obtain an in-memory relay grant, capture one selected Core Audio process, and
play the host's audio back through the same remote stream listeners receive.

## Security boundary

- The host application generates a P-256 signing key locally.
- Secure Enclave is preferred when available; the fallback key is stored as a
  this-device-only Keychain item.
- Only the public key is sent to CannaBeats.
- Pairing codes expire after ten minutes and carry no authority by themselves.
- Approval requires an authenticated host account and a fresh passkey
  assertion.
- Device proofs use one-time, two-minute server challenges. Replays fail.
- The application never receives a Spotify credential or browser session
  cookie.
- Relay credentials are returned only after a fresh signed device challenge
  and are retained in memory for the running audio session.
- The process tap uses `CATapMutedWhenTapped`, so the selected source's direct
  output is replaced by relay playback instead of being heard twice.

The deployed learning relay still has one shared source slot and static
ingest/listen credentials. The server-mediated grant proves the trust boundary,
but it is not yet a game-scoped or expiring relay capability. That is required
before this design moves beyond the private PoC.

The packaging script produces a universal arm64/x86_64 application and DMG.
It uses an ad-hoc development signature by default. Distribution to another
Mac still requires a Developer ID signature and notarization so Gatekeeper
accepts the download and macOS privacy consent remains tied to a durable code
identity.

## Build

Full Xcode is not required; the Apple command-line Swift toolchain is enough.

```sh
chmod +x scripts/build-app.sh
./scripts/build-app.sh
open ".build/distribution/CannaBeats Host.app"
```

The distributable artifact is
`.build/distribution/CannaBeats-Host-0.4-universal.dmg`. To sign with an
installed identity, set `CANNABEATS_CODESIGN_IDENTITY` to its full name. A
Developer ID build must also be notarized and stapled before family delivery.

After Developer Program membership is active, store notarization credentials
in Keychain with `xcrun notarytool store-credentials`, then run:

```sh
CANNABEATS_CODESIGN_IDENTITY="Developer ID Application: Name (TEAMID)" \
CANNABEATS_NOTARY_PROFILE="cannabeats-notary" \
./scripts/notarize-release.sh
```

The release script refuses ad-hoc and development certificates, verifies both
the certificate and Keychain notary profile before rebuilding, then submits,
staples, validates, assesses, and checksums the DMG.

The application defaults to `https://poc.cannabeats.social`. The corresponding
server endpoints and browser approval interface live in the adjacent
`access-spotify-poc` spike.

## Authorization proof

1. Open the application and choose **Pair this Mac**.
2. The application generates its key, obtains a one-time pairing code, and
   opens CannaBeats in the default browser.
3. Sign in to CannaBeats if needed and choose **Authorize application**.
4. Confirm the application name and complete the passkey prompt.
5. The application detects approval and automatically signs a fresh server
   challenge.
6. The final application status reads `Host application authorization
   confirmed for …`.

The CannaBeats account page lists the authorized application and can revoke it.
Deleting the local identity does not silently revoke the server record; the UI
reminds the user to revoke it explicitly.

## Shared-audio proof

1. Start the native host app before opening CannaBeats.
2. Choose **Create new game & open CannaBeats**, or enter a host-owned game code
   and choose **Use existing game & open**. The app proves its device identity,
   creates or validates the real four-character game room, and displays its
   code before it does anything else.
3. The app authenticates the relay grant, snapshots existing audio processes,
   and opens the installed CannaBeats PWA at `/game?session=CODE`. If the PWA is not
   installed, it opens the same URL in the default browser. The authenticated
   game loads that room into the existing lobby, rules, and gameplay UI.
4. In CannaBeats, connect Spotify if needed, start the browser player, and begin
   playback. The host app watches for the newly active audio process and
   attaches automatically; no process selection is normally required.
5. Approve macOS **Screen & System Audio Recording** access if prompted. macOS
   may require the host app to be restarted after the first permission change.
6. The detected process's direct output should become silent, then return
   through `cannaudio.cannabeats.social`. The status should say the host is
   listening through the same relay stream as players.
7. Confirm that captured seconds increase, peak is above `silence`, and dropped
   upload packets remain at zero. Choose **Stop shared audio** to remove the tap
   and restore direct playback.

If automatic discovery does not identify the correct WebKit process, expand
**Troubleshooting: choose an audio process manually**, refresh while Spotify is
playing, and start with the selected process.

The capture callback conversion is intentionally simple for this spike. A
production host app should replace its Objective-C `NSData` allocation on the
real-time audio callback with a preallocated lock-free buffer.
