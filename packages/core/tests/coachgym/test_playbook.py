"""The ACE-style curator and the playbook renderer."""

from __future__ import annotations

from arena_core.coachgym.playbook import (
    MAX_RENDERED,
    PLAYBOOK_HEADER,
    CurateContext,
    Lesson,
    Proposal,
    curate,
    lesson_id,
    render,
)

TEXT = "Before calling an answer evasive, name the fact it leaves out and quote the answer exactly."


def _ctx(existing: list[Lesson] | None = None, forbidden: list[str] | None = None) -> CurateContext:
    return CurateContext(
        existing=existing or [],
        candidate_id="A1",
        run_id="gym-1",
        trial_of={"e" * 64: "trial-1", "f" * 64: "trial-2"},
        forbidden=forbidden or ["CANARY-GYM-0011", "C-7Q2MXK4D"],
        created_at="2026-10-15T00:00:00+00:00",
    )


def test_an_accepted_lesson_carries_its_sources_and_is_pending_material() -> None:
    out = curate([Proposal(f"  {TEXT}\n", ("e" * 64, "x" * 64))], _ctx())
    assert out.refused == []
    [lesson] = out.accepted
    assert lesson.text == TEXT  # cleaned
    assert lesson.source_example_ids == ("e" * 64,)  # an id the reflector was not shown is dropped
    assert lesson.source_trial_ids == ("trial-1",)
    assert lesson.source_run_ids == ("gym-1",)
    assert lesson.lesson_id == lesson_id(TEXT)


def test_refusals_name_the_reason_never_the_text() -> None:
    out = curate(
        [
            Proposal("too short", ("e" * 64,)),
            Proposal(TEXT, ("unknown",)),
            Proposal(f"Case C-7Q2MXK4D shows it. {TEXT}", ("e" * 64,)),
            Proposal(TEXT, ("f" * 64,)),
            Proposal(TEXT.replace("exactly", "exactly."), ("f" * 64,)),  # near-duplicate of the one just accepted
        ],
        _ctx(),
    )
    assert [lesson.source_trial_ids for lesson in out.accepted] == [("trial-2",)]
    assert out.refused == [
        "proposal 0: length 9 outside 20-300 characters",
        "proposal 1: names no example the reflector was shown",
        "proposal 2: contains a reference-only string",
        "proposal 4: repeats a lesson already on file",
    ]
    assert all("C-7Q2MXK4D" not in r for r in out.refused)


def test_a_lesson_already_on_file_is_not_filed_again() -> None:
    first = curate([Proposal(TEXT, ("e" * 64,))], _ctx()).accepted
    again = curate([Proposal(TEXT.upper(), ("e" * 64,))], _ctx(existing=first))
    assert again.accepted == []


def test_render_is_empty_without_lessons_and_bounded_with_them() -> None:
    assert render([]) == ""
    lessons = [
        Lesson(
            lesson_id=f"{i:016d}",
            text=f"Lesson number {i}: quote the answer before calling it evasive.",
            candidate_id="A1",
            source_run_ids=("r",),
            source_example_ids=("e",),
            source_trial_ids=("t",),
            created_at=f"2026-10-15T00:00:{i:02d}+00:00",
        )
        for i in range(MAX_RENDERED + 5)
    ]
    text = render(list(reversed(lessons)))
    lines = text.splitlines()
    assert lines[0] == PLAYBOOK_HEADER
    assert lines[1] == f"- {lessons[0].text}"  # oldest first
    assert len(lines) == MAX_RENDERED + 1
