#!/usr/bin/env python3
"""Export a Spotify playlist to songs.json rows for RossiHitFam.

Usage:
  SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... \
    python3 playlist_to_songs.py <playlist_url_or_id> > songs.json

Client ID/secret come from the same app you registered at
https://developer.spotify.com/dashboard (client-credentials flow —
no user login needed; the playlist must be public).

CAVEAT: `year` is taken from Spotify's *album* release date, which is
wrong for remasters and compilations. Hand-verify years before game
night — that step is what makes the game good.
"""
import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request


def get_token(client_id: str, client_secret: str) -> str:
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    request = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
        headers={"Authorization": f"Basic {credentials}"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)["access_token"]


def playlist_id(arg: str) -> str:
    match = re.search(r"playlist[/:]([A-Za-z0-9]+)", arg)
    return match.group(1) if match else arg


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    token = get_token(os.environ["SPOTIFY_CLIENT_ID"], os.environ["SPOTIFY_CLIENT_SECRET"])
    fields = "next,items(track(name,uri,artists(name),album(release_date)))"
    url = (
        f"https://api.spotify.com/v1/playlists/{playlist_id(sys.argv[1])}/tracks"
        f"?limit=100&fields={urllib.parse.quote(fields)}"
    )
    songs = []
    while url:
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request) as response:
            page = json.load(response)
        for item in page["items"]:
            track = item.get("track")
            if not track or not track.get("uri", "").startswith("spotify:track:"):
                continue  # skip local files / episodes / removed tracks
            songs.append(
                {
                    "title": track["name"],
                    "artist": ", ".join(a["name"] for a in track["artists"]),
                    "year": int(track["album"]["release_date"][:4]),
                    "uri": track["uri"],
                }
            )
        url = page.get("next")
    json.dump(songs, sys.stdout, indent=2, ensure_ascii=False)
    print()


if __name__ == "__main__":
    main()
