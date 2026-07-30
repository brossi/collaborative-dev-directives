#!/usr/bin/env python3
"""Fill catalog URIs offline from public dataset mappings — zero API quota.

Usage:
  python3 fill_from_datasets.py --mappings m1.jsonl m2.jsonl -- \
      catalog/years/*.json catalog/themes/*.json

Mapping rows: {"title": ..., "artist": ..., "year": 1985, "spotify_id": "..."}

Match rules (conservative on purpose — a wrong URI plays the wrong song):
  - normalized title AND artist must match (full artist string, or the
    primary artist before any feat./comma when the full string differs),
  - the mapping's year must be within --year-tolerance of ours (default 2),
    so re-recordings and revival chartings are rejected,
  - conflicting IDs for the same key are resolved by nearest year.

A final propagation pass copies URIs between OUR OWN modules for identical
title+artist pairs (theme packs share songs with year packs), then writes
files in place. Songs it can't fill stay uri: null for resolve_uris.py.
"""
import argparse
import collections
import json
import re
import sys

FEAT = re.compile(r"\b(featuring|feat\.?|ft\.?|with|x)\b.*$")
PUNCT = re.compile(r"[^a-z0-9 ]")
PAREN = re.compile(r"[\(\[].*?[\)\]]")


def norm(text: str) -> str:
    text = text.lower().replace("&", " and ")
    text = PAREN.sub("", text)
    text = PUNCT.sub("", text)
    return " ".join(text.split())


def primary_artist(artist: str) -> str:
    cut = FEAT.sub("", artist.lower())
    cut = re.split(r",| and | & ", cut)[0]
    return norm(cut)


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
            by_key[(t, norm(row["artist"]))].append(entry)
            by_key[(t, primary_artist(row["artist"]))].append(entry)
    print(f"loaded {rows} mapping rows from {len(paths)} file(s)", file=sys.stderr)
    return by_key


def pick(entries, want_year, tolerance):
    ok = [(abs((y if y else want_year) - want_year), sid) for y, sid in entries
          if y is None or abs(y - want_year) <= tolerance]
    if not ok:
        return None
    ok.sort()
    return ok[0][1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mappings", nargs="+", required=True)
    parser.add_argument("--year-tolerance", type=int, default=2)
    parser.add_argument("files", nargs="+", help="catalog module JSONs, edited in place")
    args = parser.parse_args()

    by_key = load_mappings(args.mappings)
    filled = already = missed = 0
    modules = {}
    for path in args.files:
        modules[path] = json.load(open(path))

    for path, module in modules.items():
        for song in module["songs"]:
            if song.get("uri"):
                already += 1
                continue
            keys = [(norm(song["title"]), norm(song["artist"])),
                    (norm(song["title"]), primary_artist(song["artist"]))]
            sid = None
            for key in keys:
                if key in by_key:
                    sid = pick(by_key[key], song["year"], args.year_tolerance)
                    if sid:
                        break
            if sid:
                song["uri"] = f"spotify:track:{sid}"
                song.pop("unresolved", None)
                filled += 1
            else:
                missed += 1

    # Propagate within our own catalog: identical title+artist share a URI.
    known = {}
    for module in modules.values():
        for song in module["songs"]:
            if song.get("uri"):
                known.setdefault((norm(song["title"]), norm(song["artist"])), song["uri"])
    propagated = 0
    for module in modules.values():
        for song in module["songs"]:
            if not song.get("uri"):
                uri = known.get((norm(song["title"]), norm(song["artist"])))
                if uri:
                    song["uri"] = uri
                    song.pop("unresolved", None)
                    propagated += 1

    for path, module in modules.items():
        with open(path, "w") as handle:
            json.dump(module, handle, indent=2, ensure_ascii=False)
            handle.write("\n")

    print(f"filled {filled} from datasets, {propagated} by internal propagation; "
          f"{already} already had URIs; {missed - propagated} still null",
          file=sys.stderr)


if __name__ == "__main__":
    main()
