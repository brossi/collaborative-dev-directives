# CannaBeats web game

The browser-based host and player experience for CannaBeats. Every room can mix
players joining from their phones with players entered by the host to use the
shared screen. Play moves around the room one player at a time.

The visual system is based on the original `public/cannabeats-logo.jpg` concept
art: warm cream paper, tomato red, cobalt blue, golden yellow, and vintage print
texture.

## Play on the local network

For family play, use the production-style local server. It sends phones a
small, optimized client instead of development and hot-reload code:

```sh
npm install
npm run play:lan
```

Open the printed private host address (`http://127.0.0.1:3000`) on the host
computer, connect Spotify, and create a game. Add shared-screen players by name
and let phone players scan the QR code. The QR code uses the separately printed
network address so player phones can reach the room without receiving the
host's Spotify token. Keep this terminal running and the computer awake while
playing.

Spotify's developer dashboard must allow this exact redirect URI:

```text
http://127.0.0.1:3000/
```

The local runner reuses the client ID from
`../CannaBeats/Resources/SpotifyClientID.txt`. Browser playback requires the
host to authorize a Spotify Premium account. The Web Playback SDK runs with its
media-session metadata disabled, and mystery titles are not rendered until the
host reveals the answer.

## Develop locally

```sh
npm install
npm run dev
```

Open the printed local address in one tab to host. Open additional tabs to
join; each tab keeps its own temporary room identity. To expose the hot-reload
development server to phones, use `npm run dev:lan`; expect it to be slower than
`npm run play:lan` on mobile devices.

The development server regenerates `data/catalog.json` from the iOS app's
`../catalog/years/` source before starting. Only songs with playable Spotify
URIs are included.

## Current game loop

1. The host creates a room, enters shared-screen players by name, and lets phone
   players join by QR or room code.
2. On the hosted deployment, the host may reserve the managed Spotify source
   for this game or continue using Spotify on the host device.
3. The game gives every player an anchor song, randomly chooses who starts, and
   prepares the first mystery song without playing it.
4. The host announces the first player and starts the song when everyone is
   ready.
5. The active player chooses and locks an insertion point using the control
   assigned to them: the shared host timeline or their phone.
6. The host or any authenticated member can pause/resume managed playback for
   everyone. Track selection remains controlled by host-only game actions.
7. The host reveals the answer; the server validates the placement.
8. Correct cards stay in the timeline. The first player to ten wins.

Room, membership, managed-source lease, and playback-command state are stored
server-side, and clients poll every 1.2 seconds. This is intentionally simpler
than a socket layer and is sufficient for the family prototype. Spotify and
relay credentials are not stored in game tables.

## Checks

```sh
npm test
npm run test:do
npm run lint
```
