"""Raw `arena_referee.db.TrialFacts` rows to `arena_core.referee.leaderboard.CandidateInput` (S3 4.3, 5.3-
5.6; WP-16). Pure: classifies each row with WP-15's own `inclusion()` and `block_invalid()` -- the same
functions, on the same raw facts, that `ledger.build_manifest` reads -- so a candidate's leaderboard input
agrees with the sealed manifest by construction, never by a second, possibly drifting, derivation.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

from arena_core.contracts.adapter import adapt_subject_report, contradiction_triggers, verdicts_by_key
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.referee.leaderboard import CandidateInput, SubjectCandidateInput, SubjectTrialInput, TrialScore
from arena_core.scoring.flags import BROAD, STRICT, evasion_counts, support_counts
from arena_core.scoring.inclusion import AsstInc, Exec, block_invalid, inclusion
from arena_core.scoring.kpi import LatencyRow
from arena_core.scoring.metrics import TrialOutcome
from arena_core.scoring.rubric import Closure, assistant_questions, closure_score, score_rubric, triggers_from
from arena_referee.db import StoredTrialJudgments, TrialFacts
from arena_referee.debrief import demeanor_hit
from arena_referee.mapping import (
    adapted_cards,
    available_after,
    question_sources,
    record_released_after,
    trial_rows,
)


def trial_score(family_id: str, stored: StoredTrialJudgments) -> TrialScore:
    """WP-15's scorer functions on one trial's stored judgments (S3 2.9, 5.3): QQ from `score_rubric` over every
    proposal (relayed or not), D5 closure support when a finding was committed (M10), and the strict and broad
    evasion counts and flag support (M06-M08) against R1's labels and R2's flag verdicts."""
    data = stored.data
    subject = RefereeSubjectReport.model_validate(stored.r1["report"])
    assistant = RefereeAssistantReport.model_validate(stored.r2)
    labels = adapt_subject_report(subject, frozenset(stored.r1.get("quote_invalid", ())))
    cards = adapted_cards(data)
    proposal_text = {c.turn_no: c.follow_up.question for c in cards}
    card_turns = set(proposal_text) | set(stored.unavailable_turns)
    questions = assistant_questions(
        card_turns,
        frozenset(c.turn_no for c in cards if c.valid),
        question_sources(data),
        assistant.followups,
        frozenset(k for k, text in proposal_text.items() if demeanor_hit(text)),
    )
    triggers = triggers_from(
        labels, record_released_after(data), contradiction_triggers(subject, available_after(data))
    )
    rows = trial_rows(data)
    finding = StoredFinding.model_validate(data.final_finding) if data.final_finding is not None else None
    closure = Closure(
        finding=finding,
        turns=rows.turns,
        records=rows.records,
        as_of=len(data.transcript),
        demeanor_in_rationale=finding is not None and demeanor_hit(finding.rationale),
        citations=tuple(assistant.citations),
    )
    verdicts = verdicts_by_key(cards, assistant)
    turn_labels = {n: lab.label for n, lab in labels.items()}
    return TrialScore(
        family_id=family_id,
        qq=score_rubric(questions, triggers, assistant.subchecks, closure).qq,
        closure=closure_score(closure, assistant.subchecks) if finding is not None else None,
        strict=evasion_counts(cards, turn_labels, rows, verdicts, kinds=STRICT),
        broad=evasion_counts(cards, turn_labels, rows, verdicts, kinds=BROAD),
        support=support_counts(cards, rows, verdicts),
    )


def _block_invalid_map(facts: Sequence[TrialFacts]) -> dict[str, bool]:
    by_block: dict[str, list[Exec]] = {}
    for f in facts:
        if f.block_id is not None:
            by_block.setdefault(f.block_id, []).append(f.exec_state)
    return {block: block_invalid(states) for block, states in by_block.items()}


def candidate_inputs(
    facts: Sequence[TrialFacts],
    scores: Mapping[str, TrialScore] | None = None,
    latency: Sequence[LatencyRow] = (),
) -> list[CandidateInput]:
    """Groups by `assistant_id` (a `replay_corpus` row has none and is never an assistant's own trial).
    `scores`: `trial_score` by trial id; an included trial with none (never scored) still counts against QQ
    coverage and leaves its flag metrics out, never a zero. `latency`: samples by trial id (M16).

    Known gaps (not fixed this round):
    1. Groups an assistant's `interactive` and `replay` track rows into one `CandidateInput` -- S3 5.2's
       metric table defines the I and R columns separately, and the bootstrap seed this candidate's rows
       feed hardcodes the `"I"` track literal regardless. Only a problem once a tournament actually runs a
       `replay` track for an assistant (today's dev fixtures are interactive-only); the fix is to key
       `by_candidate` on `(assistant_id, track)` and publish one row, and one bootstrap seed, per track.
    2. `reasons` carries only `inclusion()`'s own `reason` string, which conflates "this row's own
       exec_state" with "this row was swept into an invalidated BLOCK" -- a completed row inside an
       infra-failed block and the infra-failed row itself both read `block_invalid_infra` (Codex finding
       #11). M23's own execution-rate breakdown is accurate for what `reason` means, but a caller wanting
       the raw per-row `exec_state` counts too (distinct from the exclusion reason) needs a second field
       threaded through from `TrialFacts.exec_state` -- not built here.
    """
    invalid_blocks = _block_invalid_map(facts)
    by_candidate: dict[str, list[TrialFacts]] = {}
    for f in facts:
        if f.assistant_id is not None:
            by_candidate.setdefault(f.assistant_id, []).append(f)
    out: list[CandidateInput] = []
    for candidate_id, rows in by_candidate.items():
        own_trials = {f.trial_id for f in rows if f.trial_id is not None}
        trials: list[TrialOutcome] = []
        excluded_truthful_by_family: dict[str, int] = {}
        excluded_deceptive_by_family: dict[str, int] = {}
        reasons: list[tuple[str, str]] = []
        cost_rows: list[tuple[Decimal, bool]] = []
        scored: list[TrialScore] = []
        for f in rows:
            block_bad = f.block_id is not None and invalid_blocks.get(f.block_id, False)
            asst, _subj, reason = inclusion(f.exec_state, f.verdict, block_bad)
            reasons.append((f.role, reason))
            cost_rows.append((f.settled_cost, asst in (AsstInc.INCLUDED, AsstInc.INCLUDED_AS_INSUFFICIENT)))
            if asst in (AsstInc.INCLUDED, AsstInc.INCLUDED_AS_INSUFFICIENT):
                score = (scores or {}).get(f.trial_id) if f.trial_id is not None else None
                scored.append(score or TrialScore(family_id=f.family_id))
            if asst is AsstInc.INCLUDED:
                label = f.classification if f.classification in ("truthful", "deceptive") else "insufficient_evidence"
                trials.append(TrialOutcome(f.family_id, f.role, asst, label, f.subject_id or ""))
            elif asst is AsstInc.INCLUDED_AS_INSUFFICIENT:
                trials.append(TrialOutcome(f.family_id, f.role, asst, None, f.subject_id or ""))
            elif f.role == "truthful":
                excluded_truthful_by_family[f.family_id] = excluded_truthful_by_family.get(f.family_id, 0) + 1
            else:
                # A deceptive-role trial this candidate's manifest row excludes (F14 attrition, M21's
                # "complete family" test): dropped entirely would silently zero out `exc_d` and disable the
                # sensitivity bound it feeds, and would let a family with an excluded deceptive trial still
                # read as "complete" for M21's zero-event bound.
                excluded_deceptive_by_family[f.family_id] = excluded_deceptive_by_family.get(f.family_id, 0) + 1
        out.append(
            CandidateInput(
                candidate_id=candidate_id,
                display_name=candidate_id,
                trials=trials,
                excluded_truthful_by_family=excluded_truthful_by_family,
                excluded_deceptive_by_family=excluded_deceptive_by_family,
                reasons=reasons,
                own_cost_rows=cost_rows,
                own_planned=len(rows),
                scored=scored,
                latency=[r for r in latency if r.trial_id in own_trials],
            )
        )
    return out


def _output(asst: AsstInc, classification: str | None) -> str | None:
    """The assistant's outcome on this trial (S3 `output_of`), None when the assistant is excluded."""
    if asst is AsstInc.INCLUDED:
        return classification if classification in ("truthful", "deceptive") else "insufficient_evidence"
    if asst is AsstInc.INCLUDED_AS_INSUFFICIENT:
        return "insufficient_evidence"
    return None


def subject_inputs(facts: Sequence[TrialFacts], r1: Mapping[str, Mapping[str, Any]]) -> list[SubjectCandidateInput]:
    """Groups by `subject_id` for the subject board (S3 5.3, 5.6): interactive and corpus trials (M12/M13 "I +
    corpus"); a `replay` row re-reads a corpus transcript already counted, so it never counts twice. `r1`: each
    trial's stored R1 judgment payload (`<trial>:referee_subject`) by trial id; a trial with none adds no
    evaluated turn."""
    invalid_blocks = _block_invalid_map(facts)
    by_subject: dict[str, list[SubjectTrialInput]] = {}
    for f in facts:
        if f.subject_id is None or f.track == "replay":
            continue
        block_bad = f.block_id is not None and invalid_blocks.get(f.block_id, False)
        asst, subj, _reason = inclusion(f.exec_state, f.verdict, block_bad)
        stored = r1.get(f.trial_id) if f.trial_id is not None else None
        labels = (
            adapt_subject_report(
                RefereeSubjectReport.model_validate(stored["report"]), frozenset(stored.get("quote_invalid", ()))
            )
            if stored is not None
            else None
        )
        by_subject.setdefault(f.subject_id, []).append(
            SubjectTrialInput(
                family_id=f.family_id,
                role=f.role,
                track=f.track,
                assistant_id=f.assistant_id,
                exec_state=f.exec_state,
                subj_inc=subj,
                verdict=f.verdict,
                output=_output(asst, f.classification),
                labels=labels,
            )
        )
    return [SubjectCandidateInput(candidate_id=c, display_name=c, trials=t) for c, t in by_subject.items()]
