#!/usr/bin/env python3
"""Bootstrap the artist registry from Wikidata — free, no Spotify quota.

    python3 tools/harvest_artist_ids.py                  # harvest + decide
    python3 tools/harvest_artist_ids.py --rederive       # re-decide, no network
    python3 tools/harvest_artist_ids.py --chunk 150      # smaller queries

Run from the CannaBeats/ directory. Writes mappings/artist-registry.jsonl, one
row per distinct catalog credit, and is resumable: a re-run skips credits
already present, so an interruption never loses work.

WHY
  Every tool that needs to know "is this the same artist?" currently compares
  credit strings, and that provably cannot work — the "same act" and "different
  act" similarity distributions overlap ("seal"/"seals" are DIFFERENT at 0.889,
  "pnk"/"pink" are the SAME at 0.857). Entity resolution is solved by
  identifiers. This file is where ours come from. See plans/artist-identity.md.

WHAT A ROW IS FOR
  A registry row is a lookup from a credit string EXACTLY as the catalog spells
  it to an identifier. That is not the fuzzy matching being retired: it is an
  exact-string lookup into a table a human has audited (Phase 3). The fuzziness
  is confined to this bootstrap, where it only ever proposes.

TWO WAYS A BOOTSTRAP GOES WRONG, AND WHAT STOPS THEM
  1. A shortened label matches the wrong entity. "Simon & Garfunkel" trimmed to
     "Simon" resolves confidently to somebody else. Stopped by trying labels in
     specificity order and taking the FIRST that hits — the trim is consulted
     only when the full credit found nothing — and by marking anything resolved
     that way `single-shortened` so Phase 3 looks at it.
  2. An ambiguous name silently picks a winner. "Jim Jones" is three Wikidata
     items, one of them the cult leader. Stopped by refusing to choose: several
     candidates is `multi`, carries no ID, and goes to the human queue.

  A wrong ID is worse than a missing one. A missing ID leaves a tool where it
  already is; a wrong one merges two acts permanently and invisibly.

WHY skos:altLabel IS MATCHED TOO
  Measured 2026-08-10: label-only hit 18/25 probe credits, label+altLabel 22/25.
  Aliases are where Wikidata keeps the glyph spellings — "P!nk" resolves to
  Q160009 and "Ke$ha" to Q33605 — which is precisely what _common.ARTIST_ALIASES
  was hand-maintained for. It costs a few extra candidates (someone's alias is
  "Pink"), and an extra candidate is `multi`, which is the safe direction.

WHY THE en.wikipedia SITELINK IS MATCHED TOO  (measured 2026-08-10)
  Labels alone are NOT enough, and the failure is silent. Many high-profile
  items carry no English rdfs:label in the query service at all: Q26876 (Taylor
  Swift) has 74 labels across other languages and no `en` one, and no `en`
  altLabel either, while carrying both P434 and P1902. Bruno Mars (Q1450), ABBA,
  Céline Dion and Dua Lipa are the same. A label-only harvest files all of them
  as "no Wikidata entity", which is false — so `none` would have meant two
  different things and the Phase 3 audit would have been auditing an artefact of
  the query.

  Matching the English Wikipedia article title recovers them. But it cannot
  replace the label route, because article titles are disambiguated: "Seal" is
  "Seal (musician)" so the sitelink misses him entirely, and "Jim Jones" as an
  article is only the cult leader (the rapper is "Jim Jones (rapper)"), which
  would turn a correctly-flagged `multi` into a confident wrong answer.

  So both routes run, their candidates merge by Q-number, and ambiguity from
  either one still counts as ambiguity. The union also fixed "Kool & the Gang",
  which the label route missed and then mis-resolved via its "Kool" fallback to
  Robert Bell — a person, not the band.

RATE LIMIT
  Wikidata's SPARQL endpoint 429s on sustained querying (observed 2026-08-10 on
  a paged crawl, once with Retry-After: 120). This batches ~200 labels per
  query, paces between them, and honours Retry-After by STOPPING with progress
  saved rather than sleeping through it.
"""
import argparse
import collections
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = HERE / "mappings" / "artist-registry.jsonl"
TRACK_LOG = HERE / "mappings" / "spotify-tracks.jsonl"

ENDPOINT = "https://query.wikidata.org/sparql"
UA = {
    "User-Agent": "CannaBeats-catalog/1.0 (ben@rossinet.com) artist-registry-bootstrap",
    "Accept": "application/sparql-results+json",
    "Content-Type": "application/x-www-form-urlencoded",
}
PACE = 2.0

# Case-preserving twins of _common's cutters: Wikidata label matching is exact,
# so the normalized lowercase form that primary_artist() returns matches nothing.
FEAT = re.compile(r"\s+(?:featuring|feat\.?|ft\.?|with)\s+.*$", re.I)
FEAT_X = re.compile(r"\s+x\s+.*$")
JOINED = re.compile(r"\s*(?:,| and | & )\s*", re.I)

# A one-character fallback ("? and the Mysterians" -> "?") matches junk. The
# full credit is always kept regardless of length.
MIN_FALLBACK = 2

QUERY = """SELECT ?label ?item ?itemLabel ?spotify ?mbid ?typeLabel WHERE {
  VALUES ?label { %s }
  { ?item rdfs:label|skos:altLabel ?label . }
  UNION
  { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ;
             schema:name ?label . }
  OPTIONAL { ?item wdt:P434 ?mbid }
  OPTIONAL { ?item wdt:P1902 ?spotify }
  OPTIONAL { ?item wdt:P31 ?type }
  FILTER(BOUND(?mbid) || BOUND(?spotify))
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}"""


def sparql_literal(text: str) -> str:
    return '"%s"@en' % text.replace("\\", "\\\\").replace('"', '\\"')


def lookup_labels(credit: str) -> list:
    """Labels to try for one credit, most specific first.

    Order IS the safety mechanism — see the module docstring. The full credit
    leads because it is the only label that can be exactly right; the trims are
    guesses that earn a `single-shortened` mark if they are what hit.
    """
    trimmed = FEAT_X.sub("", FEAT.sub("", credit)).strip()
    labels, seen = [], set()
    for index, candidate in enumerate((credit, trimmed, JOINED.split(trimmed)[0])):
        candidate = candidate.strip()
        if not candidate or (index and len(candidate) < MIN_FALLBACK):
            continue
        if candidate.lower() not in seen:
            seen.add(candidate.lower())
            labels.append(candidate)
    return labels


def collect(bindings) -> dict:
    """{label: [candidate]} from raw SPARQL rows, one candidate per Q-number.

    Wikidata repeats a row per P31 value, so Seals and Crofts arrives twice
    (male duo, musical duo). Counting rows instead of entities would read as
    ambiguity and send an unambiguous act to the human queue.
    """
    merged = collections.defaultdict(dict)
    for row in bindings:
        label = row["label"]["value"]
        qid = row["item"]["value"].rsplit("/", 1)[-1]
        # wikibase:label falls back to the Q-number when an item has no English
        # label — which is exactly the case the sitelink route exists to catch,
        # so it is common here. Showing "Q26876" in the Phase 3 audit would make
        # the row unreviewable; the label we matched on is the readable name.
        name = row.get("itemLabel", {}).get("value", "")
        item = merged[label].setdefault(qid, {
            "wikidata": qid,
            "name": label if name == qid else name,
            "spotify_artist_id": row.get("spotify", {}).get("value"),
            "musicbrainz_artist_id": row.get("mbid", {}).get("value"),
            "types": [],
        })
        kind = row.get("typeLabel", {}).get("value")
        if kind and kind not in item["types"]:
            item["types"].append(kind)
    return {label: list(items.values()) for label, items in merged.items()}


UNDECIDED = {"wikidata": None, "spotify_artist_id": None,
             "musicbrainz_artist_id": None, "name": None}


def decide(candidates: dict, labels) -> dict:
    """Resolve one credit from stored candidates. Never guesses.

    The first label with any candidates settles the outcome — including when
    that outcome is "ambiguous". Falling through an ambiguous full credit to a
    vaguer label would trade a flagged unknown for a confident error.
    """
    for index, label in enumerate(labels):
        items = candidates.get(label) or []
        if not items:
            continue
        if len(items) > 1:
            return {**UNDECIDED, "matched_label": label, "confidence": "multi"}
        item = items[0]
        return {
            "wikidata": item["wikidata"],
            "name": item["name"],
            "spotify_artist_id": item["spotify_artist_id"],
            "musicbrainz_artist_id": item["musicbrainz_artist_id"],
            "matched_label": label,
            "confidence": "single-exact" if index == 0 else "single-shortened",
        }
    return {**UNDECIDED, "matched_label": None, "confidence": "none"}


def registry_row(credit: str, songs: int, candidates: dict) -> dict:
    labels = lookup_labels(credit)
    verdict = decide(candidates, labels)
    return {
        "credit": credit,
        "songs": songs,
        "labels": labels,
        **verdict,
        "spotify_artist_id_source": "wikidata" if verdict["spotify_artist_id"] else None,
        "source": "wikidata",
        # Kept whole, rejects included, so --rederive can replay a corrected
        # rule with zero network. That pattern has already saved two re-crawls.
        "candidates": {label: candidates[label] for label in labels if label in candidates},
    }


def apply_resolver_ids(rows, track_log) -> int:
    """Overlay Spotify artist IDs captured by resolve_uris.py.

    They outrank Wikidata's because they came from the track we actually play.
    Only single-artist tracks are used: when a track credits several artists,
    which one is OUR act is the very question the registry exists to answer,
    and "Buenos Aires" credits six including Tim Rice and Andrew Lloyd Webber.
    """
    by_credit = {row["credit"]: row for row in rows}
    applied = 0
    for logged in track_log:
        row = by_credit.get(logged["artist"])
        if row is None:
            continue
        artists = logged.get("track", {}).get("artists", [])
        ids = [a["id"] for a in artists if a.get("id")]
        if len(ids) != 1 or row.get("spotify_artist_id") == ids[0]:
            continue
        row["spotify_artist_id"] = ids[0]
        row["spotify_artist_id_source"] = "resolver"
        applied += 1
    return applied


def catalog_credits(root: pathlib.Path):
    counts = collections.Counter()
    for path in sorted(root.glob("*/*.json")):
        for song in json.loads(path.read_text())["songs"]:
            counts[song["artist"]] += 1
    return counts


def run_query(labels) -> list:
    body = urllib.parse.urlencode({
        "query": QUERY % " ".join(sparql_literal(t) for t in labels),
        "format": "json",
    }).encode()
    request = urllib.request.Request(ENDPOINT, data=body, headers=UA)
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)["results"]["bindings"]


def read_rows(path: pathlib.Path) -> list:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def write_rows(path: pathlib.Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    tmp.replace(path)


def summarize(rows) -> None:
    tally = collections.Counter(row["confidence"] for row in rows)
    songs = collections.Counter()
    for row in rows:
        songs[row["confidence"]] += row["songs"]
    print(f"\n{len(rows)} credits in the registry:", file=sys.stderr)
    for confidence in ("single-exact", "single-shortened", "multi", "none"):
        print(f"  {confidence:18} {tally[confidence]:5} credits  "
              f"{songs[confidence]:5} songs", file=sys.stderr)
    needs_review = sum(tally[c] for c in ("single-shortened", "multi", "none"))
    print(f"Phase 3 audits {needs_review} of {len(rows)}.", file=sys.stderr)


def rederive(path: pathlib.Path) -> None:
    """Replay decide() over stored candidates — no network. Use after any
    change to the label or decision rules."""
    rows = read_rows(path)
    if not rows:
        sys.exit(f"nothing to rederive: {path} is missing or empty")
    changed = 0
    for row in rows:
        before = (row["wikidata"], row["confidence"])
        row.update(decide(row.get("candidates", {}), row["labels"]))
        row["spotify_artist_id_source"] = "wikidata" if row["spotify_artist_id"] else None
        changed += before != (row["wikidata"], row["confidence"])
    applied = apply_resolver_ids(rows, read_rows(TRACK_LOG))
    write_rows(path, rows)
    print(f"rederived {len(rows)} rows with no network: {changed} changed; "
          f"{applied} Spotify IDs from the resolver", file=sys.stderr)
    summarize(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=pathlib.Path, default=HERE / "catalog")
    parser.add_argument("--out", type=pathlib.Path, default=REGISTRY)
    parser.add_argument("--chunk", type=int, default=200, help="labels per SPARQL query")
    parser.add_argument("--rederive", action="store_true",
                        help="recompute from stored candidates; no network")
    args = parser.parse_args()

    if args.rederive:
        rederive(args.out)
        return

    existing = read_rows(args.out)
    done = {row["credit"] for row in existing}
    counts = catalog_credits(args.catalog)
    pending = [credit for credit in sorted(counts) if credit not in done]
    print(f"{len(pending)} credits to harvest ({len(done)} already done)", file=sys.stderr)
    if not pending:
        summarize(existing)
        return

    labels = sorted({label for credit in pending for label in lookup_labels(credit)})
    chunks = [labels[i:i + args.chunk] for i in range(0, len(labels), args.chunk)]
    print(f"{len(labels)} distinct labels in {len(chunks)} queries "
          f"(~{len(chunks) * PACE / 60:.1f} min of pacing)", file=sys.stderr)

    candidates, queried = {}, set()
    for index, chunk in enumerate(chunks, 1):
        try:
            bindings = run_query(chunk)
        except urllib.error.HTTPError as error:
            retry = error.headers.get("Retry-After")
            print(f"  HTTP {error.code} on chunk {index}; Retry-After={retry!r} — "
                  f"stopping with progress saved", file=sys.stderr)
            break
        except Exception as error:
            print(f"  {type(error).__name__} on chunk {index}: {error}", file=sys.stderr)
            break
        for label, items in collect(bindings).items():
            candidates.setdefault(label, []).extend(items)
        # Only labels from a chunk that actually came back may be written. A
        # credit written off an unqueried chunk would record "none" and be
        # skipped forever on resume — a rate-limit stop must not look like
        # "no data". Same bug this harvester's sibling shipped once.
        queried.update(chunk)
        print(f"  chunk {index}/{len(chunks)}: {len(bindings)} bindings", file=sys.stderr)
        time.sleep(PACE)

    written, skipped = [], 0
    for credit in pending:
        if not all(label in queried for label in lookup_labels(credit)):
            skipped += 1
            continue
        written.append(registry_row(credit, counts[credit], candidates))
    rows = existing + written
    rows.sort(key=lambda row: row["credit"])
    applied = apply_resolver_ids(rows, read_rows(TRACK_LOG))
    write_rows(args.out, rows)
    print(f"\nwrote {len(written)} new credits -> {args.out}; "
          f"{applied} Spotify IDs from the resolver", file=sys.stderr)
    if skipped:
        print(f"{skipped} credits left unwritten (a label's chunk never ran) — "
              f"re-run to continue", file=sys.stderr)
    summarize(rows)


if __name__ == "__main__":
    main()
