# CannaBeats access and Spotify PoC

This spike proves the risky integration boundaries without loading the game engine:

- invitation-only account enrollment;
- user-verifying, discoverable WebAuthn passkeys;
- multiple passkeys attached to one CannaBeats account;
- persistent, opaque server sessions;
- server-enforced `host` and `player` roles;
- browser-only Spotify Authorization Code with PKCE;
- browser-only Spotify refresh-token persistence and Web Playback SDK playback;
- passkey-approved pairing of a separately packaged macOS host application;
- P-256 device challenge proofs without sharing a browser cookie;
- signed-device delivery of in-memory audio-relay credentials.
- passkey-approved, revocable desktop-client installation credentials;
- signed Host creation or selection of a host-owned, four-character room in the existing game engine;
- launch into the existing rules, player, Spotify, and gameplay UI without putting a host credential in the URL;
- authenticated desktop credentials that the game service can validate directly.

The SQLite database has no Spotify columns. The server exposes only the public Spotify client ID and
redirect URI. Spotify authorization codes, access tokens, refresh tokens, and profile data go directly
between the host browser and Spotify.

## Desktop client pairing

The adjacent `../../clients/desktop-client` Tauri application starts a ten-minute device
authorization request and opens this site in the user's default browser. A signed-in account must
confirm the named installation and complete a fresh passkey assertion. The desktop app keeps the
resulting opaque credential in the operating system credential store; its bundled web UI never
receives the value.

The paired Host application creates or reopens an actual unfinished game room through a private
container-to-container API. It passes only the four-character locator to `/game?room=CODE`; the
game service derives host authority from the browser's existing passkey session. A code is never a
credential. After revocable installation pairing, the desktop client exchanges its protected
bearer credential for a one-minute, single-use launch ticket.
The game consumes that ticket into a twelve-hour HttpOnly webview session tied to the revocable
desktop credential, then renders the same authenticated gameplay client served under `/game`.

## Local development

WebAuthn treats `localhost` as a secure development context:

```sh
npm install
APP_ORIGIN=http://localhost:3002 RP_ID=localhost npm start
```

Create a host invitation in a second terminal:

```sh
APP_ORIGIN=http://localhost:3002 RP_ID=localhost npm run invite -- --role host --note "Ben"
```

Open `http://localhost:3002`, expand **I have an invitation**, and use the code once.

## Remote environment

The PoC origin and WebAuthn relying-party ID are deliberately pinned:

```text
APP_ORIGIN=https://poc.cannabeats.social
RP_ID=poc.cannabeats.social
```

Changing the hostname later creates a different WebAuthn security boundary. Passkeys registered to
this disposable hostname will not authenticate a future production hostname unless the production
deployment intentionally chooses a shared parent RP ID from the beginning.

The access service binds only to `127.0.0.1:3002`; the full game service binds only to
`127.0.0.1:3003`. Caddy terminates public HTTPS and routes `/game` to the game service while leaving
the account and Spotify callback routes on the access service. Both hardened containers share the
named SQLite volume so browser sessions, desktop credentials, room ownership, and game state have
one server-side authority boundary. A separate random token, mounted from
`/run/secrets/cannabeats/game-service-token`, protects room creation on the internal Docker network.

## Spotify setup

Create or select a Spotify developer application and register this exact redirect URI:

```text
https://poc.cannabeats.social/spotify/callback
```

Set only its public client ID in `.env`:

```text
SPOTIFY_CLIENT_ID=...
```

Do not create or deploy a Spotify client secret for this browser PKCE flow.

Each host browser profile connects Spotify independently. A refresh credential is stored in that
browser's local storage. Access credentials remain in JavaScript memory and are recreated from the
local refresh credential when required. **Disconnect locally** clears the stored credential.

## macOS host application pairing

The adjacent `../macos-host-agent-poc` SwiftUI application generates a local P-256 signing key and
asks this server for a ten-minute pairing code. A signed-in host enters that code in **CannaBeats Host
applications**, confirms the displayed application name, and completes a fresh passkey assertion. The
application then polls with a separate high-entropy secret and receives its agent identifier.

Possession is proved by signing a one-time, two-minute server challenge. The server stores only the
application public key and exposes revocation in the account interface. Pairing codes, polling
secrets, and challenge tokens are hashed or expire quickly; the application receives no Spotify
credential and no browser session cookie.

For the audio spike, a second signed one-time challenge gates
`POST /api/host-agents/relay-grant`. The endpoint reads the existing relay's
ingest and listen credentials from read-only files mounted under
`/run/secrets/cannabeats`; credentials are not stored in SQLite or exposed to
the browser. The current relay enforces static shared credentials, so the
returned grant is explicitly labeled `poc-shared-static`. Production needs
game-scoped, expiring capabilities enforced by the relay itself.

## Operational commands

The browser invitation generator is available at `/admin/host-invitations` to
signed-in accounts with the `manage_host_invitations` capability. The account
page shows its link only to those users, and both the HTML route and API enforce
the capability server-side. Administration is independent of the host/player
role and is granted explicitly:

```sh
docker compose exec app node cli.mjs admin-access list
docker compose exec app node cli.mjs admin-access grant --user-id USER_UUID
docker compose exec app node cli.mjs admin-access revoke --user-id USER_UUID
```

Generated secrets are shown once in the paste-ready email. Only their hashes
remain in SQLite. The administrator's current display name is used as the email
signature; no administrator identity is hardcoded in the application.

Create an invitation inside the running container:

```sh
docker compose exec app node cli.mjs invite --role host --note "Sibling name"
```

After a notarized CannaBeats Host DMG has been published into the read-only
release mount, generate a complete paste-ready host onboarding email from the
repository checkout:

```sh
./spikes/macos-host-agent-poc/scripts/create-host-invitation.sh \
  "Family member name" 48 5
```

This creates a one-time host-account invitation and a separate installer
capability with the same expiration and a five-download ceiling. Both are
stored only as hashes. Their email links carry capabilities in URL fragments;
the installer is delivered only after a deliberate same-origin POST, so
ordinary email link scanners cannot spend a download.

The generator fails before creating either capability when the notarized
release is absent. Publishing is handled separately by
`macos-host-agent-poc/scripts/publish-host-release.sh`, which refuses an
unstapled or Gatekeeper-rejected DMG.

Inspect health without exposing the application port publicly:

```sh
curl --fail http://127.0.0.1:3002/api/health
docker inspect --format '{{.State.Health.Status}}' cannabeats-access-poc
```

The invitation value is displayed once. SQLite stores only its SHA-256 digest. Passkey public keys,
credential counters, roles, sessions, and security audit events are stored server-side.
