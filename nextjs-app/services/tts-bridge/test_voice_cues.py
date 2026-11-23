"""python -m unittest test_voice_cues  (from services/tts-bridge)"""
import unittest

from voice_cues import filter_cues, strip_cues


class StripCues(unittest.TestCase):
    def test_removes_cues(self):
        self.assertEqual(strip_cues("[warm] You left the lights on. [small laugh] Again."),
                         "You left the lights on. Again.")

    def test_mid_sentence_and_punctuation(self):
        self.assertEqual(strip_cues("I read it twice [laughs], really."), "I read it twice, really.")

    def test_leaves_other_brackets(self):
        for text in ("See [the docs](https://x.y) first.", "[Eve]: hi", "[PASS]", "Footnote [1].",
                     "Checked [x] and [ ]", "[Mount Graham] is high.", "a [[wiki]] link"):
            self.assertEqual(strip_cues(text), text, text)

    def test_long_bracket_text_is_not_a_cue(self):
        text = "[this is a very long aside that goes on and on] fine."
        self.assertEqual(strip_cues(text), text)


class FilterCues(unittest.TestCase):
    def test_keeps_light_cues(self):
        text = "[warm, teasing] You left the shop lights on again. [playful] I turned them off."
        self.assertEqual(filter_cues(text), (text, []))

    def test_drops_what_sounded_fake(self):
        out, dropped = filter_cues("[sighs] And their numbers still don't add up. [whispering] Don't move. "
                                   "[deep breath] Then I keep going.")
        self.assertEqual(out, "And their numbers still don't add up. Don't move. Then I keep going.")
        self.assertEqual(dropped, ["sighs", "whispering", "deep breath"])

    def test_drops_long_directions(self):
        out, dropped = filter_cues("[laughing as she talks] No, I fell in the creek!")
        self.assertEqual(out, "No, I fell in the creek!")
        self.assertEqual(dropped, ["laughing as she talks"])

    def test_one_cue_per_sentence(self):
        out, dropped = filter_cues("[warm] Hello [small laugh] there. [softly] Night.")
        self.assertEqual(out, "[warm] Hello there. [softly] Night.")
        self.assertEqual(dropped, ["small laugh"])

    def test_blocked_cue_frees_the_slot(self):
        out, _ = filter_cues("[sighs] Fine [small laugh] really.")
        self.assertEqual(out, "Fine [small laugh] really.")

    def test_tunable(self):
        out, dropped = filter_cues("[sighs] Fine.", blocked=(), max_words=3, per_sentence=1)
        self.assertEqual((out, dropped), ("[sighs] Fine.", []))


if __name__ == "__main__":
    unittest.main()
