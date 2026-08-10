#!/usr/bin/env python3
"""Phase 3 — put the uncertain registry rows in front of a human, and take the
answers back. Zero network unless a decision names an entity we never saw.

    python3 tools/review_artist_registry.py                    # write the CSV
    python3 tools/review_artist_registry.py --apply            # read it back
    python3 tools/review_artist_registry.py --apply --dry-run  # show, write nothing

Run from the CannaBeats/ directory. Round trip:

    1. run it -> mappings/artist-registry-review.csv
    2. open that in a spreadsheet, fill the `decision` column, save as CSV
    3. run it with --apply

WHAT GOES IN THE `decision` COLUMN
    Q12345   this entity is the artist (pick one from the `candidates` column,
             or paste any Q-number you looked up yourself)
    ok       what was harvested is right — confirm it as-is
    none     there genuinely is no Wikidata entity for this credit
    (blank)  not reviewed yet; the row is left exactly as it is

WHY THIS EXISTS AT ALL
    Deciding whether "Seal" and "Seals and Crofts" are the same act is not a
    thing software can do — the similarity distributions of "same act" and
    "different act" overlap, so no threshold separates them (see _common.py).
    A person can decide it in two seconds, once. This turns that into a
    permanent fact rather than a coin flip repeated on every comparison.

    So a decision, once made, is final: rows written here carry
    `source: "human"`, and both rederive_rows() and apply_resolver_ids() skip
    them. A confirmed absence counts as a decision too — a later harvest
    turning up a plausible candidate must not overturn someone who looked.

WHAT IS DELIBERATELY NOT AUTOMATED
    No rule fills the decision column. Every mechanical shortcut available here
    is another similarity heuristic, which is the thing this whole plan is
    retiring. The tool's job is to make deciding cheap — candidates spelled
    out, real song titles alongside them, highest-song-count rows first so a
    partial audit still pays — not to decide.
"""
import argparse
import collections
import csv
import json
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from harvest_artist_ids import (ENDPOINT, HERE, REGISTRY, UA, read_rows,
                                summarize, write_rows)

REVIEW_CSV = HERE / "mappings" / "artist-registry-review.csv"

DECISION_OK = "ok"
DECISION_NONE = "none"
# Everything except a settled machine answer and an already-audited row.
REVIEWABLE = ("single-shortened", "multi", "none")

FIELDS = ["credit", "songs", "confidence", "decision", "harvested", "candidates",
          "examples", "labels", "matched_label"]

# Enough examples to recognise an act, few enough to read in a spreadsheet cell.
MAX_EXAMPLES = 4


def needs_review(rows) -> list:
    """Uncertain rows, most songs first — a partial audit then covers the most
    gameplay. `single-shortened` is included because it is an inference, not a
    match: "John Travolta & Olivia Newton-John" resolving to John Travolta
    silently drops half a duet."""
    pending = [row for row in rows
               if row.get("source") != "human" and row["confidence"] in REVIEWABLE]
    return sorted(pending, key=lambda row: (-row["songs"], row["credit"]))


def format_candidates(row) -> str:
    """One line per distinct entity, with what a person needs to tell them
    apart: who it is, what kind of thing it is, and whether it has IDs."""
    seen, lines = set(), []
    for label, items in (row.get("candidates") or {}).items():
        for item in items:
            if item["wikidata"] in seen:
                continue
            seen.add(item["wikidata"])
            marks = []
            if item.get("types"):
                marks.append("/".join(item["types"][:3]))
            if item.get("spotify_artist_id"):
                marks.append("spotify")
            if item.get("musicbrainz_artist_id"):
                marks.append("mb")
            if label != row["credit"]:
                marks.append(f"via {label!r}")
            lines.append(f"{item['wikidata']} {item['name']}"
                         + (f" [{', '.join(marks)}]" if marks else ""))
    return "\n".join(lines)


def format_harvested(row) -> str:
    if not row["wikidata"]:
        return ""
    ids = [part for part in
           ("spotify" if row["spotify_artist_id"] else "",
            "mb" if row["musicbrainz_artist_id"] else "") if part]
    return f"{row['wikidata']} {row['name'] or ''}" + (f" [{', '.join(ids)}]" if ids else "")


def catalog_examples(root: pathlib.Path) -> dict:
    """{credit: ["Title (year)", ...]} — the fastest way to tell two people
    with the same name apart is to look at what they recorded."""
    songs = collections.defaultdict(list)
    for path in sorted(root.glob("*/*.json")):
        for song in json.loads(path.read_text())["songs"]:
            songs[song["artist"]].append((song["year"], song["title"]))
    return {credit: [f"{title} ({year})" for year, title in sorted(items)[:MAX_EXAMPLES]]
            for credit, items in songs.items()}


def emit_csv(rows, examples, handle) -> None:
    writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({
            "credit": row["credit"],
            "songs": row["songs"],
            "confidence": row["confidence"],
            "decision": "",
            "harvested": format_harvested(row),
            "candidates": format_candidates(row),
            "examples": "; ".join(examples.get(row["credit"], [])),
            "labels": " | ".join(row["labels"]),
            "matched_label": row["matched_label"] or "",
        })


def parse_decisions(handle) -> dict:
    """{credit: decision} for rows a human actually filled in.

    Spreadsheets add stray whitespace and change case on export, so both are
    normalized; a Q-number is upper-cased and the two keywords lower-cased.
    """
    decisions = {}
    for record in csv.DictReader(handle):
        raw = (record.get("decision") or "").strip()
        if not raw:
            continue
        lowered = raw.lower()
        decisions[record["credit"]] = (lowered if lowered in (DECISION_OK, DECISION_NONE)
                                       else raw.upper())
    return decisions


def _candidate_index(row) -> dict:
    return {item["wikidata"]: item
            for items in (row.get("candidates") or {}).values() for item in items}


def unresolved_qids(rows, decisions) -> dict:
    """{credit: qid} for decisions naming an entity that is not among the
    stored candidates — someone looked it up by hand. Reported rather than
    accepted blindly: the row would otherwise carry a Q-number and no
    identifiers, which is exactly the state nothing downstream can join on."""
    by_credit = {row["credit"]: row for row in rows}
    missing = {}
    for credit, decision in decisions.items():
        if decision in (DECISION_OK, DECISION_NONE):
            continue
        row = by_credit.get(credit)
        if row is not None and decision not in _candidate_index(row):
            missing[credit] = decision
    return missing


def apply_decisions(rows, decisions, extra=None) -> int:
    """Write decisions into rows in place; returns how many changed.

    `extra` supplies identifiers for Q-numbers that were not among the stored
    candidates (see fetch_entities). Raises on anything ambiguous rather than
    guessing — a typo'd credit or a meaningless "ok" must stop the run, not
    silently do nothing or mint a human-blessed empty row.
    """
    by_credit = {row["credit"]: row for row in rows}
    extra = extra or {}
    applied = 0
    for credit, decision in decisions.items():
        if not (decision or "").strip():
            continue  # an unreviewed row; parse_decisions drops these too
        row = by_credit.get(credit)
        if row is None:
            raise ValueError(f"decision for a credit not in the registry: {credit!r}")
        if decision == DECISION_OK:
            if not row["wikidata"]:
                raise ValueError(
                    f"{credit!r}: 'ok' confirms the harvested answer, but this row "
                    f"has none (confidence {row['confidence']!r}). Use a Q-number, "
                    f"or 'none' if there really is no entity.")
            chosen = {"wikidata": row["wikidata"], "name": row["name"],
                      "spotify_artist_id": row["spotify_artist_id"],
                      "musicbrainz_artist_id": row["musicbrainz_artist_id"]}
        elif decision == DECISION_NONE:
            chosen = {"wikidata": None, "name": None,
                      "spotify_artist_id": None, "musicbrainz_artist_id": None}
        else:
            item = _candidate_index(row).get(decision) or extra.get(decision)
            if item is None:
                raise ValueError(
                    f"{credit!r}: {decision} is not among the stored candidates and "
                    f"could not be looked up. Re-run without --dry-run to fetch it.")
            chosen = {"wikidata": item["wikidata"], "name": item["name"],
                      "spotify_artist_id": item["spotify_artist_id"],
                      "musicbrainz_artist_id": item["musicbrainz_artist_id"]}
        after = {**chosen, "confidence": "human", "source": "human",
                 "spotify_artist_id_source": (
                     row["spotify_artist_id_source"]
                     if chosen["spotify_artist_id"] == row["spotify_artist_id"]
                     else "human")}
        if all(row.get(key) == value for key, value in after.items()):
            continue  # already applied; keep --apply idempotent
        row.update(after)
        applied += 1
    return applied


ENTITY_QUERY = """SELECT ?item ?itemLabel ?spotify ?mbid WHERE {
  VALUES ?item { %s }
  OPTIONAL { ?item wdt:P434 ?mbid }
  OPTIONAL { ?item wdt:P1902 ?spotify }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}"""


def fetch_entities(qids) -> dict:
    """Look up hand-entered Q-numbers. One batched query, free, same pacing
    discipline as the harvester: a rate limit stops the run rather than being
    slept through."""
    if not qids:
        return {}
    body = urllib.parse.urlencode({
        "query": ENTITY_QUERY % " ".join(f"wd:{q}" for q in sorted(set(qids))),
        "format": "json"}).encode()
    try:
        request = urllib.request.Request(ENDPOINT, data=body, headers=UA)
        with urllib.request.urlopen(request, timeout=120) as response:
            bindings = json.load(response)["results"]["bindings"]
    except urllib.error.HTTPError as error:
        print(f"  HTTP {error.code} looking up {len(set(qids))} entities; "
              f"Retry-After={error.headers.get('Retry-After')!r} — nothing applied",
              file=sys.stderr)
        return {}
    time.sleep(2.0)
    found = {}
    for row in bindings:
        qid = row["item"]["value"].rsplit("/", 1)[-1]
        name = row.get("itemLabel", {}).get("value", "")
        found[qid] = {"wikidata": qid, "name": qid if name == qid else name,
                      "spotify_artist_id": row.get("spotify", {}).get("value"),
                      "musicbrainz_artist_id": row.get("mbid", {}).get("value")}
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--registry", type=pathlib.Path, default=REGISTRY)
    parser.add_argument("--csv", type=pathlib.Path, default=REVIEW_CSV)
    parser.add_argument("--catalog", type=pathlib.Path, default=HERE / "catalog")
    parser.add_argument("--apply", action="store_true",
                        help="read decisions back out of the CSV")
    parser.add_argument("--dry-run", action="store_true",
                        help="with --apply: report what would change, write nothing")
    args = parser.parse_args()

    rows = read_rows(args.registry)
    if not rows:
        sys.exit(f"no registry at {args.registry} — run tools/harvest_artist_ids.py")

    if not args.apply:
        if args.csv.exists():
            existing = parse_decisions(args.csv.open())
            if existing:
                sys.exit(f"{args.csv} already holds {len(existing)} decision(s). "
                         f"Apply them first (--apply), or move the file aside — "
                         f"regenerating would discard them.")
        pending = needs_review(rows)
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        with args.csv.open("w", newline="") as handle:
            emit_csv(pending, catalog_examples(args.catalog), handle)
        tally = collections.Counter(row["confidence"] for row in pending)
        print(f"wrote {len(pending)} rows to review -> {args.csv}", file=sys.stderr)
        for confidence in REVIEWABLE:
            print(f"  {confidence:18} {tally[confidence]:5}", file=sys.stderr)
        print(f"covering {sum(row['songs'] for row in pending)} songs; "
              f"fill the `decision` column, then re-run with --apply", file=sys.stderr)
        return

    if not args.csv.exists():
        sys.exit(f"no review CSV at {args.csv} — run without --apply first")
    decisions = parse_decisions(args.csv.open())
    if not decisions:
        sys.exit(f"{args.csv} has no filled-in decisions")
    missing = unresolved_qids(rows, decisions)
    extra = {}
    if missing:
        print(f"{len(missing)} decision(s) name an entity not among the stored "
              f"candidates: {', '.join(sorted(set(missing.values())))}", file=sys.stderr)
        if args.dry_run:
            # --dry-run is meant to answer "what would this do" without a
            # request, so these stay unresolved. Reported, then set aside —
            # raising here would make the preview unusable for exactly the
            # decisions most worth previewing.
            print(f"  (--dry-run makes no requests, so these are not previewed)",
                  file=sys.stderr)
            decisions = {credit: decision for credit, decision in decisions.items()
                         if credit not in missing}
        else:
            extra = fetch_entities(missing.values())
            still_missing = set(missing.values()) - set(extra)
            if still_missing:
                sys.exit(f"could not look up {', '.join(sorted(still_missing))} — "
                         f"nothing written")
    applied = apply_decisions(rows, decisions, extra)
    if args.dry_run:
        print(f"would apply {applied} of {len(decisions)} previewable decision(s); "
              f"nothing written", file=sys.stderr)
        return
    write_rows(args.registry, rows)
    print(f"applied {applied} of {len(decisions)} decision(s) -> {args.registry}",
          file=sys.stderr)
    summarize(rows)


if __name__ == "__main__":
    main()
