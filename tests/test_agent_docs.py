"""The agents' notes stay usable: CLAUDE.md short, every area file reachable.

CLAUDE.md is loaded into every agent session whole. It grew to 270 KB of area
detail, which crowded out the task itself; the detail now lives in
docs/agents/, one file per area, read on demand. These checks keep it that way.
"""

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENTS_DIR = os.path.join(ROOT, "docs", "agents")


class AgentDocsTestCase(unittest.TestCase):
    def read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
            return f.read()

    def test_claude_md_stays_short(self):
        size = len(self.read("CLAUDE.md").encode("utf-8"))
        self.assertLess(size, 16 * 1024, "area detail belongs in docs/agents/")

    def test_agents_md_is_the_same_file(self):
        self.assertEqual(self.read("AGENTS.md"), self.read("CLAUDE.md"))

    def test_every_area_file_is_listed_and_exists(self):
        text = self.read("CLAUDE.md")
        linked = set(re.findall(r"\(docs/agents/([a-z0-9-]+\.md)\)", text))
        present = {f for f in os.listdir(AGENTS_DIR) if f.endswith(".md")}
        self.assertEqual(linked - present, set(), "a link points at no file")
        self.assertEqual(present - linked, set(), "an area file nobody is told to read")

    def test_relative_links_between_area_files_resolve(self):
        for name in os.listdir(AGENTS_DIR):
            text = self.read("docs", "agents", name)
            for target in re.findall(r"\]\(([^)#:]+\.md)\)", text):
                path = os.path.normpath(os.path.join(AGENTS_DIR, target))
                self.assertTrue(os.path.exists(path), f"{name} -> {target}")


if __name__ == "__main__":
    unittest.main()
