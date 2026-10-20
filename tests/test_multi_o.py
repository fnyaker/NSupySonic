# This file is part of Supysonic.
# Supysonic is a Python implementation of the Subsonic server API.
#
# Distributed under terms of the GNU AGPLv3 license.

"""Lot O of the multi-provider plan: the genre hierarchy.

The tree (genre_parent, genre_alias), the module that answers from memory, the
default data, the head's decision climbing it, the studio's ranking and the
routes. An existing server upgrades with its tags, labels and verdicts intact:
with the default tree and no edit, every verdict served is the one it always
was.
"""

import base64
import json
import math
import os
import random
import shutil
import sqlite3
import struct
import tempfile
import unittest

from supysonic import db as dbmod
from supysonic import genretree
from supysonic.config import DefaultConfig
from supysonic.db import (
    GenreAlias,
    GenreParent,
    GenreTag,
    Meta,
    TrackTag,
    init_database,
    release_database,
)
from supysonic.deezer import analysis as ana
from supysonic.deezer import genre as gen
from supysonic.deezer import genre_tree
from supysonic.managers.user import UserManager
from supysonic.web import create_application

from .test_deezer import count_statements

FAMILIES_JSON = os.path.join(
    os.path.dirname(__file__), "..", "webapp", "test", "data", "genre-families.json"
)


def families_before():
    """label -> engine family id, as the player's style.js#genreOf resolved
    every label of the vocabulary before the tree existed (the same file the
    webapp test holds genreOf to)."""
    with open(FAMILIES_JSON, encoding="utf-8") as fp:
        return json.load(fp)


class _Db(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "t.db")
        self.uri = "sqlite:///" + self.path
        init_database(self.uri)
        genretree.invalidate()

    def tearDown(self):
        genretree.invalidate()
        release_database()
        shutil.rmtree(self.dir, ignore_errors=True)

    def tags(self, *names):
        return {n: GenreTag.create(name=n) for n in names}


class DefaultDataTestCase(unittest.TestCase):
    def test_every_vocabulary_label_has_a_parent_or_is_a_declared_root(self):
        placed = {c for c, _p, _w in genre_tree.TREE}
        for label, _arch in ana.known_genres():
            self.assertTrue(label in placed or label in genre_tree.ROOTS, label)

    def test_every_link_names_a_real_genre_and_a_sane_weight(self):
        names = {n for n, _a in ana.known_genres()} | set(genre_tree.UMBRELLAS)
        for child, parent, weight in genre_tree.TREE:
            self.assertIn(child, names)
            self.assertIn(parent, names)
            self.assertTrue(0 < weight <= 1, (child, parent))
        self.assertEqual(len(genre_tree.TREE), len({(c, p) for c, p, _w in genre_tree.TREE}))

    def test_the_default_tree_has_no_cycle(self):
        up = {}
        for c, p, _w in genre_tree.TREE:
            up.setdefault(c, set()).add(p)

        def reaches(start, target):
            stack, seen = [start], set()
            while stack:
                n = stack.pop()
                if n == target:
                    return True
                if n not in seen:
                    seen.add(n)
                    stack.extend(up.get(n, ()))
            return False

        for c, p, _w in genre_tree.TREE:
            self.assertFalse(reaches(p, c), (c, p))

    def test_the_nearest_engine_family_of_every_label_is_the_one_the_player_resolved(self):
        """The whole point of "verdicts unchanged": the tree's family is
        genreOf's family, label for label."""
        genretree.invalidate()
        want = families_before()
        labels = [n for n, _a in ana.known_genres()]
        self.assertEqual(set(want), set(labels))
        for label in labels:
            self.assertEqual(genretree.family_of(label), want[label], label)

    def test_the_owner_s_own_example(self):
        genretree.invalidate()
        self.assertEqual(genretree.ancestors("Frenchcore")[:2], ["Hardcore", "Hard dance"])
        self.assertIn("Techno", genretree.ancestors("Frenchcore"))
        self.assertIn("Frenchcore", genretree.descendants("Techno"))
        self.assertEqual(genretree.lca("Frenchcore", "Speedcore"), "Hardcore")
        # Two parents: hardtekk is under hardcore and under tribe (tekno).
        self.assertEqual(genretree.family_of("Tekk"), "hardtekk")
        self.assertLess(genretree.distance("Frenchcore", "Speedcore"), genretree.distance("Frenchcore", "Jazz / acoustique"))
        self.assertEqual(genretree.distance("Frenchcore", "Frenchcore"), 0.0)
        self.assertEqual(genretree.distance("Frenchcore", "Jazz / acoustique"), 1.0)
        self.assertEqual(genretree.distance("nope", "Techno"), 1.0)


class WebappCopyTestCase(unittest.TestCase):
    def test_the_players_static_shelves_are_the_default_tree_s(self):
        import re

        path = os.path.join(os.path.dirname(__file__), "..", "webapp", "src", "lib", "genretree.js")
        with open(path, encoding="utf-8") as fp:
            m = re.search(r"/\*edges\*/ (\[.*?\]) /\*end\*/", fp.read(), re.S)
        static = [tuple(e) for e in json.loads(m.group(1))]
        want = [(c, p, w) for c, p, w in genre_tree.TREE if c in genre_tree.UMBRELLAS]
        self.assertEqual(static, want)


class TreeTestCase(_Db):
    def test_questions_on_a_small_graph(self):
        t = self.tags("A", "B", "C", "D", "E")
        genretree.add_parent("B", "A")
        genretree.add_parent("C", "B")
        genretree.add_parent("D", "A", 0.5)
        genretree.add_parent("D", "C", 0.8)
        self.assertEqual(genretree.ancestors("C"), ["B", "A"])
        self.assertEqual(genretree.ancestors("D"), ["C", "A", "B"])
        self.assertEqual(set(genretree.descendants("A")), {"B", "C", "D"})
        self.assertEqual(genretree.lca("C", "D"), "C")
        self.assertEqual(genretree.lca("B", "D"), "B")
        self.assertEqual(genretree.lca("D", "C"), "C")  # the second one is the ancestor
        self.assertEqual(genretree.lca("B", "E"), None)
        # a weight-1 link costs the floor, a weak one costs 1 - weight
        self.assertAlmostEqual(genretree.distance("B", "A"), genretree.MIN_EDGE)
        # D-C 0.2 + C-B 0.1 + B-A 0.1 beats the direct 0.5 link
        self.assertAlmostEqual(genretree.distance("D", "A"), 0.4)
        self.assertEqual(genretree.distance("E", "A"), 1.0)

    def test_the_weight_is_what_makes_a_path_long(self):
        self.tags("A", "B")
        genretree.add_parent("B", "A", 0.2)
        near = genretree.distance("A", "B")
        genretree.add_parent("B", "A", 1.0)
        self.assertLess(genretree.distance("A", "B"), near)

    def test_a_cycle_is_refused_and_nothing_is_written(self):
        self.tags("A", "B", "C")
        genretree.add_parent("B", "A")
        genretree.add_parent("C", "B")
        v = genretree.version()
        for child, parent in (("A", "C"), ("A", "A"), ("A", "B")):
            with self.assertRaises(genretree.CycleError):
                genretree.add_parent(child, parent)
        with self.assertRaises(genretree.CycleError):
            genretree.move("A", "C")
        self.assertEqual(genretree.version(), v)
        self.assertEqual(GenreParent.select().count(), 2)

    def test_bad_input_is_refused(self):
        self.tags("A", "B")
        for w in (0, -1, 1.5, "x", None, float("nan")):
            with self.assertRaises(ValueError):
                genretree.add_parent("B", "A", w)
        with self.assertRaises(KeyError):
            genretree.add_parent("B", "nope")

    def test_undo_takes_the_last_write_back_one_at_a_time(self):
        self.tags("A", "B", "C")
        genretree.add_parent("B", "A")
        genretree.add_parent("C", "A", 0.7)
        genretree.move("C", "B", 1.0)
        self.assertEqual(genretree.ancestors("C"), ["B", "A"])
        self.assertTrue(genretree.undo())  # the move
        edges = {(r.child.name, r.parent.name): r.weight for r in GenreParent.select()}
        self.assertEqual(edges, {("B", "A"): 1.0, ("C", "A"): 0.7})
        self.assertTrue(genretree.undo())  # C's edge to A
        self.assertTrue(genretree.undo())  # B's edge to A
        self.assertEqual(GenreParent.select().count(), 0)
        self.assertFalse(genretree.undo())
        self.assertFalse(genretree.can_undo())

    def test_undoing_a_weight_change_restores_the_old_weight(self):
        self.tags("A", "B")
        genretree.add_parent("B", "A", 0.4)
        genretree.add_parent("B", "A", 0.9)
        genretree.undo()
        self.assertEqual(GenreParent.get().weight, 0.4)

    def test_the_undo_log_is_bounded(self):
        names = [f"G{i}" for i in range(genretree.LOG_MAX + 8)]
        self.tags("Root", *names)
        for n in names:
            genretree.add_parent(n, "Root")
        keys = [m.key for m in Meta.select().where(Meta.key.startswith(genretree.LOG_PREFIX))]
        self.assertEqual(len(keys), genretree.LOG_MAX)

    def test_removing_a_genre_lifts_its_children_to_its_parents(self):
        self.tags("Top", "Mid", "Leaf", "Other")
        genretree.add_parent("Mid", "Top", 0.8)
        genretree.add_parent("Leaf", "Mid", 0.5)
        genretree.add_parent("Other", "Mid", 1.0)
        genretree.remove_node("Mid")
        GenreTag.get(GenreTag.name == "Mid").delete_instance()
        genretree.invalidate()
        self.assertEqual(genretree.ancestors("Leaf"), ["Top"])
        self.assertEqual(GenreParent.get(GenreParent.child == GenreTag.get(GenreTag.name == "Leaf")).weight, 0.4)
        self.assertEqual(genretree.ancestors("Other"), ["Top"])

    def test_a_tag_with_no_place_is_a_root(self):
        self.tags("Alone")
        genretree.seed_tree()  # what the studio's first visit does
        genretree.bump()
        self.assertIn("Alone", genretree.roots())
        self.assertEqual(genretree.ancestors("Alone"), [])

    def test_aliases_fold_case_and_accents(self):
        t = self.tags("Drum & bass")
        genretree.bump()
        # not seeded yet: only the default data answers; seed so the DB answers
        genretree.seed_tree()
        GenreAlias.create(name=genretree.fold("Jungle Électro"), genre=GenreTag.get(GenreTag.name == "Drum & bass"))
        genretree.bump()
        self.assertEqual(genretree.alias("JUNGLE electro"), "Drum & bass")
        self.assertIsNone(genretree.alias("zzz"))
        self.assertEqual(genretree.alias("drum & BASS"), "Drum & bass")

    def test_reading_the_tree_costs_no_statement_once_it_is_loaded(self):
        self.tags("A", "B", "C")
        genretree.add_parent("B", "A")
        genretree.add_parent("C", "B")
        genretree.invalidate()
        genretree.get()
        with count_statements() as stmts:
            for _ in range(50):
                genretree.ancestors("C")
                genretree.descendants("A")
                genretree.family_of("C")
                genretree.lca("C", "B")
                genretree.distance("C", "A")
                genretree.alias("b")
        self.assertEqual(sum(stmts.values()), 0, stmts)

    def test_a_write_in_another_process_is_noticed_when_the_recheck_comes(self):
        self.tags("A", "B")
        genretree.add_parent("B", "A")
        genretree.get()
        # another process: the row and the version move behind this cache's back
        conn = sqlite3.connect(self.path)
        conn.execute("DELETE FROM genre_parent")
        conn.execute("UPDATE meta SET value = '99' WHERE key = ?", (genretree.VERSION_KEY,))
        conn.commit()
        conn.close()
        self.assertEqual(genretree.ancestors("B"), ["A"])  # still inside the window
        genretree._cache["at"] -= genretree.RECHECK + 1
        self.assertEqual(genretree.ancestors("B"), [])
        self.assertEqual(genretree.version(), "99")


class SeedTestCase(_Db):
    def vocabulary(self):
        gen.seed_default_tags(force=True)
        genretree.seed_tree()

    def test_a_server_that_was_never_seeded_is_answered_by_the_default_data(self):
        # tags exist (the old vocabulary seed), no edge row, no marker
        self.tags(*[n for n, _a in ana.known_genres()])
        self.assertEqual(GenreParent.select().count(), 0)
        self.assertTrue(genretree.get().virtual)
        self.assertEqual(genretree.family_of("Gabber"), "hardcore")

    def test_seeding_writes_the_default_tree_once(self):
        self.vocabulary()
        n = GenreParent.select().count()
        self.assertEqual(n, len(genre_tree.TREE))
        self.assertTrue(GenreTag.select().where(GenreTag.name == "Hard dance").exists())
        self.assertFalse(genretree.get().virtual)
        v = genretree.version()
        self.assertEqual(genretree.seed_tree(), 0)
        self.assertEqual(genretree.version(), v)
        self.assertEqual(GenreParent.select().count(), n)

    def test_the_tree_read_from_rows_answers_like_the_default_data(self):
        self.tags(*[n for n, _a in ana.known_genres()])
        genretree.invalidate()
        virtual = {n: genretree.family_of(n) for n, _a in ana.known_genres()}
        self.vocabulary()
        genretree.invalidate()
        self.assertFalse(genretree.get().virtual)
        seeded = {n: genretree.family_of(n) for n, _a in ana.known_genres()}
        self.assertEqual(seeded, virtual)

    def test_a_genre_the_person_moved_is_never_put_back(self):
        self.vocabulary()
        genretree.move("Frenchcore", "Techno")
        genretree.remove_parent("Pieep", "Hardtekk")
        # a later release of the data
        original = genre_tree.TREE_VERSION
        genre_tree.TREE_VERSION = original + 1
        try:
            self.assertEqual(genretree.seed_tree(), 0)
        finally:
            genre_tree.TREE_VERSION = original
        self.assertEqual(genretree.ancestors("Frenchcore")[0], "Techno")
        self.assertNotIn("Hardcore", genretree.ancestors("Frenchcore")[:1])
        self.assertEqual(genretree.ancestors("Pieep"), [])

    def test_a_new_release_adds_what_is_new_and_only_that(self):
        self.vocabulary()
        before = GenreParent.select().count()
        GenreParent.delete().where(
            GenreParent.child == GenreTag.get(GenreTag.name == "Goa")
        ).execute()
        original = genre_tree.TREE_VERSION
        genre_tree.TREE_VERSION = original + 1
        try:
            self.assertEqual(genretree.seed_tree(), 1)  # Goa was nobody's choice
        finally:
            genre_tree.TREE_VERSION = original
        self.assertEqual(GenreParent.select().count(), before)

    def test_a_deleted_genre_stays_deleted(self):
        self.vocabulary()
        GenreTag.get(GenreTag.name == "Goa").delete_instance()
        original = genre_tree.TREE_VERSION
        genre_tree.TREE_VERSION = original + 1
        try:
            genretree.seed_tree()
        finally:
            genre_tree.TREE_VERSION = original
        self.assertFalse(GenreTag.select().where(GenreTag.name == "Goa").exists())

    def test_the_tags_and_labels_of_the_person_survive_seeding(self):
        mine = GenreTag.create(name="Zaagcore", color="#123456", archetype="hard")
        GenreTag.create(name="Frenchcore", color="#abcdef", archetype="hard")
        self.vocabulary()
        mine = GenreTag.get(GenreTag.id == mine.id)
        self.assertEqual((mine.color, mine.archetype), ("#123456", "hard"))
        self.assertEqual(GenreTag.get(GenreTag.name == "Frenchcore").color, "#abcdef")
        self.assertIn("Zaagcore", genretree.roots())

    def test_reset_puts_the_default_tree_back_and_keeps_the_tags(self):
        self.vocabulary()
        genretree.move("Frenchcore", None)
        genretree.add_parent("Frenchcore", "Techno", 0.3)
        mine = GenreTag.create(name="Mine")
        genretree.reset_tree()
        self.assertEqual(GenreParent.select().count(), len(genre_tree.TREE))
        self.assertEqual(genretree.ancestors("Frenchcore")[0], "Hardcore")
        self.assertTrue(GenreTag.select().where(GenreTag.id == mine.id).exists())
        self.assertFalse(genretree.can_undo())


class DecideTestCase(_Db):
    """The head hesitating, under a stored head."""

    def head(self, labels, probs, families):
        """Store a 1-wide head whose answer to [1.0] is ``probs``."""
        from supysonic.db import GenreModel

        logits = [math.log(p) for p in probs]
        flat = logits + [0.0] * len(labels)
        GenreModel.update(active=False).execute()
        GenreModel.create(
            version=1, active=True, kind="linear", dim=1, labels=json.dumps(labels),
            weights=base64.b64encode(struct.pack(f"<{len(flat)}e", *flat)).decode("ascii"),
            metrics=json.dumps({"families": families}), hidden=0,
        )
        gen.invalidate()

    def setUp(self):
        super().setUp()
        gen.seed_default_tags(force=True)
        genretree.seed_tree()
        genretree.invalidate()

    def tearDown(self):
        gen.invalidate()
        super().tearDown()

    def decide(self, **kw):
        return gen.decide([1.0], ana.MODEL_MIN_CONFIDENCE, ana.MODEL_MIN_MARGIN)

    def test_siblings_still_give_their_family_exactly_as_before(self):
        self.head(["Rawstyle", "Rawphase", "Techno"], [0.45, 0.40, 0.15],
                  {"Rawstyle": "rawstyle", "Rawphase": "rawstyle", "Techno": "techno"})
        v = self.decide()
        self.assertEqual((v["style"], v["level"]), ("rawstyle", "family"))
        self.assertAlmostEqual(v["conf"], 0.85, places=2)

    def test_two_families_under_one_parent_give_the_parent(self):
        """Frenchcore 0.45 / Speedcore 0.40: 85% sure of hardcore, which the head
        has no label for at all."""
        self.head(["Frenchcore", "Speedcore", "Jazz / acoustique"], [0.45, 0.40, 0.15],
                  {"Frenchcore": "frenchcore", "Speedcore": "speedcore", "Jazz / acoustique": "jazz"})
        v = self.decide()
        self.assertEqual((v["style"], v["level"]), ("hardcore", "ancestor"))
        self.assertAlmostEqual(v["conf"], 0.85, places=2)

    def test_it_climbs_to_a_shelf_that_is_not_an_engine_family(self):
        self.head(["Frenchcore", "Rawstyle", "Jazz / acoustique"], [0.40, 0.38, 0.22],
                  {"Frenchcore": "frenchcore", "Rawstyle": "rawstyle", "Jazz / acoustique": "jazz"})
        v = self.decide()
        self.assertEqual((v["style"], v["level"]), ("Hard dance", "ancestor"))

    def test_the_smallest_ancestor_that_passes_wins(self):
        self.head(["Frenchcore", "Speedcore", "Rawstyle"], [0.40, 0.38, 0.22],
                  {"Frenchcore": "frenchcore", "Speedcore": "speedcore", "Rawstyle": "rawstyle"})
        v = self.decide()
        # hardcore (0.78) passes before the shelf above it (1.0) is looked at
        self.assertEqual(v["style"], "hardcore")

    def test_an_ancestor_that_does_not_pass_the_gate_says_nothing(self):
        self.head(["Frenchcore", "Speedcore", "Jazz / acoustique", "House"], [0.22, 0.20, 0.30, 0.28],
                  {"Frenchcore": "frenchcore", "Speedcore": "speedcore", "Jazz / acoustique": "jazz", "House": "house"})
        self.assertIsNone(self.decide())

    def test_a_rival_as_big_as_the_parent_blocks_it(self):
        self.head(["Frenchcore", "Speedcore", "House", "Jazz / acoustique"], [0.27, 0.20, 0.40, 0.13],
                  {"Frenchcore": "frenchcore", "Speedcore": "speedcore", "House": "house", "Jazz / acoustique": "jazz"})
        # hardcore is 0.47 but house is 0.40: no margin. Électronique (0.87) would
        # pass, but a root is a whole continent and is never served.
        self.assertIsNone(self.decide())

    def test_moving_a_genre_in_the_tree_moves_what_the_head_serves(self):
        self.head(["Frenchcore", "Speedcore", "Jazz / acoustique"], [0.45, 0.40, 0.15],
                  {"Frenchcore": "frenchcore", "Speedcore": "speedcore", "Jazz / acoustique": "jazz"})
        self.assertEqual(self.decide()["style"], "hardcore")
        genretree.move("Speedcore", None)
        self.assertIsNone(self.decide())

    def test_the_tree_decides_the_family_not_the_head_s_old_table(self):
        shipped = {"Gabber": "hardcore", "Makina": "hardcore", "Jazz / acoustique": "jazz"}
        self.head(["Gabber", "Makina", "Jazz / acoustique"], [0.45, 0.40, 0.15], shipped)
        v = self.decide()
        self.assertEqual((v["style"], v["level"]), ("hardcore", "family"))
        genretree.move("Makina", "Hardstyle")  # the person says it is a hardstyle
        v = self.decide()
        self.assertEqual((v["style"], v["level"]), ("Hard dance", "ancestor"))

    def test_a_head_that_shipped_no_families_stays_quiet_as_it_always_did(self):
        self.head(["Frenchcore", "Speedcore"], [0.5, 0.5], {})
        self.assertIsNone(self.decide())

    def test_every_decision_of_an_unmodified_server_is_the_one_it_always_was(self):
        """The old decision, written out, against the new one on 400 random
        heads over the real vocabulary and the player's own family table: the
        family step and the label step answer identically, the tree seeded or
        not. (What may differ is only a decision the old code did not take: a
        None that becomes an "ancestor".)"""
        want = families_before()
        labels = sorted(want)
        rng = random.Random(1021)

        def old(dist, min_conf, min_margin):
            mass, loners = {}, []
            for lab, p in dist.items():
                fam = want.get(lab)
                if fam is None:
                    loners.append(p)
                else:
                    mass[fam] = mass.get(fam, 0.0) + p
            if not mass:
                return None
            ranked = sorted(mass.items(), key=lambda kv: kv[1], reverse=True)
            fam, top = ranked[0]
            second = max([ranked[1][1] if len(ranked) > 1 else 0.0] + loners)
            if top >= min_conf and top - second >= min_margin:
                return fam
            return None

        for seeded in (False, True):
            if not seeded:
                # an upgraded server nobody has opened the studio on
                GenreParent.delete().execute()
                Meta.delete().where(Meta.key == genretree.SEEDED_KEY).execute()
            else:
                genretree.seed_tree()
            genretree.invalidate()
            self.assertEqual(genretree.get().virtual, not seeded)
            same = changed = 0
            for _ in range(400):
                pick = rng.sample(labels, rng.choice([2, 3, 4, 6]))
                raw = [rng.random() ** 2 + 0.02 for _ in pick]
                total = sum(raw)
                probs = [r / total for r in raw]
                self.head(pick, probs, {l: want[l] for l in pick})
                guess = gen.predict([1.0])
                v = gen.decide([1.0], ana.MODEL_MIN_CONFIDENCE, ana.MODEL_MIN_MARGIN)
                fam = old(guess[2], ana.MODEL_MIN_CONFIDENCE, ana.MODEL_MIN_MARGIN)
                label_ok = guess[1] >= ana.MODEL_MIN_CONFIDENCE and guess[3] >= ana.MODEL_MIN_MARGIN
                if label_ok:
                    self.assertEqual((v["style"], v["level"]), (guess[0], "label"))
                elif fam is not None:
                    self.assertEqual((v["style"], v["level"]), (fam, "family"))
                    same += 1
                elif v is not None:
                    self.assertEqual(v["level"], "ancestor")
                    changed += 1
            self.assertGreater(same, 5)

    def test_the_analysis_serves_the_ancestor_with_its_archetype(self):
        from supysonic.deezer import library

        self.head(["Frenchcore", "Speedcore", "Jazz / acoustique"], [0.45, 0.40, 0.15],
                  {"Frenchcore": "frenchcore", "Speedcore": "speedcore", "Jazz / acoustique": "jazz"})
        track = _track(self)
        feats = {"centroid": 2000.0, "rolloff": 6000.0, "spread": 1000.0, "flatness": 0.2,
                 "entropy": 0.5, "flux_peak": 2.0, "lufs": -9.0, "lra": 5.0, "pulse": 0.6,
                 "bpm": 200.0, "bpm_confidence": 0.8}
        out = ana._decide_style(track, feats, [1.0])
        self.assertEqual((out["style"], out["source"], out["level"]), ("hardcore", "model", "ancestor"))
        self.assertEqual(out["arch"], ana._FAMILY_ARCH["hardcore"])


def _track(case):
    from supysonic.deezer import library

    archive = os.path.join(case.dir, "archive")
    os.makedirs(archive, exist_ok=True)
    root = library.get_root_folder(archive)
    return library.upsert_track(
        {"SNG_ID": "7001", "SNG_TITLE": "T", "ART_NAME": "A", "ART_ID": "5", "ALB_TITLE": "B",
         "ALB_ID": "6", "DURATION": "200", "TRACK_NUMBER": "1", "DISK_NUMBER": "1"},
        root,
    )


class RankTestCase(_Db):
    def test_the_siblings_and_the_parent_of_the_last_choice_rise(self):
        gen.seed_default_tags(force=True)
        genretree.seed_tree()
        genretree.invalidate()
        guess = ("Zaag", 0.3, {"Zaag": 0.3, "House": 0.17, "Speedcore": 0.15, "Jazz / acoustique": 0.05}, 0.0)
        plain = [r[0] for r in gen.rank_scores(guess, None)]
        lifted = gen.rank_scores(guess, None, last="Frenchcore")
        names = [r[0] for r in lifted]
        # Frenchcore's parent (Hardcore) joins; its sibling Speedcore passes House
        self.assertLess(plain.index("House"), plain.index("Speedcore"))
        self.assertLess(names.index("Speedcore"), names.index("House"))
        self.assertNotIn("Hardcore", plain)
        score = {r[0]: r[1] for r in lifted}
        self.assertEqual(score["Hardcore"], gen.PARENT_BONUS)
        self.assertGreater(score["Hardcore"], score["Jazz / acoustique"])
        self.assertEqual(gen.rank_scores(guess, None), gen.rank_scores(guess, None, last="Nope"))
        self.assertEqual([r[:3] for r in gen.rank_scores(guess, None)], [r[:3] for r in gen.rank_scores(guess, None, last=None)])


class _App(unittest.TestCase):
    def setUp(self):
        self._db = tempfile.mkstemp()
        self._dir = tempfile.mkdtemp()
        db_path, cache = self._db[1], self._dir

        class Config(DefaultConfig):
            TESTING = True

            def __init__(self):
                super().__init__()
                self.BASE = dict(self.BASE, database_uri="sqlite:///" + db_path)
                self.WEBAPP = dict(self.WEBAPP, cache_dir=cache, mount_webui=True, mount_api=True)

        self.app = create_application(Config())
        UserManager.add("alice", "Alic3", admin=True)
        UserManager.add("bob", "B0bbb", admin=False)
        self.client = self.app.test_client()
        from supysonic.webui import genre as wg

        genretree.invalidate()
        gen.invalidate()
        self.relabels = []
        self._spawn = wg._spawn
        wg._spawn = lambda fn, *args: self.relabels.append(args)
        with wg._relabel_lock:
            wg._relabel_job.update(running=False, again=False, error=None)

    def tearDown(self):
        from supysonic.webui import genre as wg

        wg._spawn = self._spawn
        with wg._relabel_lock:
            wg._relabel_job.update(running=False, again=False)
        genretree.invalidate()
        gen.invalidate()
        release_database()
        shutil.rmtree(self._dir, ignore_errors=True)
        os.close(self._db[0])
        os.remove(self._db[1])

    def login(self, who="alice", pw="Alic3"):
        return self.client.post("/api/login", json={"username": who, "password": pw})

    def store_head(self):
        flat = [math.log(0.6), math.log(0.4), 0.0, 0.0]
        r = self.client.put("/api/genre/model", json={
            "labels": ["Frenchcore", "Speedcore"], "dim": 1, "kind": "linear",
            "weights": base64.b64encode(struct.pack("<4e", *flat)).decode("ascii"),
            "metrics": {"families": {"Frenchcore": "frenchcore", "Speedcore": "speedcore"}},
        })
        self.assertEqual(r.status_code, 200, r.data)
        self.relabels.clear()
        from supysonic.webui import genre as wg

        with wg._relabel_lock:
            wg._relabel_job.update(running=False, again=False)


class RoutesTestCase(_App):
    def test_reading_the_tree_is_for_anyone_logged_in_writing_is_the_admin_s(self):
        self.assertEqual(self.client.get("/api/genre/tree").status_code, 401)
        self.login("bob", "B0bbb")
        r = self.client.get("/api/genre/tree")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json["default"])  # nobody seeded it: the data itself
        self.assertEqual(r.headers["X-NS-Tree"], "default")
        for method, path in (
            ("post", "/api/genre/tree/edge"), ("patch", "/api/genre/tree/edge"),
            ("delete", "/api/genre/tree/edge"), ("post", "/api/genre/tree/move"),
            ("post", "/api/genre/tree/undo"), ("post", "/api/genre/tree/reset"),
        ):
            self.assertEqual(getattr(self.client, method)(path, json={}).status_code, 403, path)
        self.assertEqual(GenreParent.select().count(), 0)

    def test_the_admin_s_first_read_seeds_the_tree(self):
        self.login()
        body = self.client.get("/api/genre/tree").json
        self.assertFalse(body["default"])
        names = {n["name"] for n in body["nodes"]}
        self.assertLessEqual({n for n, _a in ana.known_genres()} | set(genre_tree.UMBRELLAS), names)
        edge = next(e for e in body["edges"] if e["child"] == "Frenchcore" and e["parent"] == "Hardcore")
        self.assertEqual(edge["weight"], 1.0)
        fc = next(n for n in body["nodes"] if n["name"] == "Frenchcore")
        self.assertEqual(fc["family"], "frenchcore")
        self.assertIn("Électronique", body["roots"])

    def test_an_unchanged_tree_is_an_empty_304(self):
        self.login()
        first = self.client.get("/api/genre/tree")
        again = self.client.get("/api/genre/tree", headers={"If-None-Match": first.headers["ETag"]})
        self.assertEqual(again.status_code, 304)
        self.client.post("/api/genre/tree/edge", json={"child": "Frenchcore", "parent": "Techno", "weight": 0.4})
        changed = self.client.get("/api/genre/tree", headers={"If-None-Match": first.headers["ETag"]})
        self.assertEqual(changed.status_code, 200)

    def test_the_read_is_a_handful_of_statements_whatever_the_size(self):
        self.login()
        self.client.get("/api/genre/tree")
        with count_statements() as stmts:
            r = self.client.get("/api/genre/tree")
        self.assertEqual(r.status_code, 200)
        self.assertLessEqual(sum(stmts.values()), 6, stmts)

    def test_an_edit_moves_the_version_tells_the_devices_and_re_decides(self):
        self.login()
        self.client.get("/api/genre/tree")
        self.store_head()
        gen0 = ana.verdict_generation()
        v0 = self.client.get("/api/genre/tree").headers["X-NS-Tree"]
        r = self.client.post("/api/genre/tree/edge", json={"child": "Frenchcore", "parent": "Techno", "weight": 0.4})
        self.assertEqual(r.status_code, 200, r.data)
        self.assertNotEqual(r.json["version"], v0)
        self.assertEqual(ana.verdict_generation(), gen0 + 1)
        self.assertEqual(len(self.relabels), 1)  # the worker was started
        self.assertTrue(any(e["child"] == "Frenchcore" and e["parent"] == "Techno" and e["weight"] == 0.4
                            for e in r.json["edges"]))
        self.assertTrue(r.json["can_undo"])

    def test_without_a_head_there_is_nothing_to_re_decide(self):
        self.login()
        self.client.get("/api/genre/tree")
        self.client.post("/api/genre/tree/edge", json={"child": "Frenchcore", "parent": "Techno"})
        self.assertEqual(self.relabels, [])

    def test_a_cycle_is_a_409_an_unknown_genre_a_404_a_bad_weight_a_400(self):
        self.login()
        self.client.get("/api/genre/tree")
        post = lambda **kw: self.client.post("/api/genre/tree/edge", json=kw)  # noqa: E731
        self.assertEqual(post(child="Hardcore", parent="Frenchcore").status_code, 409)
        self.assertEqual(post(child="Frenchcore", parent="Frenchcore").status_code, 409)
        self.assertEqual(post(child="Frenchcore", parent="Nope").status_code, 404)
        self.assertEqual(post(child="Frenchcore", parent="Techno", weight=7).status_code, 400)
        self.assertEqual(post(child="Frenchcore").status_code, 400)
        self.assertEqual(post(child=["x"], parent="Techno").status_code, 400)
        self.assertEqual(self.client.patch("/api/genre/tree/edge", json={"child": "Frenchcore", "parent": "Techno"}).status_code, 404)

    def test_patch_delete_move_undo_and_reset(self):
        self.login()
        self.client.get("/api/genre/tree")
        fc = lambda body: [e for e in body["edges"] if e["child"] == "Frenchcore"]  # noqa: E731
        r = self.client.patch("/api/genre/tree/edge", json={"child": "Frenchcore", "parent": "Hardcore", "weight": 0.6})
        self.assertEqual(fc(r.json)[0]["weight"], 0.6)
        r = self.client.post("/api/genre/tree/move", json={"child": "Frenchcore", "parent": "Techno"})
        self.assertEqual([(e["parent"], e["weight"]) for e in fc(r.json)], [("Techno", 1.0)])
        r = self.client.delete("/api/genre/tree/edge", json={"child": "Frenchcore", "parent": "Techno"})
        self.assertEqual(fc(r.json), [])
        self.assertIn("Frenchcore", r.json["roots"])
        r = self.client.post("/api/genre/tree/undo")
        self.assertEqual([e["parent"] for e in fc(r.json)], ["Techno"])
        r = self.client.post("/api/genre/tree/reset")
        self.assertEqual([e["parent"] for e in fc(r.json)], ["Hardcore"])
        self.assertFalse(r.json["can_undo"])
        self.assertEqual(self.client.post("/api/genre/tree/undo").status_code, 409)

    def test_a_tag_created_renamed_or_deleted_moves_the_tree_with_it(self):
        self.login()
        self.client.get("/api/genre/tree")
        v0 = self.client.get("/api/genre/tree").headers["X-NS-Tree"]
        tag = self.client.post("/api/genre/tags", json={"name": "Mine"}).json
        body = self.client.get("/api/genre/tree").json
        self.assertNotEqual(body["version"], v0)
        self.assertIn("Mine", body["roots"])
        self.client.post("/api/genre/tree/edge", json={"child": tag["id"], "parent": "Hardcore"})
        child = self.client.post("/api/genre/tags", json={"name": "Kid"}).json
        self.client.post("/api/genre/tree/edge", json={"child": "Kid", "parent": "Mine", "weight": 0.5})
        self.client.patch(f"/api/genre/tags/{tag['id']}", json={"name": "Mine2"})
        body = self.client.get("/api/genre/tree").json
        self.assertIn({"child": "Kid", "parent": "Mine2", "weight": 0.5}, body["edges"])
        self.client.delete(f"/api/genre/tags/{tag['id']}")
        body = self.client.get("/api/genre/tree").json
        self.assertIn({"child": "Kid", "parent": "Hardcore", "weight": 0.5}, body["edges"])
        self.assertNotIn("Mine2", {n["name"] for n in body["nodes"]})

    def test_deleting_a_tag_keeps_the_tracks_of_the_others(self):
        self.login()
        self.client.get("/api/genre/tree")
        a = self.client.post("/api/genre/tags", json={"name": "A1"}).json
        self.client.delete(f"/api/genre/tags/{a['id']}")
        self.assertEqual(TrackTag.select().count(), 0)

    def test_the_candidates_scores_take_the_last_choice(self):
        self.login()
        self.client.get("/api/genre/tree")
        from supysonic.webui import genre as wg

        with self.app.test_request_context("/?last=Frenchcore"):
            rows = wg._scores_json(("Zaag", 0.3, {"Zaag": 0.3, "House": 0.17, "Speedcore": 0.15}, 0.0), None)
        names = [r[0] for r in rows]
        self.assertLess(names.index("Speedcore"), names.index("House"))
        self.assertIn("Hardcore", names)
        with self.app.test_request_context("/"):
            rows = wg._scores_json(("Zaag", 0.3, {"Zaag": 0.3, "House": 0.17, "Speedcore": 0.15}, 0.0), None)
        self.assertNotIn("Hardcore", [r[0] for r in rows])

    def test_the_bulk_preview_compares_an_ancestor_by_the_tree(self):
        """A head sure only of hardcore does not disagree with a Frenchcore tag."""
        self.login()
        self.client.get("/api/genre/tree")
        self.assertTrue(genretree.within("Frenchcore", "hardcore"))
        self.assertTrue(genretree.within("Frenchcore", "Hard dance"))
        self.assertFalse(genretree.within("Frenchcore", "House"))
        self.assertTrue(genretree.within("Frenchcore", "Frenchcore"))


class UpgradeTestCase(_Db):
    """A server at 20261020 with its tags, labels and a head boots on this code."""

    def rewind(self):
        release_database()
        conn = sqlite3.connect(self.path)
        conn.execute("DROP TABLE genre_alias")
        conn.execute("DROP TABLE genre_parent")
        conn.execute("UPDATE meta SET value = '20261020' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()

    def snapshot(self):
        conn = sqlite3.connect(self.path)
        try:
            return {t: conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall()
                    for t in ("genre_tag", "track_tag", "genre_model", "track_analysis", "track")}
        finally:
            conn.close()

    def test_the_tables_are_in_a_fresh_database(self):
        self.assertEqual(Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
        self.assertEqual(GenreParent.select().count(), 0)
        self.assertEqual(GenreAlias.select().count(), 0)
        self.assertLessEqual({"genre_parent", "genre_alias"}, {m._meta.table_name for m in dbmod._migration_order()})

    def test_an_existing_studio_gets_the_tables_and_nothing_else_changes(self):
        gen.seed_default_tags(force=True)  # the old vocabulary
        track = _track(self)
        TrackTag.create(track=track, tag=GenreTag.get(GenreTag.name == "Frenchcore"))
        mine = GenreTag.create(name="Zaagcore", color="#123", archetype="hard")
        self.rewind()
        # a server from before: no tree, no marker, the vocabulary marker present
        conn = sqlite3.connect(self.path)
        conn.execute("DELETE FROM meta WHERE key LIKE 'genre_tree%' OR key LIKE 'gt%:%'")
        conn.commit()
        conn.close()
        before = self.snapshot()
        init_database(self.uri)
        genretree.invalidate()
        self.assertEqual(Meta["schema_version"].value, dbmod.SCHEMA_VERSION)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(GenreParent.select().count(), 0)
        # nobody opened the studio: the default data answers, identically
        self.assertTrue(genretree.get().virtual)
        self.assertEqual(genretree.family_of("Gabber"), "hardcore")
        # the studio is opened: the tree is written and the person's tag is a root
        gen.seed_default_tags()
        self.assertEqual(GenreParent.select().count(), 0)  # the vocabulary alone writes no tree
        genretree.seed_tree()
        self.assertEqual(GenreParent.select().count(), len(genre_tree.TREE))
        self.assertIn("Zaagcore", genretree.roots())
        self.assertEqual(GenreTag.get(GenreTag.id == mine.id).color, "#123")
        self.assertEqual(TrackTag.select().count(), 1)

    def test_running_the_migration_twice_is_harmless(self):
        release_database()
        conn = sqlite3.connect(self.path)
        conn.execute("UPDATE meta SET value = '20261020' WHERE key = 'schema_version'")
        conn.commit()
        conn.close()
        init_database(self.uri)
        self.assertEqual(Meta["schema_version"].value, dbmod.SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
