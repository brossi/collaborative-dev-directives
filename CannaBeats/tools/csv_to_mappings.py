#!/usr/bin/env python3
"""Convert any CSV with Spotify track IDs into mapping rows for
fill_from_datasets.py — for Kaggle datasets, chart exports, etc.

Usage:
  python3 csv_to_mappings.py tracks.csv --title name --artist artists \
      --year year --id id > mappings/kaggle600k.jsonl

Column arguments name CSV header columns and are validated against the
file's actual header. --year may instead name a date column (YYYY-MM-DD...);
the leading year is extracted. --id accepts bare 22-char IDs,
spotify:track: URIs, or open.spotify.com/track/ URLs.

Expected columns (verify against your download's header — schemas drift):
  - Kaggle "Spotify Dataset 1921-2020, 600k+ Tracks" (yamaerenay):
      tracks.csv --title name --artist artists --year year --id id
      (some versions have release_date instead of year — check the header)
  - Kaggle "Spotify Charts" (dhruvildave, 2017-2021 top-200):
      charts.csv --title title --artist artist --year date --id url
  - charts.spotify.com weekly CSV export (2017-present, free login):
      --title track_name --artist artist_names --year <none: pass the
      chart week via --fixed-year> --id uri
"""
import argparse
import ast
import csv
import json
import re
import sys

ID = re.compile(r"([0-9A-Za-z]{22})")


def flatten_artist(artist: str) -> str:
    """Kaggle 600k stores artists as "['A', 'B']" — flatten to "A, B"."""
    try:
        parsed = ast.literal_eval(artist)
        if isinstance(parsed, (list, tuple)):
            return ", ".join(str(p) for p in parsed)
    except (ValueError, SyntaxError):
        pass
    return ", ".join(p[0] or p[1] for p in
                     re.findall(r"'([^']*)'|\"([^\"]*)\"", artist))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_file")
    parser.add_argument("--title", required=True, help="title column name")
    parser.add_argument("--artist", required=True, help="artist column name")
    parser.add_argument("--year", help="year or date column name")
    parser.add_argument("--fixed-year", type=int,
                        help="use this year for every row (e.g. a chart week's year)")
    parser.add_argument("--id", required=True, dest="id_col",
                        help="column with the track ID / URI / URL")
    args = parser.parse_args()

    rows = skipped = 0
    reader = csv.DictReader(open(args.csv_file, encoding="utf-8", errors="replace"))
    header = reader.fieldnames or []
    wanted = {"--title": args.title, "--artist": args.artist, "--id": args.id_col}
    if args.year:
        wanted["--year"] = args.year
    missing = [f"{flag} '{name}'" for flag, name in wanted.items() if name not in header]
    if missing:
        sys.exit(f"column(s) not in the CSV header: {', '.join(missing)}\n"
                 f"actual header: {', '.join(header)}")
    for row in reader:
        match = ID.search(row.get(args.id_col) or "")
        title = (row.get(args.title) or "").strip()
        artist = (row.get(args.artist) or "").strip()
        if artist.startswith("[") and artist.endswith("]"):
            artist = flatten_artist(artist)
        year = args.fixed_year
        if year is None and args.year:
            raw = (row.get(args.year) or "")[:4]
            year = int(raw) if raw.isdigit() else None
        if not (match and title and artist):
            skipped += 1
            continue
        print(json.dumps({"title": title, "artist": artist, "year": year,
                          "spotify_id": match.group(1)}, ensure_ascii=False))
        rows += 1
    print(f"wrote {rows} mapping rows ({skipped} skipped)", file=sys.stderr)


if __name__ == "__main__":
    main()
