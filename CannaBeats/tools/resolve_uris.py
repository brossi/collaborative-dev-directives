#!/usr/bin/env python3
"""Fill in Spotify track URIs for catalog module files (uri: null -> real URI).

Usage:
  SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... \
    python3 resolve_uris.py catalog/years/*.json --out CannaBeats/Resources/Catalog/

For each song with a null uri, searches the Spotify API (market=US) for
"track:<title> artist:<artist>" and picks the most popular result whose
title matches. Writes the resolved module to --out (same filename);
already-resolved URIs are left untouched, so re-runs are incremental.

Songs that can't be resolved keep uri: null (the app skips them) and are
listed on stderr for manual fixing — paste a track link from the Spotify
app into the JSON as "spotify:track:<id>".

Run this from a US network location (the deck is curated for US Spotify).
"""
import argparse
import base64
import difflib
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

from env import load_dotenv

API = "https://api.spotify.com/v1"


def get_token(client_id: str, client_secret: str) -> str:
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    request = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
        headers={"Authorization": f"Basic {credentials}"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)["access_token"]


def api_get(token: str, url: str) -> dict:
    for attempt in range(8):
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 429:  # rate limited — honor Retry-After, loudly
                wait = int(error.headers.get("Retry-After", 5)) + 1
                print(f"  rate limited; sleeping {wait}s (attempt {attempt + 1}/8)",
                      file=sys.stderr, flush=True)
                time.sleep(min(wait, 900))
                continue
            raise
        except (TimeoutError, OSError) as error:
            print(f"  network hiccup ({error}); retrying in 10s (attempt {attempt + 1}/8)",
                  file=sys.stderr, flush=True)
            time.sleep(10)
    raise RuntimeError(f"gave up on {url}")


def normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[\(\[].*?[\)\]]", "", text)  # drop (remastered) etc.
    text = re.sub(r"[^a-z0-9 ]", "", text)
    return " ".join(text.split())


def best_match(token: str, title: str, artist: str):
    query = urllib.parse.quote(f"track:{title} artist:{artist}")
    result = api_get(token, f"{API}/search?q={query}&type=track&market=US&limit=10")
    items = result.get("tracks", {}).get("items", [])
    if not items:  # retry without the field filters (covers punctuation quirks)
        query = urllib.parse.quote(f"{title} {artist}")
        result = api_get(token, f"{API}/search?q={query}&type=track&market=US&limit=10")
        items = result.get("tracks", {}).get("items", [])
    want = normalize(title)
    scored = []
    for track in items:
        got = normalize(track["name"])
        similarity = difflib.SequenceMatcher(None, want, got).ratio()
        if similarity < 0.6:
            continue
        scored.append((similarity, track.get("popularity", 0), track))
    if not scored:
        return None
    scored.sort(key=lambda s: (round(s[0], 1), s[1]), reverse=True)
    return scored[0][2]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", help="catalog module JSON files")
    parser.add_argument("--out", required=True, help="output directory for resolved modules")
    args = parser.parse_args()

    load_dotenv()
    token = get_token(os.environ["SPOTIFY_CLIENT_ID"], os.environ["SPOTIFY_CLIENT_SECRET"])
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    total = resolved = failed = 0
    for path in args.files:
        out_path = out_dir / pathlib.Path(path).name
        # Resume support: if this module was already (partly) resolved, work
        # from the output file so finished lookups are never repeated.
        module = json.load(open(out_path if out_path.exists() else path))
        pending = [s for s in module["songs"] if not s.get("uri")]
        if not pending:
            print(f"skip {out_path} (already resolved)", file=sys.stderr, flush=True)
            continue
        print(f"resolving {path}: {len(pending)} songs", file=sys.stderr, flush=True)
        for done, song in enumerate(pending, 1):
            total += 1
            track = best_match(token, song["title"], song["artist"])
            if track:
                song["uri"] = track["uri"]
                resolved += 1
            else:
                failed += 1
                print(f"UNRESOLVED  {song['year']}  {song['title']} / {song['artist']}",
                      file=sys.stderr, flush=True)
            if done % 10 == 0:
                print(f"  ...{done}/{len(pending)}", file=sys.stderr, flush=True)
            time.sleep(0.5)  # ~2 req/s keeps clear of extended rate limiting
        with open(out_path, "w") as handle:
            json.dump(module, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        print(f"wrote {out_path}", file=sys.stderr, flush=True)
    print(f"resolved {resolved}/{total} ({failed} need manual fixes)", file=sys.stderr)


if __name__ == "__main__":
    main()
