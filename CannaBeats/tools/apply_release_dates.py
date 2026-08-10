#!/usr/bin/env python3
"""Write harvested publication years into the source catalog as `releaseYear`.

    python3 tools/apply_release_dates.py --dry-run     # report, change nothing
    python3 tools/apply_release_dates.py               # edit catalog/ in place

Run from the CannaBeats/ directory. Reads mappings/wikidata-release-dates.jsonl
(see tools/harvest_release_dates.py) and matches on the same title|artist|year
identity the rest of the pipeline uses.

Conservative on purpose, because a wrong year is a wrong card:
  - only fills a missing `releaseYear`; never overwrites one already present,
  - drops a candidate that post-dates the chart year by more than
    --max-late years. A recording cannot enter circulation long after it was
    a hit; when Wikidata says otherwise it has matched a reissue or a
    different song sharing the title,
  - drops a candidate implausibly far BEFORE the chart year (--max-early),
    which catches same-title matches on an older composition,
  - leaves everything it rejects reported, never silently dropped.
"""
import argparse
import json
import pathlib
import sys


def song_key(song: dict) -> str:
    return f"{song['title']}|{song['artist']}|{song['year']}"


def main() -> None:
    here = pathlib.Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=pathlib.Path, default=here / "catalog")
    parser.add_argument("--mappings", type=pathlib.Path,
                        default=here / "mappings" / "wikidata-release-dates.jsonl")
    parser.add_argument("--max-late", type=int, default=1,
                        help="reject a release year more than N years AFTER the chart year")
    parser.add_argument("--max-early", type=int, default=60,
                        help="reject a release year more than N years BEFORE the chart year")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if not args.mappings.exists():
        sys.exit(f"no harvest file at {args.mappings} — run harvest_release_dates.py first")

    harvested, covers = {}, 0
    for line in args.mappings.open():
        if not line.strip():
            continue
        row = json.loads(line)
        if not row.get("release_year"):
            continue
        # A Wikidata item listing several performers is about the SONG, so its
        # P577 dates whoever recorded it FIRST — not us. Filling releaseYear
        # from that would claim Tracy Chapman's 1988 for Luke Combs' 2023
        # "Fast Car". Skip: an absent year beats somebody else's year.
        if row.get("likely_cover"):
            covers += 1
            continue
        harvested[row["key"]] = row["release_year"]
    print(f"{len(harvested)} usable release years "
          f"({covers} skipped as covers/standards)", file=sys.stderr)

    filled = already = unmatched = 0
    rejected_late, rejected_early = [], []
    gaps = []
    dirty = {}
    for path in sorted(args.catalog.glob("*/*.json")):
        module = json.loads(path.read_text())
        changed = False
        for song in module["songs"]:
            if song.get("releaseYear"):
                already += 1
                continue
            candidate = harvested.get(song_key(song))
            if not candidate:
                unmatched += 1
                continue
            delta = candidate - song["year"]
            if delta > args.max_late:
                rejected_late.append((song, candidate))
                continue
            if -delta > args.max_early:
                rejected_early.append((song, candidate))
                continue
            song["releaseYear"] = candidate
            filled += 1
            changed = True
            if song["year"] - candidate >= 3:
                gaps.append((song["year"] - candidate, song, candidate))
        if changed:
            dirty[path] = module

    print(f"fill {filled}; {already} already had one; {unmatched} had no harvested year",
          file=sys.stderr)
    print(f"rejected {len(rejected_late)} as too late (> {args.max_late}y after chart year), "
          f"{len(rejected_early)} as too early (> {args.max_early}y before)", file=sys.stderr)

    if gaps:
        gaps.sort(reverse=True, key=lambda g: g[0])
        print(f"\n{len(gaps)} songs peaked 3+ years after publication "
              f"— the 'Late Bloomers' candidates:", file=sys.stderr)
        for delta, song, release in gaps[:25]:
            print(f"  +{delta:2d}y  published {release}, charted {song['year']}  "
                  f"{song['title'][:34]} — {song['artist'][:26]}", file=sys.stderr)

    if rejected_late[:10]:
        print("\nsample rejections (release year after chart year — likely reissues):",
              file=sys.stderr)
        for song, candidate in rejected_late[:10]:
            print(f"  chart {song['year']} vs wikidata {candidate}  "
                  f"{song['title'][:34]} — {song['artist'][:24]}", file=sys.stderr)

    if args.dry_run:
        print(f"\n--dry-run: {len(dirty)} file(s) would change", file=sys.stderr)
        return

    for path, module in dirty.items():
        path.write_text(json.dumps(module, indent=2, ensure_ascii=False) + "\n")
    print(f"\nrewrote {len(dirty)} catalog file(s)", file=sys.stderr)


if __name__ == "__main__":
    main()
