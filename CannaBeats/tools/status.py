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
source module exactly and deletes bundle files with no source counterpart.
Resolver work must be committed to source before sync; stale bundle values
are never allowed to override a reviewed source removal.
"""
import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent  # CannaBeats/
SOURCE_DIRS = [ROOT / "catalog" / "years", ROOT / "catalog" / "themes"]
BUNDLE = ROOT / "CannaBeats" / "Resources" / "Catalog"


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
        return False
    return True


def sync():
    BUNDLE.mkdir(parents=True, exist_ok=True)
    copied = deleted = unchanged = 0
    source_names = set()
    for src_dir in SOURCE_DIRS:
        for src_path in sorted(src_dir.glob("*.json")):
            source_names.add(src_path.name)
            out_path = BUNDLE / src_path.name
            payload = src_path.read_bytes()
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
          f"{deleted} orphans removed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sync", action="store_true",
                        help="regenerate Resources/Catalog/ from catalog/")
    args = parser.parse_args()
    if args.sync:
        sync()
    else:
        if not status():
            sys.exit(1)


if __name__ == "__main__":
    main()
