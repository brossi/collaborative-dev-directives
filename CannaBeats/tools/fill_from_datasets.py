#!/usr/bin/env python3
"""Fill catalog URIs offline from public dataset mappings — zero API quota.

Usage:
  python3 tools/fill_from_datasets.py --mappings m1.jsonl m2.jsonl -- \
      catalog/years/*.json catalog/themes/*.json

Run from the CannaBeats/ directory (the folder containing catalog/ and tools/).

Mapping rows: {"title": ..., "artist": ..., "year": 1985, "spotify_id": "..."}

Match rules (conservative on purpose — a wrong URI plays the wrong song):
  - normalized title AND artist must match (full artist string, or the
    primary artist before any feat./comma when the full string differs),
  - a year-bearing mapping row must be within --year-tolerance of ours
    (default 2), so re-recordings and revival chartings are rejected; rows
    with year: null are used only as a last resort, ranked after every
    in-tolerance year-bearing row,
  - conflicting IDs for the same key are resolved by nearest year.

A final propagation pass copies URIs between OUR OWN modules for identical
title+artist pairs within --year-tolerance (theme packs share songs with
year packs), then writes back — only files whose songs actually changed.
Songs it can't fill stay uri: null for resolve_uris.py.
"""
import argparse
import collections
import json
import re
import sys

from _common import norm, primary_artist


def load_mappings(paths):
    by_key = collections.defaultdict(list)  # key -> [(year, id)]
    rows = 0
    for path in paths:
        for line in open(path):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if not re.fullmatch(r"[0-9A-Za-z]{22}", row.get("spotify_id", "")):
                continue
            rows += 1
            year = row.get("year")
            entry = (year, row["spotify_id"])
            t = norm(row["title"])
            full = norm(row["artist"])
            primary = primary_artist(row["artist"])
            if full:
                by_key[(t, full)].append(entry)
            # Never index under an empty key — it would become a wildcard
            # bucket every unmatched lookup falls into. Skip primary when it
            # equals the full key (avoid double-indexing identical keys).
            if primary and primary != full:
                by_key[(t, primary)].append(entry)
    print(f"loaded {rows} mapping rows from {len(paths)} file(s)", file=sys.stderr)
    return by_key


def pick(entries, want_year, tolerance):
    # year: null rows rank strictly AFTER every in-tolerance year-bearing
    # row (distance tolerance+1) — eligible only when nothing dated matched.
    ok = [((abs(y - want_year) if y is not None else tolerance + 1), sid)
          for y, sid in entries
          if y is None or abs(y - want_year) <= tolerance]
    if not ok:
        return None
    ok.sort()  # (distance, id) — deterministic
    return ok[0][1]


def lookup_keys(song):
    t = norm(song["title"])
    full = norm(song["artist"])
    primary = primary_artist(song["artist"])
    keys = []
    if full:
        keys.append((t, full))
    if primary and primary != full:
        keys.append((t, primary))
    return keys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mappings", nargs="+", required=True)
    parser.add_argument("--year-tolerance", type=int, default=2)
    parser.add_argument("files", nargs="+", help="catalog module JSONs, edited in place")
    args = parser.parse_args()

    by_key = load_mappings(args.mappings)
    filled = already = missed = 0
    modules = {}
    dirty = {path: False for path in args.files}
    for path in args.files:
        modules[path] = json.load(open(path))

    for path, module in modules.items():
        for song in module["songs"]:
            if song.get("uri"):
                already += 1
                continue
            sid = None
            for key in lookup_keys(song):
                if key in by_key:
                    sid = pick(by_key[key], song["year"], args.year_tolerance)
                    if sid:
                        break
            if sid:
                song["uri"] = f"spotify:track:{sid}"
                song.pop("unresolved", None)
                filled += 1
                dirty[path] = True
            else:
                missed += 1

    # Propagate within our own catalog: identical title+artist share a URI,
    # but only within --year-tolerance (same key, decades apart = re-recording).
    known = collections.defaultdict(list)  # (title, artist) -> [(year, uri)]
    for module in modules.values():
        for song in module["songs"]:
            if song.get("uri"):
                known[(norm(song["title"]), norm(song["artist"]))].append(
                    (song["year"], song["uri"]))
    for key, entries in known.items():
        uris = sorted({uri for _, uri in entries})
        if len(uris) > 1:
            print(f"WARNING: conflicting URIs for '{key[0]}' / '{key[1]}': "
                  + ", ".join(uris), file=sys.stderr)
    propagated = 0
    for path, module in modules.items():
        for song in module["songs"]:
            if song.get("uri"):
                continue
            candidates = sorted(
                (abs(year - song["year"]), uri)
                for year, uri in known.get((norm(song["title"]), norm(song["artist"])), [])
                if abs(year - song["year"]) <= args.year_tolerance)
            if candidates:
                song["uri"] = candidates[0][1]
                song.pop("unresolved", None)
                propagated += 1
                dirty[path] = True

    written = 0
    for path, module in modules.items():
        if not dirty[path]:
            continue
        with open(path, "w") as handle:
            json.dump(module, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        written += 1

    print(f"filled {filled} from datasets, {propagated} by internal propagation; "
          f"{already} already had URIs; {missed - propagated} still null; "
          f"rewrote {written}/{len(modules)} file(s)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
