# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""The server-side style classifier's vocabulary and verdicts.

The client has its own classifier (webapp/src/lib/audio/style.js) over its own
normalized scales; the two share ids and labels but not thresholds. These tests
pin the SERVER side only: that the engine advertises the genres the studio seeds
its tags from, and that a few characteristic feature sets land in the right
family rather than on the wrong side of the archetype.
"""

import unittest

from supysonic.deezer import analysis as ana


def feats(**kw):
    """A complete feature dict, so no family silently dies on a KeyError."""
    base = {
        "bpm": 0.0,
        "bpm_confidence": 0.0,
        "pulse": 0.0,
        "centroid": 1500.0,
        "flatness": 0.0,
        "flatness_hi": 0.0,
        "entropy": 0.0,
        "rolloff": 3000.0,
        "lra": 8.0,
        "flux_peak": 1.0,
    }
    base.update(kw)
    return base


class EngineGenresTestCase(unittest.TestCase):
    def test_the_hardcore_and_dance_additions_are_known(self):
        labels = {label for label, _arch in ana.known_genres()}
        for label in (
            "Hardcore", "Tribe", "Speedcore", "Indus", "Rawstyle", "Hard techno",
            "Dance / EDM", "Drum & bass", "Dubstep", "Disco / funk", "Psytrance",
        ):
            self.assertIn(label, labels)
        # Ids and labels are what the studio seeds tags from; both must be
        # unique. The studio keys its tags BY NAME, so a label appearing in
        # both halves of the vocabulary seeds one tag and every count taken
        # against the list is then quietly off by one.
        ids = [fid for fid, _l, _a, _w in ana.FAMILIES]
        self.assertEqual(len(ids), len(set(ids)))
        every = [label for label, _arch in ana.known_genres()]
        self.assertEqual(len(every), len(set(every)))
        # The offered vocabulary is the families the heuristic can guess PLUS
        # the sub-genres it cannot, so it is a strict superset of them.
        family_labels = {label for _fid, label, _a, _w in ana.FAMILIES}
        self.assertTrue(family_labels < labels)
        self.assertGreater(len(labels), len(ana.FAMILIES) * 2)

    def test_a_hardcore_track_reads_as_hardcore(self):
        style, conf, arch, weights = ana.classify(
            feats(
                bpm=174, bpm_confidence=0.95, pulse=0.85, centroid=2500,
                flatness=0.6, flatness_hi=0.75, entropy=0.7, rolloff=6000,
                lra=4.0, flux_peak=1.8,
            )
        )
        self.assertEqual(style, "hardcore")
        self.assertEqual(arch, "hard")
        self.assertGreater(conf, 0)
        self.assertGreater(weights["hard"], 0.5)

    def test_a_syncopated_174_groove_reads_as_drum_and_bass(self):
        style, _conf, arch, _w = ana.classify(
            feats(
                bpm=174, bpm_confidence=0.95, pulse=0.5, centroid=1500,
                flatness=0.4, flatness_hi=0.5, entropy=0.4, rolloff=5000,
                lra=6.0, flux_peak=2.0,
            )
        )
        self.assertEqual(style, "dnb")
        self.assertEqual(arch, "groove")

    def test_a_bright_four_on_the_floor_reads_as_a_groove(self):
        _style, _conf, arch, weights = ana.classify(
            feats(
                bpm=124, bpm_confidence=0.95, pulse=0.8, centroid=3000,
                flatness=0.35, flatness_hi=0.4, entropy=0.5, rolloff=8000,
                lra=6.0, flux_peak=1.3,
            )
        )
        self.assertEqual(arch, "groove")
        self.assertGreater(weights["groove"], weights["hard"])

    def test_a_memphis_808_track_reads_as_phonk(self):
        style, _conf, arch, _w = ana.classify(
            feats(
                bpm=150, bpm_confidence=0.9, pulse=0.5, centroid=1800,
                flatness=0.5, flatness_hi=0.6, entropy=0.5, rolloff=4000,
                lra=4.5, flux_peak=1.8,
            )
        )
        self.assertEqual(style, "phonk")
        self.assertEqual(arch, "groove")

    def test_a_sustained_string_section_stays_sustained(self):
        _style, _conf, arch, weights = ana.classify(
            feats(
                bpm=0, bpm_confidence=0.0, pulse=0.05, centroid=1200,
                flatness=0.14, flatness_hi=0.2, entropy=0.3, rolloff=2600,
                lra=14.0, flux_peak=1.1,
            )
        )
        self.assertEqual(arch, "sustain")
        self.assertGreater(weights["sustain"], 0.6)


if __name__ == "__main__":
    unittest.main()
