"""Text renderings shared by the prompt builders (S2 5.4, 6.7, 7.2, 7.3).

Every string a model, an investigator or a case author wrote passes `untrusted.clean` (or `clean_lines` for a
record's body and table rows) before it is placed in a block; identifiers and enum values are inserted as they
are, because their models already constrain them to IDs and fixed words. A record's text is S1's `content_text`
(the one rendering of a content object, S2 4.4.1), so a coach quotes exactly what the citation check reads.
"""

from __future__ import annotations

from collections.abc import Iterable

from arena_core.agents.untrusted import clean, clean_lines
from arena_core.agents.views import Content, PublicCase, ReleasedRecord, TranscriptTurn
from arena_core.contracts.coaching import StoredFlag
from arena_core.contracts.common import turn_id
from arena_core.scenario.content import content_text

NONE = "none"


def record_text(content: Content) -> str:
    return clean_lines(content_text(content.as_mapping()))


def lines_or_none(lines: Iterable[str], sep: str = "\n") -> str:
    return sep.join(lines) or NONE


def case_values(case: PublicCase) -> dict[str, str]:
    """The case-file block's values (S2 5.4 `untrusted_case`)."""
    ctx = case.interview_context
    context = (
        f"{clean(ctx.agency)}, {clean(ctx.facility)} ({clean(ctx.timezone)}), interview on "
        f"{clean(ctx.interview_date)}. Setting: {clean(ctx.setting)} Investigator: {clean(ctx.investigator_role)}. "
        f"Subject: {clean(ctx.subject_name)}, {clean(ctx.subject_position)}, {clean(ctx.subject_unit)}, "
        f"{ctx.subject_tenure_years} years. Purpose: {clean(ctx.purpose_statement)}"
    )
    return {
        "case_id": case.case_id,
        "objective": clean(case.objective),
        "timeline": lines_or_none(f"{clean(t.time)} | {clean(t.event)} | {t.source}" for t in case.timeline),
        "initial_documents": "\n".join(
            f"{d.doc_id} | {d.kind} | {clean(d.title)}\n{record_text(d.content)}" for d in case.initial_documents
        ),
        "interview_context": context,
        "requestable": lines_or_none(
            (
                f"{r.record_id} | {clean(r.title)} | after exchange {r.requestable_after_exchanges}"
                for r in case.requestable
            ),
            sep="; ",
        ),
    }


def released_records(records: Iterable[ReleasedRecord]) -> str:
    """S2 5.4: `rec-NN (released after exchange MM) | title | date`, then the content text."""
    out = []
    for r in records:
        head = f"{r.record_id} (released after exchange {r.released_after:02d}) | {clean(r.title)}"
        if r.date is not None:
            head += f" | {clean(r.date)}"
        out.append(f"{head}\n{record_text(r.content)}")
    return lines_or_none(out)


def transcript(turns: Iterable[TranscriptTurn], answer_label: str = "Subject") -> str:
    """`tNN Investigator: ...` and `tNN <answer_label>: ...` per exchange (S2 5.4, 6.7)."""
    return lines_or_none(
        f"{turn_id(t.turn_no)} Investigator: {clean(t.question)}\n"
        f"{turn_id(t.turn_no)} {answer_label}: {clean(t.answer)}"
        for t in turns
    )


def flag_claim(flag: StoredFlag) -> str:
    """A flag's claim: the missing fact, or the second statement or record it conflicts with (S2 7.3)."""
    if flag.missing_fact is not None:
        return clean(flag.missing_fact)
    if flag.conflict_turn_id is not None and flag.conflict_quote is not None:
        return f'conflicts with {flag.conflict_turn_id}: "{clean(flag.conflict_quote)}"'
    return f'conflicts with {flag.conflict_record_id}: "{clean(flag.conflict_record_quote or "")}"'


def flag_line(flag: StoredFlag) -> str:
    """`tNN.fK | kind | tNN | "quote" | claim` (S2 5.4, 7.3)."""
    return f'{flag.flag_ref} | {flag.kind} | {flag.turn_id} | "{clean(flag.quote)}" | {flag_claim(flag)}'
