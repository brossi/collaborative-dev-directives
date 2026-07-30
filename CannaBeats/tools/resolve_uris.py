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
"""
import argparse
import difflib
import json
import os
import pathlib
import sys
import time
import urllib.parse

from _common import (QuotaExceeded, TokenExpired, api_get, counter, get_token,
                     norm as normalize, primary_artist)
from env import load_dotenv

API = "https://api.spotify.com/v1"


def artist_matches(track: dict, artist: str) -> bool:
    """True when the candidate track shares at least one normalized artist
    token with our catalog artist (or its primary artist matches). A wrong
    artist is the wrong song no matter how well the title scores."""
    want_tokens = set(normalize(artist).split())
    want_primary = primary_artist(artist)
    if not want_tokens and not want_primary:
        return True  # nothing to compare against ("?" norms to "")
    for candidate in track.get("artists", []):
        got = normalize(candidate.get("name", ""))
        if want_tokens & set(got.split()):
            return True
        if want_primary and (got == want_primary or primary_artist(candidate.get("name", "")) == want_primary):
            return True
    return False


def score_items(items, title: str, artist: str):
    want = normalize(title)
    scored = []
    for track in items:
        if not artist_matches(track, artist):
            continue
        got = normalize(track["name"])
        similarity = difflib.SequenceMatcher(None, want, got).ratio()
        if similarity < 0.6:
            continue
        scored.append((similarity, track.get("popularity", 0), track))
    return scored


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
    if not scored:
        return None
    scored.sort(key=lambda s: (round(s[0], 1), s[1]), reverse=True)
    return scored[0][2]


def song_key(song: dict) -> str:
    return f"{song['title']}|{song['artist']}|{song['year']}"


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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", help="catalog module JSON files")
    parser.add_argument("--out", required=True, help="output directory for resolved modules")
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
