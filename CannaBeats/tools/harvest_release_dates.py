#!/usr/bin/env python3
"""Backfill first-publication years from Wikidata — free, no Spotify quota.

    python3 tools/harvest_release_dates.py                 # whole catalog
    python3 tools/harvest_release_dates.py --chunk 150     # smaller queries

Run from the CannaBeats/ directory. Writes mappings/wikidata-release-dates.jsonl
(one row per catalog song) and is resumable: re-running skips titles already
harvested, so an interruption never loses work.

WHY A SEPARATE FIELD FROM `year`
  catalog `year` is the CHART year — when a song was a hit. That is what the
  year-end seed methodology recorded and what people mean when they date a song
  ("Blinding Lights" is a 2020 song, though it shipped in November 2019).
  `releaseYear` is when the recording first entered circulation. They agree
  within a year for most songs and diverge by decades for revivals — Mariah
  Carey's "All I Want for Christmas Is You" was published in 1994 and did not
  top the Hot 100 until 2019. That gap is the "Late Bloomers" theme.

WHY WIKIDATA AND NOT MUSICBRAINZ  (measured 2026-08-10 — do not retry MB)
  MusicBrainz fragments one performance into many `recording` entities, one per
  compilation appearance, each carrying its own `first-release-date` reflecting
  that compilation. Searching "Stand by Me" / Ben E. King returned 361 recording
  entities; the earliest date in the top 100 by relevance was 1966, and the top
  5 were all 1980s-movie compilations dated 2009-2024. The true 1961 date was
  unreachable without walking every entity. Wikidata has ONE item per song with
  P577 (publication date), so there is nothing to disambiguate.

WHY WHOLE RESPONSES ARE STORED
  Every candidate Wikidata returns is written verbatim, including the ones the
  artist filter rejects. Fields unused today cost nothing to keep and a full
  re-crawl to recover. Prune at read time, never at fetch time.

RATE LIMIT
  Wikidata's SPARQL endpoint 429s on sustained querying (observed 2026-08-10 on
  a paged crawl). This batches ~200 titles per query instead of one query per
  song, paces between queries, and honours Retry-After by stopping rather than
  sleeping through it.
"""
import argparse
import collections
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from _common import artists_match, norm, primary_artist

ENDPOINT = "https://query.wikidata.org/sparql"
UA = {
    "User-Agent": "CannaBeats-catalog/1.0 (ben@rossinet.com) release-date-backfill",
    "Accept": "application/sparql-results+json",
    "Content-Type": "application/x-www-form-urlencoded",
}
PACE = 2.0

QUERY = """SELECT ?label ?date ?perfLabel WHERE {
  VALUES ?label { %s }
  ?s rdfs:label ?label .
  ?s wdt:P577 ?date .
  OPTIONAL { ?s wdt:P175 ?perf }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}"""


def sparql_literal(text: str) -> str:
    return '"%s"@en' % text.replace("\\", "\\\\").replace('"', '\\"')


def song_key(song: dict) -> str:
    return f"{song['title']}|{song['artist']}|{song['year']}"


def catalog_songs(root: pathlib.Path):
    for path in sorted(root.glob("*/*.json")):
        for song in json.loads(path.read_text())["songs"]:
            yield song


# One definition of "same artist" for every tool — see _common.artists_match.
# Wikidata is the harshest test of it: a title query returns every song sharing
# that title, so the artist credit is the only thing separating Cardi B's 2018
# "I Like It" from Gerry and the Pacemakers' 1963 one.
artist_matches = artists_match


def run_query(titles) -> list:
    body = urllib.parse.urlencode({
        "query": QUERY % " ".join(sparql_literal(t) for t in titles),
        "format": "json",
    }).encode()
    request = urllib.request.Request(ENDPOINT, data=body, headers=UA)
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)["results"]["bindings"]


def decide(found, artist):
    """(release_year, performers_on_winning_item) from stored candidates."""
    matched = [c["year"] for c in found if artist_matches(c["performer"], artist)]
    # Earliest matching publication: a song accumulates later Wikidata items for
    # reissues and anniversary editions, and anything but the earliest erases
    # the very gap this field exists to record.
    year = min(matched) if matched else None
    peers = sorted({c["performer"] for c in found
                    if c["year"] == year and c["performer"]}) if year else []
    return year, peers


def rederive(path: pathlib.Path) -> None:
    """Replay the matching rule over stored candidates — the whole reason the
    raw Wikidata bindings are kept. A better matcher costs nothing to apply."""
    if not path.exists():
        sys.exit(f"nothing to rederive: {path} does not exist")
    rows = [json.loads(line) for line in path.open() if line.strip()]
    changed = gained = lost = 0
    for row in rows:
        before = row.get("release_year")
        year, peers = decide(row.get("candidates", []), row["artist"])
        if year != before:
            changed += 1
            gained += bool(year) and not before
            lost += bool(before) and not year
        row["release_year"] = year
        row["performers_on_item"] = peers
        row["likely_cover"] = len(peers) > 1
    with path.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    have = sum(1 for r in rows if r["release_year"])
    covers = sum(1 for r in rows if r["likely_cover"])
    print(f"rederived {len(rows)} rows with no network: {changed} changed "
          f"({gained} gained a year, {lost} lost one)", file=sys.stderr)
    print(f"{have} now carry a release year; {covers} of those look like covers "
          f"(item lists several performers, so P577 dates the original)", file=sys.stderr)


def main() -> None:
    here = pathlib.Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=pathlib.Path, default=here / "catalog")
    parser.add_argument("--out", type=pathlib.Path,
                        default=here / "mappings" / "wikidata-release-dates.jsonl")
    parser.add_argument("--chunk", type=int, default=200, help="titles per SPARQL query")
    parser.add_argument("--rederive", action="store_true",
                        help="recompute release years from stored candidates; no network. "
                             "Use after any change to the artist-matching rule.")
    args = parser.parse_args()

    if args.rederive:
        rederive(args.out)
        return

    args.out.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if args.out.exists():
        for line in args.out.open():
            if line.strip():
                done.add(json.loads(line)["key"])

    songs = [s for s in catalog_songs(args.catalog) if song_key(s) not in done]
    print(f"{len(songs)} songs to harvest ({len(done)} already done)", file=sys.stderr)
    if not songs:
        return

    titles = sorted({s["title"] for s in songs})
    chunks = [titles[i:i + args.chunk] for i in range(0, len(titles), args.chunk)]
    print(f"{len(titles)} distinct titles in {len(chunks)} queries "
          f"(~{len(chunks) * PACE / 60:.1f} min)", file=sys.stderr)

    # title -> [{year, performer}] across every chunk, stored whole
    candidates = collections.defaultdict(list)
    # Only titles from a chunk that actually came back may be written. Writing a
    # song whose chunk never ran would record a null release year and then be
    # skipped forever on resume — a rate-limit stop must not look like "no data".
    queried = set()
    for index, chunk in enumerate(chunks, 1):
        try:
            rows = run_query(chunk)
        except urllib.error.HTTPError as error:
            retry = error.headers.get("Retry-After")
            print(f"  HTTP {error.code} on chunk {index}; Retry-After={retry!r} — "
                  f"stopping with progress saved", file=sys.stderr)
            break
        except Exception as error:
            print(f"  {type(error).__name__} on chunk {index}: {error}", file=sys.stderr)
            break
        for row in rows:
            date = row["date"]["value"]
            if len(date) >= 4 and date[:4].lstrip("-").isdigit():
                candidates[row["label"]["value"]].append({
                    "year": int(date[:4]),
                    "performer": row.get("perfLabel", {}).get("value", ""),
                })
        queried.update(chunk)
        print(f"  chunk {index}/{len(chunks)}: {len(rows)} bindings", file=sys.stderr)
        time.sleep(PACE)

    resolved = written = 0
    with args.out.open("a") as handle:
        for song in songs:
            if song["title"] not in queried:
                continue          # its chunk never ran; leave it for the next run
            written += 1
            found = candidates.get(song["title"], [])
            matched = [c["year"] for c in found
                       if artist_matches(c["performer"], song["artist"])]
            # Earliest matching publication: a song accumulates later Wikidata
            # items for reissues and anniversary editions, and taking anything
            # but the earliest erases the very gap this field records.
            year = min(matched) if matched else None
            # A Wikidata item listing several performers at the winning year is
            # about the SONG, not a recording — P577 there is the composition's
            # first publication, so for a cover it dates the ORIGINAL, not ours.
            # Recorded so the two cases stay distinguishable downstream.
            peers = sorted({c["performer"] for c in found
                            if c["year"] == year and c["performer"]}) if year else []
            handle.write(json.dumps({
                "key": song_key(song),
                "title": song["title"],
                "artist": song["artist"],
                "chart_year": song["year"],
                "release_year": year,
                "performers_on_item": peers,
                "likely_cover": len(peers) > 1,
                "candidates": found,      # kept whole, rejects included, on purpose
            }, ensure_ascii=False) + "\n")
            if year:
                resolved += 1
    skipped = len(songs) - written
    print(f"done: wrote {written} songs, {resolved} with a release year -> {args.out}",
          file=sys.stderr)
    if skipped:
        print(f"{skipped} songs left unwritten (their chunk never ran) — re-run to continue",
              file=sys.stderr)


if __name__ == "__main__":
    main()
