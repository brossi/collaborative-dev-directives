#!/usr/bin/env python3
"""Verify resolved Spotify URIs via the public oEmbed endpoint — no
credentials, no Web API, no developer quota.

Usage:
  python3 tools/verify_uris.py CannaBeats/Resources/Catalog/*.json [--limit N]

Run from the CannaBeats/ directory (the folder containing catalog/ and
tools/) — or any cwd, as long as the file paths resolve.

For every song with a URI, fetches
https://open.spotify.com/oembed?url=https://open.spotify.com/track/<id>
and fuzzy-compares the returned title to ours. Prints MISMATCH and DEAD
lines for anything suspicious; exits 0 either way (it's a report, not a
gate). Titles are cached in .verify_cache.json next to this script: the
cache saves oEmbed requests on re-runs, but every song's verdict is
recomputed and re-printed every run — a cached title can still MISMATCH,
and songs sharing one track ID each get their own comparison. Paced at
~2 req/s.
"""
import argparse
import difflib
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

from _common import norm

CACHE = pathlib.Path(__file__).with_name(".verify_cache.json")


def oembed_title(track_id: str):
    url = ("https://open.spotify.com/oembed?url=" +
           urllib.parse.quote(f"https://open.spotify.com/track/{track_id}", safe=""))
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            return json.load(response).get("title", "")
    except Exception as error:  # noqa: BLE001 — report, don't crash
        return None if "404" in str(error) else f"ERROR:{error}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+")
    parser.add_argument("--limit", type=int, default=0,
                        help="stop after N oEmbed fetches (0 = all; cache hits are free)")
    args = parser.parse_args()

    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    total = from_cache = fetched = mismatched = dead = 0
    limit_hit = False
    try:
        for path in args.files:
            module = json.load(open(path))
            for song in module["songs"]:
                uri = song.get("uri") or ""
                if not uri.startswith("spotify:track:"):
                    continue
                track_id = uri.rsplit(":", 1)[-1]
                if track_id in cache:
                    title = cache[track_id]
                    title = None if title == "DEAD" else title
                    from_cache += 1
                else:
                    if args.limit and fetched >= args.limit:
                        limit_hit = True
                        raise KeyboardInterrupt
                    title = oembed_title(track_id)
                    fetched += 1
                    if title is None:
                        cache[track_id] = "DEAD"
                    elif not title.startswith("ERROR:"):
                        cache[track_id] = title
                    time.sleep(0.5)
                # Verdicts are recomputed every run, cache hit or not — the
                # cache saves requests, never silences results.
                if isinstance(title, str) and title.startswith("ERROR:"):
                    print(f"UNCHECKED {song['title']} — {title}", file=sys.stderr)
                    continue
                total += 1
                if title is None:
                    dead += 1
                    print(f"DEAD      {song['year']}  {song['title']} / {song['artist']}  ({uri})")
                else:
                    ratio = difflib.SequenceMatcher(None, norm(song["title"]), norm(title)).ratio()
                    if ratio < 0.5:
                        mismatched += 1
                        print(f"MISMATCH  {song['year']}  {song['title']} / {song['artist']}"
                              f"  ->  {title}  ({uri})")
    except KeyboardInterrupt:
        pass
    finally:
        CACHE.write_text(json.dumps(cache))
    summary = (f"checked {total} songs ({from_cache} from cache, {fetched} fetched): "
               f"{mismatched} mismatches, {dead} dead")
    if limit_hit:
        summary += f" (stopped at --limit {args.limit})"
    print(summary, file=sys.stderr)


if __name__ == "__main__":
    main()
