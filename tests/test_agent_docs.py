"""The agents' notes stay usable: CLAUDE.md short, every area file reachable.

CLAUDE.md is loaded into every agent session whole. It grew to 270 KB of area
detail, which crowded out the task itself; the detail now lives in
docs/agents/, one file per area, read on demand. These checks keep it that way.

The OpenCode subagents are part of the same contract: opencode.json names them,
every one points at a prompt that exists, and the prompt is told to read
AGENTS.md. A stale agent config is a subagent that guesses.
"""

import json
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


class OpenCodeAgentsTestCase(unittest.TestCase):
    """The subagent team is declared, documented and points at real prompts."""

    def read(self, *parts):
        with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
            return f.read()

    def config(self):
        return json.loads(self.read("opencode.json"))

    def test_config_is_valid_and_every_agent_is_a_subagent(self):
        config = self.config()
        self.assertEqual(config.get("$schema"), "https://opencode.ai/config.json")
        agents = config.get("agent", {})
        self.assertTrue(agents, "no subagent is declared")
        for name, spec in agents.items():
            self.assertRegex(name, r"^[a-z][a-z0-9-]*$")
            self.assertEqual(spec.get("mode"), "subagent", name)
            self.assertTrue(spec.get("description"), name)
            self.assertEqual(
                spec.get("prompt"),
                f"{{file:./.opencode/prompts/{name}.md}}",
                f"{name} must point at .opencode/prompts/{name}.md",
            )
            self.assertTrue(
                os.path.exists(os.path.join(ROOT, ".opencode", "prompts", f"{name}.md")),
                f"missing prompt for {name}",
            )

    def test_every_prompt_is_used_and_reads_the_process(self):
        agents = self.config()["agent"]
        prompts = {
            os.path.splitext(name)[0]
            for name in os.listdir(os.path.join(ROOT, ".opencode", "prompts"))
            if name.endswith(".md")
        }
        self.assertEqual(prompts - set(agents), set(), "a prompt no agent uses")
        self.assertEqual(set(agents) - prompts, set(), "an agent with no prompt")
        for name in agents:
            text = self.read(".opencode", "prompts", f"{name}.md")
            self.assertIn("AGENTS.md", text, f"{name} is not told to read the process")
            self.assertIn("docs/agents/", text, f"{name} is not told to read its area note")

    def test_every_agent_is_documented(self):
        names = set(self.config()["agent"])
        claude = self.read("CLAUDE.md")
        orchestration = self.read("docs", "agents", "orchestration.md")
        for name in names:
            self.assertIn(f"`{name}`", claude, f"{name} is missing from CLAUDE.md")
            self.assertIn(f"`{name}`", orchestration, f"{name} is missing from orchestration.md")

    def test_security_agent_is_read_only_by_default(self):
        security = self.config()["agent"]["security"]
        self.assertIn(
            security.get("permission", {}).get("edit"),
            ("ask", "deny"),
            "security must not edit without an explicit approval",
        )
        for name, spec in self.config()["agent"].items():
            if name == "security":
                continue
            self.assertEqual(
                spec.get("permission", {}).get("edit"),
                "allow",
                f"{name} must be able to do its work",
            )


if __name__ == "__main__":
    unittest.main()
