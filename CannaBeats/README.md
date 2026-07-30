# CannaBeats (iOS)

A Hitster-style family music game for iOS: blind playback of
a shuffled, no-repeat song deck via Spotify, with pause/resume, a game-master
reveal, and manual advance. Plan and rationale:
[`../plans/hitster-family-edition--ios-mvp.md`](../plans/hitster-family-edition--ios-mvp.md).

## Layout

```
CannaBeats.xcodeproj/       Xcode 16 project (folder-synced — files added on
                            disk appear in Xcode automatically)
Config/Info.plist           URL scheme for Spotify auth callback +
                            LSApplicationQueriesSchemes (merged into the
                            generated Info.plist at build time)
CannaBeats/
  CannaBeatsApp.swift       App entry; routes auth callback + scene phase
  Models/Song.swift         One catalog row (title/artist/year/genres/uri)
  Models/Catalog.swift      Module discovery, dedupe, CatalogFilter (year/genre)
  Models/GameSession.swift  Shuffled no-repeat deck, built from a filter
  Playback/PlayerModel.swift    UI-facing facade + reconnect-before-action guard
  Playback/StubBackend.swift    Fake player (logs) — active until SpotifyiOS added
  Playback/SpotifyBackend.swift Real App Remote backend (#if canImport(SpotifyiOS))
  Playback/SpotifyConfig.swift  ← paste your Client ID here
  Views/GameView.swift      The one screen (connect / hidden song / reveal)
  Views/RevealCard.swift    Title / artist / big year
  Resources/Catalog/        Playable module packs bundled into the app
catalog/years/              Research output: top ~30 US hits per year,
                            1920-2026, uri: null until resolved
tools/resolve_uris.py       Fills URIs via Spotify search (market=US)
tools/playlist_to_songs.py  Playlist → module rows exporter (alt. sourcing)
```

## Getting it running

**Stage A — game loop only (no Spotify needed, works in the simulator):**

1. Open `CannaBeats.xcodeproj` in **Xcode 16 or newer** (the project uses
   folder-synced groups). Set your signing team under
   Signing & Capabilities.
2. Run. The app uses the **stub player** (orange banner): the whole game loop —
   Connect → Next Song → pause/play → Reveal → Next — works, logging playback
   to the console instead of making sound.

*Fallback if the project file won't open:* create a fresh iOS App project named
`CannaBeats` in Xcode, delete its template sources, drag the `CannaBeats/`
source folder in, and add the two keys from `Config/Info.plist` to the target's
Info tab. ~2 minutes.

**Stage B — real audio (device + Spotify app + Premium):**

1. At [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
   create an app. Add Redirect URI `cannabeats://spotify-callback` and, under
   iOS settings, the bundle ID `social.cannabeats.app` (or whatever you
   changed it to). Development mode is fine.
2. Paste the Client ID into `Playback/SpotifyConfig.swift`.
3. Download `SpotifyiOS.xcframework` from the releases at
   [github.com/spotify/ios-sdk](https://github.com/spotify/ios-sdk) and drag it
   into the project (target: CannaBeats, **Embed & Sign**). `SpotifyBackend`
   compiles in automatically — the orange stub banner disappears.
4. Run **on a real iPhone** with the Spotify app installed and logged in to
   Premium. (App Remote cannot work in the simulator — there's no Spotify app
   to talk to; without the framework the simulator falls back to the stub.)

First "Connect Spotify" bounces to the Spotify app once, plays the warm-up
track, and returns. Every song after that starts in the background — the app
never leaves the screen, so nothing is ever visible to cover.

## The catalog (modular)

The catalog is a set of **module files** — any number of JSONs in
`Resources/Catalog/`; the app discovers, merges, and dedupes them at launch.
A module is a per-year pack, a genre pack, a theme pack — same schema:

```json
{
  "module": "year-1985",
  "name": "Hits of 1985",
  "source": "Billboard Year-End Hot 100, 1985 (top 30)",
  "songs": [
    { "title": "…", "artist": "…", "year": 1985, "genres": ["pop"], "uri": "spotify:track:…" }
  ]
}
```

`CatalogFilter` (year range and/or genres) already narrows the deck at
session build; the future round-setup UI is just controls over that filter —
e.g. a 1990–2026 range so younger players get an even field, per round.

### Pipeline: research → resolve → bundle

1. **Research** (`catalog/years/`): top ~30 US hits per year, 1920–2026, with
   hand-assigned years and genres, `uri: null`. This is source data — not
   bundled directly.
2. **Resolve** — fill URIs via Spotify search (run from a US IP; needs the
   dashboard app's client ID/secret):

```sh
SPOTIFY_CLIENT_ID=xxx SPOTIFY_CLIENT_SECRET=yyy \
  python3 tools/resolve_uris.py catalog/years/*.json \
  --out CannaBeats/Resources/Catalog/
```

   Unresolved songs stay `uri: null` (the app skips them) and are listed for
   manual fixing. Re-runs are incremental — already-resolved URIs are kept.
3. **Bundle** — resolved modules land in `Resources/Catalog/`; rebuild the
   app. Ship only the years you want by copying only those files.

- `year` is the **chart year**, hand-verified. Never trust Spotify album
  dates — remasters and compilations lie.
- ⚠️ The starter module's URIs were filled in from memory — verify or replace
  them (running the resolver over `starter.json` fixes them too).

## Game-night notes

- The host phone holds the game; lock screen / Control Center will show the
  playing track title — host keeps the phone, same trust model as the boxed
  game.
- Long debates can suspend the Spotify app and drop the connection; the app
  reconnects automatically on the next button press. If it ever wedges, a
  fresh "Connect Spotify" fixes it.
- Free Apple developer account sideloads expire after **7 days** — re-deploy
  from the Mac weekly while traveling.
