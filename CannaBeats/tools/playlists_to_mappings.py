#!/usr/bin/env python3
"""Fetch Spotify playlists into mapping rows for fill_from_datasets.py.

Usage:
  python3 playlists_to_mappings.py --out mappings/playlists.jsonl \
      <playlist_url_or_id> [...]
  python3 playlists_to_mappings.py --out mappings/playlists.jsonl \
      --from-file playlists.txt        # one URL/ID per line, # comments ok

WHY: search costs 1 API request PER SONG; a playlist read returns 100
tracks per request. Spotify's own curated playlists ("Top Hits of 2022",
"All Out 80s", "Broadway's Best", soundtrack playlists) can cover most
catalog gaps for a few dozen requests instead of hundreds. Then run:

  python3 fill_from_datasets.py --mappings mappings/playlists.jsonl -- \
      catalog/years/*.json catalog/themes/*.json

Quota-aware: counts requests, honors --budget (default 100), detects
QUOTA_EXCEEDED 429s and stops with output saved. Appends to --out and
records finished playlists as marker rows, so re-runs skip them (the
markers have no spotify_id, so fill_from_datasets ignores them).

CAVEAT: year comes from the *album* release date — wrong for remasters
and compilations. fill_from_datasets.py's --year-tolerance (default 2)
rejects those instead of mislinking; raise it to 3 for cast-recording
playlists, where the album often trails the show by a season.
"""
import argparse
import base64
import json
import os
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

from env import load_dotenv

requests_made = 0


class QuotaExceeded(Exception):
    def __init__(self, retry_after: int):
        self.retry_after = retry_after


def get_token(client_id: str, client_secret: str) -> str:
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    request = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
        headers={"Authorization": f"Basic {credentials}"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["access_token"]


def api_get(token: str, url: str) -> dict:
    global requests_made
    for attempt in range(6):
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            requests_made += 1
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 429:
                wait = int(error.headers.get("Retry-After", 5)) + 1
                body = b""
                try:
                    body = error.read()
                except OSError:
                    pass
                if b"QUOTA_EXCEEDED" in body or wait > 3600:
                    raise QuotaExceeded(wait) from None
                print(f"  rate limited; sleeping {wait}s (attempt {attempt + 1}/6)",
                      file=sys.stderr, flush=True)
                time.sleep(wait)
                continue
            raise
        except (TimeoutError, OSError) as error:
            print(f"  network hiccup ({error}); retrying in 10s (attempt {attempt + 1}/6)",
                  file=sys.stderr, flush=True)
            time.sleep(10)
    raise RuntimeError(f"gave up on {url}")


def playlist_id(arg: str) -> str:
    match = re.search(r"playlist[/:]([A-Za-z0-9]+)", arg)
    return match.group(1) if match else arg


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("playlists", nargs="*", help="playlist URLs or IDs")
    parser.add_argument("--from-file", help="file with one playlist URL/ID per line")
    parser.add_argument("--out", required=True, help="mapping JSONL to append to")
    parser.add_argument("--budget", type=int, default=100,
                        help="max API requests this run (default 100)")
    args = parser.parse_args()

    wanted = [playlist_id(p) for p in args.playlists]
    if args.from_file:
        for line in open(args.from_file):
            line = line.split("#", 1)[0].strip()
            if line:
                wanted.append(playlist_id(line))
    if not wanted:
        sys.exit("no playlists given")

    out_path = pathlib.Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out_path.exists():
        for line in open(out_path):
            line = line.strip()
            if line:
                row = json.loads(line)
                if "playlist_done" in row:
                    done.add(row["playlist_done"])

    load_dotenv()
    client_id = os.environ["SPOTIFY_CLIENT_ID"]
    print(f"using client ID {client_id[:6]}...{client_id[-4:]}", file=sys.stderr, flush=True)
    token = get_token(client_id, os.environ["SPOTIFY_CLIENT_SECRET"])

    fields = "next,items(track(name,uri,artists(name),album(release_date)))"
    tracks_written = 0
    with open(out_path, "a") as out:
        try:
            for pid in wanted:
                if pid in done:
                    print(f"skip {pid} (already fetched)", file=sys.stderr, flush=True)
                    continue
                url = (f"https://api.spotify.com/v1/playlists/{pid}/tracks"
                       f"?limit=100&fields={urllib.parse.quote(fields)}")
                count = 0
                while url:
                    if requests_made >= args.budget:
                        raise QuotaExceeded(0)
                    page = api_get(token, url)
                    for item in page.get("items", []):
                        track = item.get("track")
                        if not track or not track.get("uri", "").startswith("spotify:track:"):
                            continue
                        date = (track.get("album") or {}).get("release_date") or ""
                        year = int(date[:4]) if date[:4].isdigit() else None
                        out.write(json.dumps({
                            "title": track["name"],
                            "artist": ", ".join(a["name"] for a in track["artists"]),
                            "year": year,
                            "spotify_id": track["uri"].rsplit(":", 1)[-1],
                        }, ensure_ascii=False) + "\n")
                        count += 1
                    url = page.get("next")
                    time.sleep(0.6)
                out.write(json.dumps({"playlist_done": pid}) + "\n")
                out.flush()
                tracks_written += count
                print(f"{pid}: {count} tracks [{requests_made}/{args.budget} requests]",
                      file=sys.stderr, flush=True)
        except QuotaExceeded as quota:
            reason = ("request budget reached" if quota.retry_after == 0 else
                      f"daily quota exhausted (Retry-After {quota.retry_after}s)")
            print(f"STOPPED: {reason} — output saved; re-run later to continue",
                  file=sys.stderr)
    print(f"wrote {tracks_written} mapping rows ({requests_made} requests spent)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
