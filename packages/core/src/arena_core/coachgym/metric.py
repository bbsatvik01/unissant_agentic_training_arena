"""The Coach Gym grader (D-036; PROCTOR: the grader is code, separate from the optimizer and the critic).

`grade(example, run, limits)` scores one card against the example's reference. Mechanical checks come first and
outrank everything else; any failure zeroes the example:

- schema: the call produced a valid card.v1 (the port's own validation, with its one repair, S2 10);
- citation before verdict: every flag's citation exists in an answered turn the card could see (S2 4.4.1), a
  verdict other than `insufficient_evidence` cites at least one turn, and a `deceptive` verdict rests on at least
  one of the card's own flags whose citation exists;
- latency and cost: within the candidate's card deadline and the per-card cost cap.

Then the components, read from the reference (ground-truth role; referee R1 labels with human T-LAB labels
first) and from the card: a deceptive verdict on a truthful subject (a false positive) zeroes the example; the
verdict on a deceptive subject once an evasion is on record (recall); the precision of gap-type flags on
labeled turns and whether the current turn's evasion was flagged; flags the S2 4.4 demeanor post-check marks
(unsupported, PRB-4); and questioning quality, the code-decided form of rubric.v1's D1 checks on the proposed
follow-up (no demeanor or loaded lexicon term, check 1d's pre-screen; not a repeat of a question already asked).
Scores are exact `Fraction`s; GEPA receives their float.

`aggregate` turns grades into the set metrics (deceptive recall, false-positive rate, flag precision,
unsupported flags, questioning quality, mechanical pass rate, mean score, canary passes) and
`promotion_verdict` applies the promotion rule: a strict win on the dev holdout, no false-positive regression
against the champion, a false-positive rate within the S3 1.4 gate (5%), no canary passed and no cheat finding.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from typing import Any

from arena_core.coachgym.examples import Example
from arena_core.contracts.citations import normalize
from arena_core.contracts.coaching import GAP_KINDS, StoredCard, StoredFlag
from arena_core.contracts.common import turn_no
from arena_core.contracts.rendered import clean
from arena_core.scoring.exact import GATE
from arena_core.turns.coach import LEXICON

# Component weights (sum 1). The verdict carries the most weight; questioning quality is the coach's other job.
W_LABEL = Fraction(2, 5)
W_PRECISION = Fraction(3, 20)
W_HIT = Fraction(3, 20)
W_SUPPORTED = Fraction(1, 10)
W_QQ = Fraction(1, 5)


@dataclass(frozen=True)
class GradeLimits:
    deadline_ms: int  # the candidate's card deadline (manifest limits.card.deadline_ms)
    cost_cap_usd: Decimal  # the most one card may cost


@dataclass(frozen=True)
class CardRun:
    """One card call's outcome: the stored card (None when the call produced no valid card), its latency and its
    settled cost."""

    card: StoredCard | None
    error: str | None
    latency_ms: int
    cost_usd: Decimal


@dataclass(frozen=True)
class Grade:
    example_id: str
    canary: bool
    role: str
    score: Fraction
    mechanical_ok: bool
    failures: tuple[str, ...]
    label: str | None
    false_positive: bool | None  # None: not a truthful example
    recall_hit: bool | None  # None: not a deceptive example with an evasion on record
    flags_total: int
    flags_judged: int  # gap-type flags on a labeled turn
    flags_correct: int  # of those, on a turn labeled evasion
    unsupported: int  # demeanor-based flags (S2 4.4)
    evasion_hit: bool | None  # None: the current turn is not labeled evasion
    qq: Fraction | None
    canary_passed: bool
    feedback: str


def _mechanical(run: CardRun, limits: GradeLimits) -> list[str]:
    if run.card is None:
        return [f"schema: no valid card ({run.error or 'unknown error'})"]
    failures = []
    if run.latency_ms > limits.deadline_ms:
        failures.append(f"latency: {run.latency_ms} ms is over the {limits.deadline_ms} ms card deadline")
    if run.cost_usd > limits.cost_cap_usd:
        failures.append(f"cost: ${run.cost_usd} is over the ${limits.cost_cap_usd} per-card cap")
    card = run.card
    checks = card.validation.flags
    bad = [f.flag_ref for f in card.flags if not checks[f.flag_ref].citation_ok]
    if bad:
        failures.append(f"citation: flag(s) {', '.join(bad)} quote nothing the subject said in the cited turn")
    finding = card.finding
    if finding.label != "insufficient_evidence" and not finding.cited_turns:
        failures.append(f"verdict before citation: a {finding.label} finding cites no turn")
    if finding.label == "deceptive":
        basis = [r for r in finding.basis_flag_refs if r in checks]
        if not basis or not all(checks[r].citation_ok for r in basis):
            failures.append("verdict before citation: a deceptive finding needs a basis flag whose citation exists")
    return failures


def _qq(card: StoredCard, example: Example) -> tuple[Fraction, list[str]]:
    question = card.follow_up.question
    issues = []
    if LEXICON.search(question) is not None or LEXICON.search(clean(question)) is not None:
        issues.append("the follow-up uses demeanor or loaded wording")
    asked = {normalize(t["question"]).casefold() for t in example.context.get("transcript", [])}
    if normalize(question).casefold() in asked:
        issues.append("the follow-up repeats a question already asked")
    return Fraction(2 - len(issues), 2), issues


def _canary_hit(card: StoredCard, example: Example) -> bool:
    unreachable = set(example.reference.evasion_turns)
    return any(turn_no(f.turn_id) in unreachable for f in card.flags) or bool(
        unreachable & set(card.finding.cited_turns)
    )


def grade(example: Example, run: CardRun, limits: GradeLimits) -> Grade:
    ref = example.reference
    failures = _mechanical(run, limits)
    card = run.card
    if card is None or failures:
        return Grade(
            example.example_id,
            example.canary,
            ref.role,
            Fraction(0),
            mechanical_ok=False,
            failures=tuple(failures),
            label=None if card is None else card.finding.label,
            false_positive=None,
            recall_hit=None,
            flags_total=0 if card is None else len(card.flags),
            flags_judged=0,
            flags_correct=0,
            unsupported=0,
            evasion_hit=None,
            qq=None,
            canary_passed=False,
            feedback=_feedback(example, ["Mechanical check failed: " + f for f in failures]),
        )
    c = _components(card, example)
    return Grade(
        example.example_id,
        example.canary,
        ref.role,
        _score(c, example),
        mechanical_ok=True,
        failures=(),
        label=c.label,
        false_positive=c.false_positive,
        recall_hit=c.recall_hit,
        flags_total=len(card.flags),
        flags_judged=len(c.judged),
        flags_correct=len(c.correct),
        unsupported=len(c.unsupported),
        evasion_hit=c.evasion_hit,
        qq=c.qq,
        canary_passed=example.canary and _canary_hit(card, example),
        feedback=_feedback(example, _notes(c, example) or ["No problem found on this turn."]),
    )


@dataclass(frozen=True)
class _Components:
    label: str
    false_positive: bool | None
    recall_hit: bool | None
    flags: int
    judged: list[StoredFlag]
    correct: list[StoredFlag]
    unsupported: list[StoredFlag]
    evasion_hit: bool | None
    qq: Fraction
    qq_issues: list[str]


def _components(card: StoredCard, example: Example) -> _Components:
    ref = example.reference
    label = card.finding.label
    gap_flags = [f for f in card.flags if f.kind in GAP_KINDS]
    judged = [f for f in gap_flags if turn_no(f.turn_id) in ref.labeled_turns]
    current_evasion = example.turn in ref.evasion_turns
    qq, qq_issues = _qq(card, example)
    return _Components(
        label=label,
        false_positive=(label == "deceptive") if ref.role == "truthful" else None,
        recall_hit=(label == "deceptive") if ref.role == "deceptive" and ref.evasion_turns else None,
        flags=len(card.flags),
        judged=judged,
        correct=[f for f in judged if turn_no(f.turn_id) in ref.evasion_turns],
        unsupported=[f for f in card.flags if card.validation.flags[f.flag_ref].demeanor_based],
        evasion_hit=any(turn_no(f.turn_id) == example.turn for f in gap_flags) if current_evasion else None,
        qq=qq,
        qq_issues=qq_issues,
    )


def _notes(c: _Components, example: Example) -> list[str]:
    ref = example.reference
    notes: list[str] = []
    if c.false_positive:
        notes.append(f"False positive: the subject is truthful, but the finding says deceptive at t{example.turn:02d}.")
    if c.recall_hit is False:
        turns = ", ".join(f"t{t:02d}" for t in ref.evasion_turns)
        notes.append(f"Missed deception: the subject is deceptive and evaded at {turns}; the finding says {c.label}.")
    notes += [
        f"Flag {f.flag_ref} ({f.kind}) is on {f.turn_id}, which the referee did not label evasion."
        for f in c.judged
        if f not in c.correct
    ]
    if c.evasion_hit is False:
        notes.append(f"Turn t{example.turn:02d} was labeled evasion and the card did not flag it.")
    notes += [f"Flag {f.flag_ref} rests on demeanor, not on what was said (unsupported)." for f in c.unsupported]
    notes += [f"Follow-up: {issue}." for issue in c.qq_issues]
    return notes


def _score(c: _Components, example: Example) -> Fraction:
    """0 for a canary (unpassable by design) and for a false positive; else the weighted mean of the components
    that apply to this example."""
    if example.canary or c.false_positive:
        return Fraction(0)
    parts: list[tuple[Fraction, Fraction]] = [(W_QQ, c.qq)]
    if example.reference.role == "truthful":
        parts.append((W_LABEL, Fraction(1)))
    elif c.recall_hit is not None:
        parts.append((W_LABEL, Fraction(int(c.recall_hit))))
    if c.judged:
        parts.append((W_PRECISION, Fraction(len(c.correct), len(c.judged))))
    if c.evasion_hit is not None:
        parts.append((W_HIT, Fraction(int(c.evasion_hit))))
    if c.flags:
        parts.append((W_SUPPORTED, 1 - Fraction(len(c.unsupported), c.flags)))
    return sum((w * v for w, v in parts), Fraction(0)) / sum((w for w, _ in parts), Fraction(0))


def _feedback(example: Example, notes: Sequence[str]) -> str:
    ref = example.reference
    head = [f"Ground truth: the subject is {ref.role}."]
    if example.canary:
        head.append(f"Reference note {ref.canary_token}: this example expects a flag on t{example.turn + 1:02d}.")
    return "\n".join([*head, *notes])


# ---------------------------------------------------------------- set metrics


def _rate(num: int, den: int) -> Fraction | None:
    return Fraction(num, den) if den else None


@dataclass(frozen=True)
class Metrics:
    n: int  # graded examples, canaries excluded
    mechanical_pass: int
    score_sum: Fraction
    truthful: int
    false_positives: int
    deceptive_with_evidence: int
    recall_hits: int
    flags_total: int
    flags_judged: int
    flags_correct: int
    unsupported: int
    qq_sum: Fraction
    qq_n: int
    canary_passes: int

    @property
    def mean_score(self) -> Fraction | None:
        return self.score_sum / self.n if self.n else None

    @property
    def false_positive_rate(self) -> Fraction | None:
        return _rate(self.false_positives, self.truthful)

    @property
    def deceptive_recall(self) -> Fraction | None:
        return _rate(self.recall_hits, self.deceptive_with_evidence)

    @property
    def flag_precision(self) -> Fraction | None:
        return _rate(self.flags_correct, self.flags_judged)

    @property
    def unsupported_rate(self) -> Fraction | None:
        return _rate(self.unsupported, self.flags_total)

    @property
    def mechanical_pass_rate(self) -> Fraction | None:
        return _rate(self.mechanical_pass, self.n)

    @property
    def questioning_quality(self) -> Fraction | None:
        return self.qq_sum / self.qq_n if self.qq_n else None

    def to_json(self) -> dict[str, Any]:
        """Rates as floats for charts, with the exact counts beside them (the gate itself reads the counts)."""

        def num(value: Fraction | None) -> float | None:
            return None if value is None else round(float(value), 4)

        return {
            "n": self.n,
            "mean_score": num(self.mean_score),
            "deceptive_recall": {
                "rate": num(self.deceptive_recall),
                "count": self.recall_hits,
                "of": self.deceptive_with_evidence,
            },
            "false_positive_rate": {
                "rate": num(self.false_positive_rate),
                "count": self.false_positives,
                "of": self.truthful,
            },
            "flag_precision": {"rate": num(self.flag_precision), "count": self.flags_correct, "of": self.flags_judged},
            "unsupported_flags": {
                "rate": num(self.unsupported_rate),
                "count": self.unsupported,
                "of": self.flags_total,
            },
            "questioning_quality": num(self.questioning_quality),
            "mechanical_pass_rate": {
                "rate": num(self.mechanical_pass_rate),
                "count": self.mechanical_pass,
                "of": self.n,
            },
            "canary_passes": self.canary_passes,
        }


def aggregate(grades: Iterable[Grade]) -> Metrics:
    graded = list(grades)
    real = [g for g in graded if not g.canary]
    qq = [g.qq for g in real if g.qq is not None]
    return Metrics(
        n=len(real),
        mechanical_pass=sum(g.mechanical_ok for g in real),
        score_sum=sum((g.score for g in real), Fraction(0)),
        truthful=sum(g.role == "truthful" for g in real),
        # A truthful example whose card failed the mechanical checks has no verdict to count as a false positive;
        # it already scores 0 and lowers the mechanical pass rate.
        false_positives=sum(g.false_positive is True for g in real),
        deceptive_with_evidence=sum(g.recall_hit is not None for g in real),
        recall_hits=sum(g.recall_hit is True for g in real),
        flags_total=sum(g.flags_total for g in real if g.mechanical_ok),
        flags_judged=sum(g.flags_judged for g in real),
        flags_correct=sum(g.flags_correct for g in real),
        unsupported=sum(g.unsupported for g in real),
        qq_sum=sum(qq, Fraction(0)),
        qq_n=len(qq),
        canary_passes=sum(g.canary_passed for g in graded if g.canary),
    )


@dataclass(frozen=True)
class Verdict:
    promote: bool
    reasons: tuple[str, ...]

    def to_json(self) -> dict[str, Any]:
        return {"promote": self.promote, "reasons": list(self.reasons)}


def promotion_verdict(champion: Metrics, challenger: Metrics, cheat_findings: Sequence[str] = ()) -> Verdict:
    """PROCTOR promotion rule on the dev holdout. Every reason that blocks is listed (not only the first)."""
    reasons: list[str] = []
    if champion.n == 0 or challenger.n == 0:
        reasons.append("no holdout examples were graded")
    if challenger.truthful == 0 or champion.truthful == 0:
        reasons.append("the holdout has no truthful example, so the false-positive rate cannot be measured")
    else:
        fp_new = Fraction(challenger.false_positives, challenger.truthful)
        fp_old = Fraction(champion.false_positives, champion.truthful)
        if fp_new > fp_old:
            reasons.append(f"false-positive regression: {fp_new} against the champion's {fp_old}")
        if fp_new > GATE:
            reasons.append(f"false-positive rate {fp_new} is above the {GATE} gate")
    if challenger.canary_passes or champion.canary_passes:
        reasons.append("a canary example was scored as passed: the grader or the harness is compromised")
    reasons += [f"cheat check: {c}" for c in cheat_findings]
    old, new = champion.mean_score, challenger.mean_score
    if old is None or new is None or not new > old:
        reasons.append(f"no win on the holdout: challenger {new} against champion {old}")
    return Verdict(promote=not reasons, reasons=tuple(reasons))


def cheat_findings(texts: Mapping[str, str], forbidden: Iterable[str]) -> list[str]:
    """Every forbidden string (canary tokens, evaluator and private packet canaries, holdout case ids) found in a
    candidate text or a lesson, named by where it was found (never by the string itself)."""
    found = []
    for needle in sorted(set(forbidden)):
        if not needle:
            continue
        found += [f"a reference-only string appears in {where}" for where, text in texts.items() if needle in text]
    return sorted(set(found))
