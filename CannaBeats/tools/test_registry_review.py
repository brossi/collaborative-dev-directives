#!/usr/bin/env python3
"""Guards for the Phase 3 human audit: the review CSV and the way decisions
come back in.

    python3 -m unittest discover -s tools -p 'test_*.py'
    python3 tools/test_registry_review.py

The whole point of the audit is that "Seal" vs "Seals and Crofts" becomes ONE
permanent human decision instead of a heuristic re-guessing it on every
comparison. That only holds if a decision, once made, is durable — so the
load-bearing test here is that --rederive leaves human rows alone. Everything
else is plumbing around it.
"""
import csv
import io
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from harvest_artist_ids import rederive_rows
from review_artist_registry import (DECISION_NONE, DECISION_OK, SHAPE_ORDER,
                                    apply_decisions, emit_csv, needs_review,
                                    parse_decisions, removed_text, review_shape,
                                    unresolved_qids)


def row(credit, confidence, songs=1, wikidata=None, candidates=None, **extra):
    base = {
        "credit": credit,
        "songs": songs,
        "labels": [credit],
        "wikidata": wikidata,
        "name": None,
        "spotify_artist_id": None,
        "musicbrainz_artist_id": None,
        "matched_label": credit if wikidata else None,
        "confidence": confidence,
        "spotify_artist_id_source": None,
        "source": "wikidata",
        "candidates": candidates or {},
    }
    base.update(extra)
    return base


def candidate(qid, name, spotify=None, mbid=None, types=None):
    return {"wikidata": qid, "name": name, "spotify_artist_id": spotify,
            "musicbrainz_artist_id": mbid, "types": types or []}


class NeedsReviewPicksTheUncertainRows(unittest.TestCase):
    def setUp(self):
        self.rows = [
            row("Aretha Franklin", "single-exact", 12, "Q125121"),
            row("Jim Jones", "multi", 3),
            row("Beyonce", "none", 2),
            row("Kool & the Gang", "single-shortened", 7, "Q850290"),
        ]

    def test_settled_rows_are_left_out(self):
        self.assertNotIn("Aretha Franklin", [r["credit"] for r in needs_review(self.rows)])

    def test_every_other_verdict_is_reviewed(self):
        # single-shortened is included deliberately: it is an inference, and
        # "John Travolta & Olivia Newton-John" -> John Travolta drops a duet.
        self.assertEqual({r["credit"] for r in needs_review(self.rows)},
                         {"Jim Jones", "Beyonce", "Kool & the Gang"})

    def test_like_rows_are_grouped_so_one_judgement_covers_many(self):
        # Shape order first, song count within it. 219 "X feat. Y" rows in a
        # block are one judgement repeated; scattered among ambiguous names
        # they are 219 separate ones.
        rows = [
            row("Jim Jones", "multi", 50),
            row("Beyonce", "none", 40),
            row("Small Feat", "single-shortened", 1, "Q2", matched_label="Small"),
            row("Big Feat", "single-shortened", 9, "Q1", matched_label="Big"),
        ]
        rows[2]["credit"] = "Small feat. Other"
        rows[2]["matched_label"] = "Small"
        rows[3]["credit"] = "Big feat. Other"
        rows[3]["matched_label"] = "Big"
        self.assertEqual([r["credit"] for r in needs_review(rows)],
                         ["Big feat. Other", "Small feat. Other", "Jim Jones", "Beyonce"])

    def test_most_songs_first_within_a_group(self):
        rows = [row("A", "multi", 2), row("B", "multi", 9)]
        self.assertEqual([r["credit"] for r in needs_review(rows)], ["B", "A"])

    def test_an_already_decided_row_is_not_re_asked(self):
        decided = row("Jim Jones", "human", 3, "Q707008", source="human")
        self.assertEqual(needs_review([decided]), [])


class ShapeSaysWhichCutFiredNotWhetherItWasRight(unittest.TestCase):
    def shape_of(self, credit, matched):
        return review_shape(row(credit, "single-shortened", 1, "Q1",
                                matched_label=matched))

    def test_a_featured_credit(self):
        self.assertEqual(self.shape_of("Ariana Grande feat. Iggy Azalea", "Ariana Grande"),
                         "trimmed:featured")
        self.assertEqual(self.shape_of("Tommy Dorsey featuring Frank Sinatra", "Tommy Dorsey"),
                         "trimmed:featured")

    def test_a_backing_band(self):
        for credit, matched in (("Abe Lyman and His Orchestra", "Abe Lyman"),
                                ("Ted Lewis and His Band", "Ted Lewis"),
                                ("Archie Bell & the Drells", "Archie Bell")):
            with self.subTest(credit=credit):
                self.assertEqual(self.shape_of(credit, matched), "trimmed:backing-band")

    def test_a_co_credited_act_is_kept_separate_from_a_backing_band(self):
        # The risky group: this one drops half a duet, the ones above drop a
        # backing band. Same syntax, opposite consequence.
        self.assertEqual(self.shape_of("John Travolta & Olivia Newton-John", "John Travolta"),
                         "trimmed:co-credited")
        self.assertEqual(self.shape_of("Daniel Jenkins, Ron Richardson", "Daniel Jenkins"),
                         "trimmed:co-credited")

    def test_other_verdicts_pass_straight_through(self):
        self.assertEqual(review_shape(row("Jim Jones", "multi", 1)), "multi")
        self.assertEqual(review_shape(row("Beyonce", "none", 1)), "none")

    def test_every_shape_is_orderable(self):
        # A shape missing from SHAPE_ORDER would make needs_review raise.
        for credit, matched in (("X feat. Y", "X"), ("X and His Orchestra", "X"),
                                ("X & Y", "X"), ("X ~ Y", "X"), ("Totally Other", "Z")):
            with self.subTest(credit=credit):
                shape = review_shape(row(credit, "single-shortened", 1, "Q1",
                                         matched_label=matched))
                self.assertIn(shape, SHAPE_ORDER)

    def test_removed_shows_exactly_what_was_dropped(self):
        self.assertEqual(removed_text(row("Abe Lyman and His Orchestra", "single-shortened",
                                          1, "Q1", matched_label="Abe Lyman")),
                         "and His Orchestra")
        self.assertEqual(removed_text(row("Jim Jones", "multi", 1)), "")


class TheCsvIsReviewableWithoutLeavingIt(unittest.TestCase):
    def emit(self, rows, examples=None):
        buffer = io.StringIO()
        emit_csv(rows, examples or {}, buffer)
        return list(csv.DictReader(io.StringIO(buffer.getvalue())))

    def test_candidates_are_spelled_out_for_the_human(self):
        rows = [row("Jim Jones", "multi", 3, candidates={"Jim Jones": [
            candidate("Q213861", "Jim Jones", types=["human"]),
            candidate("Q707008", "Jim Jones", spotify="6AMa1VFQ", types=["rapper"])]})]
        out = self.emit(rows)[0]
        self.assertIn("Q213861", out["candidates"])
        self.assertIn("Q707008", out["candidates"])
        self.assertIn("rapper", out["candidates"])

    def test_catalog_examples_travel_with_the_row(self):
        # What actually lets someone decide: "Billie Jean (1983)" settles which
        # Michael Jackson this is without opening Wikidata at all.
        rows = [row("Michael Jackson", "multi", 2)]
        out = self.emit(rows, {"Michael Jackson": ["Billie Jean (1983)", "Beat It (1983)"]})[0]
        self.assertIn("Billie Jean (1983)", out["examples"])

    def test_the_decision_column_starts_empty(self):
        out = self.emit([row("Jim Jones", "multi", 3)])[0]
        self.assertEqual(out["decision"], "")

    def test_commas_and_quotes_in_a_credit_survive(self):
        awkward = 'Andrew Rannells, Josh Gad & "The Book of Mormon"'
        out = self.emit([row(awkward, "multi", 1)])[0]
        self.assertEqual(out["credit"], awkward)

    def test_an_untouched_csv_yields_no_decisions(self):
        buffer = io.StringIO()
        emit_csv([row("Jim Jones", "multi", 3), row("Beyonce", "none", 2)], {}, buffer)
        self.assertEqual(parse_decisions(io.StringIO(buffer.getvalue())), {})

    def test_a_filled_in_csv_round_trips_through_a_spreadsheet(self):
        # Emit, fill the decision column the way a spreadsheet would, read back.
        buffer = io.StringIO()
        emit_csv([row("Jim Jones", "multi", 3), row("Beyonce", "none", 2)], {}, buffer)
        reader = list(csv.DictReader(io.StringIO(buffer.getvalue())))
        reader[0]["decision"] = "Q707008"
        reader[1]["decision"] = DECISION_NONE
        edited = io.StringIO()
        writer = csv.DictWriter(edited, fieldnames=list(reader[0]))
        writer.writeheader()
        writer.writerows(reader)
        self.assertEqual(parse_decisions(io.StringIO(edited.getvalue())),
                         {"Jim Jones": "Q707008", "Beyonce": DECISION_NONE})

    def test_whitespace_and_case_from_a_spreadsheet_are_tolerated(self):
        text = "credit,decision\nJim Jones,  q707008  \nBeyonce, NONE \n"
        self.assertEqual(parse_decisions(io.StringIO(text)),
                         {"Jim Jones": "Q707008", "Beyonce": DECISION_NONE})


class ApplyingDecisionsIsExplicit(unittest.TestCase):
    def setUp(self):
        self.rows = [row("Jim Jones", "multi", 3, candidates={"Jim Jones": [
            candidate("Q213861", "Jim Jones", types=["human"]),
            candidate("Q707008", "Jim Jones", spotify="6AMa1VFQ", mbid="81148ae0")]}),
            row("Kool & the Gang", "single-shortened", 7, "Q850290",
                candidates={"Kool & the Gang": [candidate("Q850290", "Kool & The Gang",
                                                          spotify="sp1", mbid="mb1")]},
                spotify_artist_id="sp1", musicbrainz_artist_id="mb1"),
            row("Beyonce", "none", 2)]

    def test_choosing_a_candidate_fills_its_identifiers_with_no_network(self):
        applied = apply_decisions(self.rows, {"Jim Jones": "Q707008"})
        self.assertEqual(applied, 1)
        decided = self.rows[0]
        self.assertEqual(decided["wikidata"], "Q707008")
        self.assertEqual(decided["spotify_artist_id"], "6AMa1VFQ")
        self.assertEqual(decided["musicbrainz_artist_id"], "81148ae0")
        self.assertEqual(decided["confidence"], "human")
        self.assertEqual(decided["source"], "human")

    def test_ok_confirms_what_was_harvested(self):
        apply_decisions(self.rows, {"Kool & the Gang": DECISION_OK})
        confirmed = self.rows[1]
        self.assertEqual(confirmed["wikidata"], "Q850290")
        self.assertEqual(confirmed["spotify_artist_id"], "sp1")
        self.assertEqual(confirmed["source"], "human")

    def test_ok_on_a_row_with_nothing_harvested_is_refused(self):
        # "Confirm the answer" is meaningless where there is no answer; silently
        # accepting it would mint a human-blessed empty row.
        with self.assertRaises(ValueError):
            apply_decisions(self.rows, {"Beyonce": DECISION_OK})

    def test_none_records_a_confirmed_absence(self):
        apply_decisions(self.rows, {"Beyonce": DECISION_NONE})
        self.assertIsNone(self.rows[2]["wikidata"])
        self.assertEqual(self.rows[2]["source"], "human")
        self.assertEqual(self.rows[2]["confidence"], "human")

    def test_a_blank_decision_changes_nothing(self):
        self.assertEqual(apply_decisions(self.rows, {"Jim Jones": ""}), 0)
        self.assertEqual(self.rows[0]["confidence"], "multi")
        self.assertEqual(self.rows[0]["source"], "wikidata")

    def test_a_decision_for_an_unknown_credit_is_refused(self):
        with self.assertRaises(ValueError):
            apply_decisions(self.rows, {"Nobody At All": "Q1"})

    def test_applying_twice_changes_nothing_the_second_time(self):
        apply_decisions(self.rows, {"Jim Jones": "Q707008"})
        snapshot = json.dumps(self.rows, sort_keys=True)
        apply_decisions(self.rows, {"Jim Jones": "Q707008"})
        self.assertEqual(json.dumps(self.rows, sort_keys=True), snapshot)

    def test_a_qid_outside_the_candidates_is_reported_not_guessed(self):
        # The human may have looked one up by hand. Accepting it silently would
        # leave a row with a Q-number and no identifiers, breaking the invariant
        # that a resolved row can actually be joined on.
        self.assertEqual(unresolved_qids(self.rows, {"Beyonce": "Q36153"}),
                         {"Beyonce": "Q36153"})
        self.assertEqual(unresolved_qids(self.rows, {"Jim Jones": "Q707008"}), {})


class HumanDecisionsSurviveEverythingAfterThem(unittest.TestCase):
    """The load-bearing guarantee. Without it the audit is worthless: the next
    harvest re-guesses and quietly replaces a decision someone reasoned about."""

    def test_rederive_leaves_a_human_row_untouched(self):
        rows = [row("Jim Jones", "human", 3, "Q707008",
                    candidates={"Jim Jones": [
                        candidate("Q213861", "Jim Jones"),
                        candidate("Q707008", "Jim Jones", spotify="6AMa1VFQ")]},
                    spotify_artist_id="6AMa1VFQ", source="human")]
        before = json.dumps(rows[0], sort_keys=True)
        rederive_rows(rows)
        self.assertEqual(json.dumps(rows[0], sort_keys=True), before,
                         "rederive overwrote a human decision")

    def test_rederive_still_recomputes_machine_rows(self):
        rows = [row("Aretha Franklin", "none", 1,
                    candidates={"Aretha Franklin": [
                        candidate("Q125121", "Aretha Franklin", spotify="7nwUJ")]})]
        rederive_rows(rows)
        self.assertEqual(rows[0]["confidence"], "single-exact")
        self.assertEqual(rows[0]["wikidata"], "Q125121")

    def test_a_confirmed_absence_is_not_re_resolved(self):
        # Someone decided this credit has no entity. A later harvest finding a
        # plausible candidate must not overturn that.
        rows = [row("Encanto Cast", "human", 2,
                    candidates={"Encanto Cast": [candidate("Q999", "Encanto", spotify="x")]},
                    source="human")]
        rederive_rows(rows)
        self.assertIsNone(rows[0]["wikidata"])
        self.assertEqual(rows[0]["confidence"], "human")


if __name__ == "__main__":
    unittest.main(verbosity=2)
