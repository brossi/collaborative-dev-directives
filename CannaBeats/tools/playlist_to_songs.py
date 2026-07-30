#!/usr/bin/env python3
"""Export a Spotify playlist to songs.json rows for CannaBeats.

Usage:
  python3 playlist_to_songs.py <playlist_url_or_id> > songs.json

Credentials come from SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (env or
.env) — the same app you registered at
https://developer.spotify.com/dashboard (client-credentials flow —
no user login needed; the playlist must be public).

CAVEAT: `year` is taken from Spotify's *album* release date, which is
wrong for remasters and compilations (and null when Spotify has no usable
date). Hand-verify years before game night — that step is what makes the
game good.
"""
import json
import os
import sys
import time
import urllib.parse

from _common import TokenExpired, api_get, get_token, playlist_id
from env import load_dotenv


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    load_dotenv()
    client_id = os.environ["SPOTIFY_CLIENT_ID"]
    client_secret = os.environ["SPOTIFY_CLIENT_SECRET"]
    token = get_token(client_id, client_secret)
    fields = "next,items(track(name,uri,artists(name),album(release_date)))"
    url = (
        f"https://api.spotify.com/v1/playlists/{playlist_id(sys.argv[1])}/tracks"
        f"?limit=100&fields={urllib.parse.quote(fields)}"
    )
    songs = []
    while url:
        try:
            page = api_get(token, url)
        except TokenExpired:
            print("access token expired; refreshing", file=sys.stderr, flush=True)
            token = get_token(client_id, client_secret)
            page = api_get(token, url)
        for item in page["items"]:
            track = item.get("track")
            if not track or not track.get("uri", "").startswith("spotify:track:"):
                continue  # skip local files / episodes / removed tracks
            date = (track.get("album") or {}).get("release_date") or ""
            year = int(date[:4]) if date[:4].isdigit() else None
            if year is None:
                print(f"WARNING: no release year for {track['name']} — kept with year: null",
                      file=sys.stderr)
            songs.append(
                {
                    "title": track["name"],
                    "artist": ", ".join(a["name"] for a in track["artists"]),
                    "year": year,
                    "uri": track["uri"],
                }
            )
        url = page.get("next")
        time.sleep(0.6)  # stay far inside the rolling rate-limit window
    json.dump(songs, sys.stdout, indent=2, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
