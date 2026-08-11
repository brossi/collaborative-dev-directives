#!/usr/bin/env python3
"""Guards for the shared text plumbing. Standard library only — no framework.

    python3 -m unittest discover -s tools -p 'test_*.py'
    python3 tools/test_common.py

These exist because artists_match got the same thing wrong twice. norm() maps
"&" to " and ", so a rule that accepted a single shared token married
"The Beatles" to "The Rolling Stones" on "the", and Cardi B to Gerry and the
Pacemakers on "and". Both shipped confident, wrong answers into the catalog.
"""
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from _common import (artists_match, lead_credit, norm, primary_artist, show_title,
                     significant_tokens)


class LeadCreditKeepsTheOriginalSpelling(unittest.TestCase):
    """Two callers need the lead act as WRITTEN, where primary_artist()'s
    normalized output is useless: Wikidata label matching is exact, and
    Spotify's artist: filter reads the real string."""

    def test_case_and_punctuation_survive(self):
        self.assertEqual(lead_credit("Booker T. & the M.G.'s"), "Booker T.")
        self.assertEqual(primary_artist("Booker T. & the M.G.'s"), "booker t")

    def test_featured_credits_are_cut(self):
        self.assertEqual(lead_credit("Ariana Grande feat. Iggy Azalea"), "Ariana Grande")
        self.assertEqual(lead_credit("2Pac featuring K-Ci and JoJo"), "2Pac")

    def test_joined_credits_are_cut_at_the_first_act(self):
        self.assertEqual(lead_credit("Daniel Jenkins, Ron Richardson"), "Daniel Jenkins")
        self.assertEqual(lead_credit("A Great Big World & Christina Aguilera"),
                         "A Great Big World")

    def test_a_plain_credit_is_returned_unchanged(self):
        self.assertEqual(lead_credit("Aretha Franklin"), "Aretha Franklin")

    def test_a_band_name_containing_x_is_not_cut(self):
        # FEAT_X needs whitespace both sides, so the trailing X survives.
        self.assertEqual(lead_credit("Lil Nas X"), "Lil Nas X")

    def test_a_credit_that_is_only_a_separator_can_come_back_empty(self):
        # Documented so callers guard it: an empty artist: filter or an empty
        # lookup key matches everything. A bare comma splits to nothing; " & "
        # keeps its ampersand, because the pattern needs whitespace on both
        # sides and stripping has already removed it.
        self.assertEqual(lead_credit(","), "")
        self.assertEqual(lead_credit(" & "), "&")


class ShowTitleFindsTheWorkInACastCredit(unittest.TestCase):
    """A cast recording credits no artist — "Original Broadway Cast of Cats"
    is not a performer and has no Wikidata artist entity, which is why all 32
    of them harvested to `none`. The entity they DO have is the work, and the
    only place the work's name appears is inside the credit string: the song
    records carry title/artist/year/genres/uri and nothing else (verified
    against catalog/themes/tony-musicals.json, 2026-08-10).

    Getting this wrong is not a near miss. "Original Broadway Cast of Nine"
    truncated to "Original Broadway" resolves to nothing; truncated to "Nine"
    it resolves to the NUMBER. So each rule is anchored, and a credit that
    does not clearly name a work returns "" rather than a guess.
    """

    def test_cast_of_takes_what_follows(self):
        self.assertEqual(show_title("Original Broadway Cast of Hamilton"), "Hamilton")
        self.assertEqual(show_title("Original London Cast of Mamma Mia!"), "Mamma Mia!")
        self.assertEqual(show_title("Cast of Schmigadoon!"), "Schmigadoon!")

    def test_a_trailing_cast_is_stripped(self):
        self.assertEqual(show_title("Encanto Cast"), "Encanto")
        self.assertEqual(show_title("La La Land Cast"), "La La Land")
        self.assertEqual(show_title("The Rocky Horror Picture Show Original Cast"),
                         "The Rocky Horror Picture Show")

    def test_a_featured_performer_is_cut_before_the_show(self):
        # "Nashville Cast feat. Sam Palladio & Clare Bowen" -> the TV series.
        self.assertEqual(show_title("Nashville Cast feat. Sam Palladio & Clare Bowen"),
                         "Nashville")

    def test_the_last_cast_of_wins(self):
        # A performer billed ahead of the cast: the show is still what trails.
        self.assertEqual(
            show_title("John Lloyd Young, Original Broadway Cast of Jersey Boys"),
            "Jersey Boys")

    def test_punctuation_and_articles_survive(self):
        # Wikidata label matching is exact, so a stripped "!" or "The" misses.
        self.assertEqual(show_title("Original Broadway Cast of Fiorello!"), "Fiorello!")
        self.assertEqual(show_title("Original Broadway Cast of The Lion King"),
                         "The Lion King")
        self.assertEqual(show_title("Original Broadway Cast of Ain't Misbehavin'"),
                         "Ain't Misbehavin'")

    def test_an_ordinary_artist_is_not_a_show(self):
        self.assertEqual(show_title("Aretha Franklin"), "")
        self.assertEqual(show_title("Julie Andrews"), "")
        self.assertEqual(show_title("Dick Van Dyke"), "")

    def test_a_band_with_cast_inside_a_word_is_not_a_show(self):
        # The rule is anchored, so "Cast" has to stand alone as the credit's
        # own word -- "Casting Crowns" and "Newcastle" must not match.
        self.assertEqual(show_title("Casting Crowns"), "")
        self.assertEqual(show_title("The Newcastle Big Band"), "")

    def test_a_credit_naming_no_work_returns_empty(self):
        self.assertEqual(show_title("Original Broadway Cast"), "")
        self.assertEqual(show_title("Cast of"), "")
        self.assertEqual(show_title(""), "")


class NormKeepsItsContract(unittest.TestCase):
    def test_ampersand_becomes_and(self):
        # Correct for TITLE comparison, and the reason artist matching may
        # never treat norm() output as a bag of significant words.
        self.assertEqual(norm("Simon & Garfunkel"), "simon and garfunkel")

    def test_punctuation_is_removed_not_interpreted(self):
        # norm() serves titles too, where guessing is wrong: "Oh!" is not "Ohi".
        self.assertEqual(norm("P!nk"), "pnk")
        self.assertEqual(norm("Panic! at the Disco"), "panic at the disco")
        self.assertEqual(norm("Hello, Dolly!"), "hello dolly")
        self.assertEqual(norm("Let It Snow! Let It Snow!"), "let it snow let it snow")

    def test_digits_are_never_substituted(self):
        # "3"->"e" would wreck band names; only punctuation is letter-shaped.
        self.assertEqual(norm("3 Doors Down"), "3 doors down")
        self.assertEqual(norm("blink-182"), "blink182")

    def test_filler_is_not_significant(self):
        self.assertNotIn("and", significant_tokens("Cardi B & J Balvin"))
        self.assertNotIn("the", significant_tokens("The Beatles"))
        self.assertEqual(significant_tokens("The Beatles"), {"beatles"})


class ArtistsMatchRejectsFiller(unittest.TestCase):
    """Every case here returned True under the single-shared-token rule."""

    def test_the_does_not_marry_unrelated_bands(self):
        self.assertFalse(artists_match("The Rolling Stones", "The Beatles"))
        self.assertFalse(artists_match("The Beach Boys",
                                       "Marky Mark and the Funky Bunch"))

    def test_and_does_not_marry_unrelated_acts(self):
        self.assertFalse(artists_match("Gerry and the Pacemakers",
                                       "Cardi B, Bad Bunny & J Balvin"))
        self.assertFalse(artists_match("Hall and Oates", "Simon and Garfunkel"))

    def test_shared_filler_in_cast_credits(self):
        # "broadway" and "cast" are near-universal in this repertoire.
        self.assertFalse(artists_match("Broadway Karaoke Band",
                                       "Original Broadway Cast of Cats"))

    def test_empty_credit_never_matches(self):
        self.assertFalse(artists_match("", "Kate Bush"))
        self.assertFalse(artists_match("Kate Bush", ""))


class ArtistsMatchStillAcceptsRealVariants(unittest.TestCase):
    def test_identical(self):
        self.assertTrue(artists_match("Kate Bush", "Kate Bush"))

    def test_featured_credit_reduces_to_primary(self):
        self.assertTrue(artists_match("Wham!", "Wham! featuring George Michael"))

    def test_cast_credit_matches_its_lead(self):
        self.assertTrue(artists_match(
            "Lin-Manuel Miranda",
            "Lin-Manuel Miranda, Original Broadway Cast of Hamilton"))

    def test_punctuation_spelled_names_match_their_plain_form(self):
        self.assertTrue(artists_match("P!nk", "Pink"))
        self.assertTrue(artists_match("Pink", "P!nk"))
        self.assertTrue(artists_match("Ke$ha", "Kesha"))

    def test_glyph_aliases_are_applied(self):
        self.assertTrue(artists_match("Ty Dolla $ign", "Ty Dolla Sign"))
        self.assertTrue(artists_match("A$AP Rocky", "ASAP Rocky"))
        self.assertTrue(artists_match("Post Malone feat. Ty Dolla $ign", "Ty Dolla $ign"))


class SharedBoilerplateDoesNotImplySameAct(unittest.TestCase):
    """The bug this file exists for, second instance: cast credits agree on
    three words and name different shows. Only the residue discriminates."""

    def test_broadway_casts_of_different_shows(self):
        self.assertFalse(artists_match("Original Broadway Cast of Annie",
                                       "Original Broadway Cast of Nine"))
        self.assertFalse(artists_match("Original Broadway Cast of Cats",
                                       "Original Broadway Cast of Rent"))
        self.assertFalse(artists_match("Original Broadway Cast of Fiorello!",
                                       "Original London Cast of Mamma Mia!"))

    def test_near_miss_names_are_not_merged(self):
        # Similarity would accept all three: 0.900, 0.900, 0.889.
        self.assertFalse(artists_match("The Champs", "The Cramps"))
        self.assertFalse(artists_match("Jim Jones", "Jimmy Jones"))
        self.assertFalse(artists_match("Seal", "Seals and Crofts"))

    def test_two_real_shared_words_are_enough(self):
        self.assertTrue(artists_match("Booker T. & the M.G.'s", "Booker T and the MGs"))

    def test_every_catalog_artist_matches_itself(self):
        """The tightening must not reject anything the tools already accept."""
        root = pathlib.Path(__file__).resolve().parent.parent / "catalog"
        artists = {song["artist"]
                   for path in root.glob("*/*.json")
                   for song in json.loads(path.read_text())["songs"]}
        self.assertGreater(len(artists), 100, "catalog not found — test proves nothing")
        for artist in artists:
            with self.subTest(artist=artist):
                self.assertTrue(artists_match(artist, artist))
                if primary_artist(artist):
                    self.assertTrue(artists_match(primary_artist(artist), artist))


if __name__ == "__main__":
    unittest.main(verbosity=2)
