# Hitster Family Edition — iOS MVP Plan

A minimal, locally-run iOS app that recreates the core loop of
[Hitster](https://hitstergame.com/en-us/) for family play: a host phone plays a
randomly selected song *blind* (no title/artist/year shown), players guess where
it falls on their timeline, then the host reveals the answer and advances to the
next song.

This is a personal-use app: sideloaded via Xcode, one host phone, no App Store
release, no backend.

**Status:** scaffolded in [`../HitsterFam/`](../HitsterFam/README.md) —
milestone 1 complete (full game loop on a stub player) with the milestone 2/3
Spotify backend pre-written behind `#if canImport(SpotifyiOS)`. Remaining
on-Mac steps: signing team, Client ID, drop in the xcframework, verify deck
URIs.

---

## 1. The confirmed gameplay loop (v1 contract)

The official Hitster app's observed loop is: Next card → scan QR → bounce to
the Spotify app to load the song → drop back to Hitster → pause/play from
Hitster. Our app supports the same loop, minus scanning (hand-written cards
represent songs on players' timelines):

1. Open our app (one-time Spotify connect happens here — see §5).
2. Tap **Next Song**.
3. App randomly selects a song from the catalog, **without repeats** in a
   session.
4. App starts the song in Spotify, keeping it **blind** — no metadata visible.
5. **Pause / resume** freely while players argue about the year.
6. When guessed, the game master advances to the next "card" (back to 2).

**One improvement over the real Hitster flow:** after the single connect
handshake at app open, App Remote plays each song *in the background* — the
phone never leaves our app on "Next Song," so there is no Spotify screen to
"cover" during song load. The blind is structural, not a race.

A **game-master reveal** stays in the design even though it's not in the loop
above: the game master needs to know title/artist/year to confirm the guess
and hand over (or write) the correct card. It's a peek, not a game phase.

Everything else in the boxed game (tokens, steal mechanics, timeline layout)
stays physical/verbal. The app is only the deck + the speaker.

---

## 2. The one hard decision: how to play Spotify audio

| Option | Full tracks? | Requirements | Verdict |
|---|---|---|---|
| **Spotify iOS SDK (App Remote)** | ✅ | Spotify app installed + **Premium** on host phone; free dev-dashboard app registration | **✅ MVP choice** |
| Spotify Web API `preview_url` (30s clips via AVPlayer) | ❌ 30 s | None | ❌ Deprecated for new apps (Nov 2024); unreliable |
| Spotify Web Playback SDK | ✅ | Browser/EME environment | ❌ Not viable in a native iOS app |
| Apple Music (MusicKit) | ✅ | Apple Music subscription | 🟡 Documented fallback — see §8 |

**App Remote** works by remote-controlling the installed Spotify app: our app
sends `play(trackURI)`, `pause()`, `resume()`; audio comes out of the Spotify
app. This is exactly the level of control the game needs, and it means we never
touch audio buffers, DRM, or streaming ourselves.

Consequences to accept:

- The **host phone's** Spotify account must be Premium (on-demand playback of a
  specific track is Premium-only). **Confirmed available.** Only the host
  authorizes — other players need nothing.
- Internet required (fine — this works the same in Italy as at home).
- The Spotify app's own UI and the lock screen / Control Center **will show the
  track title** while playing. Mitigation is procedural, same as the real game:
  the host holds the phone and nobody looks. (Optional hardening later:
  reveal-screen-only design where the host keeps our app foregrounded.)
- App Remote connections drop when the Spotify app is backgrounded too long;
  the controller needs a simple reconnect-on-demand path (§5).

---

## 3. The song corpus: a bundled, hand-curated JSON file

**Do not derive the year from Spotify metadata at runtime.** Spotify album
release dates are notoriously wrong for this game (remasters, compilations,
"greatest hits" re-releases). The known-good approach — and the reason Hitster
cards work — is a **curated list with hand-verified original release years**.

Bundle a single `songs.json` in the app:

```json
[
  {
    "title": "Superstition",
    "artist": "Stevie Wonder",
    "year": 1972,
    "uri": "spotify:track:1h2xVEoJORqrg71HocgqXd"
  }
]
```

- `uri` is the Spotify track URI (copyable from the Spotify app:
  Share → Copy Link, then convert, or via a one-off script).
- Target **150–300 songs** spread across decades (1950s–2020s) for real games;
  **20 songs** is enough to build and test the app.
- Corpus building is data work, not app work (§7). Updating the corpus = edit
  JSON, rebuild — acceptable for personal use.

---

## 4. App architecture (SwiftUI, iOS 16+, single target)

Deliberately tiny — three source files of logic, two of views:

```
HitsterFam/
  Models/
    Song.swift            # Codable struct matching songs.json
    GameSession.swift     # ObservableObject: the shuffled deck + cursor
  Playback/
    SpotifyController.swift  # wraps SPTAppRemote: connect/auth, play, pause, resume
  Views/
    GameView.swift        # the one main screen
    RevealCard.swift      # title / artist / big year
  Resources/
    songs.json
```

### GameSession (the deck)

- On session start: load `songs.json`, `shuffle()` once, keep an index.
- `currentSong`, `advance()`, `songsRemaining`. No repeats until the deck is
  exhausted; then offer "reshuffle and start over."
- Plain `SystemRandomNumberGenerator` — no seeding or reproducibility needed.
- Entire game state is in-memory. Killing the app resets the game. Fine.

### GameView (the whole UI)

One screen, three states, big touch targets (this gets used at a dinner table):

1. **Not connected** → "Connect Spotify" button → auth/connect flow (§5).
   Done once at app open, *before* any real song is in play.
2. **Song armed (hidden)** → ▶️/⏸ toggle, **Reveal** button, songs-remaining
   count. *Nothing else* — no title, no artwork, no progress bar (a progress
   bar leaks song-length information; omit it).
3. **Revealed** → `RevealCard` with title / artist / year in huge type — the
   game master's peek for confirming the guess and handing over the right
   hand-written card — and a **Next Song** button that advances the deck and
   immediately starts the next track hidden.

### Playback behavior

- "Next" = `appRemote.playerAPI.play(uri)` — starts at 0:00. Playing from the
  top is standard Hitster behavior; intros are part of the game.
- Pause/resume map 1:1 to App Remote calls.
- No seek, no volume, no queue. The Spotify app owns all of that.

---

## 5. Spotify integration specifics

One-time setup (host developer account):

1. Create an app at developer.spotify.com/dashboard → get **Client ID**.
2. Add a **Redirect URI** (e.g. `hitsterfam://spotify-callback`) and the app's
   **iOS Bundle ID** in the dashboard.
3. Development mode is fine — only the host's own Premium account authorizes.

In Xcode:

- Add the **SpotifyiOS** framework (xcframework from
  `spotify/ios-sdk` on GitHub; drag-in or SPM if available).
- `Info.plist`: register the `hitsterfam` URL scheme (for the auth callback)
  and add `spotify` to `LSApplicationQueriesSchemes` (so we can wake the
  Spotify app).

`SpotifyController` responsibilities:

- `connect()` → `authorizeAndPlayURI(...)` handshake: bounces to the Spotify
  app **once, at app open**, returns via the redirect URI with an access
  token, establishes the App Remote connection. This is the only moment the
  Spotify UI is ever visible, so the URI bundled into the handshake must be a
  **neutral warm-up track** (a game "theme song"), *never* the first deck
  song — the Spotify screen briefly shows whatever it was asked to play.
  After the handshake, every game song starts via a background
  `playerAPI.play(uri)` with our app foregrounded: nothing to cover, nothing
  leaks.
- Delegate callbacks → published `isConnected` / `isPaused` state for the UI.
- **Reconnect path:** App Remote disconnects if the Spotify app is suspended
  (e.g., long pause while players debate). Every user action (`play`, `pause`,
  `next`) goes through a guard: if disconnected, reconnect first, then perform
  the action. This must be automatic — the host should never see a raw
  "not connected" error mid-game.

---

## 6. Build order

| # | Milestone | Proves |
|---|---|---|
| 1 | Xcode project + `songs.json` (20 songs) + `GameSession` + full UI with a **stub player** (logs instead of audio) | Whole game loop works on-device with fake audio |
| 2 | Spotify SDK: auth handshake + play/pause of one hardcoded URI | The only risky integration, isolated |
| 3 | Wire deck → controller; reveal flow; reconnect guard | Playable MVP 🎉 |
| 4 | Corpus expansion to 150–300 songs (§7) | A real game night |
| 5 | Polish only if wanted: decade filter, played-song history list | — |

Milestones 1–3 are roughly an evening each. The app is intentionally boring;
the corpus (4) is where the real effort and the fun is.

---

## 7. Corpus building (data task, parallel to milestones 2–3)

Fastest workflow:

1. Build/choose Spotify **playlists** of candidate songs (one per decade works
   well, and the family can contribute from their phones).
2. One-off script (any language, Web API client-credentials flow) exports each
   playlist to JSON rows: title, artist, album release year (as a *first
   guess*), URI.
3. **Hand-verify the years** — this is the step that makes the game good.
   Wikipedia single/album release dates are the reference. Expect to correct
   10–20% of them.
4. Concatenate into `songs.json`.

---

## 8. Fallback: Apple Music / MusicKit

If Premium turns out to be unavailable on the trip, MusicKit +
`ApplicationMusicPlayer` is the plan-B with the *same app shell*: swap
`SpotifyController` for a `MusicKitController` behind the same 4-method
protocol (`connect / play(id) / pause / resume`), and store Apple Music song
IDs in the corpus alongside Spotify URIs. Requires an Apple Music
subscription and the MusicKit capability on the app ID — but no third-party
SDK and no dashboard registration. Not built in the MVP; the protocol seam
(§4) is the only accommodation made for it.

---

## 9. Explicit non-goals (MVP)

- No score/timeline tracking in-app — tokens and timelines stay physical.
- No multi-phone / party mode, no backend, no accounts.
- No QR cards, no printed components.
- No offline caching of audio (impossible with Spotify anyway).
- No App Store distribution. Xcode sideload only. **Note:** with a free Apple
  developer account, a sideloaded build expires after **7 days**; a paid
  account ($99/yr) gives 1 year. On a multi-week trip with a free account,
  plan to re-deploy from the Mac weekly.

## 10. Known risks

| Risk | Mitigation |
|---|---|
| No Premium on host account | §8 MusicKit fallback, or upgrade for a month |
| App Remote disconnects mid-game | Reconnect-before-action guard (§5) |
| Lock screen leaks track title | Host holds the phone (same trust model as the real game) |
| Wrong years from Spotify metadata | Hand-verified corpus; never trust album dates (§3) |
| 7-day free-provisioning expiry | Weekly re-deploy, or paid dev account |
| Track URI dead/region-locked in Italy | "Next Song" is always one tap away; skip and move on |
