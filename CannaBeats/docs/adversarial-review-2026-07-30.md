# Adversarial review — 2026-07-30

Method: 8 finder agents with individualized, overlapping focus areas
(quota/budget, matching/normalization, state/resume, Swift app, data audit,
docs-vs-reality, scope discipline, game-night simulation) produced ~76 raw
findings; 4 verifier agents then re-checked every claim with a default-REJECT
stance, re-executing regexes/functions and recomputing all data claims from
scratch. Result: ~50 findings confirmed or confirmed-with-adjustment, 1
rejected outright, several narrowed. Findings below are the verified set,
merged where verifiers identified shared root causes, ranked by threat to
game night.

Scope ruler used throughout: personal sideloaded app, one developer, one
phone, daily Spotify quota (~600–1000 req/day/account) is the rationed
resource, and the worst possible failure is the wrong song playing behind a
hand-written year card.

---

## P0 — the app in its current state is not the game you built

### 1. The bundle ships a 1920–1955 deck (4 finders, verified twice)
`Resources/Catalog/` = 37 files: years 1920–1955 + starter.json. After the
app's dedupe: **1,098 songs, 1,027 playable — all pre-1956 except starter's
18**. Source `catalog/` holds 2,834 playable. 56 of 107 years have zero
playable songs in the bundle; themes have no route in at all. No script or
README step syncs `catalog/` → `Resources/Catalog/`; tonight's 1920–1955
presence is a hand-run coincidence. GameView shows only "N songs left", so
nothing on the device would ever reveal this.
**Fix:** sync step (see status.py, #14) + a "Deck: N songs, YYYY–YYYY" line
on the connect pane.

### 2. The only modern songs in the bundle are 18 unverified memory-URIs
starter.json's URIs were written from model memory and are flagged
"unverified" in its own `source` field. They are 100% of the
recognizable-era deck as bundled. One transposed character = a valid
*different* track. Also: 11 of its 15 year-module overlaps disagree on year
by exactly +1 (release-year vs chart-year convention clash), 5 disagree on
URI, and 3 songs exist in no year module.
**Fix:** verify all 18 via oEmbed (free), or delete starter.json once the
full catalog is bundled; reconcile the year convention first.

### 3. Three true URI collisions — same track behind different cards (recomputed exactly)
- `3mRM4NM8iO7UBqrSigCQFH` = **both** "Night Fever" and "Stayin' Alive"
  (1978.json *and* film-soundtracks.json — the only within-file dupes in
  the corpus).
- `1GrikfH0jDejDvrxo84n4P` = Janet Jackson "Again" (1994) **and**
  "Together Again" (1998).
- `7FA0HOQtpun5DlYuOS50qF` = "In the Chapel in the Moonlight" Shep Fields
  (1936) **and** Kitty Kallen (1954) — **in the shipped bundle**, 18-year gap.
15 further same-URI groups are artist-spelling variants of one song
(and/&/feat. credit drift) — not wrong-song bugs, but they defeat the app's
exact-string dedupe if co-bundled.
**Fix:** re-resolve one side of each of the 3; canonicalize artist strings.

### 4. Playability holes: 1956=0, 1957=1, 2022=3, 2023–26=0; tony-musicals 4/99, tv-soundtracks 23/80

---

## P1 — Swift app failure modes at the table (all confirmed against code)

### 5. Killed Spotify app bricks the session for the rest of the launch
`accessToken` is set once and never cleared on any failure path; every
reconnect then takes plain `connect()`, which cannot wake a killed Spotify —
`authorizeAndPlayURI` (the only wake path) is unreachable. Token expiry
(~1 h) hits the same dead end. Related: the token isn't persisted either, so
every cold launch re-bounces to Spotify with the warm-up track audible
("bounces once" copy is false per-launch).
**Fix:** clear `accessToken` in `didFailConnectionAttemptWithError` after
one failed retry so the flow falls back to `authorizeAndPlayURI`.

### 6. Playback errors are invisible + the card is consumed before play is confirmed + no skip
`play/pause/resume` errors go to a print-only callback; `playerAPI?` nil is
a silent no-op; `isPaused` is set optimistically. `drawAndPlay` calls
`drawNext()` *before* dispatching play, and the hidden pane has no
skip-without-reveal. Verifier refinement: because player-state subscription
eventually syncs, the typical symptom is the *previous/warm-up track keeps
playing* under a "new" hidden song — wrong song, not silence.
**Fix:** route command errors to `lastError`; add "Skip (no reveal)"; draw
after dispatch.

### 7. Placeholder client ID = permanent silent hang
Missing `SpotifyClientID.txt` silently falls back to
`"YOUR_SPOTIFY_CLIENT_ID"`; Spotify never issues the redirect for an
unknown client; `status` stays `.connecting` forever and the only button on
screen is disabled. No timeout exists anywhere in the playback path.
**Fix:** refuse loudly at launch on the placeholder; timeout `.connecting`
back to `.disconnected` after ~15 s.

### 8. Assorted confirmed table-UX issues
- Mid-game disconnect swaps the whole game screen for the connect pane.
- `pendingAction` survives failed reconnects and fires stale, minutes later.
- Nothing pauses the warm-up track after the handshake; its URI is also
  hardcoded-unverified and load-bearing (App Remote needs an active session).
- Empty deck (misbuilt bundle / over-narrow filter) = big button that
  silently does nothing (normal exhaustion does show Reshuffle UI).
- No history view of past reveals (data is retained; view is missing).
- Deck resets on jetsam eviction (accepted in-code trade-off; note only).
- Loader/dedupe verified robust: recursive enumeration survives bundle
  flattening, `try?` skips foreign JSONs, first-wins is deterministic, year
  modules beat starter on collisions. One edge: a null-URI copy in an
  earlier-sorting file shadows a playable one — latent until themes bundle.

### 9. Market: resolve with the playing account's market (adjusted, real but narrow)
`spotify:track:` URIs are global; playability follows the **account's**
registered country, not geo-IP. A US-market Premium account playing in
Italy is fine. An IT-market account playing `market=US`-resolved URIs hits
per-track relink-or-fail — worst for the 1920–1955 era. oEmbed verification
proves existence, not market playability.
**Fix:** if the game account is IT-market, re-verify/resolve with
`market=IT`; delete README's wrong "run from a US IP" line either way.

---

## P2 — matching pipeline: the wrong-song machine (all executed, not eyeballed)

### 10. `pick()` lets year-less mapping rows beat correct-year rows
`(y if y else want_year)` gives `year: null` rows distance 0 — reproduced:
a null-year row *outright beats* an off-by-one correct row and ties exact
rows (winner then decided by lexicographic ID). Supply side:
`csv_to_mappings.py` silently emits all-null years when `--year` names a
wrong/missing column ("0 skipped", exit 0) — so a mistyped flag voids the
re-recording guard for an entire dataset.
**Fix:** rank null-year entries after all in-tolerance entries; validate
column names against `reader.fieldnames`.

### 11. `best_match` never checks the artist; norm divergence demotes correct titles
No reference to `track["artists"]` anywhere in resolve_uris. Parens
stripping makes "(Originally Performed by…) [Karaoke]" score 1.0;
`round(sim,1)` buckets ~(0.95,1.0] so popularity decides. Verifier
narrowing: the `artist:` field filter contains the primary query, so the
raw karaoke case mostly enters via `--thorough`'s plain-text fallback; the
unmitigated risk is same-artist re-recordings winning on popularity
(exactly the pre-1960 catalog). Compounding: `fill_from_datasets.norm`
folds `&`→"and" but resolve/verify's copies don't — executed: catalog
"Me and U" vs Spotify "Me & U" scores 0.667 while wrong-song "Me and You"
scores 0.889 and **wins**. 212 catalog rows contain `&`. And
`verify_uris.py` compares only titles, so it is structurally blind to
every wrong-artist/wrong-version pick above — the audit tool can't see the
failure class it exists to catch.
**Fix:** require normalized-token artist overlap on candidates; one shared
`norm()` (the `&`-folding one) in `tools/_common.py`; store matched artist
at resolve time and compare it in verify.

### 12. FEAT regex creates an empty-key wildcard bucket (end-to-end reproduced)
`\b(featuring|feat\.?|ft\.?|with|x)\b` → `primary_artist("Lil Nas X")` =
`'lil nas'`; `"X"`/`"X Ambassadors"`/`"? and the Mysterians"` = `''`. All
dataset rows whose artist collapses to `''` pile into `(title, '')`, and
catalog lookups fall through to it: a "96 Tears" row by the band X filled
the ? and the Mysterians entry with the wrong ID in a live reproduction.
**Fix:** never index/look up an empty primary key; drop bare `x`/`with`
from the regex in favor of separator forms.

### 13. Lower-severity confirmed
- Accents deleted not folded (`Beyoncé`→`beyonc`, `Mýa`→`ma`; 14 rows):
  guaranteed offline-fill misses → quota spent in resolver instead.
- Propagation ignores year (68 shared pairs, 27 off-by-one) — intent today,
  latent hazard; add tolerance check + warn on conflicting URIs.
- csv artist flatten mangles single-quoted apostrophe names ("Guns N") —
  narrow: Python repr double-quotes those, so Kaggle 600k is safe.
- 7 catalog rows with `:`/`"` break the unescaped field query.
- Theme year drift: 35 instances all exactly −1 vs year modules (30 share
  URI, 5 both-null; +3 more hidden behind artist-spelling variants). And 22
  same-song/different-year URI groups mean the `title|artist|year` dedupe
  key **cannot** collapse them if themes bundle — instant duplicate cards.

---

## P3 — tool robustness & quota hygiene (confirmed)

### 14. resolve_uris: crash paths lose paid work; resume shadows source
- Only `QuotaExceeded` is caught; a 401/500/RuntimeError/Ctrl-C skips
  `save()` — the current module's quota-funded results (≤~30 lookups) are
  lost, despite the "partial progress is kept" comment.
- Token fetched once, never refreshed, no 401 handling; a slept
  Retry-After ≤3599 s outlives the 3600 s token and lands in the crash path.
- Resume reads `out_path if exists else path` — source-file edits and
  offline fills are ignored forever after the first run; new songs added to
  a source module are silently reported "done".
- Token-endpoint 400 (bad secret) is caught as URLError → 4 retries + a
  misleading "check your proxy/VPN" message.
- Minor: budget can overshoot ~10 via in-call retries; save is non-atomic.
**Fix bundle:** `try/finally` save; refresh token on 401; resume =
source-overlay-merge; catch HTTPError separately. Plus the single
highest-value addition in the repo: **`tools/status.py`** — a zero-network
table (segment × songs/resolved/null) plus `--sync` that regenerates
`Resources/Catalog/` from source (non-null URI wins, source wins conflicts).
It replaces tonight's four hand-run counting snippets and ends the
two-directory drift class.

### 15. Other confirmed tool findings
- `verify_uris` cache: each MISMATCH/DEAD prints exactly once *ever*;
  re-runs say "0 mismatches" — indistinguishable from a clean pass. Re-print
  cached verdicts (free); note `--limit` in the summary; decide
  commit-vs-ignore for the cache file (currently neither).
- `playlists_to_mappings`: budget stop mid-playlist re-fetches that
  playlist from page 1 on resume and duplicates its rows (bounded: 1 req/100
  tracks); resume markers are keyed to whatever file relative `--out`
  resolves to — different cwd, different file, full re-fetch.
- `mappings/` and the verify cache are neither committed nor gitignored —
  quota-embodying state stranded on one laptop by design.
- `playlist_to_songs.py`: no timeouts, no 429 handling, no pacing,
  all-or-nothing output, crashes on partial release dates. Verifier
  overruled "delete" (it's the only tool that creates *new* catalog rows
  from a playlist): fix to _common.py standards or mark deprecated.
- `env.py` reads `cwd/.env` first but only `CannaBeats/.gitignore` covers
  `.env` — a repo-root `.env` (from running tools at root) is committable
  with the client secret. **Add a repo-root .gitignore.**
- Duplicated plumbing is already drifting: 3 `get_token`s (3 robustness
  levels), 2 identical `api_get`+`QuotaExceeded`, 3 `norm`s (1 divergent —
  see #11). Extract `tools/_common.py` (~90 lines net deletion).
- fill_from_datasets rewrites all files unconditionally — mtime churn only
  (output is byte-stable, verified).

### 16. Docs vs reality (confirmed)
- README teaches the pre-dataset pipeline; none of the four new tools
  (fill/verify/playlists/csv) appear anywhere in it; "uri: null until
  resolved" contradicts 2,886 filled rows. Rewrite pipeline as: fill
  offline → playlists → fill → verify → budgeted resolve.
- No command anywhere states its required cwd; docstring usage lines imply
  a `tools/` cwd where inputs don't exist. (Verifier narrowed the
  quota-misdirection scenario — from repo root the command fails before
  spending search quota — but the cwd ambiguity class already bit tonight.)
- README "run from a US IP" directly contradicts the resolver's own
  message; delete it.
- csv_to_mappings presents three unverified third-party schemas as
  "Known-good" — and the Kaggle 600k `--year year` hint is likely wrong
  (`release_date` in current tracks.csv), which feeds the silent null-year
  path (#10). Hedge + validate columns.
- `.env.example` omits playlists_to_mappings from its credential-reading
  tool list.

---

## Rejected / overruled by verification
- Retry-After HTTP-date crash: mechanically true, no plausible trigger
  (Spotify sends delta-seconds; documented 429s were numeric).
- "Delete playlist_to_songs.py": overruled — different output shape, only
  new-rows tool; deprecate or fix instead.
- "README command from repo root misdirects quota": fails fast instead;
  survives only as the cwd-ambiguity doc bug.
- "unresolved markers = fiction": narrowed — mechanism coherent; today's
  nulls are legitimately retry-worthy; residual concern folds into the
  crash-save bug.
- Scope checks that came back *clean*: csv_to_mappings generality justified
  (each branch maps to a planned dataset); all five audited CLI flags earn
  their keep; CatalogFilter is a fine dormant seam (one unread stored
  property); auth plumbing (scheme/plist/pbxproj/bundle id) consistent;
  loader robust; schema hygiene zeros across 148 files; the 36 bundled year
  files byte-identical to source.

## Suggested order (game night is the deadline)
1. **Data first (no quota):** fix the 3 URI collisions; reconcile
   starter/theme year conventions; then `status.py --sync` so the app
   actually bundles the 2,886-song catalog; verify starter's 18 +
   warm-up URI via oEmbed.
2. **Swift safety net (small diffs):** token-clear-on-failure, error
   surfacing + Skip button, placeholder-ID loud failure, pause after
   handshake, deck line on connect pane.
3. **Tool correctness before the next API run:** try/finally save + 401
   refresh + merge-resume; `pick()` null-year fix + column validation;
   artist check in best_match; unified norm/_common.py.
4. **Quota work:** playlists pass for 2020s/themes, budgeted resolver for
   the residue — now safe to run.
5. **Docs:** README pipeline rewrite, cwd lines, root .gitignore.
