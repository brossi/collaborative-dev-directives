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

    So a decision, once made, is final: rows written here carry a `source` of
    "human" or "assistant", and both rederive_rows() and apply_resolver_ids()
    skip them. A confirmed absence counts as a decision too — a later harvest
    turning up a plausible candidate must not overturn someone who looked.

WHO DECIDED  (--reviewer, default "human")
    An assistant can work this queue too, and should: reading "Harry James"
    beside "Ciribiribin (1939)" and two candidate descriptions is the same act
    of judgement the column is asking for, and it is not the thing the plan
    retires. What the plan proves impossible is a FUNCTION OF THE CHARACTERS —
    "seal"/"seals" are different acts and score higher than "pnk"/"pink", which
    are the same. Nothing there constrains a reader with world knowledge.

    But those two sources are not interchangeable, so they are not conflated:

      - `--reviewer assistant` stamps `source: "assistant"`. Those rows STAY in
        the review queue with their answer pre-filled in `decision` and their
        author in `reviewed_by`, so the human sees every one and overrides by
        editing the cell. Accepting them is re-applying the file.
      - `--reviewer human` stamps `source: "human"` and retires the row.

    An assistant may only choose among candidates already stored on the row, so
    it cannot invent a Q-number; anything it wants that is not there has to be
    looked up against Wikidata like any other hand-entered ID.

WHAT IS STILL NOT AUTOMATED
    No RULE fills the decision column — no threshold, no similarity score, no
    "if it ends in `and His Orchestra` then". The tool also makes deciding
    cheap: candidates spelled out with their types and identifiers, real song
    titles alongside them, rows grouped by `shape` so like judgements batch.
"""
import argparse
import collections
import csv
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from _common import CREDIT_FEAT, CREDIT_FEAT_X, CREDIT_JOINED
from harvest_artist_ids import (ENDPOINT, HERE, REGISTRY, REVIEWED, UA,
                                read_rows, summarize, write_rows)

REVIEW_CSV = HERE / "mappings" / "artist-registry-review.csv"

DECISION_OK = "ok"
DECISION_NONE = "none"
# Everything except a settled machine answer and an already-audited row.
REVIEWABLE = ("single-shortened", "multi", "none")

FIELDS = ["shape", "credit", "songs", "removed", "decision", "reviewed_by",
          "harvested", "candidates", "examples", "confidence", "labels",
          "matched_label"]

# A POSSESSIVE backing band — "and His Orchestra", "and His Five Pennies". The
# possessive is what makes it safe to drop: the ensemble is named as the
# leader's, so the leader is the entity.
#
# "& The <Name>" deliberately does NOT count, even though it looks identical.
# "& The Teenagers", "& The Supremes", "& The Fresh Prince" name a second act
# with its own identity, and dropping it can lose the better-known half —
# "DJ Jazzy Jeff & The Fresh Prince" reduces to DJ Jazzy Jeff, discarding Will
# Smith. Lumping the two together was wrong when this file first grouped them.
BACKING_BAND = re.compile(r"^(?:and|&|with)\s+(?:his|her|their)\b", re.I)
NAMED_GROUP = re.compile(r"^(?:and|&|with)\s+the\b", re.I)

# Cheapest-to-decide first, so the queue drains; genuinely hard ones last.
SHAPE_ORDER = ["trimmed:featured", "trimmed:backing-band", "trimmed:named-group",
               "trimmed:co-credited", "trimmed:other", "multi", "none"]


def review_shape(row) -> str:
    """Which cut produced the matched label — purely syntactic.

    This groups the queue so like rows can be judged together; it is NOT a
    verdict on whether the cut was right. Measured over the 423
    `single-shortened` rows: 219 featured, 150 co-credited, 54 backing-band.
    They want different treatment, and mixing them makes every row a fresh
    decision:

      trimmed:featured      "X feat. Y" -> X. The lead is the act.
      trimmed:backing-band  "X and His Orchestra" -> X. The possessive says the
                            ensemble is the leader's, so the leader is the entity.
      trimmed:named-group   "X & The Teenagers" -> X. Looks the same, is not: the
                            group is a second act, and dropping it can lose the
                            better-known half (DJ Jazzy Jeff & The Fresh Prince).
      trimmed:co-credited   "X & Y" -> X. Drops a real co-artist — e.g.
                            "John Travolta & Olivia Newton-John".
    """
    # harvest_confidence outlives a decision: once `confidence` becomes
    # "assistant" the row is still in the queue, and it still has to sort into
    # the block it came from.
    verdict = row.get("harvest_confidence") or row["confidence"]
    if verdict != "single-shortened":
        return verdict
    credit, matched = row["credit"], row["matched_label"] or ""
    trimmed = CREDIT_FEAT_X.sub("", CREDIT_FEAT.sub("", credit)).strip()
    if matched == trimmed and trimmed != credit:
        return "trimmed:featured"
    dropped = removed_text(row)
    if BACKING_BAND.match(dropped):
        return "trimmed:backing-band"
    if NAMED_GROUP.match(dropped):
        return "trimmed:named-group"
    if CREDIT_JOINED.split(trimmed)[0].strip() == matched:
        return "trimmed:co-credited"
    return "trimmed:other"


def removed_text(row) -> str:
    """What the trim dropped, verbatim — the thing to eyeball when deciding
    whether the shortened label still names the same act."""
    credit, matched = row["credit"], row["matched_label"] or ""
    return credit[len(matched):].strip() if matched and credit.startswith(matched) else ""


# Enough examples to recognise an act, few enough to read in a spreadsheet cell.
MAX_EXAMPLES = 4


def needs_review(rows) -> list:
    """Uncertain rows, grouped by shape and then most songs first.

    Grouping beats a flat song-count ordering here because the file is meant to
    be finished: 219 `X feat. Y` rows in a block are one judgement repeated,
    while the same rows scattered among ambiguous names are 219 separate ones.
    Within a group the highest song counts still lead, so stopping part-way
    inside a block still takes the most gameplay.

    `single-shortened` is included, which the plan did not ask for: those are
    inferences, not matches — "John Travolta & Olivia Newton-John" resolving to
    John Travolta silently drops half a duet.
    """
    pending = [row for row in rows
               if row.get("source") != "human"
               and (row["confidence"] in REVIEWABLE
                    or row.get("source") in REVIEWED)]
    return sorted(pending, key=lambda row: (SHAPE_ORDER.index(review_shape(row)),
                                            -row["songs"], row["credit"]))


def prior_decision(row) -> str:
    """The decision already on the row, re-rendered so it round-trips.

    An assistant-reviewed row comes back into the queue with its answer showing
    rather than blank: the human is reviewing a proposal, not re-deriving it
    from scratch. Leaving the cell alone accepts it; editing it overrides.
    """
    if row.get("source") not in REVIEWED:
        return ""
    return row["wikidata"] or DECISION_NONE


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
            # Two independent witnesses to the name. The disagreement is the
            # signal — it is what a vandalised English label looks like from
            # here — and the disambiguator is the point on an ambiguous row:
            # "Jim Jones" is identical on all three entities, and only
            # "(rapper)" vs "(cult leader)" tells them apart.
            article = item.get("article") or ""
            title = f" ~ {article}" if article and article != item["name"] else ""
            lines.append(f"{item['wikidata']} {item['name']}{title}"
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
            "shape": review_shape(row),
            "credit": row["credit"],
            "songs": row["songs"],
            "removed": removed_text(row),
            "confidence": row["confidence"],
            "decision": prior_decision(row),
            "reviewed_by": row["source"] if row["source"] in REVIEWED else "",
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


def apply_decisions(rows, decisions, extra=None, reviewer="human") -> int:
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
            if reviewer != "human" and decision not in _candidate_index(row):
                raise ValueError(
                    f"{credit!r}: {reviewer} may only choose among the candidates "
                    f"stored on the row; {decision} is not one of them.")
            item = _candidate_index(row).get(decision) or extra.get(decision)
            if item is None:
                raise ValueError(
                    f"{credit!r}: {decision} is not among the stored candidates and "
                    f"could not be looked up. Re-run without --dry-run to fetch it.")
            chosen = {"wikidata": item["wikidata"], "name": item["name"],
                      "spotify_artist_id": item["spotify_artist_id"],
                      "musicbrainz_artist_id": item["musicbrainz_artist_id"]}
        after = {**chosen, "confidence": reviewer, "source": reviewer,
                 "harvest_confidence": (row.get("harvest_confidence")
                                        or row["confidence"]),
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
    parser.add_argument("--reviewer", choices=("human", "assistant"), default="human",
                        help="who made these calls. 'assistant' rows stay in the "
                             "queue with their answer pre-filled for a human to "
                             "accept or override (default: human)")
    args = parser.parse_args()

    rows = read_rows(args.registry)
    if not rows:
        sys.exit(f"no registry at {args.registry} — run tools/harvest_artist_ids.py")

    if not args.apply:
        if args.csv.exists():
            applied_already = {row["credit"]: prior_decision(row) for row in rows}
            unapplied = {credit: decision
                         for credit, decision in parse_decisions(args.csv.open()).items()
                         if applied_already.get(credit) != decision}
            if unapplied:
                sys.exit(f"{args.csv} holds {len(unapplied)} decision(s) not yet in "
                         f"the registry. Apply them first (--apply), or move the "
                         f"file aside — regenerating would discard them.")
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
    applied = apply_decisions(rows, decisions, extra, args.reviewer)
    if args.dry_run:
        print(f"would apply {applied} of {len(decisions)} previewable decision(s); "
              f"nothing written", file=sys.stderr)
        return
    write_rows(args.registry, rows)
    print(f"applied {applied} of {len(decisions)} {args.reviewer} decision(s) "
          f"-> {args.registry}", file=sys.stderr)
    summarize(rows)


if __name__ == "__main__":
    main()
