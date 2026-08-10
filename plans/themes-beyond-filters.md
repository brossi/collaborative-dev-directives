# Themes Beyond Filters — CannaBeats Round Setup

How to get from "the deck is every song, shuffled" to *1980s night*, *Movie
soundtracks*, *One-hit wonders*, *Songs the parents should know*, *Songs the
kids should know*, *Summer road trip*, *British versus American*, *Family
favourites*, and *Generations*.

**Planning document — no code changed.** Target is the web app
(`web/`, branch `feature/interactive-gameplay`), which is where the
multi-player timeline game now lives. The iOS app's `CatalogFilter` has the
same shape of problem and the same answer, but is not what this plans.

---

## 1. The nine themes are four different mechanisms

The load-bearing observation: these are not nine instances of one feature. Sorting
them by *what the game has to know* to draw the next song:

| Mechanism | Themes | What it needs |
|---|---|---|
| **A. Filter** — predicate over fields the catalog already has | 1980s night, Movie soundtracks | Nothing new. Ship first. |
| **B. Tag** — predicate over an attribute the catalog does *not* have | One-hit wonders, British vs American, Summer road trip, Family favourites | A new data layer, one sourcing job per tag |
| **C. Player-relative** — the predicate depends on *who is playing* | Songs the parents should know, Songs the kids should know | Player age band, captured at join |
| **D. Scheduled** — the theme changes *per round* | Generations, British vs American (as a versus mode) | A turn-aware selector; theme state in the room |

Mechanism D is the one that breaks the current architecture. A filter is a
`boolean` over a song. *Generations* is not — it is a rule about the **sequence**
of songs. Any design that models a theme as `Song => boolean` can express five of
these nine and will have to be rewritten for the other four.

**So: a theme is a selector, not a filter.**

```
pick(catalog, roomState, round) => Song
```

with a theme supplying two parts:

```ts
type Theme = {
  id: string;
  name: string;
  blurb: string;                                  // shown at setup
  scope(song, ctx): boolean | number;             // 0 = excluded, >0 = weight
  bucketFor?(round, state): ThemeBucket | null;   // D: what this round draws from
};
```

`ctx` carries the room: players, their age bands, the round, the active player.
A pure filter theme just ignores `ctx` and omits `bucketFor`. Nothing is
over-built for mechanism A — the same signature is what B, C and D need, and
four of the nine require it.

---

## 2. What is actually in the catalog today (verified this session)

Counted over `catalog/years/*.json` + `catalog/themes/*.json`, deduped by URI:

| Fact | Value |
|---|---|
| Catalog rows | 3,616 |
| Rows with a Spotify URI | 3,032 |
| Playable songs after URI dedupe | **2,944** |
| Distinct artists (playable) | 1,607 |
| Distinct genre tags | 31 |
| Rows missing `genres` | 0 |
| Songs the **web app** can actually see | **2,863** |

Per decade (playable, deduped):

| 1920s | 1930s | 1940s | 1950s | 1960s | 1970s | 1980s | 1990s | 2000s | 2010s | 2020s |
|---|---|---|---|---|---|---|---|---|---|---|
| 267 | 283 | 282 | 218 | 275 | 271 | 280 | 280 | 284 | 305 | 199 |

Every song row carries `title`, `artist`, `year`, `genres[]`, `uri`. There is
**no** field for nationality, tempo/mood, chart-run length, or family rating.
That is the whole of the gap between where we are and the nine themes.

---

## 3. Phase 0 — the three things that block *every* theme

None of these are theme features. All three must land before any theme can work,
and each is small.

### 3.1 The web catalog throws away everything a theme needs

`web/scripts/build-catalog.mjs` reads **only** `../catalog/years`, and copies
only `title`, `artist`, `year`, `uri` (lines 6, 21–27). Two consequences:

- `genres` never reaches the web app → *Movie soundtracks* is not expressible.
- `catalog/themes/*.json` is never read → the four curated theme packs that
  already exist (`film-soundtracks`, `oscar-songs`, `tv-soundtracks`,
  `tony-musicals`) are **invisible to the web game**, despite 169 playable songs
  in them.

Fix: read both directories, carry `genres`, and carry the source `module` id so
a theme can say "this pack" without re-deriving it from genres. Dedupe by URI —
the theme packs overlap the year packs (3,032 rows collapse to 2,944 songs), and
without dedupe a song could appear twice in one player's timeline.

### 3.2 The selector is hard-coded and the room has no theme

`pickSong` in `web/app/api/game/route.ts:58` is uniform random over the whole
catalog minus `usedUris`. `RoomState` (`web/lib/game.ts:21`) has no theme field.

Fix: `RoomState.theme: { id: string; params?: Record<string, unknown> }`, chosen
by the host at `create` (or in the lobby before `start`), validated server-side
against the theme registry, and defaulting to `everything` so existing rooms and
tests keep working. Then `pickSong` becomes `pick(catalog, state, round)` and
consults the theme.

Theme identity must live in room state, not client-side — the client already
cannot be trusted with the current song (`roomView` strips it for non-hosts), and
the same reasoning applies to the draw.

### 3.3 A narrow theme makes catalogue exhaustion a real failure, not a theory

`pickSong` throws `"The playable catalogue is exhausted."` when the filtered pool
empties (`route.ts:62`) — surfacing as a 500 from `start`, `advance`, or `skip`,
**mid-game**, with the room left unplayable. With 2,863 songs and no filter this
never fires. With *One-hit wonders* narrowed to, say, 80 songs and a long
five-player game it becomes reachable.

Fix, two parts:

- **Setup-time guard:** compute the pool size when the theme is chosen and
  refuse to start below a floor, naming the number: *"Summer road trip has 41
  playable songs — that isn't enough for 4 players (need ~60)."* A wrong theme
  should be rejected in the lobby, never at round 23.
- **Run-time fallback:** when a *scheduled* theme's bucket is empty but the
  overall pool is not (a real case for *Generations* — see §6), fall back to the
  next bucket rather than failing. Log which, so the host can see it happened.

Sizing the floor: a game ends when someone holds 10 cards, so a round is consumed
per song regardless of who places it. `N` starter cards plus one song per round,
with wrong placements consuming songs without growing a timeline. **~60 playable
songs is a safe floor for 4 players; ~100 is comfortable.** Every theme below is
scored against that number.

---

## 4. Phase 1 — the themes that need no new data

Available the moment Phase 0 lands.

| Theme | Rule | Pool | Verdict |
|---|---|---|---|
| **1980s night** | `1980 <= year <= 1989` | 280 | ✅ ample |
| Any decade night | year range | 199–305 | ✅ ample (2020s thinnest at 199) |
| **Movie soundtracks** | `genres` includes `soundtrack`, **or** module ∈ {film, tv, oscar, tony} packs | 160 by genre; ~169 by pack | ✅ ample |
| Summer road trip | curated pack — see §5.3 | — | 🟡 needs a pack authored |

Two design notes that fall out of *1980s night*:

- **A narrow year range makes the game harder, not easier.** Every card is
  1980–89, so placement is fine-grained rather than "before or after the 70s".
  This is a feature, but it changes the difficulty of a round materially and the
  setup blurb should say so.
- **The theme name leaks information.** Announcing "1980s night" tells every
  player the decade of every card. For decade themes that is the point. For a
  future *hidden* theme mode it would not be — worth keeping the display name and
  the selector rule as separate fields (as §1's `Theme` already does) so a theme
  can be run unannounced later without restructuring.

`CatalogFilter` in the iOS app already covers year range + genre. Phase 1 is the
web app catching up to it, then both gaining the rest.

---

## 5. Phase 2 — the tag layer

### 5.1 Where tags live: sidecar files, never in the year packs

`catalog/years/*.json` is hand-verified chart data — the README is explicit that
`year` is the chart year and that Spotify's dates lie. Derived, regenerable, or
curated attributes must not be interleaved with it, or a bad tagging run
corrupts the one thing in this repo that is expensive to reconstruct.

Proposal — a third source-of-truth directory alongside `years/` and `themes/`:

```
catalog/tags/
  artists.json     { "<normalised artist>": { "country": "GB", "source": "musicbrainz", ... } }
  songs.json       { "spotify:track:…": { "mood": ["driving"], "oneHitWonder": true, ... } }
```

- Artist-level tags key on `norm(primary_artist(artist))` — both functions already
  exist in `tools/_common.py` and are what the fill pipeline uses to match, so
  tag joins and URI fills succeed and fail together instead of diverging.
- Song-level tags key on the Spotify URI, which is stable and already the dedupe
  key.
- Every tag record carries its `source`, so a hand-curated call is
  distinguishable from a scraped one when it turns out to be wrong.
- `build-catalog.mjs` joins tags at build time; the runtime never joins.
- The two-directory rule extends unchanged: `catalog/tags/` is source,
  `web/data/catalog.json` and `Resources/Catalog/` are build products.

### 5.2 British versus American — MusicBrainz, free, ~27 minutes

MusicBrainz publishes an artist `country` field, requires no credentials, and
does not touch the Spotify quota. Its documented rate limit is **1 request per
second per IP** (50/s per user-agent, 300/s global), enforced with 503s and
temporary IP blocks, and it requires a descriptive `User-Agent` with contact
details.

1,607 distinct playable artists at 1 req/s ≈ **27 minutes** for a full pass —
and it is a one-time job whose output is committed. Per repo policy the tool
pauses on `Retry-After`, logs every sleep, sets a timeout, and resumes from
partial output, exactly like `resolve_uris.py`.

Judgement calls to make before running it, not after:

- MusicBrainz `country` is the artist's *area*, not the members' nationalities.
  Fleetwood Mac is the standing example of a band this labels arguably wrong.
- Groups vs persons need different treatment (`begin-area` for persons is often
  the useful field).
- Name matching against 1,607 catalog artist strings — many with "featuring",
  "and His Orchestra", "&" — will produce misses. Expect a manual residue and
  budget for reviewing it rather than trusting a silent 80% hit rate.

Then: `versus` mode is `country == "GB"` alternating with `country == "US"` by
round — mechanism D, sharing the scheduler with *Generations* (§6).

### 5.3 Summer road trip — curate it, do not compute it

The obvious implementation is Spotify's `/audio-features` (tempo, energy,
valence). **That endpoint is gone.** Spotify deprecated `/audio-features` and
`/audio-analysis` on 27 November 2024; apps without a pre-existing quota
extension get 403, there is no waitlist and no replacement, and extended access
is not granted below a 250K MAU threshold. This app will never qualify. Any plan
routed through live audio features is dead on arrival.

Two live options:

1. **Curate a pack** (recommended) — `catalog/themes/road-trip.json`, same schema
   as the four existing theme packs, filled by the existing offline pipeline
   (`fill_from_datasets.py` → `verify_uris.py` → `resolve_uris.py` for the
   residue). ~80–120 songs. This is a taste judgement about what a family sings
   in a car; it is *better* hand-made, and it costs no new machinery at all.
2. **Import audio features from an offline dataset** — pre-2024 Kaggle Spotify
   dumps carry tempo/energy/valence per track ID. `tools/csv_to_mappings.py`
   already ingests exactly this shape of CSV, so the marginal work is a variant
   that writes `catalog/tags/songs.json` instead of URI mappings. Use as an
   *assist* for candidate generation, not as the rule.

Route trip is the template for any future mood theme (party, chill, singalong):
a curated pack, not a computed one.

### 5.4 One-hit wonders — the cheap proxy does not work

The tempting rule is "artist appears exactly once in the catalog." Measured:
**1,144 of 1,607 playable artists appear exactly once — 71%.** A filter that
admits 71% of the catalog is not a theme, it is a rounding error away from
"everything". The catalog is top-~30-per-year, so appearing once means "had one
big hit *in this deck*", which is not the same claim at all.

Real path: import a curated list — Wikipedia is the likely source «unverified: I
have not confirmed the existence, shape, or licence of a specific US/UK
one-hit-wonder list this session; check before committing to it, and have a
hand-authored fallback» — match it against catalog artists, hand-review the residue, and write
`oneHitWonder: true` into `catalog/tags/songs.json` with `source` recorded. Expect
to keep only what matches an artist already in the deck — the pool has to clear
the ~60-song floor of §3.3, and if it does not, the honest move is to widen the
catalog rather than to loosen the definition.

### 5.5 Family favourites — a room feature, not a catalog feature

This is the only theme whose data is per-household, so it does not belong in
`catalog/` at all. It also has no natural home in the current app: there are no
user accounts, and the room is ephemeral (`rooms` table, keyed by a 4-character
code, `web/db/schema.ts`).

Smallest honest version: a "keep this one" control on the host's reveal screen,
writing `(householdId, uri)` to a new D1 table; *Family favourites* draws from
that table. `householdId` has to come from somewhere — a host-chosen household
name, or a token persisted in the host browser's `localStorage` (the app already
persists player name that way — key in `web/lib/session.ts:9`, write at
`web/app/page.tsx:84`).

This is the highest-effort and lowest-certainty of the nine, and it is the one
that only pays off after several game nights have populated it. **Sequence it
last**, and treat the persistence question as genuinely open.

---

## 6. Phase 3 — scheduled themes

*Generations* and *versus* modes need the room to carry theme state across
rounds, and need the selector to answer "what does **this** round draw from?"

```ts
state.theme = {
  id: "generations",
  params: { bands: [[1955,1975],[1976,1995],[1996,2026]] },
  cursor: 0,          // advances each round
};
```

`bucketFor(round, state)` returns the band at `cursor`, the selector filters to
it, and `advance` rotates the cursor. Falling back on an empty bucket (§3.3)
means skipping to the next band rather than 500ing.

**Where the bands come from is the interesting question**, and it is the same
question *Songs the parents should know* asks.

### 6.1 Player-relative themes need an age band at join

*Parents should know* / *kids should know* / *Generations* are all the same
underlying rule: **each player has a musical territory, derived from when they
grew up.** Given that, all three fall out:

| Theme | Rule |
|---|---|
| Songs the kids should know | draw from the youngest cohort's window |
| Songs the parents should know | draw from the oldest cohort's window |
| Generations | rotate the window across cohorts, one per round |

The window is `birthYear + lo` to `birthYear + hi`. The usual heuristic is that
musical formation peaks somewhere in the teens — commonly cited as roughly ages
10–20 «unverified: I have not checked a source for the reminiscence-bump range
this session; treat `lo`/`hi` as tunable constants and validate them against a
real game night, not as a fact». Ship them as named constants with the window
visible in the setup blurb ("Songs from when Mum was 10–20: 1985–1995") so a
wrong window is obvious and correctable at the table rather than silently baked
into the draw.

Capture, at join: an **age band**, not a birth date. A dropdown of decades of
birth, or even three buttons (kid / parent / grandparent) mapped to windows the
host can adjust. It is a family game on a phone in a living room — a
year-of-birth field is both more friction and more personal data than the feature
needs. Player-visible: everyone can see everyone's band, so there is no
confidentiality claim to get wrong.

`Player` (`web/lib/game.ts:10`) gains one optional field; `join` accepts it;
themes that do not use it ignore it.

### 6.2 The fairness consequence, stated plainly

*Songs the kids should know* makes the round easy for the kids and hard for
everyone else. That is the intent — it is the handicap system the boxed game
lacks. But it means a scheduled theme like *Generations* is **not** a neutral
shuffle: whoever's band is up has an advantage that round, so the schedule must
be tied to turn order (each player gets their own band the same number of times)
rather than rotating freely. Decide this at design time; it is invisible in code
review and extremely visible at the table.

---

## 7. AI-assembled lists versus real-time filtering

**This is not an alternative architecture — it is a better way to fill the tag
layer of §5.** The `catalog/tags/` file shapes do not change; what changes is who
writes them. Adopting it leaves Phase 0 untouched and deletes most of the
sourcing work in Phases 4–5.

The right split is not *AI vs filtering*. It is:

> **Lists supply membership. The runtime supplies sequencing and state.**

### 7.1 What the runtime must keep regardless of how good the lists get

| Concern | Why it cannot be baked into a list |
|---|---|
| Year maths (decade themes, placement scoring) | Exact, free, and the catalog is the authority. Never ask a model what year a song charted. |
| No-repeat (`usedUris`) | Per-room mutable state |
| *Generations* rotation | A rule about the **sequence**, not about any song. §1's mechanism D survives intact. |
| Pool-size guard (§3.3) | Must count the *live intersection* of theme × unused × available |

### 7.2 The dividing line: taste versus fact

This is the whole design, and it is sharp.

| Kind of tag | Themes | Source | Why |
|---|---|---|---|
| **Taste / canon** — no ground truth exists | Summer road trip, Songs the kids/parents should know, Family-friendly | **LLM, no review needed beyond a read-through** | The judgement *is* the deliverable. There is nothing to be wrong about. |
| **Fact, authoritative source is free** | British vs American | **MusicBrainz first, LLM for the residue only** | A right answer exists and is free to fetch (§5.2). LLM fills the ~name-match misses, marked lower-confidence. |
| **Fact, no free source** | One-hit wonders | **LLM proposes, human accepts/rejects** | A right answer exists but costs to obtain. Candidate pool is small enough to review by hand. |
| **Hand-verified chart data** | `year` | **Never touched by any generated pass** | The README is explicit that even Spotify's dates lie about this. It is the one expensive-to-reconstruct thing in the repo. |

### 7.3 Why the risk here is much lower than general LLM generation

The pass is **classification over a closed set of 2,944 songs we already hold**,
not generation. It cannot invent a track, misattribute a URI, or hallucinate a
release year, because it is labelling rows from a list we supply and we join its
output back on the URI. A wrong *label* is reviewable and revertible; a
fabricated *track* would not be. That collapses the failure mode that usually
makes this idea unwise.

Sizing, measured this session: the full playable catalog rendered as
`Title — Artist (Year)` is **124,792 characters, ≈35k tokens**. The entire deck
fits in one context window — the model can see every song at once and make
*relative* judgements ("the 40 most road-trip-ish of these"), which is exactly
what produces a coherent deck rather than 2,944 independent coin-flips. Batching
is driven by **output** limits, not input: send full context, take back a few
hundred labelled rows per call. One theme is a handful of calls, entirely offline,
at build time.

### 7.4 The failure mode that is left, and the structural mitigation

An LLM pass never returns "not found". It returns confident, uniform, plausible
output *including where it is wrong* — unlike a scraper, which fails loudly. Three
requirements follow, none optional:

1. **Provenance on every record.** `source: "llm"`, model id, prompt version,
   confidence. A bad pass must be identifiable and revertible afterwards, not
   indistinguishable from curated truth.
2. **Generated and hand-corrected data in separate files.**
   `catalog/tags/songs.generated.json` (regenerable, overwritten freely) and
   `catalog/tags/overrides.json` (hand, wins on conflict, **never** written by a
   tool). A regeneration that silently destroys a human's corrections is exactly
   the irreproducible-artifact loss the repo's guards exist to prevent.
3. **Spot-check a random sample before trusting a pass** — and record that you
   did, with the sample size. Uniform-looking output invites uniform trust.

### 7.5 Two shapes of list — and the repo already has both

| Shape | Already in the repo as | Use for |
|---|---|---|
| **Materialised deck** — an explicit song list | `catalog/themes/*.json` (4 packs) | A one-off vibe nobody will intersect: *Summer road trip*. Reviewable *as a deck* — you can ask "does this feel right as a whole?", which a tag list never lets you ask. |
| **Tag layer** — multi-label per song | `genres[]` (31 tags) | Anything that must **compose**: country × decade × canon. *1980s British night* is free; as decks it is a new deck. |

Default to tags; use a curated pack when the deck's coherence *as a set* is the
point. Both already exist, so neither is new machinery.

### 7.6 Where this fixes the weakest part of this plan

*Songs the kids should know* modelled as a birth-year window (§6.1) is mechanical,
and I had to tag its central constant «unverified». Read as a **canon** judgement
— what a child ought to have heard — it is a taste question an LLM answers well
and a year range answers badly.

**This is an interpretation branch worth settling explicitly:** *era* (songs from
when they were young) or *canon* (songs they ought to know)? They select very
different decks. The strongest version is canon list ∩ optional era window, which
keeps §6.1's machinery for *Generations* — which genuinely is about eras — while
letting the two "should know" themes be about cultural literacy.

### 7.7 Runtime theme authoring — and why the hosting move decides its cost

The app is currently a ChatGPT app on Cloudflare (`web/.openai/hosting.json` has a
`project_id` and the D1 binding; `web/vite.config.ts` imports it). **That is
stated to be temporary — the target is a Linux app on a DigitalOcean Droplet.**
Plan for the Droplet; treat anything the ChatGPT hosting hands you for free as a
loan.

**The idea itself survives the move: let a model author themes at setup, never
draw songs during play.** The host types *"songs for a rainy Sunday"* or *"stuff
my mum would sing along to"*; the model assembles a candidate deck **from the
catalog**; the host reviews and approves it in the lobby; it is frozen into
`RoomState` as a materialised URI list before `start`. Generation at setup,
determinism during play. This turns the nine fixed themes into an open set with no
new data pipeline, and it is the strongest form of the idea.

What the move changes is what it *costs*:

| | ChatGPT hosting (today) | Droplet (target) |
|---|---|---|
| Model access | in the loop already | your own API key, your own bill |
| Failure mode at setup | host model unavailable | network + key + rate limit, all yours |
| Verdict | free capability | **optional feature, gated behind a key check** |

So: build it so a missing key degrades to the preset themes rather than breaking
the lobby. Do not let a paid network call sit on the critical path to starting a
game.

**And it un-solves §5.5.** `web/app/chatgpt-auth.ts` reads a stable user id from
`oai-authenticated-user-*` headers, which looked like the household identity
*Family favourites* needs. On a Droplet those headers do not exist. Since that
file is also **imported nowhere** and the `/signin-with-chatgpt` and `/callback`
routes it names do not exist under `web/app/`, nothing is lost by ignoring it —
and the portable answer is better anyway: **a household code the host types, kept
in the host browser's `localStorage`, no accounts at all.** It works on both
hostings and needs no auth system on either.

### 7.8 What the Droplet move means for this plan

The coupling is narrow and precisely located, which is good news:

| Cloudflare-specific | Where | Portability |
|---|---|---|
| `import { env } from "cloudflare:workers"` | `web/db/index.ts:1`, `web/app/api/game/route.ts:1` | 2 files, mechanical |
| Raw D1 API (`.prepare().bind()…`) | `route.ts:15–23` (CREATE TABLE), `43–47` (SELECT), `52–56` (UPDATE), `120–123` (INSERT) | D1-shaped, but SQLite-shaped enough to port |
| Config injected via the Workers `env` object | `route.ts:125` (`PUBLIC_JOIN_ORIGIN`) | becomes `process.env` on a Droplet |
| `drizzle-orm/d1` driver | `web/db/index.ts` | dialect is already `"sqlite"` in `drizzle.config.ts` — a driver swap, not a rewrite |
| Workers entry point (`ASSETS`, `IMAGES` bindings) | `web/worker/index.ts` | does not move; a Droplet serves assets and images differently |
| `vinext` runtime | `package.json` | stock `next` 16.2.6 is already a dependency |

**The conclusion that matters for themes: keep theme data in the build artifact,
never in the database.** `web/data/catalog.json` and `catalog/tags/*.json` are
static files compiled at build time — they cross the hosting move for free. Had
themes been modelled as D1 tables, the move would owe them a migration. §5.1's
sidecar-file decision is *reinforced* by the Droplet plan, not challenged by it.
Only genuinely per-room, per-household mutable data (favourites) belongs in a
database.

Two constraints the move removes, worth knowing but not worth designing for yet:

- No Workers CPU ceiling or D1 read pricing, so a *runtime* tag join over 2,944
  songs becomes trivially affordable. Keep the build-time join anyway — it is
  simpler and portable — but the constraint is gone.
- A long-lived process makes SSE or WebSockets available in place of the current
  1,200 ms polling (`web/app/page.tsx:100–106`). Relevant to scheduled themes, where
  the round's bucket changes and every client wants to see it promptly, but out of
  scope here.

---

## 8. Sequencing

Revised for §7. The LLM tagging pass moves the two expensive sourcing jobs much
earlier, because it is offline, cheap, and reviewable.

| Phase | Delivers | New data needed |
|---|---|---|
| **0** | Catalog carries genres + theme packs + module id; theme in `RoomState`; selector replaces `pickSong`; pool-size guard | none |
| **1** | 1980s night (any decade), Movie soundtracks | none |
| **2** | Tag pass + provenance/override split (§7.4) → Summer road trip, Kids/Parents should know (canon), One-hit wonders (with review) | one offline LLM job, ~35k-token input |
| **3** | Age band at join → era-window variants; scheduler → Generations | one join-form field |
| **4** | MusicBrainz `artists.json`, LLM residue → British vs American | ~27 min offline job + manual residue |
| **5** | Host-authored themes in the lobby (§7.7) | none — reuses phase 2 output shape; needs an API key on the Droplet |
| **6** | Family favourites | one table + a host-typed household code (§7.7) |

Phases 0–1 still need no external data at all. The change from the original
ordering is that **three themes move out of "expensive sourcing" into a single
offline tagging pass**, and *Family favourites* stops being the open-ended one.

---

## 9. Open questions worth settling before Phase 0

1. **Who picks the theme, and when?** Host at room creation (simplest, locks the
   whole game) or host in the lobby (allows a change after seeing who joined —
   which player-relative themes actually want)? Lobby is the better fit for
   mechanism C, at the cost of one more state transition.
2. **One theme per game, or per round?** Everything above assumes per game, with
   *Generations* varying within it. Per-round theme switching is a different
   product.
3. **Does a theme change the win condition?** *British vs American* invites teams
   and a team score; that is a scoring change, not a deck change, and is out of
   scope here unless wanted.
4. **Market availability under narrow themes.** The README notes oEmbed proves a
   track exists, not that it plays in the account's market. A theme that narrows
   to 60 songs is far more exposed to a handful of region-blocked tracks than a
   2,863-song shuffle is. Worth a verification pass over any pack before it ships.
5. **Era or canon** for the two "should know" themes (§7.6) — they select very
   different decks, and the answer decides whether Phase 2 or Phase 3 delivers them.
6. **Is a host-authored theme (§7.7) the actual product?** If free-text theme
   authoring lands, the nine named themes become presets over one mechanism rather
   than nine features. That is a scope question, not a technical one, and it is
   worth answering before building nine bespoke selectors.

---

## Assumptions

- **Target is the web app.** The nine themes were raised against the multi-player
  game, which exists only in `web/`. The iOS `CatalogFilter` already does year +
  genre; extending it is a parallel job this document does not plan.
- **A theme is a selector, not a filter** (§1). Justification for the added
  indirection over a plain predicate: four of the nine themes as stated
  (Generations, British vs American as versus, parents/kids should know) cannot
  be expressed as `Song => boolean`. This is current requirement, not YAGNI.
- **`catalog/tags/` as a third source directory** (§5.1). Justification: keeps
  regenerable derived data out of hand-verified chart data, and reuses the
  existing `norm`/`primary_artist` join keys rather than introducing a new
  matching scheme.
- **Formative-year window** «unverified» — flagged inline at §6.1, and largely
  superseded by §7.6 if the "should know" themes are read as canon.
- **LLM tagging is classification over a closed set, not generation** (§7.3).
  Justification for accepting generated data into a repo whose chart data is
  hand-verified: the join key is the URI we already hold, so the pass cannot
  invent songs — only mislabel ones — and §7.4's provenance + override split
  makes a mislabelling revertible. `year` is out of bounds for any generated pass.
- **The ~35k-token catalog size is measured** (2,944 songs rendered as
  `Title — Artist (Year)` = 124,792 chars, chars÷3.6). The token figure is an
  approximation from character count, not a tokeniser run — treat it as an
  order-of-magnitude fact ("the whole catalog fits in one context"), not a budget.
- **No model, pricing, or provider recommendation is made here.** The tagging pass
  is offline and runs against any provider. Deliberately left open.
- **Planned against the Droplet, not the current hosting.** The ChatGPT/Cloudflare
  setup is stated to be temporary, so nothing in this plan is allowed to depend on
  it: theme data stays in build artifacts (§7.8), the household identity is a
  host-typed code rather than `getChatGPTUser` (§7.7), and runtime theme authoring
  is gated behind an API key that may be absent. The Cloudflare coupling inventory
  in §7.8 is a portability observation, not a migration plan — porting the app is
  a separate job from themes.
- Pool-size floor (~60 for 4 players) is derived from the win condition in
  `route.ts:186` (10 cards) and one song consumed per round; it is arithmetic
  from the code, not a measured playtest figure.

## Smells (out of scope)

- `pickSong` throwing on an empty pool surfaces as a **500 mid-game** with the
  room stuck (`route.ts:62`). Harmless today, load-bearing the moment themes
  narrow the deck — planned as §3.3, but it is a latent defect in the current
  code independent of themes.
- `build-catalog.mjs` silently ignores `catalog/themes/` — four authored packs
  (169 playable songs) are dead weight in the repo with no error or warning
  anywhere. Silent omission, not a filter.
- `web/data/catalog.json` (2,863 songs) is a committed build product with no
  freshness check against `catalog/`; `tools/status.py` reports source/bundle
  drift for the iOS bundle but nothing does so for the web copy.
- Room state is a JSON blob in a single `state` column with read-modify-write and
  no optimistic concurrency; two simultaneous `place` calls can lose one. Widens
  as themes add per-round state.
- `web/app/chatgpt-auth.ts` is fully implemented and **imported nowhere**; the
  `SIGN_IN_PATH` / `CALLBACK_PATH` routes it names do not exist under `web/app/`.
  Dead on arrival given the Droplet target — a deletion candidate at porting time,
  not now.
- `web/db/index.ts` exports `getDb()` (drizzle over D1) which **nothing imports** —
  verified across `web/app`, `web/lib`, `web/worker`, `web/tests`. The API route
  talks raw D1 instead. The unused layer is the portable one; the used one is the
  Cloudflare-specific one. Worth resolving *before* the Droplet move, because
  routing the four call sites through drizzle is most of the porting work already
  scaffolded and currently rotting.
