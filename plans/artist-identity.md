# Artist identity: replace string matching with entity IDs

Written 2026-08-10. Everything marked ✅ was measured in-session; anything
inferred is marked «unverified» with the check that would settle it.

Resume point: **Phase 1**. Nothing in this plan has been started.

---

## 0. Why — string matching cannot work, and this is a proof, not an opinion

`artists_match` decides whether two artist credits name the same act. Three
successive rules were written this session; each fixed one class of failure and
opened another:

| rule | fixed | broke |
|---|---|---|
| single shared token | — | `The Beatles` == `The Rolling Stones` (on `the`) |
| stopwords + 2-token overlap | the above | `OBC of Annie` == `OBC of Nine` (on `original/broadway/cast`) |
| per-character glyph regex | `P!nk`/`Pink` | `Ty Dolla $ign` → `ign`; word-initial `$` |
| residue + no fuzzy (current) | all the above | needs an alias table for glyphs |

The blocker is not rule quality. Similarity on the two candidates'
discriminating residues **overlaps between the two classes** ✅:

```
0.900  SAME        uicideboy / suicideboys
0.889  DIFFERENT   seal / seals
0.857  SAME        pnk / pink
0.857  SAME        ign / sign
0.833  DIFFERENT   champs / cramps
0.750  DIFFERENT   jim / jimmy
0.667  DIFFERENT   annie / nine
```

`seal`/`seals` are different acts and score **higher** than `pnk`/`pink`, which
are the same act. No threshold separates them, so no function of the characters
can be correct on both. Whole-string similarity is worse still: the Broadway
casts score **0.951** against each other ✅.

Entity resolution is solved by identifiers. That is the fix.

## 1. Verified facts to build on

**Spotify endpoints, this app's credentials** ✅ (probed 2026-08-10):

| endpoint | result |
|---|---|
| `GET /v1/tracks?ids=` (batch, 50) | **403 Forbidden** — not available to this app |
| `GET /v1/tracks/{id}` | OK |
| `GET /v1/artists/{id}` | OK |
| `GET /v1/search` | OK |

Consequences: **there is no cheap bulk backfill.** Per-song enrichment costs one
request each (3,616 songs ≈ 6 days at a conservative 600/day). The registry is
therefore keyed on **artists (1,661)**, not songs.

**Search responses already carry `artists[].id`** ✅ — e.g. `Aretha Franklin` →
`7nwUJBm0HE4ZxD3f5cy5ok`. `resolve_uris.py` reads that object, uses the *name*,
and discards the ID. This is the loss Phase 1 stops.

**`popularity` is `None` on every search result** ✅ (5/5). `resolve_uris.py`
sorts candidates on `(round(similarity,1), popularity)`, so the tie-breaker is
inert — ties resolve to whatever Spotify returned first. It does **not** crash
(verified). Real popularity needs `/v1/tracks/{id}`, one request per track.

**Wikidata join properties** ✅: `P1902` Spotify artist ID · `P434` MusicBrainz
artist ID · `P4404` MusicBrainz recording ID · `P577` publication date ·
`P175` performer.

**Wikidata rate limit** ✅: 429s on sustained querying; a paged crawl tripped it
twice, once with `Retry-After: 120`. Batched SPARQL (~200 values per query,
2s apart) completed 17 queries. Use that shape.

**MusicBrainz is the wrong source for release dates** ✅ — do not retry. It
fragments one performance into many `recording` entities, one per compilation,
each dated to that compilation. `Stand by Me` / Ben E. King returned 361
entities; earliest in the top 100 by relevance was 1966 (true answer 1961), and
the top 5 were movie comps dated 2009–2024.

**Counts** ✅: 3,616 catalog songs · 3,523 playable · 1,747 carry `releaseYear` ·
**1,969 distinct credits → 1,661 distinct primary artists** · 3,415 in the built
`web/data/catalog.json` (URI-deduplicated).

## 2. Phase 1 — stop discarding what we already receive

**Free. No extra requests. Do this first.**

`tools/resolve_uris.py` `best_match()` returns the chosen track; the caller
writes `uri` and drops everything else. Change it to also persist, per song:

- `spotifyArtistIds: [str]` — from `track["artists"][*]["id"]`
- `spotifyArtistNames: [str]` — what Spotify called them, for audit
- `spotifyAlbumReleaseDate` — already present in the response

Write these into the resolver's **output modules** and into a mappings row, then
carry them through `tools/apply_release_dates.py`-style application into
`catalog/`. Per the standing directive, store the whole track object in a
sidecar JSONL — the fields not used today cost nothing to keep and a full
re-crawl to recover.

Also fix the inert popularity sort while in this function: either drop the
tie-breaker (honest) or fetch real popularity separately. Do **not** leave a
sort key that silently does nothing.

Definition of done: a resolver run writes artist IDs; `tools/test_common.py`
gains a guard that a resolved row carries at least one artist ID.

## 3. Phase 2 — bootstrap the artist registry

**Free.** New file: `mappings/artist-registry.jsonl`, one row per distinct
primary artist:

```json
{"primary": "aretha franklin", "credits": ["Aretha Franklin"],
 "spotify_artist_id": "7nwUJBm0HE4ZxD3f5cy5ok", "wikidata": "Q27332",
 "musicbrainz": "...", "source": "wikidata|resolver|human", "confidence": "..."}
```

Bootstrap with batched Wikidata SPARQL over the 1,661 primaries — roughly **9
queries** at the batch size already proven. Ask for `P1902`, `P434`, and the
Q-number in one go. Store whole bindings, including rejected candidates, so a
better matcher can be replayed offline (`--rederive`, as
`tools/harvest_release_dates.py` already does ✅ — that pattern saved a full
re-crawl twice this session).

Merge in any IDs Phase 1 has captured; resolver-sourced IDs outrank Wikidata's,
since they came from the actual track we play.

## 4. Phase 3 — audit once, by hand

Emit `mappings/artist-registry-review.csv` for every row that is **0-candidate**
or **multi-candidate**. 1,661 rows total is a spreadsheet, not a project.

The point: `Seal` vs `Seals and Crofts` becomes one permanent human decision
instead of a heuristic re-guessing it on every comparison. Record the decision
with `source: human` so no later pass overwrites it.

## 5. Phase 4 — join on IDs

Switch the hot paths from string comparison to `spotify_artist_id` equality:

- `tools/fill_from_datasets.py` — keys become `(norm(title), artist_id)`
- `tools/harvest_release_dates.py` — Wikidata performer Q-number vs our
  Q-number, which makes `likely_cover` **exact** instead of the current
  "several performers on the item" heuristic (638 rows currently skipped)
- `cannabeats-themes/aggregate_gaps.py` — same

Then demote `artists_match` to **registry bootstrap only**: a fuzzy suggestion a
human confirms, never a silent decision made thousands of times. When that
lands, delete `ARTIST_ALIASES` and re-evaluate whether `ARTIST_STOPWORDS` is
still needed.

## 6. State at handoff

Two commits landed earlier this session:
`a45a4e8 feat(catalog): resolve theme-module Spotify URIs` ·
`8c0356b fix(web): include catalog/themes in the built catalogue`.
Later commits (`f495e8e`, `6a2dff7`) are Ben's parallel desktop-client work.

**Uncommitted and mine** — `releaseYear` schema + backfill, and the matcher fix:
`CannaBeats/Models/Song.swift` · `web/lib/game.ts` ·
`web/scripts/build-catalog.mjs` · `web/tests/build-catalog.test.mjs` ·
`tools/_common.py` · `tools/resolve_uris.py` · `web/data/catalog.json` ·
all of `catalog/` and `Resources/Catalog/` · new: `tools/harvest_release_dates.py`,
`tools/apply_release_dates.py`, `tools/test_common.py`,
`mappings/wikidata-release-dates.jsonl`.

**Uncommitted and Ben's** — `web/app/page.tsx`, `web/app/globals.css`,
`web/tests/rendered-html.test.mjs`. Leave alone.

Tests green at handoff ✅: 17 Python (`python3 -m unittest discover -s tools -p
'test_*.py'`), 23 web (`cd web && npm test`), lint clean.

## 7. Known defects, none fixed

- **Two wrong URIs in `catalog/years/`**: `Love Letters in the Sand`
  (Ted Black 1931 / Pat Boone 1957) and `Say It Isn't So` (George Olsen 1932 /
  Hall & Oates 1984) each have two rows sharing one URI, so one row in each pair
  plays the wrong audio. Needs hand-picked track IDs.
- **`Fame` / Irene Cara** in `themes/oscar-songs.json` points at a
  *re-recording*, not the 1980 original.
- **19 theme URIs and 74 year URIs unresolved** (68 pre-1950, deprioritized).
- **~30 cast-credit resolutions in `tony-musicals` are artist-unverified** —
  oEmbed returns titles only. Phase 1's artist IDs would settle these.
- **`one-hit-wonders` pack (265 songs) unreviewed**, asserts factual claims.
- **638 `likely_cover` rows** have a usable *original* publication year that
  `apply_release_dates.py` discards. Not lost — it is in
  `mappings/wikidata-release-dates.jsonl`. Powers a "Covers & Originals" theme
  if a third schema field is ever wanted.

## 8. Open decisions, blocking later work

1. **Year semantics** — proposed and unconfirmed: *year = when the recording
   entered public circulation*, evidenced by chart year where it charted and
   release year where it did not. The catalog is empirically chart-dated ✅
   (10/10 probes: Blinding Lights 2020 not 2019, etc.).
2. **Recognition model** — is "recognized × hard-to-place" the right frame? It
   determines what a round logs, and unlogged game nights are unrecoverable.
3. **Who is at the table, and how old** — sets where recognition concentrates,
   and therefore where sourcing pays. Upstream of 4 and 5.
4. **Flat ~34 songs/year, or weighted to players' formative years?**
5. **Is a dead card acceptable if it grows coverage?** — decides whether the
   ~3,900-row Billboard 31–100 import is gated on a recognition floor.
6. **Do theme packs become a game mode?** — ten packs and a `CONTRACT.md` exist;
   nothing consumes them, and the web build now merges themes into the flat pool.

## 9. Related artifacts

- `plans/themes-beyond-filters.md` — theme mechanics (untracked)
- `~/LLM/cannabeats-themes/CATALOG-SOURCES.md` — the five sourcing sources with
  verified structure; RS500 canon list and its 366-song gap set live in
  `canon/` there, 182 with free Spotify URLs already harvested
- `CannaBeats/CONTRACT.md` — v1 theme artifact schema
