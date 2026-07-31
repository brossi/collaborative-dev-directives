# CannaBeats web game

The browser-based host and player experience for CannaBeats. A host creates a
four-character room code, family members join from their phones, and play moves
around the room one player at a time.

The visual system is based on the original `public/cannabeats-logo.jpg` concept
art: warm cream paper, tomato red, cobalt blue, golden yellow, and vintage print
texture.

## Run locally

```sh
npm install
npm run dev
```

Open the printed local address in one tab to host. Open additional tabs or
devices to join; each tab keeps its own temporary room identity.

The development server regenerates `data/catalog.json` from the iOS app's
`../catalog/years/` source before starting. Only songs with playable Spotify
URIs are included.

## Current game loop

1. The host creates a room and players join by QR code or manual room code.
2. Every player receives one revealed anchor song.
3. The host opens the mystery track in Spotify.
4. The active player chooses and locks an insertion point on their phone.
5. The host reveals the answer; the server validates the placement.
6. Correct cards stay in the timeline. The first player to ten wins.

Room state is stored in one D1 table and clients poll it every 1.2 seconds. This
is intentionally simpler than a socket layer and is sufficient for the family
prototype.

## Checks

```sh
npm test
npm run lint
```
