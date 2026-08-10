# Artist identity: replace string matching with entity IDs

Written 2026-08-10. Everything marked ✅ was measured in-session; anything
inferred is marked «unverified» with the check that would settle it.

Resume point: **Phase 4** — or the Phase 3 audit, which is Ben's to run whenever.
Phase 1 landed 2026-08-10 (`8d3864c`, plus the
ranking fix it exposed, `d1ad4f0`); Phase 2 landed the same day (`5194271`).

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
therefore keyed on **artist credits (1,969)**, not songs — see §3 for why the
credit string rather than the 1,662 normalized primaries.

**Search responses already carry `artists[].id`** ✅ — e.g. `Aretha Franklin` →
`7nwUJBm0HE4ZxD3f5cy5ok`. This was the loss Phase 1 stopped. Multi-artist rows
also yield composer IDs: the *Man of La Mancha* row carried Joseph Darion and
Mitch Leigh alongside Richard Kiley.

**Search responses also carry `external_ids.isrc`** ✅ — the recording
identifier. Captured as of Phase 1.

**A whole search item is ~1.8 KB** ✅ — `market=US` suppresses
`available_markets`, so storing responses verbatim is cheap.

**`popularity` is `None` on every search result** ✅ (10/10, re-verified
2026-08-10). The `(round(similarity,1), popularity)` tie-breaker was inert; it
did not crash only because every value was None. Removed. Real popularity needs
`/v1/tracks/{id}`, one request per track.

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

**Counts** ✅: 3,616 catalog songs · 3,532 playable · 1,747 carry `releaseYear` ·
**1,969 distinct credits → 1,662 distinct primary artists** · 3,424 in the built
`web/data/catalog.json` (URI-deduplicated).

## 2. Phase 1 — stop discarding what we already receive ✅ DONE 2026-08-10

Every resolution now appends the whole chosen track object to
`mappings/spotify-tracks.jsonl`, keyed by `title|artist|year`. Guards live in
`tools/test_resolve_uris.py` (not `test_common.py` — that file is about the
shared text plumbing), including one that binds to the committed log and fails
if any row lacks an artist ID.

**Deviation from the plan as written, deliberate:** the catalog schema was NOT
changed. Neither client has any use for the fields, and Phase 4 does not need
them there — a catalog song reaches its artist ID through the registry, keyed
on its exact credit string, which is a lookup in a human-audited table rather
than the fuzzy match being retired. A sidecar keyed by song identity is the
normalized form and avoids touching 111 files two clients decode. Reverse this
if Phase 4 turns out to want the denormalization.

The sidecar carries `{title, artist, year, spotify_id}`, so it is also a valid
`fill_from_datasets.py` mappings file. That gave a better route than the README
flow: resolver `--out` to a scratch dir, fill `catalog/` from the log, then
`status.py --sync`. The build product is never written directly and there is
nothing for sync to "rescue".

**Two findings that change what the plan said:**

- **ISRC is on every search result** (`external_ids.isrc`) ✅ and identifies the
  *recording*, stable across pressings — three of four "Bohemian Rhapsody" hits
  share `GBUM71029604` while the 2010 edition is a different master. Now
  captured. It is the join key to MusicBrainz and a better dedup key than the
  URI; §5 should use it.
- **`spotifyAlbumReleaseDate` is not a release year** ✅ — the same
  recording-entity fragmentation that killed MusicBrainz. That song's hits are
  dated 1975, 2010, 2021 and 2018 depending on which pressing matched. Captured
  with its `release_date_precision`, never fed to `releaseYear`.

The inert `popularity` sort is gone (verified None on 10/10 items). Its slot is
now a real key — see below.

### 2a. The defect Phase 1 exposed — version suffixes ✅ FIXED (`d1ad4f0`)

The first real run resolved **0 of 25**. Not absent tracks: `norm()` strips
`(…)` and `[…]` but not Spotify's `" - "` qualifier, so our "Men in Black"
scored 0.453 against `Men In Black - From "Men In Black" Soundtrack` and fell
under the 0.6 floor with the right track at rank 1. This is why the theme packs
carried a null residue — soundtrack and cast titles almost always carry one.

Similarity is now the better of the full and stripped readings; a candidate
rescued *only* by stripping must clear 0.9, since stripping otherwise lifts
"Fight for Your Right" to 0.788 against "Fight for You". Stripping also makes a
live cut tie with the studio original, so the vacated tie-breaker is now
"prefer the unsuffixed track".

Result: 8 of 25 resolved, each audited against what it actually points at.
Playable 3,415 → 3,423. Pending is now **85** (13 themes, 72 years), of which 68
are the deprioritized pre-1950 set — left alone rather than spending quota to
mark them unresolved.

## 3. Phase 2 — bootstrap the artist registry ✅ DONE 2026-08-10

`tools/harvest_artist_ids.py` → `mappings/artist-registry.jsonl` (1.1 MB, all
candidates stored, `--rederive` replays with no network). 12 queries, free.

| confidence | credits | songs | meaning |
|---|---|---|---|
| `single-exact` | 1279 | 2675 | one item, matched on the full credit |
| `single-shortened` | 423 | 546 | one item, but only after trimming the credit |
| `multi` | 182 | 303 | several items — no ID recorded, human decides |
| `none` | 85 | 92 | nothing found |

3,221 of 3,616 song rows sit on an identified artist. 1,266 credits carry a
Spotify artist ID, 1,671 carry MusicBrainz or Spotify.

**Deviation:** keyed on the **credit string** (1,969), not the normalized
primary (1,662). Phase 4 needs "given this exact catalog spelling, which
artist?", and `primary_artist()` is lossy in ways that matter here — it mangles
`Simon & Garfunkel` to `simon` and `? and the Mysterians` to `""`.

**The finding that nearly sank it:** matching `rdfs:label` alone is silently
incomplete. Q26876 (Taylor Swift) carries 74 labels, **none English**, no
English altLabel, and both P434 and P1902 ✅. Bruno Mars, ABBA, Céline Dion and
Dua Lipa are the same. A label-only harvest filed them as "no Wikidata entity",
so `none` meant two different things and the Phase 3 queue would have been
auditing an artefact of the query. Matching the **en.wikipedia sitelink title**
recovers them.

Neither route may be dropped. Article titles are disambiguated, so `Seal` is
"Seal (musician)" and the sitelink misses him, and `Jim Jones` as an article is
only the cult leader — which would convert a correctly-flagged `multi` into a
confident error. Both run; candidates merge by Q-number. The union also fixed
`Kool & the Gang`, which the label route missed and then mis-resolved via its
`Kool` fallback to Robert Bell.

`skos:altLabel` resolves the glyph spellings `ARTIST_ALIASES` was kept for
(`P!nk` → Q160009, `Ke$ha` → Q33605), which is what lets §5 delete that table.

### 3a. What Phase 3 is inheriting

690 credits need a human. Known shapes, so the audit can be batched:

- **202 of the 423 `single-shortened` reduce a joined credit to one act.** Two
  kinds, and they need opposite treatment: `Paul Whiteman and His Orchestra` →
  Paul Whiteman is fine (the bandleader is the entity), but `John Travolta &
  Olivia Newton-John` → John Travolta drops half a duet.
- **`multi` is mostly real ambiguity** — `Jim Jones` (3), `Michael Jackson` vs
  Michael R. Jackson, `TLC` vs The Learning Company, `Pink` vs someone whose
  alias is Pink.
- **`none` includes diacritic misses** — the catalog spells it `Beyonce`,
  Wikidata `Beyoncé`. «unverified» how many of the 85 this accounts for; a scan
  of accent-folded label equality against the 85 would settle it.
- Cast credits (`Original Broadway Cast of …`) are genuinely not Wikidata
  entities and will stay `none`. Their identity comes from Spotify artist IDs
  via the Phase 1 track log instead.

### Original sketch (superseded by the above)

New file: `mappings/artist-registry.jsonl`, one row per distinct
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
since they came from the actual track we play. As of 2026-08-10 that is 8 songs
in `mappings/spotify-tracks.jsonl` — Phase 1 stops the bleeding going forward,
it does not backfill. The 3,523 songs resolved before it will never be searched
again, so Wikidata is doing nearly all the bootstrap work.

## 4. Phase 3 — audit once, by hand ✅ TOOLING DONE 2026-08-10 (`0fe0caa`)

**The audit itself is Ben's to do.** `tools/review_artist_registry.py` is the
round trip:

```
python3 tools/review_artist_registry.py                    # emit the CSV
# fill the `decision` column in a spreadsheet, save as CSV
python3 tools/review_artist_registry.py --apply            # read it back
python3 tools/review_artist_registry.py --apply --dry-run  # preview only
```

`mappings/artist-registry-review.csv` holds **690 rows / 941 songs**: 423
`single-shortened`, 182 `multi`, 85 `none`. Ordered by song count, so stopping
part-way still buys the most gameplay.

`decision` accepts a Q-number, `ok` (confirm what was harvested), `none`
(confirmed absence), or blank (unreviewed — row untouched).

**The guarantee:** applied rows carry `source: "human"`, and `rederive_rows()`
and `apply_resolver_ids()` both skip them ✅ (tested). Without that the audit
buys nothing, because the next pass re-guesses over it.

**Nothing auto-fills `decision`.** Every shortcut available is another
similarity heuristic — the thing this plan retires. The tool makes deciding
cheap instead: candidates carry their P31 types and which IDs they hold, real
catalog songs sit alongside, e.g. `TLC` = *musical group/girl group [spotify,
mb]* vs *The Learning Company [video game developer]*.

Scope note: `single-shortened` is reviewed too, which §3's sketch did not ask
for. Those are inferences, not matches.

**Verified end-to-end on scratch copies** ✅, registry untouched: candidate
pick, `ok`, `none`, and a hand-entered Q outside the candidate set (fetched in
one batched query — a row with a Q and no identifiers is exactly what nothing
downstream can join on). All four survived `--rederive`.

`Beyonce` → Q36153 resolves to **Beyoncé** ✅, confirming diacritics as a cause
of some `none` rows — previously «unverified» in §3a.

### Original sketch

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
- `web/scripts/build-catalog.mjs` — dedup on ISRC rather than URI. URI dedup
  cannot see that two different URIs are the same master; ISRC can.

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
- **13 theme URIs and 72 year URIs unresolved** (68 pre-1950, deprioritized).
  The 17 post-1950 leftovers are genuine absences, re-checked 2026-08-10 after
  the suffix fix — not match failures.
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
