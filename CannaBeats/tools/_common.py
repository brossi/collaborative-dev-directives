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
# Acts that spell letters with punctuation. norm() strips the glyph, so "P!nk"
# becomes "pnk" and shares nothing with a catalog spelling of "Pink".
#
# This is a table and not a rule because no rule works. Similarity on the
# stripped forms cannot separate the cases: "seal"/"seals" are DIFFERENT acts
# and score 0.889, while "pnk"/"pink" are the SAME act and score 0.857. The
# distributions overlap, so any threshold either admits Seals & Crofts as Seal
# or drops P!nk. Per-character rules fare no better — "Panic!" and "$ign" are
# both word-boundary glyphs needing opposite treatment.
#
# The durable fix is not string matching at all: Spotify, MusicBrainz and
# Wikidata all publish stable artist IDs. Match on those and this table dies.
# Until then, entries are added only from an OBSERVED failure, never guessed.
ARTIST_ALIASES = {
    "pnk": "pink",      # P!nk       — cost a one-off script to recover 8 songs
    "keha": "kesha",    # Ke$ha
    "ign": "sign",      # Ty Dolla $ign
    "aap": "asap",      # A$AP Rocky / A$AP Ferg
}


def _dealias(token: str) -> str:
    return ARTIST_ALIASES.get(token, token)


# Separator-style patterns only: they need whitespace on both sides, so a
# trailing "X" in a band name ("Lil Nas X") is never treated as a feat. cut.
FEAT = re.compile(r"\s+(?:featuring|feat\.?|ft\.?|with)\s+.*$")
FEAT_X = re.compile(r"\s+x\s+.*$")
PLAYLIST_ID = re.compile(r"playlist[/:]([A-Za-z0-9]+)")


def norm(text: str) -> str:
    """Canonical fuzzy-compare form: lowercase, accents folded to ascii,
    "&" -> " and ", (…)/[…] spans dropped, non-alphanumerics stripped.

    Punctuation is removed, not interpreted: "P!nk" -> "pnk". Restoring the
    letter belongs to ARTIST_ALIASES, which only the artist path consults —
    titles must not be second-guessed this way ("Oh!" is not "Ohi")."""
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
    return " ".join(_dealias(t) for t in norm(cut).split())


# norm() rewrites "&" to " and " — correct for comparing titles, ruinous when
# the result is treated as a bag of significant words. "Cardi B, Bad Bunny & J
# Balvin" and "Gerry and the Pacemakers" then share "and"; "The Beatles" and
# "The Rolling Stones" share "the". Both matched under a single-shared-token
# rule and produced confident, wrong answers.
ARTIST_STOPWORDS = frozenset({
    "the", "and", "a", "an", "of", "featuring", "feat", "with", "his", "her",
    "their", "band", "orchestra", "group", "presents", "vs", "x", "duo", "trio",
})


def significant_tokens(artist: str) -> set:
    """norm() tokens with filler dropped and glyph spellings de-aliased."""
    return {_dealias(t) for t in norm(artist).split()
            if t not in ARTIST_STOPWORDS and len(t) > 1}


def artists_match(candidate: str, ours: str) -> bool:
    """True when two artist credits plausibly name the same act.

    Judge on what the two credits DO NOT share. Shared words carry no
    information about whether these are the same act — "Original Broadway Cast
    of Annie" and "Original Broadway Cast of Nine" agree on three words and are
    different shows, while "Wham!" and "Wham! featuring George Michael" agree on
    one and are the same act. Only the residue discriminates.

      1. same primary artist                          -> match
      2. one side's significant words contain the
         other's (a credit truncated to its lead)      -> match
      3. anything else                                 -> no match

    Deliberately no fuzzy step. Similarity cannot separate real variants from
    real collisions here — "seal"/"seals" are different acts at 0.889 and
    "pnk"/"pink" are the same act at 0.857 — so any threshold trades one error
    for the other. A false accept plays the wrong song; a false reject only
    leaves a URI unresolved. Glyph spellings are handled by ARTIST_ALIASES,
    which is auditable, and properly by artist IDs when we start storing them.
    """
    if not candidate or not ours:
        return False
    ours_primary = primary_artist(ours)
    if ours_primary and primary_artist(candidate) == ours_primary:
        return True
    theirs, mine = significant_tokens(candidate), significant_tokens(ours)
    if not theirs or not mine:
        return False
    return theirs <= mine or mine <= theirs


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
