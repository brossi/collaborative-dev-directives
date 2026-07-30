#!/usr/bin/env python3
"""Fill in Spotify track URIs for catalog module files (uri: null -> real URI).

Usage:
  python3 resolve_uris.py catalog/years/*.json --out CannaBeats/Resources/Catalog/

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

Songs that can't be matched are marked "unresolved": true (skipped on
re-runs unless --retry-unresolved) — paste a track link from the Spotify
app into the JSON as "spotify:track:<id>" for those.
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

requests_made = 0


class QuotaExceeded(Exception):
    def __init__(self, retry_after: int):
        self.retry_after = retry_after


def get_token(client_id: str, client_secret: str) -> str:
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    last_error = None
    for attempt in range(4):
        request = urllib.request.Request(
            "https://accounts.spotify.com/api/token",
            data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
            headers={"Authorization": f"Basic {credentials}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)["access_token"]
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            last_error = error
            print(f"token request failed ({error}); retrying in 5s (attempt {attempt + 1}/4)",
                  file=sys.stderr, flush=True)
            time.sleep(5)
    raise SystemExit(
        f"could not reach accounts.spotify.com: {last_error}\n"
        "If you are behind a proxy/VPN, try disabling it for this run — "
        "the resolver pins the US catalog via market=US and does not need a US IP."
    )


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
                # Daily quota, not the rolling rate limit: stop, don't sleep.
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


def normalize(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[\(\[].*?[\)\]]", "", text)  # drop (remastered) etc.
    text = re.sub(r"[^a-z0-9 ]", "", text)
    return " ".join(text.split())


def best_match(token: str, title: str, artist: str, thorough: bool):
    query = urllib.parse.quote(f"track:{title} artist:{artist}")
    result = api_get(token, f"{API}/search?q={query}&type=track&market=US&limit=10")
    items = result.get("tracks", {}).get("items", [])
    if not items and thorough:  # fallback plain query costs a 2nd request
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


def save(module: dict, out_path: pathlib.Path) -> None:
    with open(out_path, "w") as handle:
        json.dump(module, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


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
    print(f"using client ID {client_id[:6]}...{client_id[-4:]} "
          "(shell env vars override .env — unset them to switch credentials)",
          file=sys.stderr, flush=True)
    token = get_token(client_id, os.environ["SPOTIFY_CLIENT_SECRET"])
    out_dir = pathlib.Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    total = resolved = failed = 0
    stop_reason = None
    for path in args.files:
        if stop_reason:
            break
        out_path = out_dir / pathlib.Path(path).name
        # Resume support: work from the output file when it exists so
        # finished lookups are never repeated.
        module = json.load(open(out_path if out_path.exists() else path))
        pending = [s for s in module["songs"] if not s.get("uri")
                   and (args.retry_unresolved or not s.get("unresolved"))]
        if not pending:
            skipped = sum(1 for s in module["songs"] if s.get("unresolved"))
            note = f" ({skipped} known-unresolved skipped)" if skipped else ""
            print(f"skip {out_path} (done{note})", file=sys.stderr, flush=True)
            continue
        print(f"resolving {path}: {len(pending)} songs "
              f"[{requests_made}/{args.budget} requests spent]",
              file=sys.stderr, flush=True)
        for done, song in enumerate(pending, 1):
            per_song = 2 if args.thorough else 1
            if requests_made + per_song > args.budget:
                stop_reason = f"request budget ({args.budget}) reached"
                break
            total += 1
            try:
                track = best_match(token, song["title"], song["artist"], args.thorough)
            except QuotaExceeded as quota:
                hours = quota.retry_after / 3600
                stop_reason = (f"daily quota exhausted (Retry-After {quota.retry_after}s "
                               f"~ {hours:.1f}h) — quota is per developer account")
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
        save(module, out_path)  # partial progress is kept even on early stop
        print(f"wrote {out_path}", file=sys.stderr, flush=True)
    print(f"resolved {resolved}/{total} this run ({failed} marked unresolved; "
          f"{requests_made} requests spent)", file=sys.stderr)
    if stop_reason:
        print(f"STOPPED: {stop_reason}\n"
              "Progress is saved — re-run later (tomorrow, or with a different "
              "developer account's credentials) to continue from here.",
              file=sys.stderr)


if __name__ == "__main__":
    main()
