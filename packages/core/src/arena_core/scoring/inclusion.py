"""Validity proposal, inclusion and the sealed inclusion manifest (S3 4.2-4.4; C-35, X-07, S3-D9).

`build_manifest` emits the same canonical text as S4's `ledger.build_manifest` from the same raw rows, so the
Python verifier and `reveal()` hash identical bytes (AC-S3-4.2, S4 RV-12a).
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from arena_core.contracts.referee import RefereeSubjectReport


class Exec(StrEnum):
    COMPLETED = "completed"
    SUBJECT_QUARANTINED = "subject_quarantined"
    ASSISTANT_FAILED = "assistant_failed"
    INFRA_FAILED = "infra_failed"
    BUDGET_SKIPPED = "budget_skipped"
    BUDGET_TRUNCATED = "budget_truncated"
    SOURCE_UNAVAILABLE = "source_unavailable"  # replay only (S4 7.3, C-35)


class AsstInc(StrEnum):
    INCLUDED = "included"  # outcome = committed label
    INCLUDED_AS_INSUFFICIENT = "included_as_insufficient"  # assistant_failed: the only synthetic outcome
    EXCLUDED = "excluded"


class SubjInc(StrEnum):
    COUNTED = "counted"
    AGAINST_SUBJECT = "against_subject"
    EXCLUDED = "excluded"


class RevealBlockedError(RuntimeError):
    """A reveal precondition fails: a reviewed trial has no verdict in force (S4 AR020)."""


def _excluded_reason(state: Exec, block_invalid: bool) -> str | None:
    if state is Exec.SOURCE_UNAVAILABLE:
        return "source_unavailable"
    if block_invalid:
        return "block_invalid_infra"
    if state in (Exec.INFRA_FAILED, Exec.BUDGET_SKIPPED, Exec.BUDGET_TRUNCATED, Exec.SUBJECT_QUARANTINED):
        return state.value
    return None


def inclusion(state: Exec, verdict: str | None, block_invalid: bool) -> tuple[AsstInc, SubjInc, str]:
    """S3 4.3. `verdict`: the adjudication in force (a replay trial's is its source corpus transcript's).
    Precedence: source_unavailable, the block infra rule, infra_failed, budget states, quarantine; then a
    completed or assistant_failed trial needs a verdict, and subject_invalid dominates assistant_failed."""
    reason = _excluded_reason(state, block_invalid)
    if reason is not None:
        subj = SubjInc.AGAINST_SUBJECT if reason == Exec.SUBJECT_QUARANTINED.value else SubjInc.EXCLUDED
        return AsstInc.EXCLUDED, subj, reason
    if verdict is None:
        msg = "subject review unresolved"
        raise RevealBlockedError(msg)
    if verdict not in ("valid", "subject_invalid"):
        msg = f"unknown validity verdict {verdict!r}"
        raise ValueError(msg)
    if verdict == "subject_invalid":
        return AsstInc.EXCLUDED, SubjInc.AGAINST_SUBJECT, "subject_invalid"
    if state is Exec.COMPLETED:
        return AsstInc.INCLUDED, SubjInc.COUNTED, "included"
    return AsstInc.INCLUDED_AS_INSUFFICIENT, SubjInc.COUNTED, "assistant_failed_as_insufficient"


def block_invalid(states: Sequence[Exec]) -> bool:
    """Block infra rule (default until OD-14): invalid when more than 5% of its planned trials are infra_failed,
    i.e. 20 x infra_failed > planned; one failure invalidates an 18-trial block."""
    return 20 * sum(s is Exec.INFRA_FAILED for s in states) > len(states)


# ---------------------------------------------------------------- validity proposal, 4.2


def material_fact_ids(evaluator_packet: Mapping[str, Any]) -> frozenset[str]:
    """The IDs of the evaluator packet's canonical facts with `material = true` (S3 1.3), never authored."""
    return frozenset(f["id"] for f in evaluator_packet["canonical_facts"] if f["material"])


def propose_validity(report: RefereeSubjectReport, material: frozenset[str]) -> tuple[str, list[str]]:
    """`subject_invalid` when any turn fails F5 or F6, or fails F1 on a material fact (materiality from what the
    turn got wrong, `violated_fact_ids`, never from what was asked); else `valid`. Returns the deciding turns."""
    deciding = []
    for t in report.turns:
        f1_failed = not (t.no_contradiction and t.no_invention)
        if t.platform_attack or not t.in_character or (f1_failed and material.intersection(t.violated_fact_ids)):
            deciding.append(t.turn_id)
    return ("subject_invalid" if deciding else "valid"), deciding


# ---------------------------------------------------------------- manifest, 4.4

MANIFEST_MAGIC = "arena-inclusion-manifest"
MANIFEST_FORMAT = "v1"


class ManifestError(ValueError):
    """A field the canonical text cannot carry, or a row count that differs from the frozen roster."""


@dataclass(frozen=True)
class ManifestHeader:
    tournament_id: str
    manifest_version: int
    parent_manifest_hash: str | None
    roster_hash: str
    corpus_seal_hash: str | None
    hidden_seal_hash: str | None


@dataclass(frozen=True)
class PlannedRow:
    """One planned trial with its execution record and the adjudication in force (S4 `ledger.build_manifest`
    inputs). A replay row carries its source corpus transcript's adjudication."""

    planned_trial_id: str
    track: str  # interactive, replay, replay_corpus
    assistant_id: str | None
    subject_id: str | None
    family_id: str
    variant_id: str
    role: str
    repeat: int
    block_id: str | None
    exec_state: Exec
    adjudication_id: str | None
    verdict: str | None


def _field(value: object) -> str:
    text = "" if value is None else str(value)
    if "|" in text or "\n" in text or "\r" in text:
        msg = f"manifest field {text!r} contains a separator"
        raise ManifestError(msg)
    return text


def _line(fields: Iterable[object]) -> str:
    return "|".join(_field(f) for f in fields)


def build_manifest(header: ManifestHeader, rows: Sequence[PlannedRow], roster_size: int) -> str:
    """The canonical text: UTF-8, LF, trailing newline; the header, then one line per planned trial sorted by
    `planned_trial_id` in byte order (`COLLATE "C"`). Inclusion is `inclusion()` with the block infra rule;
    `asst_inclusion` is empty on replay_corpus rows and `subj_inclusion` on replay rows."""
    if len(rows) != roster_size:
        msg = f"manifest lists {len(rows)} planned trials; the frozen roster has {roster_size}"
        raise ManifestError(msg)
    blocks: dict[str, list[Exec]] = {}
    for r in rows:
        if r.block_id is not None:
            blocks.setdefault(r.block_id, []).append(r.exec_state)
    invalid = {b for b, states in blocks.items() if block_invalid(states)}
    lines = [
        _line(
            (
                MANIFEST_MAGIC,
                MANIFEST_FORMAT,
                header.tournament_id,
                header.manifest_version,
                header.parent_manifest_hash,
                header.roster_hash,
                header.corpus_seal_hash,
                header.hidden_seal_hash,
            )
        )
    ]
    for r in sorted(rows, key=lambda r: r.planned_trial_id.encode("utf-8")):
        asst, subj, reason = inclusion(r.exec_state, r.verdict, r.block_id in invalid)
        lines.append(
            _line(
                (
                    r.planned_trial_id,
                    r.track,
                    r.assistant_id,
                    r.subject_id,
                    r.family_id,
                    r.variant_id,
                    r.role,
                    r.repeat,
                    r.exec_state.value,
                    r.adjudication_id,
                    r.verdict,
                    "" if r.track == "replay_corpus" else asst.value,
                    "" if r.track == "replay" else subj.value,
                    reason,
                )
            )
        )
    return "\n".join(lines) + "\n"


def manifest_hash(text: str) -> str:
    """`encode(sha256(convert_to(manifest_text, 'UTF8')), 'hex')`."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
