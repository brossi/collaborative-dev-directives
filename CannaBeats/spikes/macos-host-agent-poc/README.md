# CannaBeats macOS host-agent PoC

This spike proves that a separately packaged macOS application can be approved
by an existing passkey-authenticated CannaBeats host account and subsequently
prove possession of its own device signing key.

It deliberately stops before audio capture. The next boundary is to move the
working Core Audio process-tap mechanics from `btaudio-learning` into this
signed application and use the authorized agent to obtain game-scoped relay
credentials.

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

This is an ad-hoc-signed development bundle. Stable distribution requires a
Developer ID signature and notarization so macOS privacy consent remains tied
to a durable code identity.

## Build

Full Xcode is not required; the Apple command-line Swift toolchain is enough.

```sh
chmod +x scripts/build-app.sh
./scripts/build-app.sh
open ".build/CannaBeats Host PoC.app"
```

The application defaults to `https://poc.cannabeats.social`. The corresponding
server endpoints and browser approval interface live in the adjacent
`access-spotify-poc` spike.

## End-to-end proof

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
