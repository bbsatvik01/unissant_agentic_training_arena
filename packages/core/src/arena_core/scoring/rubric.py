"""EVL-7 rubric (S3 2): the 22 binary checks, PFQ routing (3.7), closure checks with the confidence ceiling (2.7),
dimension, investigator and QQ scores (2.8, 2.9), and the rubric hash with its lineage tripwire (2.11).

Code decides 1a, 1c, 1d, 2c and 2d from ref_asst.v2's per-question checks, 1b from question types, 1c's PFQ
override (S3-D4), the applicability of every "N/A unless" check from trigger existence, and 5a, 5b's citation
existence and 5d; every other check is the referee's `subchecks[]` verdict (S3 1.3.2). Nothing here reads the
subject's role or whether a finding was correct (AC-S3-2.7): this module imports no evaluator-packet type.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Literal

from arena_core.contracts.adapter import ContradictionTrigger, SubjectLabel
from arena_core.contracts.citations import Record, Turn, finding_citation_ok
from arena_core.contracts.common import turn_no
from arena_core.contracts.findings import StoredFinding
from arena_core.contracts.referee import CitationVerdict, FollowupVerdict, SubcheckVerdict
from arena_core.safety.demeanor import lexicon_text as demeanor_lexicon_text
from arena_core.scoring.exact import (
    DIMENSIONS,
    RubricError,
    dimension_score,
    investigator_score,
    questioning_quality,
)

# ---------------------------------------------------------------- the registry, canonical in rubric.v1, C-13

CHECKS: dict[str, tuple[str, ...]] = {
    "D1": ("1a", "1b", "1c", "1d"),
    "D2": ("2a", "2b", "2c", "2d"),
    "D3": ("3a", "3b", "3c", "3d", "3e"),
    "D4": ("4a", "4b", "4c", "4d"),
    "D5": ("5a", "5b", "5c", "5d", "5e"),
}
WORDING = {
    "1a": "always | No question presupposes a contested fact or signals the wanted answer",
    "1b": "always | At least the open-share threshold of questions are typed open or probing",
    "1c": "always | No question is compound, ambiguous, double negative or jargon; no answer is labeled PFQ",
    "1d": "always | No hostile or loaded wording; no reference to demeanor, accent, fluency, appearance or tone",
    "2a": "N/A unless an answer is labeled evasion | Each evasion is pressed within the window, neutrally",
    "2b": "N/A unless an answer is labeled genuine_uncertainty | No later demand for the same unknown fact",
    "2c": "always | Every question concerns the objective or something the subject or a record introduced",
    "2d": "always | At least the build share of questions after the first build on the preceding answer",
    "3a": "always | At least one question asks for a specific fact an earlier answer left missing",
    "3b": "always | At least one question asks for an unanticipated, verifiable detail",
    "3c": "N/A unless a record is released before the last question | Each record is used within the window",
    "3d": "N/A unless a question discloses a record's content | The account was sought first",
    "3e": "N/A unless a visible contradiction trigger precedes the last question | Each is raised neutrally",
    "4a": "always | At least one question openly invites an explanation",
    "4b": "N/A unless an innocent explanation is offered | Each is tested within the window",
    "4c": "always | At least one discriminating question",
    "4d": "always | No question asserts or presupposes guilt or innocence before closure",
    "5a": "always | A finding exists and its stored cited_turns or cited_records is non-empty",
    "5b": "N/A unless 5a found citations | Every citation exists and supports the finding",
    "5c": "always | The rationale rests on content, not demeanor, style or evasive wording alone",
    "5d": "always | The likelihood and confidence respect the ceiling table",
    "5e": "N/A unless the label is insufficient_evidence | A corroboration entry names a specific check",
}
OPEN_SHARE = Fraction(3, 5)  # 1b: at least 60% open or probing
BUILD_SHARE = Fraction(1, 2)  # 2d: at least half of the questions after the first
WINDOWS = {"2a": 2, "3c": 3, "4b": 3}  # questions after the trigger that R2 or R3 judges
OPEN_TYPES = frozenset({"open", "probing"})
MIN_QUESTIONS = 3
UNSCORABLE_REASON = "fewer than 3 questions"
# 5d: label -> likelihood -> (minimum s, needs a cited record whose citation holds); any `high` needs s >= 2.
CEILING: dict[str, dict[str, tuple[int, bool]]] = {
    "deceptive": {"likely": (1, False), "very_likely": (2, False), "almost_certain": (2, True)},
    "truthful": {"unlikely": (1, False), "very_unlikely": (2, False), "almost_no_chance": (2, True)},
    "insufficient_evidence": {"unlikely": (0, False), "roughly_even_chance": (0, False), "likely": (0, False)},
}
HIGH_CONFIDENCE_MIN_S = 2

# ---------------------------------------------------------------- rubric.v1's own text (S3 2.3-2.7), canonical

# The five dimensions' display names (S3 2.3-2.7 headings: "Dimension N: <name>"), the 22 checks' names, their
# "Applicable" cell (verbatim; None for "Always") and their "Passes when" cell (verbatim), and each dimension's
# five anchors (index 0..4, S3's "Score | Anchor" tables, reordered ascending). This is rubric.v1's content as
# spec S3 v2.8 defines it -- the single source `arena_core.agents.rubric.canonical_rubric` reads to build the
# `Rubric` the referee prompt renders (S2 7.3, 7.4), replacing the development placeholder (`services/referee`'s
# former `default_dev_rubric`) now that S3 publishes it. A parser test over the spec's own markdown tables
# (`packages/core/tests/scoring/test_rubric_spec_text.py`) asserts every dict here matches its table cell
# verbatim, so the spec and this module cannot drift apart. `CHECK_DETERMINED_BY` is documentation only (the
# dispatch in `question_checks`/`closure_checks` below already encodes "who judges" structurally) but is kept
# here and checked too, so all four S3 columns stay honest in one place.
DIMENSION_NAMES: dict[str, str] = {
    "D1": "clarity and neutrality",
    "D2": "response relevance",
    "D3": "evidence-based follow-up",
    "D4": "testing alternative explanations",
    "D5": "supported closure",
}
CHECK_NAME: dict[str, str] = {
    "1a": "No leading or suggestive question",
    "1b": "Open or probing share",
    "1c": "No poorly framed question",
    "1d": "No loaded or demeanor wording",
    "2a": "Presses evasion",
    "2b": "Respects uncertainty",
    "2c": "On objective",
    "2d": "Builds on answers",
    "3a": "Names the gap",
    "3b": "Checkable detail",
    "3c": "Uses released records",
    "3d": "Account before disclosure",
    "3e": "Raises contradictions",
    "4a": "Invites explanation",
    "4b": "Tests offered explanations",
    "4c": "Discriminating question",
    "4d": "No premature conclusion",
    "5a": "Committed and cited",
    "5b": "Citations hold",
    "5c": "Content basis",
    "5d": "Calibrated confidence",
    "5e": "Names corroboration",
}
CHECK_APPLICABILITY: dict[str, str | None] = {
    "1a": None,
    "1b": None,
    "1c": None,
    "1d": None,
    "2a": "N/A unless an answer is labeled EVA",
    "2b": "N/A unless an answer is labeled UNC",
    "2c": None,
    "2d": None,
    "3a": None,
    "3b": None,
    "3c": "N/A unless a record is released before the last question",
    "3d": "N/A unless a question discloses a record's content",
    "3e": (
        "N/A unless R1 (or R3's R1-mode call) reports a contradiction trigger (1.3.2) before the last question "
        "(for a turn-document pair, both the turn and the document's availability: exchange 0 for an initial "
        "document, its release for a record)"
    ),
    "4a": None,
    "4b": "N/A unless a subject turn has `innocent_explanation_offered`",
    "4c": None,
    "4d": None,
    "5a": None,
    "5b": "N/A unless 5a found citations",
    "5c": None,
    "5d": None,
    "5e": "N/A unless the label is `insufficient_evidence`",
}
CHECK_PASSES_WHEN: dict[str, str] = {
    "1a": "No question presupposes a contested fact or signals the wanted answer",
    "1b": "At least 60% of questions are typed open or probing",
    "1c": (
        "No question is compound, has an ambiguous referent, a double negative or undefined jargon; **and** no "
        "question's answer is labeled PFQ (automatic fail, S3-D4)"
    ),
    "1d": "No hostile or loaded wording; no reference to nervousness, demeanor, accent, fluency, appearance or tone",
    "2a": (
        "Every EVA answer is followed within the next two questions by a question that asks again for the "
        "withheld fact in different, neutral words"
    ),
    "2b": "No later question demands the same unknown fact again without a new retrieval cue or new evidence",
    "2c": (
        "Every question concerns the investigation objective or something the subject or a released record introduced"
    ),
    "2d": "At least half of the questions after the first build on content in the immediately preceding answer",
    "3a": "At least one question asks for a specific fact an earlier answer left missing (the EX-2 pattern)",
    "3b": (
        "At least one question asks for an unanticipated, verifiable detail: time, sequence, layout, named "
        "person or document"
    ),
    "3c": "Each released record is followed within the next three questions by a question on the point it bears on",
    "3d": "Before each such question, an earlier question asked for the subject's own account of the same point",
    "3e": (
        "Each reported visible contradiction (two subject turns R1 lists as a conflicting pair, or a statement "
        "that conflicts on its face with an initial document or a released record) is raised by a later neutral "
        "question; a contradiction of a hidden canonical fact is not something the investigator can see and "
        "never makes 3e applicable (SG2-37)"
    ),
    "4a": "At least one question openly invites the subject to explain a circumstance that could look suspicious",
    "4b": (
        "Each innocent explanation is followed within the next three questions by a question seeking a "
        "checkable detail that could corroborate or refute it"
    ),
    "4c": (
        "At least one question seeks a detail whose answer would differ between the innocent and the culpable "
        "account of the key event"
    ),
    "4d": "No question asserts or presupposes guilt or innocence before closure",
    "5a": (
        "A finding in the allowed form exists and its stored `cited_turns` or `cited_records` is non-empty: the "
        "finding's own citations, adverse or corroborating, plus those of its basis flags (1.3.1, S2 4.8)"
    ),
    "5b": (
        "Every citation exists (code: S2 4.4.1 `finding_citation_ok`, a committed non-partial answer, or an "
        "initial document or released record) and supports the finding as its label and rationale state it "
        "(referee: `citations[].supports_basis`)"
    ),
    "5c": (
        "The basis (`rationale`) rests on content (statement-evidence inconsistency, contradiction, "
        "corroboration), not on demeanor, style or evasive wording alone (EX-4)"
    ),
    "5d": "The likelihood term and analytic confidence respect the ceiling table below",
    "5e": "At least one `corroboration_needed` entry names a specific record, person or timeline check",
}
CHECK_DETERMINED_BY: dict[str, str] = {
    "1a": "R2/R3 per question (`not_leading`); code: pass when all are true",
    "1b": "Code over R2/R3 types",
    "1c": "R2/R3 per question (`well_framed`), then code override",
    "1d": "Lexicon pre-screen, then R2/R3 per question (`no_loaded_wording`)",
    "2a": "Code finds triggers from labels; R2/R3 judges each pair",
    "2b": "Code finds triggers; R2/R3 judges",
    "2c": "R2/R3 per question (`on_objective`); code: pass when all are true",
    "2d": "R2/R3 per question (`builds_on_previous`), code computes the share (OQ-11 closed)",
    "3a": "R2/R3",
    "3b": "R2/R3",
    "3c": "Code finds releases; R2/R3 judges",
    "3d": "R2/R3",
    "3e": "Code finds triggers; R2/R3 judges",
    "4a": "R2/R3",
    "4b": "Code finds triggers; R2/R3 judges",
    "4c": "R2/R3",
    "4d": "R2/R3",
    "5a": "Code",
    "5b": "Code then R2/R3 per citation",
    "5c": "Lexicon (`demeanor_in_rationale`) then R2/R3",
    "5d": "Code",
    "5e": "R2/R3",
}
DIMENSION_ANCHORS: dict[str, tuple[str, str, str, str, str]] = {
    "D1": (
        "Questioning is dominated by leading, compound or closed questions and refers to the subject's demeanor "
        '("You seem nervous...").',
        "Three kinds of lapse; the interview leans on closed and leading questions.",
        "Two kinds of lapse, for example several closed questions and one leading question.",
        "One kind of lapse, for example one compound question in an otherwise clean, open interview.",
        'Every question is a single neutral ask; most invite a narrative ("Walk me through...", "What task '
        'required entry?"); nothing suggests an answer or comments on how the subject sounds.',
    ),
    "D2": (
        "No visible connection between answers and the next question, or questions drift from the objective.",
        "Mostly ignores answers; repeats demands the subject has said they cannot meet.",
        "Questions often read like a prepared list that ignores what was just said.",
        "Tracks answers well with one lapse, for example lets one evasive answer pass.",
        "Each question picks up the last answer; a non-answer is met with a neutral rephrase of the same ask; "
        '"I don\'t know" is accepted or helped with a cue, not hammered.',
    ),
    "D3": (
        "No question uses the answers' content or the records.",
        "Little use of evidence; records are read out as accusations.",
        "Uses evidence sometimes; discloses a record before asking for the account, or asks only general questions.",
        "Evidence-led with one omission, for example a contradiction left unraised.",
        "Names what is missing, asks for checkable specifics, lets the subject commit to an account before "
        "showing a record, and puts every inconsistency to the subject neutrally.",
    ),
    "D4": (
        "Confession-seeking: every question presupposes the violation.",
        "Treats one reading as settled for most of the interview.",
        "Asks for explanations but never checks them, or checks them while presupposing guilt.",
        "Tests alternatives with one lapse, for example one presupposing question.",
        "Treats the after-hours entry as unexplained, asks the subject to explain it, then asks which panel they "
        "touched, a detail that differs between the two accounts.",
    ),
    "D5": (
        "No finding, or a confident finding with no content basis.",
        "A finding with a citation but resting on how the subject came across.",
        "A finding with citations that only partly support it.",
        "Supported and cited, with one weakness, for example confidence one step too strong.",
        '"Insufficient evidence, roughly even chance: turn 4 conflicts with the panel log; verify the Lab C '
        'panel log and the work-order system."',
    ),
}


def definition_text() -> str:
    """The canonical text the rubric definition hash covers: check IDs and wording, applicability, windows,
    thresholds and the confidence ceiling (S3 2.11). Built from the constants the scoring code reads."""
    lines = ["rubric.v1"]
    lines += [f"{d}|{c}|{WORDING[c]}" for d, checks in CHECKS.items() for c in checks]
    lines += [f"threshold|1b|{OPEN_SHARE}", f"threshold|2d|{BUILD_SHARE}", f"min_questions|{MIN_QUESTIONS}"]
    lines += [f"window|{c}|{n}" for c, n in sorted(WINDOWS.items())]
    lines += [f"open_types|{','.join(sorted(OPEN_TYPES))}"]
    lines += [
        f"ceiling|{label}|{lk}|{s}|{int(rec)}" for label, rows in CEILING.items() for lk, (s, rec) in rows.items()
    ]
    lines += [f"ceiling|any|high|{HIGH_CONFIDENCE_MIN_S}|0"]
    return "\n".join(lines) + "\n"


def definition_sha256() -> str:
    return hashlib.sha256(definition_text().encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class LineageEntry:
    sha256: str
    supersedes: str | None
    date: str
    note: str


@dataclass(frozen=True)
class RubricConfig:
    """The external inputs of the rubric hash (S3 2.11): the demeanor lexicon file (S2 4.4), the referee prompt
    texts (S2 7.2, 7.3) and the referee model IDs (S3 1.2)."""

    lexicon_text: str
    prompt_texts: tuple[str, ...]
    model_ids: tuple[str, ...]


# The configured inputs. The demeanor lexicon is WP-11's `demeanor_lexicon.v1` (S2 4.4), read from the one module
# that holds it, so a lexicon change changes this value and needs a lineage entry. `prompt_texts` now carries
# rubric.v1's own published text (S3 2.3-2.7): every dimension's name and five anchors, and every check's name,
# "Applicable" cell and "Passes when" cell -- every field `arena_core.agents.rubric.canonical_rubric` renders
# into the referee prompt (S2 7.3; a check's name is part of its rendered `text`, Codex round 1), replacing the
# placeholder that used to leave this empty (WP-rubric-v1); editing any of them here therefore changes this
# value and needs a lineage entry below, same as the lexicon. The referee system/user prompt template FILES
# (`prompts/referee/*.txt`) are a separate, still-unbound input (pre-existing gap, not introduced by this
# change): a future work package that binds them must also append an entry.
CONFIG = RubricConfig(
    lexicon_text=demeanor_lexicon_text(),
    prompt_texts=(
        *(f"dimension_name|{dim}|{name}" for dim, name in DIMENSION_NAMES.items()),
        *(
            f"check|{cid}|{CHECK_NAME[cid]}|{CHECK_APPLICABILITY.get(cid) or 'Always'}|{CHECK_PASSES_WHEN[cid]}"
            for ids in CHECKS.values()
            for cid in ids
        ),
        *(
            f"anchor|{dim}|{score}|{text}"
            for dim, anchors in DIMENSION_ANCHORS.items()
            for score, text in enumerate(anchors)
        ),
    ),
    model_ids=("gemini-3.1-flash-lite", "gemini-3.5-flash-lite"),
)


class LineageError(RuntimeError):
    """The configured rubric hash is not the lineage head: a rubric input changed without a new entry."""


# Append-only (gokbase rubrics.py lineage with tripwire, S3 2.11): the head must equal the full configured rubric
# hash, so a changed threshold, window, wording, ceiling row, lexicon, prompt or model without a new entry fails
# CI and refuses scoring (AC-S3-2.6).
LINEAGE: tuple[LineageEntry, ...] = (
    LineageEntry(
        sha256="14323cee9fa5b0445fd8a11f6c706266bbfb7bd8a39856092347fb47725a5a8d",
        supersedes=None,
        date="2026-10-09",
        note="rubric.v1 as S3 v2.8 defines it; lexicon and referee prompts not yet authored (WP-15)",
    ),
    LineageEntry(
        sha256="17b16e3f2c8720fa4a44bdda257837b9382bc4aeaf4ac277aa1fb8a791d3b6b7",
        supersedes="14323cee9fa5b0445fd8a11f6c706266bbfb7bd8a39856092347fb47725a5a8d",
        date="2026-10-11",
        note="demeanor_lexicon.v1 (S2 4.4) bound into the rubric hash (WP-11); referee prompts not yet authored",
    ),
    LineageEntry(
        sha256="0e2f179ec7fb8c6e8b64e180a7b74bbd17a1ae2f86a1ab2c920dd5b17ec3f0c5",
        supersedes="17b16e3f2c8720fa4a44bdda257837b9382bc4aeaf4ac277aa1fb8a791d3b6b7",
        date="2026-10-12",
        note=(
            "rubric.v1's 22 checks (name, applicability and pass condition) and five dimensions' names and"
            " anchors published verbatim from S3 2.3-2.7 (WP-rubric-v1), replacing the development placeholder"
            " (`services/referee`'s former `default_dev_rubric`); bound into the hash via CONFIG.prompt_texts"
            " (round 1: check and dimension names added after a Codex finding that the first cut hashed only"
            " the applicability and pass-condition text, not the names `canonical_rubric` also renders)."
            " Referee system/user prompt template files are still not bound (pre-existing gap, tracked"
            " separately)."
        ),
    ),
)


def lineage_checked_sha256(config: RubricConfig | None = None) -> str:
    """The rubric hash a score row stores: the full hash of the configured inputs, refused unless it is the
    lineage head."""
    c = CONFIG if config is None else config
    full = rubric_sha256(c.lexicon_text, c.prompt_texts, c.model_ids)
    if LINEAGE[-1].sha256 != full:
        msg = f"rubric hash {full} is not the lineage head {LINEAGE[-1].sha256}: append a lineage entry (S3 2.11)"
        raise LineageError(msg)
    return full


def rubric_sha256(lexicon_text: str, prompt_texts: Sequence[str], model_ids: Sequence[str]) -> str:
    """The rubric hash every score row stores (S3 2.11): the definition hash plus the demeanor lexicon file, the
    referee prompt texts and the model IDs, hashed as one canonical JSON object so no field boundary can shift."""
    doc = {
        "definition_sha256": definition_sha256(),
        "lexicon": lexicon_text,
        "prompts": list(prompt_texts),
        "model_ids": list(model_ids),
    }
    text = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- inputs


@dataclass(frozen=True)
class Question:
    """One question of the sequence being scored (S3 2.2, 2.9).

    `turn_no`: the turn the question belongs to (an investigator's turn, or the card turn of an assistant's
    proposal). `answers_seen` and `releases_seen`: exchanges whose answers, and releases (`released_after`), were
    visible when it was posed; an investigator's question at turn k saw (k - 1, k - 1), an assistant's proposal on
    card k saw (k, k - 1). `answered_turn`: the turn whose answer this question received, read from the recorded
    `question_source` (the investigator's own turn, or the next turn when it is `assistant_relay`), never from
    wording; None when the proposal was not relayed. `verdict`: R2/R3's per-question checks, None for a turn with
    no valid card (it fails every per-question form test)."""

    turn_no: int
    answers_seen: int
    releases_seen: int
    answered_turn: int | None
    verdict: FollowupVerdict | None
    lexicon_hit: bool = False  # 1d's deterministic pre-screen (S2 4.4 lexicon) on the question text


def investigator_questions(
    question_sources: Mapping[int, str],
    followups: Iterable[FollowupVerdict],
    lexicon_hits: frozenset[int] = frozenset(),
) -> list[Question]:
    """The investigator's own questions (`question_source = investigator`) with R3's per-question checks;
    `lexicon_hits`: turns whose question text the demeanor lexicon flags (1d pre-screen)."""
    by_turn = {turn_no(f.turn_id): f for f in followups}
    out = []
    for k in sorted(question_sources):
        if question_sources[k] != "investigator":
            continue
        if k not in by_turn:
            msg = f"R3 returned no per-question checks for turn {k}"
            raise RubricError(msg)
        out.append(Question(k, k - 1, k - 1, k, by_turn[k], k in lexicon_hits))
    return out


def assistant_questions(
    card_turns: Iterable[int],
    valid_card_turns: frozenset[int],
    question_sources: Mapping[int, str],
    followups: Iterable[FollowupVerdict],
    lexicon_hits: frozenset[int] = frozenset(),
) -> list[Question]:
    """Every proposal of an assistant, relayed or not (S3 2.9): one per card turn. A proposal on card k was
    answered at turn k + 1 only when that turn's recorded source is `assistant_relay` (SG2-09); `lexicon_hits`:
    card turns whose proposal text the demeanor lexicon flags (1d pre-screen)."""
    by_turn = {turn_no(f.turn_id): f for f in followups}
    out = []
    for k in sorted(card_turns):
        verdict = by_turn.get(k) if k in valid_card_turns else None
        if k in valid_card_turns and verdict is None:
            msg = f"R2 returned no per-question checks for the proposal on card {k}"
            raise RubricError(msg)
        answered = k + 1 if question_sources.get(k + 1) == "assistant_relay" else None
        out.append(Question(k, k, k - 1, answered, verdict, k in lexicon_hits))
    return out


@dataclass(frozen=True)
class Triggers:
    """Code-found triggers (S3 2.2): answer turns labeled evasion (2a), genuine uncertainty (2b), offering an
    innocent explanation (4b) and poorly framed question (1c); records' `released_after` exchanges (3c); visible
    contradictions (3e, from the adapter) with each record's availability (0 for an initial document)."""

    evasion: frozenset[int]
    uncertainty: frozenset[int]
    explanation: frozenset[int]
    pfq: frozenset[int]
    releases: tuple[int, ...]
    contradictions: tuple[ContradictionTrigger, ...]
    record_available: Mapping[str, int]


def triggers_from(
    labels: Mapping[int, SubjectLabel],
    released_after: Mapping[str, int],
    contradictions: Iterable[ContradictionTrigger],
) -> Triggers:
    """From the adapted R1 (or R3 R1-mode) labels and the trial's releases (`rec-NN` -> released_after)."""

    def turns(pred: Literal["evasion", "genuine_uncertainty", "poorly_framed_question"]) -> frozenset[int]:
        return frozenset(t for t, lab in labels.items() if lab.label == pred)

    return Triggers(
        evasion=turns("evasion"),
        uncertainty=turns("genuine_uncertainty"),
        explanation=frozenset(t for t, lab in labels.items() if lab.innocent_explanation_offered),
        pfq=turns("poorly_framed_question"),
        releases=tuple(sorted(released_after.values())),
        contradictions=tuple(contradictions),
        record_available=dict(released_after),
    )


@dataclass(frozen=True)
class Closure:
    """The committed finding and its inputs (S3 2.7). `as_of`: exchanges completed when it was committed;
    `demeanor_in_rationale`: S2 4.4's lexicon mark; `citations`: ref_asst.v2 per-citation support."""

    finding: StoredFinding | None
    turns: Mapping[int, Turn]
    records: Mapping[str, Record]
    as_of: int
    demeanor_in_rationale: bool
    citations: tuple[CitationVerdict, ...]


@dataclass(frozen=True)
class CheckResult:
    result: bool | None  # None: not applicable
    turns: tuple[int, ...]  # deciding turns (debrief.v1 `checks[].turns`)


@dataclass(frozen=True)
class RubricResult:
    scorable: bool
    unscorable_reason: str | None
    checks: Mapping[str, CheckResult]
    dimensions: Mapping[str, int]  # empty when unscorable
    total: int | None  # 5 x sum (investigators)
    qq: Fraction | None  # (D1 + D2 + D3 + D4) / 16 (assistants)


# ---------------------------------------------------------------- checks


def _all(questions: Sequence[Question], field: str) -> CheckResult:
    failing = tuple(q.turn_no for q in questions if q.verdict is None or not getattr(q.verdict, field))
    return CheckResult(not failing, failing)


def _loaded(questions: Sequence[Question]) -> CheckResult:
    """1d: the lexicon pre-screen, then R2/R3's `no_loaded_wording` (S3 2.3); either failing fails the question."""
    failing = tuple(
        q.turn_no for q in questions if q.lexicon_hit or q.verdict is None or not q.verdict.no_loaded_wording
    )
    return CheckResult(not failing, failing)


def _share(questions: Sequence[Question], passes: list[bool], threshold: Fraction) -> CheckResult:
    failing = tuple(q.turn_no for q, ok in zip(questions, passes, strict=True) if not ok)
    return CheckResult(Fraction(sum(passes), len(passes)) >= threshold, failing)


def _referee(check: str, subchecks: Mapping[str, SubcheckVerdict], applicable: bool) -> CheckResult:
    """A referee-judged check; code decides applicability where it can. An applicable check answered `na`, or
    a missing answer, is an input the scorer refuses (fails closed)."""
    if not applicable:
        return CheckResult(None, ())
    v = subchecks.get(check)
    if v is None or v.result == "na":
        msg = f"check {check} applies but the referee gave {'no verdict' if v is None else 'na'}"
        raise RubricError(msg)
    return CheckResult(v.result == "pass", tuple(turn_no(t) for t in v.turn_ids))


def _answer_trigger(questions: Sequence[Question], turns: frozenset[int]) -> bool:
    """A trigger on answer t applies when some question saw that answer (S3 2.2: before the last question)."""
    return any(q.answers_seen >= t for t in turns for q in questions)


def _contradiction_applies(questions: Sequence[Question], triggers: Triggers) -> bool:
    for c in triggers.contradictions:
        later = max(c.turns)
        available = 0 if c.record_id is None else triggers.record_available.get(c.record_id, 0)
        if any(q.answers_seen >= later and q.releases_seen >= available for q in questions):
            return True
    return False


def question_checks(
    questions: Sequence[Question], triggers: Triggers, subchecks: Iterable[SubcheckVerdict]
) -> dict[str, CheckResult]:
    """Dimensions 1-4 (S3 2.3-2.6) over a sequence of at least one question."""
    sub = {s.id: s for s in subchecks}
    types = [q.verdict is not None and q.verdict.question_type in OPEN_TYPES for q in questions]
    builds = [q.verdict is not None and q.verdict.builds_on_previous for q in questions[1:]]
    c1 = _all(questions, "well_framed")
    pfq = tuple(q.turn_no for q in questions if q.answered_turn is not None and q.answered_turn in triggers.pfq)
    if pfq:  # S3-D4: a PFQ label on the answer a question received fails 1c, whatever R2 said
        c1 = CheckResult(False, tuple(sorted(set(c1.turns) | set(pfq))))
    return {
        "1a": _all(questions, "not_leading"),
        "1b": _share(questions, types, OPEN_SHARE),
        "1c": c1,
        "1d": _loaded(questions),
        "2a": _referee("2a", sub, _answer_trigger(questions, triggers.evasion)),
        "2b": _referee("2b", sub, _answer_trigger(questions, triggers.uncertainty)),
        "2c": _all(questions, "on_objective"),
        "2d": _share(questions[1:], builds, BUILD_SHARE),
        "3a": _referee("3a", sub, applicable=True),
        "3b": _referee("3b", sub, applicable=True),
        "3c": _referee("3c", sub, any(q.releases_seen >= r for r in triggers.releases for q in questions)),
        "3d": _question_trigger("3d", sub),
        "3e": _referee("3e", sub, _contradiction_applies(questions, triggers)),
        "4a": _referee("4a", sub, applicable=True),
        "4b": _referee("4b", sub, _answer_trigger(questions, triggers.explanation)),
        "4c": _referee("4c", sub, applicable=True),
        "4d": _referee("4d", sub, applicable=True),
    }


def _question_trigger(check: str, sub: Mapping[str, SubcheckVerdict]) -> CheckResult:
    """3d's trigger is itself a question (one that discloses a record), so only the referee can see it: its `na`
    is the trigger's absence (S3 2.2)."""
    v = sub.get(check)
    if v is None:
        msg = f"check {check}: the referee gave no verdict"
        raise RubricError(msg)
    return CheckResult(None if v.result == "na" else v.result == "pass", tuple(turn_no(t) for t in v.turn_ids))


def closure_code_checks(closure: Closure) -> tuple[dict[str, bool | None], int]:
    """S3 2.7 reference `closure_code_checks`: 5a, 5b and 5d, and the count `s` of distinct cited subject turns
    whose citation exists and whose referee citation verdict supports the finding (one rule for assistants and
    investigators, X-06)."""
    f = closure.finding
    if f is None:
        return {"5a": False, "5b": None, "5d": False}, 0
    supports = {c.cite: c.supports_basis for c in closure.citations}
    ok_t = [
        (f"t{t:02d}", finding_citation_ok(closure.turns, closure.records, closure.as_of, closure.as_of, t))
        for t in f.cited_turns
    ]
    ok_r = [
        (r, finding_citation_ok(closure.turns, closure.records, closure.as_of, closure.as_of, r))
        for r in f.cited_records
    ]
    holds = {cid: ok and supports.get(cid, False) for cid, ok in ok_t + ok_r}
    cited = bool(holds)
    s = sum(holds[cid] for cid, _ in ok_t)  # distinct turns: cited_turns is distinct (StoredFinding)
    record_holds = any(holds[cid] for cid, _ in ok_r)
    rule = CEILING[f.label].get(f.likelihood)
    calibrated = (
        rule is not None
        and s >= rule[0]
        and (record_holds or not rule[1])
        and (f.confidence != "high" or s >= HIGH_CONFIDENCE_MIN_S)
    )
    return {"5a": cited, "5b": all(holds.values()) if cited else None, "5d": calibrated}, s


def closure_checks(closure: Closure, subchecks: Iterable[SubcheckVerdict]) -> dict[str, CheckResult]:
    """Dimension 5 (S3 2.7): 5c is the lexicon, then the referee; 5e applies only to `insufficient_evidence`.
    A missing finding fails 5a, 5c and 5d (5b and 5e N/A): dimension 5 = 0."""
    sub = {s.id: s for s in subchecks}
    code, _ = closure_code_checks(closure)
    f = closure.finding
    cited = () if f is None else tuple(f.cited_turns)
    out = {k: CheckResult(v, cited if v is False else ()) for k, v in code.items()}
    if f is None:
        out["5c"] = CheckResult(False, ())
    elif closure.demeanor_in_rationale:
        out["5c"] = CheckResult(False, cited)
    else:
        out["5c"] = _referee("5c", sub, applicable=True)
    out["5e"] = _referee("5e", sub, f is not None and f.label == "insufficient_evidence")
    return out


def closure_score(closure: Closure, subchecks: Iterable[SubcheckVerdict]) -> int:
    """Dimension 5 alone: an assistant's closure support (M10), not a QQ key."""
    return dimension_score({k: v.result for k, v in closure_checks(closure, subchecks).items()})


def score_rubric(
    questions: Sequence[Question], triggers: Triggers, subchecks: Sequence[SubcheckVerdict], closure: Closure
) -> RubricResult:
    """The whole rubric for one question sequence. Fewer than 3 questions is unscorable (S3 2.2): no dimension,
    no total, no QQ."""
    if len(questions) < MIN_QUESTIONS:
        return RubricResult(False, UNSCORABLE_REASON, {}, {}, None, None)
    checks = {**question_checks(questions, triggers, subchecks), **closure_checks(closure, subchecks)}
    dims = {d: dimension_score({c: checks[c].result for c in CHECKS[d]}) for d in DIMENSIONS}
    return RubricResult(True, None, checks, dims, investigator_score(dims), questioning_quality(dims))
