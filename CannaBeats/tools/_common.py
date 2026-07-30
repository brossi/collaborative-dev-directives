"""Shared plumbing for the CannaBeats tools — one copy of the things that
were drifting apart: text normalization, primary-artist extraction, Spotify
token fetch, and the quota-aware API GET.

Not a CLI. Import from the sibling tools (they run with tools/ on sys.path,
so `from _common import ...` works from any cwd).
"""
import base64
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

PAREN = re.compile(r"[\(\[].*?[\)\]]")
PUNCT = re.compile(r"[^a-z0-9 ]")
# Separator-style patterns only: they need whitespace on both sides, so a
# trailing "X" in a band name ("Lil Nas X") is never treated as a feat. cut.
FEAT = re.compile(r"\s+(?:featuring|feat\.?|ft\.?|with)\s+.*$")
FEAT_X = re.compile(r"\s+x\s+.*$")
PLAYLIST_ID = re.compile(r"playlist[/:]([A-Za-z0-9]+)")


def norm(text: str) -> str:
    """Canonical fuzzy-compare form: lowercase, accents folded to ascii,
    "&" -> " and ", (…)/[…] spans dropped, non-alphanumerics stripped."""
    text = text.lower()
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = text.replace("&", " and ")
    text = PAREN.sub("", text)
    text = PUNCT.sub("", text)
    return " ".join(text.split())


def primary_artist(artist: str) -> str:
    """Normalized lead artist: cut feat./ft./with/" x " credits (separator
    forms only — primary_artist("Lil Nas X") == "lil nas x"), then take the
    first name before any ","/" and "/" & ", then norm. May be "" (e.g. a
    bare "?"); callers must never index or look up an empty key."""
    cut = FEAT.sub("", artist.lower())
    cut = FEAT_X.sub("", cut)
    cut = re.split(r",| and | & ", cut)[0]
    return norm(cut)


def playlist_id(arg: str) -> str:
    """Extract the playlist ID from a Spotify URL/URI, or pass a bare ID through."""
    match = PLAYLIST_ID.search(arg)
    return match.group(1) if match else arg


class QuotaExceeded(Exception):
    """Daily-quota 429 (retry_after seconds), or — with retry_after == 0 —
    the caller-supplied request budget for this run is spent."""
    def __init__(self, retry_after: int):
        self.retry_after = retry_after


class TokenExpired(Exception):
    """HTTP 401 — the access token aged out; refresh is the caller's job."""


class RequestCounter:
    """Mutable request tally shared between a tool and api_get."""
    def __init__(self):
        self.made = 0


counter = RequestCounter()  # module-level default; tools may pass their own


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
        except urllib.error.HTTPError as error:
            # 4xx = the request itself is bad (wrong credentials); retrying
            # cannot fix it and the old URLError path blamed the network.
            if 400 <= error.code < 500:
                snippet = b""
                try:
                    snippet = error.read()[:200]
                except OSError:
                    pass
                raise SystemExit(
                    f"token request rejected (HTTP {error.code}): check "
                    f"SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET\n{snippet.decode(errors='replace')}"
                ) from None
            last_error = error
            print(f"token request failed ({error}); retrying in 5s (attempt {attempt + 1}/4)",
                  file=sys.stderr, flush=True)
            time.sleep(5)
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


def api_get(token: str, url: str, budget=None, counter=counter) -> dict:
    """Authorized GET with retries, visible rate-limit sleeps, and the
    quota/rate-limit split. Raises QuotaExceeded(0) if the next request
    would exceed `budget` (checked inside the retry loop, so retries can
    never overshoot), QuotaExceeded(s) on a daily-quota 429, TokenExpired
    on 401. Every request — retries included — bumps `counter.made`."""
    for attempt in range(6):
        if budget is not None and counter.made + 1 > budget:
            raise QuotaExceeded(0)
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            counter.made += 1
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
            if error.code == 401:
                raise TokenExpired() from None
            raise
        except (TimeoutError, OSError) as error:
            print(f"  network hiccup ({error}); retrying in 10s (attempt {attempt + 1}/6)",
                  file=sys.stderr, flush=True)
            time.sleep(10)
    raise RuntimeError(f"gave up on {url}")
