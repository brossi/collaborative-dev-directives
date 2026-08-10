#!/usr/bin/env python3
"""Guards for the resolver's candidate ranking and its track sidecar.

    python3 -m unittest discover -s tools -p 'test_*.py'
    python3 tools/test_resolve_uris.py

Two defects motivate this file.

1. The resolver received `artists[].id` on every search response and threw it
   away, keeping only the name — so artist identity fell back to comparing
   credit strings, which provably cannot work (see tools/_common.py). Nothing
   re-issues a search for a song that already has a URI, so every discarded ID
   was gone for good.

2. Candidates were sorted on `(similarity, popularity)`, but `popularity` is
   None on every search result (verified 2026-08-10, 10/10 items). The key was
   inert, and would have raised TypeError the day Spotify populated it for some
   rows but not others.
"""
import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from resolve_uris import (append_track, pick_best, score_items, song_key,
                          track_record)

# Field-for-field the shape of a live /v1/search?type=track&market=US item,
# captured 2026-08-10. market=US pins the catalog, so `available_markets` is
# absent and a whole item is ~1.8 KB — cheap enough to store verbatim.
SEARCH_ITEM = {
    "id": "7s25THrKz86DM225dOYwnr",
    "uri": "spotify:track:7s25THrKz86DM225dOYwnr",
    "name": "Respect",
    "artists": [{"id": "7nwUJBm0HE4ZxD3f5cy5ok", "name": "Aretha Franklin"}],
    "album": {
        "name": "I Never Loved a Man the Way I Love You",
        "release_date": "1967-03-10",
        "release_date_precision": "day",
    },
    "external_ids": {"isrc": "USAT29900609"},
    "popularity": None,
}
SONG = {"title": "Respect", "artist": "Aretha Franklin", "year": 1967}

TRACK_LOG = pathlib.Path(__file__).resolve().parent.parent / "mappings" / "spotify-tracks.jsonl"


def fake_track(name, artist, track_id, **extra):
    track = {
        "id": track_id,
        "uri": f"spotify:track:{track_id}",
        "name": name,
        "artists": [{"id": f"artist-{track_id}", "name": artist}],
        "album": {"name": name, "release_date": "1967", "release_date_precision": "year"},
        "external_ids": {},
    }
    track.update(extra)
    return track


class TrackRecordKeepsTheIdentifiers(unittest.TestCase):
    def setUp(self):
        self.record = track_record(SONG, SEARCH_ITEM)

    def test_keyed_by_the_same_identity_the_catalog_uses(self):
        # Anything wanting per-song artist IDs joins on this; it must stay
        # byte-identical to Song.id in Swift and song_key() everywhere else.
        self.assertEqual(self.record["key"], "Respect|Aretha Franklin|1967")
        self.assertEqual(self.record["key"], song_key(SONG))

    def test_a_resolved_row_carries_at_least_one_artist_id(self):
        """Phase 1's definition of done."""
        self.assertTrue(self.record["spotify_artist_ids"])
        self.assertEqual(self.record["spotify_artist_ids"], ["7nwUJBm0HE4ZxD3f5cy5ok"])

    def test_spotifys_own_spelling_is_kept_for_audit(self):
        self.assertEqual(self.record["spotify_artist_names"], ["Aretha Franklin"])

    def test_isrc_is_captured(self):
        # The recording identifier — stable across album pressings, and the
        # join key to MusicBrainz. Free on every search response.
        self.assertEqual(self.record["isrc"], "USAT29900609")

    def test_album_release_date_is_captured_with_its_precision(self):
        # Captured, never authoritative: which date you get depends on which
        # pressing matched. Bohemian Rhapsody's search hits are dated 1975,
        # 2010, 2021 and 2018 (verified 2026-08-10). Precision travels with it
        # so a bare "1975" is never mistaken for a day-accurate date.
        self.assertEqual(self.record["album_release_date"], "1967-03-10")
        self.assertEqual(self.record["album_release_date_precision"], "day")

    def test_it_doubles_as_a_fill_from_datasets_mapping_row(self):
        # {title, artist, year, spotify_id} is the existing mappings contract.
        for field in ("title", "artist", "year", "spotify_id"):
            self.assertIn(field, self.record)
        self.assertEqual(self.record["spotify_id"], "7s25THrKz86DM225dOYwnr")

    def test_the_whole_response_object_is_stored_verbatim(self):
        # Prune at read time, never at fetch time: recovering a dropped field
        # costs a full re-crawl against a daily quota.
        self.assertEqual(self.record["track"], SEARCH_ITEM)

    def test_the_record_survives_a_json_round_trip(self):
        self.assertEqual(json.loads(json.dumps(self.record, ensure_ascii=False)),
                         self.record)


class TrackRecordOnAwkwardResponses(unittest.TestCase):
    def test_id_less_artists_are_dropped_from_ids_but_kept_in_names(self):
        # The two lists are convenience projections, NOT positionally paired —
        # record["track"]["artists"] is the aligned truth. Asserted so the
        # non-alignment is a decision on record rather than a latent surprise.
        track = dict(SEARCH_ITEM, artists=[{"name": "Unknown Session Band"},
                                           {"id": "abc", "name": "Aretha Franklin"}])
        record = track_record(SONG, track)
        self.assertEqual(record["spotify_artist_ids"], ["abc"])
        self.assertEqual(record["spotify_artist_names"],
                         ["Unknown Session Band", "Aretha Franklin"])

    def test_missing_album_and_external_ids_do_not_raise(self):
        record = track_record(SONG, {"id": "x", "uri": "spotify:track:x",
                                     "name": "Respect", "artists": []})
        self.assertIsNone(record["album_release_date"])
        self.assertIsNone(record["isrc"])
        self.assertEqual(record["spotify_artist_ids"], [])


class RankingHasNoDeadTieBreaker(unittest.TestCase):
    def test_equal_similarity_keeps_spotifys_relevance_order(self):
        items = [fake_track("Respect", "Aretha Franklin", "first"),
                 fake_track("Respect", "Aretha Franklin", "second")]
        scored = score_items(items, "Respect", "Aretha Franklin")
        self.assertEqual(len(scored), 2)
        self.assertEqual(pick_best(scored)["id"], "first")

    def test_a_populated_popularity_can_no_longer_raise(self):
        # The old key compared None to int as soon as the two differed.
        items = [fake_track("Respect", "Aretha Franklin", "a", popularity=None),
                 fake_track("Respect", "Aretha Franklin", "b", popularity=57)]
        self.assertEqual(pick_best(score_items(items, "Respect", "Aretha Franklin"))["id"], "a")

    def test_higher_similarity_still_wins_from_any_position(self):
        items = [fake_track("Respect Yourself", "Aretha Franklin", "loose"),
                 fake_track("Respect", "Aretha Franklin", "exact")]
        self.assertEqual(pick_best(score_items(items, "Respect", "Aretha Franklin"))["id"],
                         "exact")

    def test_nothing_scored_is_no_match(self):
        self.assertIsNone(pick_best([]))

    def test_a_wrong_artist_is_still_rejected_outright(self):
        items = [fake_track("Respect", "The Rolling Stones", "wrong")]
        self.assertEqual(score_items(items, "Respect", "Aretha Franklin"), [])


class VersionSuffixesDoNotHideTheRightTrack(unittest.TestCase):
    """The defect that made 25 pending soundtrack/cast songs unresolvable: the
    correct track sat at rank 1 with the right artist and scored 0.453."""

    def test_the_soundtrack_suffix_no_longer_sinks_an_exact_match(self):
        # Verbatim from a live search response, 2026-08-10.
        items = [fake_track('Men In Black - From "Men In Black" Soundtrack',
                            "Will Smith", "mib")]
        self.assertEqual(pick_best(score_items(items, "Men in Black", "Will Smith"))["id"],
                         "mib")

    def test_a_long_from_the_motion_picture_suffix_too(self):
        items = [fake_track('Fight For You - From the Original Motion Picture '
                            '"Judas and the Black Messiah"', "H.E.R.", "her")]
        self.assertEqual(pick_best(score_items(items, "Fight for You", "H.E.R."))["id"], "her")

    def test_the_bare_track_outranks_a_live_or_remastered_cut(self):
        # Stripping the suffix makes these tie on similarity. Under blind audio
        # a live take is the wrong recording, so bare must win from either
        # input position — not by luck of Spotify's ordering.
        for order in ([("Respect - Live at Fillmore West", "live"), ("Respect", "bare")],
                      [("Respect", "bare"), ("Respect - Remastered 2011", "remaster")]):
            items = [fake_track(name, "Aretha Franklin", tid) for name, tid in order]
            with self.subTest(order=[t for _, t in order]):
                self.assertEqual(
                    pick_best(score_items(items, "Respect", "Aretha Franklin"))["id"], "bare")

    def test_is_bare_is_recorded_per_candidate(self):
        scored = score_items([fake_track("Respect - Live", "Aretha Franklin", "live"),
                              fake_track("Respect", "Aretha Franklin", "bare")],
                             "Respect", "Aretha Franklin")
        self.assertEqual([(s[1], s[2]["id"]) for s in scored],
                         [(False, "live"), (True, "bare")])

    def test_hyphens_inside_names_are_not_treated_as_qualifiers(self):
        # No whitespace around the hyphen, so nothing is stripped.
        items = [fake_track("99 Problems", "Jay-Z", "jayz")]
        self.assertEqual(pick_best(score_items(items, "99 Problems", "Jay-Z"))["id"], "jayz")

    def test_stripping_does_not_admit_a_different_song(self):
        # The floor still applies to the stripped form: "Fight for Your Right"
        # must not become "Fight for You" just because a suffix came off.
        items = [fake_track("Fight for Your Right - Remastered", "H.E.R.", "wrong")]
        best = pick_best(score_items(items, "Fight for You", "H.E.R."))
        self.assertTrue(best is None or best["id"] != "wrong",
                        "a different song passed the similarity floor")


class TrackLogIsAppendOnlyAndCrashSafe(unittest.TestCase):
    def test_each_append_lands_on_its_own_line_immediately(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "nested" / "spotify-tracks.jsonl"
            with append_track(path) as log:
                log(track_record(SONG, SEARCH_ITEM))
                # Readable BEFORE the handle closes: a Ctrl-C mid-run must not
                # lose lookups already paid for against the daily quota.
                self.assertEqual(len(path.read_text().splitlines()), 1)
                log(track_record(dict(SONG, title="Think"), SEARCH_ITEM))
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            self.assertEqual([r["key"] for r in rows],
                             ["Respect|Aretha Franklin|1967", "Think|Aretha Franklin|1967"])

    def test_a_second_run_appends_rather_than_truncating(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "spotify-tracks.jsonl"
            with append_track(path) as log:
                log(track_record(SONG, SEARCH_ITEM))
            with append_track(path) as log:
                log(track_record(dict(SONG, title="Think"), SEARCH_ITEM))
            self.assertEqual(len(path.read_text().splitlines()), 2)


class TheCommittedTrackLogIsUsable(unittest.TestCase):
    """Binds to the real artifact, not just the shape. A resolver run that
    silently stopped writing IDs would pass every test above."""

    def test_every_logged_row_carries_an_artist_id_and_a_track(self):
        self.assertTrue(
            TRACK_LOG.exists(),
            f"{TRACK_LOG} is missing — run tools/resolve_uris.py to produce it")
        rows = [json.loads(line) for line in TRACK_LOG.read_text().splitlines() if line.strip()]
        self.assertGreater(len(rows), 0, "empty track log proves nothing")
        for row in rows:
            with self.subTest(key=row.get("key")):
                self.assertTrue(row["spotify_artist_ids"])
                self.assertEqual(row["spotify_id"], row["track"]["id"])
                self.assertEqual(row["key"], song_key(row))


if __name__ == "__main__":
    unittest.main(verbosity=2)
