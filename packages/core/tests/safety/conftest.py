"""Shared helpers for the guard, lexicon and fixture tests: spec text and a stand-in subject instruction.

The subject prompt files land in WP-10. Until then the G6 reference set is the S2 6.3-6.6 instruction text as
the spec writes it (base text, both role blocks, both policy blocks and every style line), which is what those
files will contain; the tests that use it read it from the spec, so they cannot drift from it.
"""

from __future__ import annotations

import re
from pathlib import Path

from arena_core.fixtures import injection

STYLE_LEVELS = 11  # S2 6.6 has eleven axis levels
SPEC_S2 = Path(__file__).resolve().parents[4] / "docs" / "spec" / "S2-agents-and-prompts.md"


def spec_section(number: str) -> str:
    """The body of S2 section `number` (for example "6.9"), up to the next heading of any level 2 or 3."""
    text = SPEC_S2.read_text(encoding="utf-8")
    marker = f"### {number} " if "." in number else f"## {number}. "
    return re.split(r"\n#{2,3} ", text.split(marker, 1)[1], maxsplit=1)[0]


def reference_instruction() -> str:
    """S2 6.3's base text, 6.4's role blocks, 6.5's policy blocks and 6.6's style lines, as one string."""
    blocks: list[str] = []
    for number in ("6.3", "6.4", "6.5"):
        blocks.extend(re.findall(r"```text\n(.*?)```", spec_section(number), flags=re.DOTALL))
    style = re.findall(r'^\| [a-z]+ \| [a-z_]+ \| "(.+)" \|$', spec_section("6.6"), flags=re.MULTILINE)
    assert len(style) == STYLE_LEVELS
    return "\n".join([*blocks, *style])


def injection_answer(fixture_id: str) -> str:
    """The subject answer at the first injected turn of an FX-INJ fixture (the pipeline-path input)."""
    injected, _control = injection.build(fixture_id)
    first = min(injection.injected_turns(fixture_id))
    return str(injected["exchanges"][first - 1]["answer"])
