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

    # The two below are MEASURED: what _spectral and _measure_tempo read on the
    # arranged records of webapp/test/songs.mjs (tools/tempo_eval.py --render
    # writes them). They used to be drawn — flatness 0.6 and entropy 0.7 for a
    # hardcore track — on the scale the rules had been written for, which no
    # file ever reaches here (0.01-0.34): the tests passed and every hard
    # record in the eval came out as jazz or strings.

    def test_a_hardcore_track_reads_as_hardcore(self):
        # gabber-185, measured.
        style, conf, arch, weights = ana.classify(
            feats(
                bpm=185, bpm_confidence=0.95, pulse=0.47, centroid=3600,
                flatness=0.289, flatness_hi=0.431, entropy=0.452, rolloff=8719,
                lra=16.2, flux_peak=8.27,
            )
        )
        self.assertEqual(style, "hardcore")
        self.assertEqual(arch, "hard")
        self.assertGreater(conf, 0)
        self.assertGreater(weights["hard"], 0.5)

    def test_a_syncopated_174_groove_is_not_hardcore(self):
        # dnb-174, measured: a broken beat puts little of the bass on the grid
        # (0.06, against gabber's 0.47) — which is what keeps it out of the
        # hard families that share its tempo. (Naming it drum & bass is the
        # live reading's job: the shares below are all this side can see.)
        _style, _conf, _arch, weights = ana.classify(
            feats(
                bpm=174, bpm_confidence=0.95, pulse=0.06, centroid=3338,
                flatness=0.233, flatness_hi=0.527, entropy=0.316, rolloff=8555,
                lra=14.4, flux_peak=4.35,
            )
        )
        self.assertLess(weights["hard"], 0.5)

    def test_krach_and_uptempo_are_not_a_noise_wall_apart(self):
        # krach-205 and uptempo-dark-210, measured: the same tempo band, and
        # the kick's noise under a sung, euphoric lead (entropy 0.59) against
        # a noise wall of a record (0.78). Krach used to be written as the
        # noise wall — flatness over 0.55, entropy over 0.75 — which is the
        # opposite of the genre.
        krach, _c, arch, _w = ana.classify(
            feats(
                bpm=205, bpm_confidence=0.95, pulse=0.21, centroid=1832,
                flatness=0.166, flatness_hi=0.454, entropy=0.586, rolloff=2930,
                lra=9.2, flux_peak=4.41,
            )
        )
        self.assertEqual((krach, arch), ("krach", "hard"))
        dark, _c, _a, _w = ana.classify(
            feats(
                bpm=210, bpm_confidence=0.95, pulse=0.15, centroid=3278,
                flatness=0.285, flatness_hi=0.503, entropy=0.781, rolloff=7477,
                lra=16.7, flux_peak=4.05,
            )
        )
        self.assertEqual(dark, "uptempo")

    def test_a_confidence_is_backed_by_what_the_rules_found(self):
        # Nothing specific fits a steady 132 BPM pulse with these numbers, and
        # a share of next to nothing used to come out at confidence 1.00.
        _style, conf, _arch, _w = ana.classify(
            feats(
                bpm=132, bpm_confidence=0.95, pulse=0.02, centroid=900,
                flatness=0.01, flatness_hi=0.05, entropy=0.05, rolloff=1000,
                lra=2.0, flux_peak=1.0,
            )
        )
        self.assertLess(conf, 0.5)

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


class PublishedTempoTestCase(unittest.TestCase):
    """Deezer's bpm is taken outright — except for its octave.

    It is exact for most of the library, which is why it wins. The exception is
    the half of this catalogue nobody else indexes well: a frenchcore or uptempo
    track at 200 BPM is very often published at 100, and that one number is then
    served to every client, seeded into the live beat tracker as an anchor, and
    used to pick the genre. The file is measured in the same pass anyway, so the
    cross-check costs nothing.
    """

    def test_a_confident_file_doubles_a_halved_figure(self):
        bpm, conf, source = ana._reconcile_octave(100.0, 200.4, 0.8, 0.95, "deezer")
        self.assertEqual(bpm, 200.0)
        self.assertEqual(source, "deezer+octave")
        # ...and says so: the figure is no longer purely Deezer's.
        self.assertLess(conf, 0.95)

    def test_the_published_precision_is_kept(self):
        # Deezer's two decimals beat an eight-second window's, so the answer is
        # the PUBLISHED figure doubled, never the measured one.
        bpm, _conf, _src = ana._reconcile_octave(101.5, 202.9, 0.9, 0.95, "deezer")
        self.assertEqual(bpm, 203.0)

    def test_an_unsure_measurement_changes_nothing(self):
        self.assertEqual(
            ana._reconcile_octave(100.0, 200.4, 0.3, 0.95, "deezer"),
            (100.0, 0.95, "deezer"),
        )

    def test_it_never_halves(self):
        # The measurement's own prior leans low, so it reading half of a
        # published figure says nothing about the published figure.
        self.assertEqual(
            ana._reconcile_octave(200.0, 100.1, 0.95, 0.95, "deezer"),
            (200.0, 0.95, "deezer"),
        )

    def test_it_only_ever_moves_one_octave(self):
        for measured in (300.5, 133.0, 149.0, 260.0):
            bpm, _c, src = ana._reconcile_octave(100.0, measured, 0.95, 0.95, "deezer")
            self.assertEqual(bpm, 100.0, f"{measured} moved the published figure")
            self.assertEqual(src, "deezer")

    def test_it_stays_inside_the_searchable_range(self):
        # Doubling 180 is 360, which no tracker on either side can represent.
        self.assertEqual(
            ana._reconcile_octave(180.0, 360.0, 0.95, 0.95, "deezer"),
            (180.0, 0.95, "deezer"),
        )


if __name__ == "__main__":
    unittest.main()
