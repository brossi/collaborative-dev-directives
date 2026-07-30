# HitsterFam — Hitster Family Edition (iOS)

A minimal iOS app that replaces the Hitster expansion decks: blind playback of
a shuffled, no-repeat song deck via Spotify, with pause/resume, a game-master
reveal, and manual advance. Plan and rationale:
[`../plans/hitster-family-edition--ios-mvp.md`](../plans/hitster-family-edition--ios-mvp.md).

## Layout

```
HitsterFam.xcodeproj/       Xcode 16 project (folder-synced — files added on
                            disk appear in Xcode automatically)
Config/Info.plist           URL scheme for Spotify auth callback +
                            LSApplicationQueriesSchemes (merged into the
                            generated Info.plist at build time)
HitsterFam/
  HitsterFamApp.swift       App entry; routes auth callback + scene phase
  Models/Song.swift         Codable row of songs.json
  Models/GameSession.swift  Shuffled no-repeat deck
  Playback/PlayerModel.swift    UI-facing facade + reconnect-before-action guard
  Playback/StubBackend.swift    Fake player (logs) — active until SpotifyiOS added
  Playback/SpotifyBackend.swift Real App Remote backend (#if canImport(SpotifyiOS))
  Playback/SpotifyConfig.swift  ← paste your Client ID here
  Views/GameView.swift      The one screen (connect / hidden song / reveal)
  Views/RevealCard.swift    Title / artist / big year
  Resources/songs.json      The starter deck (18 songs)
tools/playlist_to_songs.py  Playlist → songs.json exporter (corpus building)
```

## Getting it running

**Stage A — game loop only (no Spotify needed, works in the simulator):**

1. Open `HitsterFam.xcodeproj` in **Xcode 16 or newer** (the project uses
   folder-synced groups). Set your signing team under
   Signing & Capabilities.
2. Run. The app uses the **stub player** (orange banner): the whole game loop —
   Connect → Next Song → pause/play → Reveal → Next — works, logging playback
   to the console instead of making sound.

*Fallback if the project file won't open:* create a fresh iOS App project named
`HitsterFam` in Xcode, delete its template sources, drag the `HitsterFam/`
source folder in, and add the two keys from `Config/Info.plist` to the target's
Info tab. ~2 minutes.

**Stage B — real audio (device + Spotify app + Premium):**

1. At [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   create an app. Add Redirect URI `hitsterfam://spotify-callback` and, under
   iOS settings, the bundle ID `com.rossinet.hitsterfam` (or whatever you
   changed it to). Development mode is fine.
2. Paste the Client ID into `Playback/SpotifyConfig.swift`.
3. Download `SpotifyiOS.xcframework` from the releases at
   [github.com/spotify/ios-sdk](https://github.com/spotify/ios-sdk) and drag it
   into the project (target: HitsterFam, **Embed & Sign**). `SpotifyBackend`
   compiles in automatically — the orange stub banner disappears.
4. Run **on a real iPhone** with the Spotify app installed and logged in to
   Premium. (App Remote cannot work in the simulator — there's no Spotify app
   to talk to; without the framework the simulator falls back to the stub.)

First "Connect Spotify" bounces to the Spotify app once, plays the warm-up
track, and returns. Every song after that starts in the background — the app
never leaves the screen, so nothing is ever visible to cover.

## The deck (`Resources/songs.json`)

```json
{ "title": "…", "artist": "…", "year": 1985, "uri": "spotify:track:…" }
```

- `year` must be the **original release year**, hand-verified (Wikipedia).
  Never trust Spotify album dates — remasters and compilations lie.
- ⚠️ **Verify the starter deck's URIs before game night.** They were filled in
  from memory and some may be wrong or region-locked. Quickest check: play
  through the deck once in stub-free mode; a wrong URI simply errors/skips.
  Best fix: rebuild the deck from your own playlist:

```sh
SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy \
  python3 tools/playlist_to_songs.py https://open.spotify.com/playlist/XYZ \
  > HitsterFam/Resources/songs.json
```

then hand-fix the years. A good real deck is 150–300 songs spread across
decades; family members can contribute to the playlist from their own phones.

## Game-night notes

- The host phone holds the game; lock screen / Control Center will show the
  playing track title — host keeps the phone, same trust model as the boxed
  game.
- Long debates can suspend the Spotify app and drop the connection; the app
  reconnects automatically on the next button press. If it ever wedges, a
  fresh "Connect Spotify" fixes it.
- Free Apple developer account sideloads expire after **7 days** — re-deploy
  from the Mac weekly while traveling.
