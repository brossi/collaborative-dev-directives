#!/usr/bin/env python3
"""Fetch Spotify playlists into mapping rows for fill_from_datasets.py.

Usage (run from the CannaBeats/ directory, so the relative --out path — and
the resume markers inside it — stay stable across runs):
  python3 tools/playlists_to_mappings.py --out mappings/playlists.jsonl \
      <playlist_url_or_id> [...]
  python3 tools/playlists_to_mappings.py --out mappings/playlists.jsonl \
      --from-file playlists.txt        # one URL/ID per line, # comments ok

WHY: search costs 1 API request PER SONG; a playlist read returns 100
tracks per request. Spotify's own curated playlists ("Top Hits of 2022",
"All Out 80s", "Broadway's Best", soundtrack playlists) can cover most
catalog gaps for a few dozen requests instead of hundreds. Then run:

  python3 tools/fill_from_datasets.py --mappings mappings/playlists.jsonl -- \
      catalog/years/*.json catalog/themes/*.json

Quota-aware: counts requests, honors --budget (default 100), detects
QUOTA_EXCEEDED 429s and stops with output saved. Appends to --out and
records finished playlists as marker rows, so re-runs skip them (the
markers have no spotify_id, so fill_from_datasets ignores them). A
playlist's rows are written only once ALL its pages are fetched — a
budget/quota stop mid-playlist writes nothing for it.

CAVEAT: year comes from the *album* release date — wrong for remasters
and compilations. fill_from_datasets.py's --year-tolerance (default 2)
rejects those instead of mislinking; raise it to 3 for cast-recording
playlists, where the album often trails the show by a season.
"""
import argparse
import json
import os
import pathlib
import sys
import time
import urllib.parse

from _common import QuotaExceeded, TokenExpired, api_get, counter, get_token, playlist_id
from env import load_dotenv


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
    # Resume markers live in whatever file --out resolves to — print the
    # absolute path so a different cwd can't silently mean a fresh file.
    print(f"output: {out_path.resolve()} ({len(done)} playlist(s) already done)",
          file=sys.stderr, flush=True)

    load_dotenv()
    client_id = os.environ["SPOTIFY_CLIENT_ID"]
    client_secret = os.environ["SPOTIFY_CLIENT_SECRET"]
    print(f"using client ID {client_id[:6]}...{client_id[-4:]}", file=sys.stderr, flush=True)
    token = get_token(client_id, client_secret)

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
                # Accumulate the playlist in memory; rows + the done marker
                # are written together only after its final page. A stop
                # mid-playlist writes NOTHING for it — re-fetching a few
                # pages next run beats duplicate mapping rows forever.
                rows = []
                while url:
                    try:
                        page = api_get(token, url, budget=args.budget)
                    except TokenExpired:
                        print("access token expired; refreshing", file=sys.stderr, flush=True)
                        token = get_token(client_id, client_secret)
                        page = api_get(token, url, budget=args.budget)
                    for item in page.get("items", []):
                        track = item.get("track")
                        if not track or not track.get("uri", "").startswith("spotify:track:"):
                            continue
                        date = (track.get("album") or {}).get("release_date") or ""
                        year = int(date[:4]) if date[:4].isdigit() else None
                        rows.append({
                            "title": track["name"],
                            "artist": ", ".join(a["name"] for a in track["artists"]),
                            "year": year,
                            "spotify_id": track["uri"].rsplit(":", 1)[-1],
                        })
                    url = page.get("next")
                    time.sleep(0.6)
                for row in rows:
                    out.write(json.dumps(row, ensure_ascii=False) + "\n")
                out.write(json.dumps({"playlist_done": pid}) + "\n")
                out.flush()
                tracks_written += len(rows)
                print(f"{pid}: {len(rows)} tracks [{counter.made}/{args.budget} requests]",
                      file=sys.stderr, flush=True)
        except QuotaExceeded as quota:
            reason = ("request budget reached" if quota.retry_after == 0 else
                      f"daily quota exhausted (Retry-After {quota.retry_after}s)")
            print(f"STOPPED: {reason} — finished playlists saved; re-run later to continue",
                  file=sys.stderr)
    print(f"wrote {tracks_written} mapping rows ({counter.made} requests spent)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
