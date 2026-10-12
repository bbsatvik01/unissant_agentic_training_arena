"""`canonical_rubric` (S2 7.4): rubric.v1 built from spec S3's real text (`arena_core.scoring.rubric`), replacing
the development placeholder that used to leave J3/J4 judging checks like "3a: placeholder text of 3a"."""

from __future__ import annotations

import pytest

from arena_core.agents import rubric as agents_rubric
from arena_core.agents.referee_prompts import build_referee_assistant_prompt, rubric_subchecks
from arena_core.agents.rubric import canonical_rubric
from arena_core.contracts.referee import PER_QUESTION_SUBCHECKS
from arena_core.scoring.rubric import CHECK_APPLICABILITY, CHECK_NAME, CHECK_PASSES_WHEN, CHECKS

from . import fixtures as fx
from .test_referee_prompts import REFEREE, assistant_input


def test_canonical_rubric_has_22_checks_and_no_placeholder_text() -> None:
    r = canonical_rubric()
    assert r.rubric_version == "rubric.v1"
    assert [d.dim_id for d in r.dimensions] == ["D1", "D2", "D3", "D4", "D5"]
    ids = [s.id for d in r.dimensions for s in d.subchecks]
    assert (len(ids), len(set(ids))) == (22, 22)
    for d in r.dimensions:
        assert (len(d.anchors_0_to_4),) == (5,)
        assert d.anchors_0_to_4 != [f"anchor {k}" for k in range(5)]
        for s in d.subchecks:
            assert "placeholder" not in s.text
            assert s.text.startswith(CHECK_NAME[s.id])
            if CHECK_APPLICABILITY.get(s.id) is None:
                assert s.na_when is None
            else:
                assert s.na_when == CHECK_APPLICABILITY[s.id]


def test_canonical_rubric_renders_into_the_referee_prompt() -> None:
    system = build_referee_assistant_prompt(assistant_input(), REFEREE, salt=fx.SALT, dev_rubric=canonical_rubric())
    section = system.system_instruction.split("Rubric sub-checks:\n", 1)[1].split("\n\nPart 3.", 1)[0]
    rendered_ids = [line.split(":", 1)[0] for line in section.splitlines() if not line.startswith("D")]
    expected = [c for ids in CHECKS.values() for c in ids if c not in PER_QUESTION_SUBCHECKS]
    assert rendered_ids == expected
    assert "placeholder" not in section


def test_check_3d_applicability_is_in_its_own_rendered_text() -> None:
    """3d is the one check whose own `na` answer is load-bearing with no code-built trigger list to pre-filter
    it (S3 2.2: "3d's trigger is itself a question"), so its rendered text must say when it does not apply, not
    just judge it blind -- the prompt (`prompts/referee/assistant.v1.txt`) tells the model to answer `na` "only
    where the sub-check text says when it does not apply"."""
    text = rubric_subchecks(canonical_rubric())
    line = next(x for x in text.splitlines() if x.startswith("3d:"))
    assert "N/A unless a question discloses a record's content" in line


def test_canonical_rubric_drops_3e_applicability_clause_too_long_to_fit() -> None:
    """3e's own "Applicable" cell (237 characters) does not fit beside its "Passes when" text under the
    400-byte cap, so the rendered `text` falls back to name + "Passes when" alone -- `na_when` still records
    the full applicability clause even though the rendered text drops it."""
    r = canonical_rubric()
    s3e = next(s for d in r.dimensions for s in d.subchecks if s.id == "3e")
    applicability = CHECK_APPLICABILITY["3e"]
    assert applicability is not None
    assert s3e.text == f"{CHECK_NAME['3e']}. {CHECK_PASSES_WHEN['3e']}."
    assert applicability not in s3e.text
    assert s3e.na_when == applicability


def test_canonical_rubric_refuses_a_check_that_would_fit_no_rendering(monkeypatch: pytest.MonkeyPatch) -> None:
    """A check whose name and "Passes when" text alone already overrun the cap has nothing left to drop; this
    cannot happen with today's S3 text (proven by every other test here that builds `canonical_rubric`
    successfully) but must fail loudly, not silently ship truncated or oversized rubric text, if a future spec
    edit ever makes a check's own text this long."""
    monkeypatch.setattr(agents_rubric, "MAX_SUBCHECK_TEXT_BYTES", 1)
    with pytest.raises(ValueError, match="text exceeds 1 rendered bytes"):
        canonical_rubric()
