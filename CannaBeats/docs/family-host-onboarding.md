# CannaBeats family host onboarding

This flow creates a personal host account and authorizes one Mac to host games.
The account invitation and Mac pairing are separate, short-lived approvals.

## Before sending the invitation

The family host needs:

- macOS 14.2 or later;
- a Touch ID, iCloud Keychain, security-key, or other passkey-capable setup;
- a Spotify Premium account that has been added to the CannaBeats Spotify
  development application's user allowlist; and
- the notarized `CannaBeats-Host-0.4-universal.dmg` release.

After producing a notarized release, publish it to the private download mount:

```sh
./spikes/macos-host-agent-poc/scripts/publish-host-release.sh
```

The publisher refuses an unstapled build. The onboarding generator also
refuses to create an invitation if no published installer is available.

Generate the one-time host-account invitation only when the recipient is ready:

```sh
./spikes/macos-host-agent-poc/scripts/create-host-invitation.sh "Family member name" 48 5
```

The command prints a complete email containing a fragment-protected setup URL,
a fragment-protected installer page, the one-time invitation as a fallback,
and the setup/game instructions. Paste that content into an email. Neither
capability is stored in plaintext by CannaBeats, and email link scanners cannot
consume the installer allowance with an ordinary GET request.

## Recipient setup

1. Open `https://poc.cannabeats.social` and expand **I have an invitation**.
2. Enter a display name and the one-time invitation, then choose **Create
   passkey** and approve the normal macOS security prompt.
3. Open the CannaBeats Host DMG and drag **CannaBeats Host** to Applications.
4. Open CannaBeats Host and choose **Pair this Mac**. Its ten-minute pairing
   request opens in the default browser.
5. Sign in with the new passkey, confirm the named Mac, and authorize it.
6. Return to CannaBeats Host. It should report that this Mac is authorized for
   the host account.
7. Choose **Create new game & open CannaBeats**.
8. In the opened PWA or browser, connect the recipient's own Spotify account.
   Spotify credentials stay in that browser/PWA profile.
9. Approve **Screen & System Audio Recording** when macOS asks. Restart
   CannaBeats Host if macOS requests it.
10. Start a test game, confirm audio returns through the shared relay, and use
    the lobby's secure guest QR to admit players.

## Recovery and revocation

- A lost or replaced Mac should be revoked from **CannaBeats Host
  applications** on the account page.
- Removing the local identity does not revoke the server authorization by
  itself.
- Spotify can be disconnected locally without changing the CannaBeats account
  or Host application authorization.
- If a passkey is lost, sign in with another synced or previously added
  passkey and remove the lost credential from the account page.

## Replacing the Host PoC

The stable app intentionally creates a new device identity instead of asking
for access to the ad-hoc PoC's Keychain item. Pair **CannaBeats Host** once,
confirm it works, then revoke the old **CannaBeats Host PoC** authorization
from the account page. The old app and its Keychain identity remain available
as rollback until they are removed explicitly.
