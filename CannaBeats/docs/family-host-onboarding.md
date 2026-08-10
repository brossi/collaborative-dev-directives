# CannaBeats family host onboarding

This flow creates a personal host account and authorizes one Mac to host games.
The account invitation and Mac pairing are separate, short-lived approvals.

## Before sending the invitation

The family host needs:

- macOS 14.2 or later;
- a Touch ID, iCloud Keychain, security-key, or other passkey-capable setup;
- access to the private managed Spotify source (selected automatically in the
  game lobby); and
- the current universal Host release. During the Developer ID wait this is the
  explicitly labeled ad-hoc 0.5 interim build; replace it with the signed and
  notarized release when Apple activates the certificate.

Publish the ad-hoc interim build to its separate private download path with:

```sh
./spikes/macos-host-agent-poc/scripts/publish-interim-host-release.sh
```

After producing a notarized release, switch the configured release channel and
publish it with:

```sh
./spikes/macos-host-agent-poc/scripts/publish-host-release.sh
```

The publisher refuses an unstapled build. The onboarding generator also
refuses to create an invitation if no published installer is available.

Generate the one-time host-account invitation only when the recipient is ready:

1. Sign in at `https://poc.cannabeats.social` with an account that has the
   `manage_host_invitations` capability.
2. Open **Host invitation administration** and choose **Open invitation
   generator**.
3. Enter the recipient, expiration, and download limit, then copy the generated
   email before leaving the page.

The capability is assigned independently of the host/player account role. The
first administrator is granted explicitly during deployment; another enrolled
user can be added later without changing application code:

```sh
docker compose exec app node cli.mjs admin-access list
docker compose exec app node cli.mjs admin-access grant --user-id USER_UUID
docker compose exec app node cli.mjs admin-access revoke --user-id USER_UUID
```

The server-side command remains available as an operational fallback:

```sh
./spikes/macos-host-agent-poc/scripts/create-host-invitation.sh "Family member name" 48 5
```

Both paths produce a complete email containing a fragment-protected setup URL,
a fragment-protected installer page, the one-time invitation as a fallback,
and the setup/game instructions. Paste that content into an email. Neither
capability is stored in plaintext by CannaBeats, and email link scanners cannot
consume the installer allowance with an ordinary GET request.

## Recipient setup

1. Open `https://poc.cannabeats.social` and expand **I have an invitation**.
2. Enter a display name and the one-time invitation, then choose **Create
   passkey** and approve the normal macOS security prompt.
3. Open the CannaBeats Host DMG and drag **CannaBeats Host** to Applications.
   For the interim build, try opening it once, then use **System Settings →
   Privacy & Security → Open Anyway** and authenticate to the Mac. Never disable
   Gatekeeper globally.
4. Open CannaBeats Host and choose **Pair this Mac**. Its ten-minute pairing
   request opens in the default browser.
5. Sign in with the new passkey, confirm the named Mac, and authorize it.
6. Return to CannaBeats Host. It should report that this Mac is authorized for
   the host account.
7. Choose **Create new game & open CannaBeats**.
8. Confirm **CannaBeats Linux Spotify source** is selected in the lobby and
   reports that it is reserved for the game. The recipient does not receive or
   store the managed Spotify account's credential.
9. Do not grant **Screen & System Audio Recording** for the normal managed-source
   path. That permission is needed only when explicitly testing the advanced
   local-Mac audio fallback.
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
