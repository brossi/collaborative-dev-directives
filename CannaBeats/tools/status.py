#!/usr/bin/env python3
"""Catalog status and bundle sync — zero network, zero quota.

Usage:
  python3 tools/status.py           # coverage table + source/bundle drift
  python3 tools/status.py --sync    # regenerate the app bundle folder
                                    # (CannaBeats/Resources/Catalog/) from
                                    # the source catalog

Paths are anchored to this script's location, so it works from any cwd.

The rule --sync enforces: catalog/years/ + catalog/themes/ are the single
source of truth; Resources/Catalog/ is a build product. Sync copies every
source module in, deletes bundle files with no source counterpart, and —
so paid resolver work is never lost — keeps a non-null URI from the old
bundle copy when the source's is null (by title|artist|year identity),
printing each such rescue so it can be back-filled into source.
"""
import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent  # CannaBeats/
SOURCE_DIRS = [ROOT / "catalog" / "years", ROOT / "catalog" / "themes"]
BUNDLE = ROOT / "CannaBeats" / "Resources" / "Catalog"


def song_id(song):
    return f"{song['title']}|{song['artist']}|{song['year']}".lower()


def load(path):
    return json.load(open(path))


def counts(paths):
    modules = songs = resolved = null = marked = 0
    for path in paths:
        modules += 1
        for song in load(path)["songs"]:
            songs += 1
            if song.get("uri"):
                resolved += 1
            else:
                null += 1
                marked += 1 if song.get("unresolved") else 0
    return modules, songs, resolved, null, marked


def status():
    rows = [("segment", "modules", "songs", "resolved", "null", "unresolved-marked")]
    segments = [
        ("catalog/years", sorted((SOURCE_DIRS[0]).glob("*.json"))),
        ("catalog/themes", sorted((SOURCE_DIRS[1]).glob("*.json"))),
        ("bundle (Resources/Catalog)", sorted(BUNDLE.glob("*.json"))),
    ]
    for name, paths in segments:
        rows.append((name, *counts(paths)))
    widths = [max(len(str(r[i])) for r in rows) for i in range(6)]
    for row in rows:
        print("  ".join(str(v).ljust(w) for v, w in zip(row, widths)))

    source = {p.name: p for d in SOURCE_DIRS for p in d.glob("*.json")}
    bundled = {p.name: p for p in BUNDLE.glob("*.json")}
    missing = sorted(set(source) - set(bundled))
    orphaned = sorted(set(bundled) - set(source))
    differ = sorted(n for n in set(source) & set(bundled)
                    if source[n].read_bytes() != bundled[n].read_bytes())
    print(f"\nbundle: {len(missing)} source modules missing, "
          f"{len(differ)} differ from source, {len(orphaned)} orphaned")
    for label, names in (("missing", missing), ("differ", differ), ("orphaned", orphaned)):
        if names:
            head = ", ".join(names[:6]) + (" …" if len(names) > 6 else "")
            print(f"  {label}: {head}")
    if missing or differ or orphaned:
        print("run `python3 tools/status.py --sync` to regenerate the bundle")


def sync():
    BUNDLE.mkdir(parents=True, exist_ok=True)
    copied = rescued = deleted = unchanged = 0
    source_names = set()
    for src_dir in SOURCE_DIRS:
        for src_path in sorted(src_dir.glob("*.json")):
            source_names.add(src_path.name)
            module = load(src_path)
            out_path = BUNDLE / src_path.name
            # Preserve resolver work: old bundle URI fills a null source URI.
            if out_path.exists():
                old = {song_id(s): s.get("uri")
                       for s in load(out_path)["songs"] if s.get("uri")}
                for song in module["songs"]:
                    if not song.get("uri") and song_id(song) in old:
                        song["uri"] = old[song_id(song)]
                        rescued += 1
                        print(f"  rescued URI from old bundle: {src_path.name}: "
                              f"{song['title']} / {song['artist']} "
                              f"(back-fill this into catalog/!)")
            payload = (json.dumps(module, indent=2, ensure_ascii=False) + "\n").encode()
            if out_path.exists() and out_path.read_bytes() == payload:
                unchanged += 1
                continue
            out_path.write_bytes(payload)
            copied += 1
    for stale in sorted(BUNDLE.glob("*.json")):
        if stale.name not in source_names:
            stale.unlink()
            deleted += 1
            print(f"  deleted orphan: {stale.name}")
    print(f"sync: {copied} written, {unchanged} already current, "
          f"{deleted} orphans removed, {rescued} URIs rescued from old bundle")
    if rescued:
        print("NOTE: rescued URIs exist only in the bundle — back-fill them "
              "into catalog/ (fill_from_datasets or by hand) or the next "
              "source edit may drop them.", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sync", action="store_true",
                        help="regenerate Resources/Catalog/ from catalog/")
    args = parser.parse_args()
    if args.sync:
        sync()
    else:
        status()


if __name__ == "__main__":
    main()
