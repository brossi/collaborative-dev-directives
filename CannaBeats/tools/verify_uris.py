#!/usr/bin/env python3
"""Verify resolved Spotify URIs via the public oEmbed endpoint — no
credentials, no Web API, no developer quota.

Usage:
  python3 verify_uris.py CannaBeats/Resources/Catalog/*.json [--limit N]

For every song with a URI, fetches
https://open.spotify.com/oembed?url=https://open.spotify.com/track/<id>
and fuzzy-compares the returned title to ours. Prints MISMATCH and DEAD
lines for anything suspicious; exits 0 either way (it's a report, not a
gate). Results are cached in .verify_cache.json next to this script so
re-runs only check new URIs. Paced at ~2 req/s.
"""
import argparse
import difflib
import json
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

CACHE = pathlib.Path(__file__).with_name(".verify_cache.json")


def norm(text: str) -> str:
    text = re.sub(r"[\(\[].*?[\)\]]", "", text.lower())
    text = re.sub(r"[^a-z0-9 ]", "", text)
    return " ".join(text.split())


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
    parser.add_argument("--limit", type=int, default=0, help="stop after N checks (0 = all)")
    args = parser.parse_args()

    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    checked = mismatched = dead = 0
    try:
        for path in args.files:
            module = json.load(open(path))
            for song in module["songs"]:
                uri = song.get("uri") or ""
                if not uri.startswith("spotify:track:"):
                    continue
                track_id = uri.rsplit(":", 1)[-1]
                if track_id in cache:
                    continue
                if args.limit and checked >= args.limit:
                    raise KeyboardInterrupt
                title = oembed_title(track_id)
                checked += 1
                if title is None:
                    dead += 1
                    print(f"DEAD      {song['year']}  {song['title']} / {song['artist']}  ({uri})")
                    cache[track_id] = "DEAD"
                elif isinstance(title, str) and title.startswith("ERROR:"):
                    print(f"UNCHECKED {song['title']} — {title}", file=sys.stderr)
                else:
                    ratio = difflib.SequenceMatcher(None, norm(song["title"]), norm(title)).ratio()
                    if ratio < 0.5:
                        mismatched += 1
                        print(f"MISMATCH  {song['year']}  {song['title']} / {song['artist']}"
                              f"  ->  {title}  ({uri})")
                    cache[track_id] = title
                time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        CACHE.write_text(json.dumps(cache))
    print(f"checked {checked} new URIs: {mismatched} mismatches, {dead} dead",
          file=sys.stderr)


if __name__ == "__main__":
    main()
