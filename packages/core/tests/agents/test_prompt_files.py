"""The prompt files are S2's text (S2 5.2-5.4, 6.3-6.7, 7.2, 7.3, 9.3), carry no case content (S2 3.4) and their
templates name exactly the placeholders the builders fill."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from arena_core.agents.templates import REPO_ROOT, TemplateError, placeholders, read_text, render

SPEC = (REPO_ROOT / "docs/spec/S2-agents-and-prompts.md").read_text(encoding="utf-8")
PROMPTS = REPO_ROOT / "prompts"


def spec_block(name: str) -> str:
    """The first ```text block after the first line that names `name` in backquotes."""
    start = SPEC.index(f"`prompts/{name}`") if f"`prompts/{name}`" in SPEC else SPEC.index(f"`{name}`")
    body = SPEC[start:].split("```text\n", 1)[1].split("\n```", 1)[0]
    return body + "\n"


VERBATIM = [
    "coach/common.v1.txt",
    "coach/a1.strategy.v1.txt",
    "coach/a2.strategy.v1.txt",
    "coach/a3.strategy.v1.txt",
    "coach/final.v1.txt",
    "subject/role.t.v1.txt",
    "subject/role.d.v1.txt",
    "subject/policy.standard.v1.txt",
    "subject/policy.skilled.v1.txt",
    "referee/subject.v1.txt",
]


@pytest.mark.parametrize("name", VERBATIM)
def test_prompt_file_is_the_spec_text(name: str) -> None:
    assert read_text(f"prompts/{name}") == spec_block(name)


def test_referee_assistant_is_the_spec_text_with_the_rubric_placeholder() -> None:
    spec = spec_block("referee/assistant.v1.txt")
    spec = re.sub(r"\{\{for each dimension[^}]*\}\}", "{{rubric_subchecks}}", spec)
    assert read_text("prompts/referee/assistant.v1.txt") == spec


def test_subject_system_and_live_are_the_spec_text_with_one_blocks_placeholder() -> None:
    system = spec_block("subject/system.v1.txt").replace(
        "{{ROLE BLOCK}}\n\n{{POLICY BLOCK}}\n\n{{STYLE BLOCK}}", "{{behavior_blocks}}"
    )
    assert read_text("prompts/subject/system.v1.txt") == system
    live = spec_block("subject/live.v1.txt")
    live = re.sub(
        r"\{\{ROLE BLOCK[^}]*\}\}\n\n\{\{POLICY BLOCK[^}]*\}\}\n\n\{\{STYLE BLOCK[^}]*\}\}", "{{behavior_blocks}}", live
    )
    live = re.sub(r"\{\{FACTS, UNCERTAINTY[^}]*\}\}", "{{ledger}}", live)
    assert read_text("prompts/subject/live.v1.txt") == live


def test_a1_deep_is_the_common_contract_subset_then_the_task() -> None:
    common = read_text("prompts/coach/common.v1.txt").split("\n")
    rules: dict[int, list[str]] = {}
    current = 0
    for line in common[3:]:
        match = re.match(r"^(\d+)\. ", line)
        if match:
            current = int(match.group(1))
            rules[current] = [line]
        elif not line:
            current = 0
        elif current:
            rules[current].append(line)
    sentence = (
        " Your flags in this card will be t{n}.f1, t{n}.f2 and t{n}.f3, in the order you list them, where t{n} is the"
        " turn you are assessing."
    )
    rule9 = "\n".join(rules[9])
    assert sentence in rule9
    head = "\n".join(
        [common[0], "", common[2], *("\n".join(rules[k]) for k in range(1, 6)), rule9.replace(sentence, "")]
    )
    assert read_text("prompts/coach/a1.deep.v1.txt") == f"{head}\n\n{spec_block('prompts/coach/a1.deep.v1.txt')}"


def test_style_table_is_s2_6_6() -> None:
    rows = re.findall(r'^\| (\w+) \| (\w+) \| "(.+)" \|$', SPEC.split("### 6.6", 1)[1].split("### 6.7", 1)[0], re.M)
    table = dict(line.split(": ", 1) for line in read_text("prompts/subject/style.v1.txt").splitlines())
    assert {f"{axis} {level}": text for axis, level, text in rows} == {
        k: v for k, v in table.items() if k not in ("heading", "closing")
    }
    assert (
        table["closing"]
        == "Your speaking style never changes what you know, what you disclose, or which behavior you use."
    )


TEMPLATES = {
    "coach/user.card.v1.txt": {
        "n",
        "turn",
        "salt",
        "case_id",
        "objective",
        "timeline",
        "initial_documents",
        "interview_context",
        "requestable",
        "released_records",
        "transcript",
        "running_finding",
        "flags",
        "deep_update",
    },
    "subject/user.turn.v1.txt": {
        "n",
        "turn",
        "salt",
        "persona.name",
        "persona.position",
        "persona.organization",
        "persona.background",
        "matter",
        "ledger",
        "said_so_far",
        "transcript",
        "question",
    },
    "referee/subject.user.v1.txt": {
        "canonical_facts",
        "ledger",
        "permitted_behaviors",
        "style",
        "salt",
        "records",
        "transcript",
        "last",
    },
    "referee/assistant.user.v1.txt": {
        "salt",
        "case_id",
        "objective",
        "timeline",
        "initial_documents",
        "interview_context",
        "requestable",
        "released_records",
        "transcript",
        "flags",
        "followups",
        "finding",
        "finding_citations",
        "triggers",
    },
}


@pytest.mark.parametrize(("name", "names"), TEMPLATES.items())
def test_template_placeholders(name: str, names: set[str]) -> None:
    assert placeholders(read_text(f"prompts/{name}")) == names


def test_deep_and_final_templates_differ_from_the_card_only_in_the_last_sentence() -> None:
    card = read_text("prompts/coach/user.card.v1.txt").rsplit("\n\n", 1)
    for name, last in [
        ("deep", "Write the deep update as of turn {{turn}}.\n"),
        ("final", "The interview has ended after turn {{turn}}. Write the final finding.\n"),
    ]:
        assert read_text(f"prompts/coach/user.{name}.v1.txt") == f"{card[0]}\n\n{last}"


def test_every_untrusted_block_in_a_template_is_salted_and_closed() -> None:
    for path in sorted(PROMPTS.rglob("user.*.txt")) + sorted(PROMPTS.glob("referee/*.user.v1.txt")):
        text = path.read_text(encoding="utf-8")
        opens = re.findall(r"<untrusted_([a-z]+)_\{\{salt\}\}>", text)
        closes = re.findall(r"</untrusted_([a-z]+)_\{\{salt\}\}>", text)
        assert opens == closes, path.name
        assert not re.search(r"<untrusted_[a-z]+_(?!\{\{salt\}\})", text), path.name


def _grams(text: str, n: int = 8) -> set[tuple[str, ...]]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


def _strings(node: object, path: str = "") -> list[str]:
    if isinstance(node, str):
        return [node]
    if isinstance(node, dict):
        # EX-4 platform text every public packet carries (S2 3.4 allowlist).
        return [s for k, v in node.items() if k not in ("ground_rules", "limits") for s in _strings(v, f"{path}.{k}")]
    if isinstance(node, list):
        return [s for v in node for s in _strings(v, path)]
    return []


def test_prompt_files_carry_no_case_content() -> None:
    prompt_grams: set[tuple[str, ...]] = set()
    for path in PROMPTS.rglob("*.txt"):
        prompt_grams |= _grams(path.read_text(encoding="utf-8"))
    for family in sorted((REPO_ROOT / "cases/dev").glob("F*.json")):
        data = json.loads(family.read_text(encoding="utf-8"))
        case = set().union(*(_grams(s) for s in _strings(data["variants"])))
        assert not prompt_grams & case, family.name


def test_render_is_strict_and_single_pass() -> None:
    assert render("a {{x}} b", {"x": "{{x}}"}) == "a {{x}} b"
    with pytest.raises(TemplateError, match="missing values"):
        render("{{x}} {{y}}", {"x": "1"})
    with pytest.raises(TemplateError, match="without placeholders"):
        render("{{x}}", {"x": "1", "y": "2"})


def test_prompt_paths_and_encodings_are_checked(tmp_path: Path) -> None:
    with pytest.raises(TemplateError, match="repository-relative"):
        read_text("../etc/passwd")
    (tmp_path / "prompts").mkdir()
    (tmp_path / "prompts" / "bad.txt").write_bytes(b"\xff\xfe")
    with pytest.raises(TemplateError, match="not UTF-8"):
        read_text("prompts/bad.txt", tmp_path)
