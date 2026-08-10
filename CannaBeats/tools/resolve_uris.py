#!/usr/bin/env python3
"""Fill in Spotify track URIs for catalog module files (uri: null -> real URI).

Usage:
  python3 tools/resolve_uris.py catalog/years/*.json catalog/themes/*.json \
      --out CannaBeats/Resources/Catalog/

Run from the CannaBeats/ directory (the folder containing catalog/ and tools/).

Credentials come from SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (env or .env).

QUOTA REALITY (researched 2026-07): Spotify development-mode apps have a
DAILY REQUEST QUOTA, counted per developer account and shared across all of
that account's client IDs (July 2026 change). Exceeding it returns a 429
with "reason": "QUOTA_EXCEEDED" and a Retry-After near 24 hours. Pacing
cannot beat a budget, so this script:
  - spends at most --budget requests per run (default 400), then stops
    cleanly; run it again tomorrow (or with another developer account's
    credentials) and resume continues where it left off,
  - detects quota-style 429s and exits immediately with state saved,
    instead of sleeping on a 24-hour Retry-After,
  - uses one search per song (pass --thorough for a fallback second query).

Resume is a MERGE: each run always reads the SOURCE file, then overlays any
non-null URIs and "unresolved" markers from the existing output file (matched
by title|artist|year, the same identity the app uses). Source edits and new
songs are therefore always picked up, while previously-paid resolutions are
never re-spent. Output is written even on crash/Ctrl-C, atomically.

Songs that can't be matched are marked "unresolved": true (skipped on
re-runs unless --retry-unresolved) — paste a track link from the Spotify
app into the JSON as "spotify:track:<id>" for those.

TRACK LOG (--tracks, default mappings/spotify-tracks.jsonl)
Every resolution also appends the WHOLE chosen track object, keyed by
title|artist|year. The module itself keeps only "uri", and nothing ever
re-issues a search for a song that already has one — so a field not captured
here is unrecoverable without paying full quota again. What it buys:
  - spotify_artist_ids — artist identity by IDENTIFIER. Comparing credit
    strings provably cannot work (see _common.artists_match); this is what
    replaces it, and it costs nothing because the response already carries it.
  - isrc — the recording identifier, stable across pressings, joins to
    MusicBrainz.
  - the rest of the object, verbatim, to be pruned at read time.
The file doubles as a fill_from_datasets.py mappings source.
"""
import argparse
import contextlib
import difflib
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse

from _common import (QuotaExceeded, TokenExpired, api_get, artists_match,
                     counter, get_token, norm as normalize, primary_artist,
                     significant_tokens)
from env import load_dotenv

API = "https://api.spotify.com/v1"


def artist_matches(track: dict, artist: str) -> bool:
    """True when any credited artist on the track plausibly names our act.

    Delegates to _common.artists_match so there is one definition of "same
    artist" across the tools. The previous local rule accepted a single shared
    normalized token, which matched The Beatles to The Rolling Stones on "the"
    — survivable here only because Spotify's own artist: filter had already
    narrowed the candidates, and dangerous for cast credits where "broadway"
    and "cast" are near-universal filler.
    """
    if not significant_tokens(artist) and not primary_artist(artist):
        return True  # nothing to compare against ("?" norms to "")
    return any(artists_match(candidate.get("name", ""), artist)
               for candidate in track.get("artists", []))


# Spotify's version qualifier: everything after a spaced hyphen. It carries
# "- Remastered 2011", "- Live", "- Single Version", and — the case that made
# this necessary — '- From "Men In Black" Soundtrack'. Needs whitespace on both
# sides, so hyphenated names ("Jay-Z", "Blue-Eyed Soul") are untouched.
VERSION_SUFFIX = re.compile(r"\s+-\s+.*$")

# A candidate whose full name already clears this is judged on the better of
# its two readings.
SIMILARITY_FLOOR = 0.6
# A candidate that ONLY clears the floor once its qualifier is stripped has to
# be near-exact. Stripping asserts "the qualifier is noise", and that claim is
# only safe when what remains is essentially the title: dropping "- Remastered"
# from "Fight for Your Right" otherwise lifts it to 0.788 against our "Fight
# for You", which the undiluted comparison rejected only by accident.
STRIPPED_FLOOR = 0.9


def score_items(items, title: str, artist: str):
    """[(title_similarity, is_bare, track)] for candidates crediting our act.

    Similarity is the better of the full name and the name with Spotify's
    version qualifier removed. Comparing full names alone threw away exact
    matches: our "Men in Black" against Spotify's 'Men In Black - From "Men In
    Black" Soundtrack' scores 0.453, under the 0.6 floor, so the correct track
    sitting at rank 1 with the right artist was rejected. That hit the
    soundtrack and cast repertoire hardest — the theme packs are made of it.

    `is_bare` records whether the candidate carried a qualifier at all, so a
    plain track outranks a live/remastered/soundtrack cut of the same song
    instead of tying with it. Under blind audio a live take is the wrong
    recording, and stripping the suffix is what made those tie in the first
    place.
    """
    want = normalize(title)
    scored = []
    for track in items:
        if not artist_matches(track, artist):
            continue
        full = normalize(track["name"])
        base = normalize(VERSION_SUFFIX.sub("", track["name"]))
        full_similarity = difflib.SequenceMatcher(None, want, full).ratio()
        base_similarity = difflib.SequenceMatcher(None, want, base).ratio()
        if full_similarity < SIMILARITY_FLOOR and base_similarity < STRIPPED_FLOOR:
            continue
        scored.append((max(full_similarity, base_similarity), base == full, track))
    return scored


def pick_best(scored):
    """Highest rounded similarity wins, then the unsuffixed track; Spotify's
    own relevance order breaks what is left, since Python's sort is stable
    (reverse=True included).

    The second key used to be `popularity`, which is None on every search
    result — every item, always (verified 2026-08-10, 10/10). It sorted
    nothing, and would have raised TypeError comparing None to int the day
    Spotify populated it for some rows but not others. Real popularity needs
    /v1/tracks/{id}, one request per track against the daily quota.
    """
    if not scored:
        return None
    return sorted(scored, key=lambda s: (round(s[0], 1), s[1]), reverse=True)[0][2]


def best_match(token: str, title: str, artist: str, thorough: bool, budget: int):
    # ':' and '"' are Spotify query syntax; stripped so a title like
    # "Don't Stop: Part 2" can't break out of the field filter.
    clean_title = title.replace(":", " ").replace('"', " ")
    clean_artist = artist.replace(":", " ").replace('"', " ")
    query = urllib.parse.quote(f"track:{clean_title} artist:{clean_artist}")
    result = api_get(token, f"{API}/search?q={query}&type=track&market=US&limit=10",
                     budget=budget)
    scored = score_items(result.get("tracks", {}).get("items", []), title, artist)
    if not scored and thorough:  # fallback plain query costs a 2nd request
        query = urllib.parse.quote(f"{clean_title} {clean_artist}")
        result = api_get(token, f"{API}/search?q={query}&type=track&market=US&limit=10",
                         budget=budget)
        scored = score_items(result.get("tracks", {}).get("items", []), title, artist)
    return pick_best(scored)


def song_key(song: dict) -> str:
    return f"{song['title']}|{song['artist']}|{song['year']}"


def track_record(song: dict, track: dict) -> dict:
    """One sidecar row: everything the search response told us about the track
    we chose, keyed by the same identity the catalog and the app use.

    The catalog module gets only `uri` — the clients decode it and neither has
    any use for the rest. This row is where the rest survives, and it is the
    only place it CAN survive: nothing re-issues a search for a song that
    already has a URI, so a field dropped here is gone until someone pays for
    a full re-crawl against the daily quota.

    Field notes:
      - `spotify_artist_ids` is the point of the exercise. Artist identity by
        credit string provably cannot work (see _common.artists_match); these
        IDs are what replaces it.
      - `spotify_artist_names` records Spotify's own spelling for audit. It is
        NOT positionally paired with the ID list (an artist object may lack an
        id) — `track["artists"]` is the aligned truth.
      - `isrc` identifies the RECORDING, stable across album pressings and the
        join key to MusicBrainz. Three of four "Bohemian Rhapsody" search hits
        share GBUM71029604; the 2010 edition is a different master.
      - `album_release_date` is captured but is NOT a release year. Which date
        you get depends on which pressing matched: that same song's hits are
        dated 1975, 2010, 2021 and 2018 (verified 2026-08-10). This is the
        recording-entity fragmentation that made MusicBrainz useless for dates.
        `releaseYear` comes from Wikidata P577 — see harvest_release_dates.py.
      - `title`/`artist`/`year`/`spotify_id` make the file a drop-in mappings
        source for fill_from_datasets.py at no extra cost.
      - `track` is the whole object, ~1.8 KB with market=US pinned. Prune at
        read time, never at fetch time.
    """
    artists = track.get("artists", [])
    album = track.get("album", {})
    return {
        "key": song_key(song),
        "title": song["title"],
        "artist": song["artist"],
        "year": song["year"],
        "spotify_id": track.get("id"),
        "spotify_artist_ids": [a["id"] for a in artists if a.get("id")],
        "spotify_artist_names": [a.get("name", "") for a in artists],
        "isrc": track.get("external_ids", {}).get("isrc"),
        "album_release_date": album.get("release_date"),
        "album_release_date_precision": album.get("release_date_precision"),
        "album_name": album.get("name"),
        "track": track,
    }


@contextlib.contextmanager
def append_track(path: pathlib.Path):
    """Yield a `log(record)` that appends one JSON object per line and flushes.

    Append-only and flushed per row on purpose: these rows cost quota, and a
    Ctrl-C or a crash mid-run must not lose the ones already paid for. A key
    may appear twice if --retry-unresolved re-searches a song; that is history,
    not corruption, and readers should take the last row for a key.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        def log(record: dict) -> None:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
        yield log


def load_merged(path: str, out_path: pathlib.Path) -> dict:
    """Always load the SOURCE module; overlay paid-for results (non-null
    URIs, unresolved markers) from a previous output file when one exists."""
    module = json.load(open(path))
    if out_path.exists():
        previous = {song_key(s): s for s in json.load(open(out_path))["songs"]}
        for song in module["songs"]:
            prev = previous.get(song_key(song))
            if not prev:
                continue
            if prev.get("uri") and not song.get("uri"):
                song["uri"] = prev["uri"]
            if prev.get("unresolved"):
                song["unresolved"] = True
    for song in module["songs"]:
        if song.get("uri"):
            song.pop("unresolved", None)
    return module


def save(module: dict, out_path: pathlib.Path) -> None:
    tmp = out_path.with_name(out_path.name + ".tmp")
    with open(tmp, "w") as handle:
        json.dump(module, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(tmp, out_path)


def main() -> None:
    here = pathlib.Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", help="catalog module JSON files")
    parser.add_argument("--out", required=True, help="output directory for resolved modules")
    parser.add_argument("--tracks", type=pathlib.Path,
                        default=here / "mappings" / "spotify-tracks.jsonl",
                        help="append-only log of the whole chosen track object per "
                             "resolved song (artist IDs, ISRC); never re-fetchable free")
    parser.add_argument("--budget", type=int, default=400,
                        help="max API requests this run (default 400 — stay under the "
                             "per-developer-account daily quota, observed at ~600-1000)")
    parser.add_argument("--thorough", action="store_true",
                        help="allow a fallback second search per song (doubles worst-case cost)")
    parser.add_argument("--retry-unresolved", action="store_true",
                        help="re-attempt songs previously marked unresolved "
                             "(default: skip them so re-runs only do new work)")
    args = parser.parse_args()

    load_dotenv()
    client_id = os.environ["SPOTIFY_CLIENT_ID"]
    client_secret = os.environ["SPOTIFY_CLIENT_SECRET"]
    print(f"using client ID {client_id[:6]}...{client_id[-4:]} "
          "(shell env vars override .env — unset them to switch credentials)",
          file=sys.stderr, flush=True)
    token = get_token(client_id, client_secret)
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    total = resolved = failed = 0
    stop_reason = None
    try:
        with append_track(args.tracks) as log_track:
            for path in args.files:
                if stop_reason:
                    break
                out_path = out_dir / pathlib.Path(path).name
                module = load_merged(path, out_path)
                pending = [s for s in module["songs"] if not s.get("uri")
                           and (args.retry_unresolved or not s.get("unresolved"))]
                if not pending:
                    skipped = sum(1 for s in module["songs"] if s.get("unresolved"))
                    note = f" ({skipped} known-unresolved skipped)" if skipped else ""
                    save(module, out_path)  # keep output in sync with source edits
                    print(f"skip {path} (done{note})", file=sys.stderr, flush=True)
                    continue
                print(f"resolving {path}: {len(pending)} songs "
                      f"[{counter.made}/{args.budget} requests spent]",
                      file=sys.stderr, flush=True)
                file_done = False
                try:
                    for done, song in enumerate(pending, 1):
                        per_song = 2 if args.thorough else 1
                        if counter.made + per_song > args.budget:
                            stop_reason = f"request budget ({args.budget}) reached"
                            break
                        total += 1
                        try:
                            track = best_match(token, song["title"], song["artist"],
                                               args.thorough, args.budget)
                        except TokenExpired:
                            print("access token expired; refreshing", file=sys.stderr, flush=True)
                            token = get_token(client_id, client_secret)
                            track = best_match(token, song["title"], song["artist"],
                                               args.thorough, args.budget)
                        except QuotaExceeded as quota:
                            if quota.retry_after == 0:
                                stop_reason = f"request budget ({args.budget}) reached"
                            else:
                                hours = quota.retry_after / 3600
                                stop_reason = (f"daily quota exhausted (Retry-After "
                                               f"{quota.retry_after}s ~ {hours:.1f}h) — "
                                               "quota is per developer account")
                            break
                        if track:
                            song["uri"] = track["uri"]
                            song.pop("unresolved", None)
                            # Before anything else: the module keeps only the
                            # URI, and this search will never be re-issued.
                            log_track(track_record(song, track))
                            resolved += 1
                        else:
                            failed += 1
                            song["unresolved"] = True  # skip next run unless --retry-unresolved
                            print(f"UNRESOLVED  {song['year']}  {song['title']} / {song['artist']}",
                                  file=sys.stderr, flush=True)
                        if done % 10 == 0:
                            print(f"  ...{done}/{len(pending)}", file=sys.stderr, flush=True)
                        time.sleep(0.6)  # stay far inside the rolling 30s rate-limit window
                    else:
                        file_done = True
                finally:
                    # ALWAYS save — a crash or Ctrl-C must never lose paid lookups.
                    save(module, out_path)
                    suffix = "" if file_done else " (partial)"
                    print(f"wrote {out_path}{suffix}", file=sys.stderr, flush=True)
    except KeyboardInterrupt:
        stop_reason = "interrupted (Ctrl-C)"
    print(f"resolved {resolved}/{total} this run ({failed} marked unresolved; "
          f"{counter.made} requests spent)", file=sys.stderr)
    if stop_reason:
        print(f"STOPPED: {stop_reason}\n"
              "Progress is saved — re-run later (tomorrow, or with a different "
              "developer account's credentials) to continue from here.",
              file=sys.stderr)


if __name__ == "__main__":
    main()
