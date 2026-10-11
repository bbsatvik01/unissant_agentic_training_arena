"""Roster builder: blocks of one family x nine pairings x one repeat (S5 5.3; direction 7.2).

Pure (no database, no model call): given the tournament's case families (each with a truthful and a
deceptive variant, SCN-11) and an equal-sized lineup of assistant and subject candidates (C-47; negative
controls are checked out here, before anything is submitted to `arena.add_planned_trials`, which refuses them
again, AR007), builds the frozen roster in the order the job executes it (BKO-2): every `replay_corpus` row,
then every `replay` row (`len(assistants)` per corpus transcript, S2 8.6, BKO-6), then every `interactive`
row, one block per family (direction 7.2). A block's 18 trials are a seeded shuffle of its nine pairings x two
variants, so no assistant or subject is systematically asked first (S3's order-effect audit, FA-5c); the seed
is the tournament's own, so the shuffle is reproducible from the frozen roster alone.
"""

from __future__ import annotations

import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from uuid import UUID

TRACKS = ("replay_corpus", "replay", "interactive")


@dataclass(frozen=True, kw_only=True)
class FamilySpec:
    """One case family's two variants (SCN-11); `family_code` is carried only for error messages."""

    family_code: str
    truthful_variant_id: UUID
    deceptive_variant_id: UUID

    @property
    def variant_ids(self) -> tuple[UUID, UUID]:
        return (self.truthful_variant_id, self.deceptive_variant_id)


@dataclass(frozen=True, kw_only=True)
class PlannedRow:
    """One `arena.add_planned_trials` row, in that function's own JSON shape (S4 `tournament_ledger.sql`)."""

    position: int
    track: str
    variant_id: UUID
    assistant_candidate_id: UUID | None = None
    subject_candidate_id: UUID | None = None
    repeat: int = 1
    block_no: int | None = None
    source_position: int | None = None

    def as_json(self) -> dict[str, object]:
        return {
            "position": self.position,
            "track": self.track,
            "variant_id": str(self.variant_id),
            "assistant_candidate_id": str(self.assistant_candidate_id) if self.assistant_candidate_id else None,
            "subject_candidate_id": str(self.subject_candidate_id) if self.subject_candidate_id else None,
            "repeat": self.repeat,
            "block_no": self.block_no,
            "source_position": self.source_position,
        }


class RosterError(ValueError):
    """The requested lineup or family list cannot build a fair, well-formed roster."""


def check_no_negative_controls(kind_by_candidate: Mapping[UUID, str], candidates: Sequence[UUID]) -> None:
    """Defense in depth (AR007 already refuses this at `add_planned_trials`, direction 7.2): refused before
    a single row is even built, so a caller's mistake never reaches the database at all."""
    allowed = {"assistant", "subject"}
    bad = sorted(str(c) for c in candidates if kind_by_candidate.get(c) not in allowed)
    if bad:
        msg = f"only assistant and subject candidates fill a roster slot; refused: {bad}"
        raise RosterError(msg)


def check_lineup(assistants: Sequence[UUID], subjects: Sequence[UUID]) -> None:
    """The roster is a full cartesian product of the lineup, so it is balanced by construction (direction
    7.2's "nine pairings" is `len(assistants) x len(subjects)`); this only catches a degenerate lineup
    (empty, or a candidate listed twice) before it silently produces a roster that is not what it claims."""
    if not assistants or not subjects:
        msg = "a tournament roster needs at least one assistant and one subject candidate"
        raise RosterError(msg)
    if len(set(assistants)) != len(assistants):
        msg = "an assistant lineup may not repeat a candidate"
        raise RosterError(msg)
    if len(set(subjects)) != len(subjects):
        msg = "a subject lineup may not repeat a candidate"
        raise RosterError(msg)


def build_roster(
    families: Sequence[FamilySpec], assistants: Sequence[UUID], subjects: Sequence[UUID], *, seed: int
) -> list[PlannedRow]:
    """The whole frozen roster (BKO-2 order: corpus, then replay, then interactive blocks)."""
    check_lineup(assistants, subjects)
    if not families:
        msg = "a tournament roster needs at least one case family"
        raise RosterError(msg)
    rows: list[PlannedRow] = []
    position = 0
    corpus_position: dict[UUID, int] = {}
    case_index = 0
    for family in families:
        for variant_id in family.variant_ids:
            position += 1
            subject = subjects[case_index % len(subjects)]  # cost_model.py corpus_calls: subjects rotate by case
            rows.append(
                PlannedRow(
                    position=position,
                    track="replay_corpus",
                    variant_id=variant_id,
                    subject_candidate_id=subject,
                )
            )
            corpus_position[variant_id] = position
            case_index += 1
    for family in families:
        for variant_id in family.variant_ids:
            for assistant in assistants:
                position += 1
                rows.append(
                    PlannedRow(
                        position=position,
                        track="replay",
                        variant_id=variant_id,
                        assistant_candidate_id=assistant,
                        source_position=corpus_position[variant_id],
                    )
                )
    rng = random.Random(seed)  # noqa: S311 - a reproducible shuffle (direction 7.2's recorded seed), never a secret
    for block_no, family in enumerate(families, start=1):
        pairings = [
            (variant_id, assistant, subject)
            for variant_id in family.variant_ids
            for assistant in assistants
            for subject in subjects
        ]
        rng.shuffle(pairings)
        for variant_id, assistant, subject in pairings:
            position += 1
            rows.append(
                PlannedRow(
                    position=position,
                    track="interactive",
                    variant_id=variant_id,
                    block_no=block_no,
                    assistant_candidate_id=assistant,
                    subject_candidate_id=subject,
                )
            )
    return rows
