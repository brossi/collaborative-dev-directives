#!/usr/bin/env python3
"""Guards for the artist registry bootstrap.

    python3 -m unittest discover -s tools -p 'test_*.py'
    python3 tools/test_artist_registry.py

The registry exists to retire artist matching by credit string, which provably
cannot work (see tools/_common.py). Everything here protects the two ways a
bootstrap can quietly go wrong:

  - a lookup label that is too short matches the wrong entity confidently
    ("Simon & Garfunkel" trimmed to "Simon", "? and the Mysterians" to "?"),
  - a genuinely ambiguous name resolves to whichever item came back first
    ("Jim Jones" is three Wikidata items, one of them the cult leader).

Neither may ever produce a silent single answer. They must be labelled for the
Phase 3 human audit instead.
"""
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from harvest_artist_ids import (REGISTRY, REVIEWED, apply_resolver_ids, collect,
                                decide, lookup_labels, registry_row)


def binding(label, qid, name, spotify=None, mbid=None, type_label=None):
    """One SPARQL result row, shaped as query.wikidata.org returns it."""
    row = {"label": {"value": label},
           "item": {"value": f"http://www.wikidata.org/entity/{qid}"},
           "itemLabel": {"value": name}}
    if spotify:
        row["spotify"] = {"value": spotify}
    if mbid:
        row["mbid"] = {"value": mbid}
    if type_label:
        row["typeLabel"] = {"value": type_label}
    return row


class LookupLabelsTriesTheMostSpecificFirst(unittest.TestCase):
    def test_a_plain_credit_yields_only_itself(self):
        self.assertEqual(lookup_labels("Aretha Franklin"), ["Aretha Franklin"])

    def test_the_full_credit_always_comes_first(self):
        # Order is the whole safety mechanism: a shortened label is consulted
        # only when the full one found nothing.
        for credit in ("Simon & Garfunkel", "Abe Lyman and His Orchestra",
                       "Ariana Grande feat. Iggy Azalea"):
            with self.subTest(credit=credit):
                self.assertEqual(lookup_labels(credit)[0], credit)

    def test_featured_credits_fall_back_to_the_lead(self):
        self.assertEqual(lookup_labels("Ariana Grande feat. Iggy Azalea"),
                         ["Ariana Grande feat. Iggy Azalea", "Ariana Grande"])
        self.assertEqual(lookup_labels("2Pac featuring K-Ci and JoJo")[1], "2Pac")

    def test_joined_credits_fall_back_to_the_first_act(self):
        self.assertEqual(lookup_labels("A Great Big World & Christina Aguilera"),
                         ["A Great Big World & Christina Aguilera", "A Great Big World"])
        self.assertEqual(lookup_labels("Abe Lyman and His Orchestra")[1], "Abe Lyman")

    def test_original_casing_is_preserved(self):
        # Wikidata label matching is exact; a normalized lowercase form
        # (_common.primary_artist) matches nothing.
        self.assertEqual(lookup_labels("The Beatles"), ["The Beatles"])
        self.assertNotIn("the beatles", lookup_labels("The Beatles"))

    def test_useless_short_fallbacks_are_dropped(self):
        # "?" as a Wikidata label matches junk; the full credit is kept anyway.
        self.assertEqual(lookup_labels("? and the Mysterians"), ["? and the Mysterians"])

    def test_no_duplicate_labels(self):
        labels = lookup_labels("Queen")
        self.assertEqual(len(labels), len(set(labels)))


class CollectFoldsWikidatasRepeatedRows(unittest.TestCase):
    def test_one_item_with_two_types_is_one_candidate(self):
        # Seals and Crofts is both "male duo" and "musical duo", so Wikidata
        # returns the same Q-number twice. Counting rows would read as ambiguity.
        rows = [binding("Seals and Crofts", "Q763765", "Seals and Crofts",
                        "6jdObwsrIjSRnBbMw6lPBj", "b0633a9d", "male duo"),
                binding("Seals and Crofts", "Q763765", "Seals and Crofts",
                        "6jdObwsrIjSRnBbMw6lPBj", "b0633a9d", "musical duo")]
        items = collect(rows)["Seals and Crofts"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["wikidata"], "Q763765")
        self.assertEqual(sorted(items[0]["types"]), ["male duo", "musical duo"])

    def test_distinct_items_stay_distinct(self):
        rows = [binding("Jim Jones", "Q213861", "Jim Jones"),
                binding("Jim Jones", "Q707008", "Jim Jones", "6AMa1VFQ7qCi61tCRtVWXe"),
                binding("Jim Jones", "Q6195946", "Jim Jones")]
        self.assertEqual(len(collect(rows)["Jim Jones"]), 3)

    def test_bindings_are_grouped_by_their_label(self):
        rows = [binding("Seal", "Q218091", "Seal", "5GtMEZEeFFsuHY8ad4kOxv"),
                binding("Seals and Crofts", "Q763765", "Seals and Crofts")]
        self.assertEqual(sorted(collect(rows)), ["Seal", "Seals and Crofts"])

    def test_a_qid_placeholder_name_falls_back_to_the_matched_label(self):
        # wikibase:label returns the Q-number when an item has no English
        # label. Q26876 (Taylor Swift) is exactly that, and it is common in
        # sitelink-matched rows — "Q26876" in the audit CSV is unreviewable.
        items = collect([binding("Taylor Swift", "Q26876", "Q26876",
                                 "06HL4z0CvFAxyc27GXpf02")])
        self.assertEqual(items["Taylor Swift"][0]["name"], "Taylor Swift")

    def test_a_real_name_is_left_alone(self):
        items = collect([binding("Celine Dion", "Q5105", "Céline Dion", "4S9EykWX")])
        self.assertEqual(items["Celine Dion"][0]["name"], "Céline Dion")

    def test_the_two_routes_merge_into_one_candidate(self):
        # The same item arrives twice — once by label, once by sitelink. Two
        # rows for one entity must not read as ambiguity.
        rows = [binding("The Beatles", "Q1299", "The Beatles", "3WrFJ7z", "b10bbbfc"),
                binding("The Beatles", "Q1299", "The Beatles", "3WrFJ7z", "b10bbbfc")]
        self.assertEqual(len(collect(rows)["The Beatles"]), 1)

    def test_absent_optional_fields_become_none(self):
        items = collect([binding("The Champs", "Q1065615", "The Champs", mbid="bbaa7a18")])
        self.assertIsNone(items["The Champs"][0]["spotify_artist_id"])
        self.assertEqual(items["The Champs"][0]["musicbrainz_artist_id"], "bbaa7a18")


class DecideRefusesToGuess(unittest.TestCase):
    def test_a_single_hit_on_the_full_credit_is_exact(self):
        candidates = collect([binding("Aretha Franklin", "Q125121", "Aretha Franklin",
                                      "7nwUJBm0HE4ZxD3f5cy5ok", "2f9ecbed")])
        got = decide(candidates, ["Aretha Franklin"])
        self.assertEqual(got["confidence"], "single-exact")
        self.assertEqual(got["wikidata"], "Q125121")
        self.assertEqual(got["spotify_artist_id"], "7nwUJBm0HE4ZxD3f5cy5ok")
        self.assertEqual(got["matched_label"], "Aretha Franklin")

    def test_a_hit_only_on_a_shortened_label_is_flagged(self):
        # "Abe Lyman and His Orchestra" is not a Wikidata item; "Abe Lyman" is.
        # Probably right, but it is an inference and must not read as certain.
        candidates = collect([binding("Abe Lyman", "Q2822195", "Abe Lyman", mbid="aaa")])
        got = decide(candidates, ["Abe Lyman and His Orchestra", "Abe Lyman"])
        self.assertEqual(got["confidence"], "single-shortened")
        self.assertEqual(got["matched_label"], "Abe Lyman")

    def test_several_items_never_collapse_to_one(self):
        candidates = collect([binding("Jim Jones", "Q213861", "Jim Jones"),
                              binding("Jim Jones", "Q707008", "Jim Jones", "6AMa1VFQ")])
        got = decide(candidates, ["Jim Jones"])
        self.assertEqual(got["confidence"], "multi")
        self.assertIsNone(got["wikidata"])
        self.assertIsNone(got["spotify_artist_id"])

    def test_the_full_credit_wins_even_when_a_fallback_would_also_hit(self):
        # The trap: "Simon & Garfunkel" shortens to "Simon". Both resolve, and
        # taking the shorter one would file the duo under a different act.
        candidates = collect([
            binding("Simon & Garfunkel", "Q484918", "Simon & Garfunkel", "70cRZdQ"),
            binding("Simon", "Q999999", "Simon", "wrongwrongwrong")])
        got = decide(candidates, ["Simon & Garfunkel", "Simon"])
        self.assertEqual(got["wikidata"], "Q484918")
        self.assertEqual(got["confidence"], "single-exact")

    def test_an_ambiguous_full_credit_does_not_fall_through_to_a_fallback(self):
        # Ambiguity is an answer ("a human must look"), not a reason to keep
        # searching with a vaguer label.
        candidates = collect([binding("Will Smith", "Q40096", "Will Smith", "41qil2"),
                              binding("Will Smith", "Q8003106", "Will Smith"),
                              binding("Will", "Q1", "Will", "somethingelse")])
        got = decide(candidates, ["Will Smith", "Will"])
        self.assertEqual(got["confidence"], "multi")
        self.assertEqual(got["matched_label"], "Will Smith")

    def test_nothing_anywhere_is_none(self):
        got = decide({}, ["Original Broadway Cast of Annie"])
        self.assertEqual(got["confidence"], "none")
        self.assertIsNone(got["wikidata"])
        self.assertIsNone(got["matched_label"])


class RegistryRowsCarryTheirEvidence(unittest.TestCase):
    def test_the_row_keeps_every_candidate_including_rejects(self):
        # The reason --rederive can replay a corrected rule with no network.
        candidates = collect([binding("Jim Jones", "Q213861", "Jim Jones"),
                              binding("Jim Jones", "Q707008", "Jim Jones", "6AMa1VFQ")])
        row = registry_row("Jim Jones", 2, candidates)
        self.assertEqual(row["credit"], "Jim Jones")
        self.assertEqual(row["songs"], 2)
        self.assertEqual(row["confidence"], "multi")
        self.assertEqual(len(row["candidates"]["Jim Jones"]), 2)

    def test_the_row_survives_a_json_round_trip(self):
        row = registry_row("Seal", 1, collect([binding("Seal", "Q218091", "Seal", "5GtM")]))
        self.assertEqual(json.loads(json.dumps(row, ensure_ascii=False)), row)


class ResolverIdsOutrankWikidata(unittest.TestCase):
    """They came from the track we actually play."""

    def setUp(self):
        self.rows = [registry_row("Will Smith", 1, collect(
            [binding("Will Smith", "Q40096", "Will Smith", "wikidata-said-this")]))]

    def test_a_single_artist_track_overrides_the_wikidata_id(self):
        log = [{"artist": "Will Smith",
                "track": {"artists": [{"id": "41qil2VaGbD194gaEcmmyx"}]}}]
        self.assertEqual(apply_resolver_ids(self.rows, log), 1)
        self.assertEqual(self.rows[0]["spotify_artist_id"], "41qil2VaGbD194gaEcmmyx")
        self.assertEqual(self.rows[0]["spotify_artist_id_source"], "resolver")

    def test_a_multi_artist_track_is_ignored(self):
        # Which of the credited artists is OUR act is exactly the question the
        # registry exists to answer, so a multi-artist track cannot answer it.
        # Buenos Aires credits six, including Tim Rice and Andrew Lloyd Webber.
        log = [{"artist": "Will Smith",
                "track": {"artists": [{"id": "aaa"}, {"id": "bbb"}]}}]
        self.assertEqual(apply_resolver_ids(self.rows, log), 0)
        self.assertEqual(self.rows[0]["spotify_artist_id"], "wikidata-said-this")
        self.assertEqual(self.rows[0]["spotify_artist_id_source"], "wikidata")

    def test_a_credit_absent_from_the_registry_is_skipped(self):
        log = [{"artist": "Nobody At All", "track": {"artists": [{"id": "zzz"}]}}]
        self.assertEqual(apply_resolver_ids(self.rows, log), 0)


class TheCommittedRegistryIsUsable(unittest.TestCase):
    """Binds to the real artifact. Every assertion above passes on an empty
    or half-built file."""

    @classmethod
    def setUpClass(cls):
        # Deliberately no skipIf: a missing registry must fail the suite, not
        # quietly excuse it. Every test below then reports the same real cause.
        cls.rows = ([json.loads(l) for l in REGISTRY.read_text().splitlines() if l.strip()]
                    if REGISTRY.exists() else [])

    def test_it_exists_and_covers_the_whole_catalog(self):
        self.assertTrue(REGISTRY.exists(),
                        f"{REGISTRY} is missing — run tools/harvest_artist_ids.py")
        catalog = {song["artist"]
                   for path in (REGISTRY.parent.parent / "catalog").glob("*/*.json")
                   for song in json.loads(path.read_text())["songs"]}
        self.assertEqual({row["credit"] for row in self.rows}, catalog)

    def test_credits_are_unique(self):
        credits = [row["credit"] for row in self.rows]
        self.assertEqual(len(credits), len(set(credits)))

    def test_every_row_is_classified(self):
        for row in self.rows:
            with self.subTest(credit=row["credit"]):
                self.assertIn(row["confidence"],
                              {"single-exact", "single-shortened", "multi", "none",
                               "human", "assistant"})

    def test_a_reviewed_row_says_who_reviewed_it_and_what_it_used_to_be(self):
        # harvest_confidence is what keeps a decided row sorting into the block
        # it came from when it goes back into the queue.
        for row in self.rows:
            if row["source"] in REVIEWED:
                with self.subTest(credit=row["credit"]):
                    self.assertEqual(row["confidence"], row["source"])
                    self.assertIn(row.get("harvest_confidence"),
                                  {"single-shortened", "multi", "none"})

    def test_a_resolved_row_carries_an_identifier_and_an_unresolved_one_does_not(self):
        # Stated as invariants rather than a list of verdict names, so adding a
        # reviewer does not silently widen what counts as resolved. A row with a
        # Q-number and no identifier is the one state nothing downstream can
        # join on; an undecided verdict must never carry a Q-number at all.
        for row in self.rows:
            with self.subTest(credit=row["credit"]):
                if row["wikidata"]:
                    self.assertTrue(row["spotify_artist_id"] or
                                    row["musicbrainz_artist_id"])
                if row["confidence"].startswith("single"):
                    self.assertTrue(row["wikidata"])
                if row["confidence"] in {"multi", "none"}:
                    self.assertIsNone(row["wikidata"])

    def test_an_artist_with_no_english_wikidata_label_still_resolves(self):
        # Guards the silent failure a label-only harvest had: Q26876 carries 74
        # labels, none of them English, and was filed as "no Wikidata entity".
        row = {r["credit"]: r for r in self.rows}.get("Taylor Swift")
        self.assertIsNotNone(row, "Taylor Swift missing from the registry")
        self.assertNotEqual(row["confidence"], "none",
                            "label-only regression: en.wikipedia sitelink not matched")
        self.assertTrue(row["spotify_artist_id"] or row["musicbrainz_artist_id"])

    def test_the_pair_that_broke_string_matching_is_two_entities(self):
        by_credit = {row["credit"]: row for row in self.rows}
        seal, crofts = by_credit.get("Seal"), by_credit.get("Seals and Crofts")
        self.assertIsNotNone(seal, "Seal missing from the registry")
        self.assertIsNotNone(crofts, "Seals and Crofts missing from the registry")
        self.assertNotEqual(seal["wikidata"], crofts["wikidata"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
