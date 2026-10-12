"""Referee operations around S4 `reveal` and `seal_corrected_manifest` (S3 4.4, 5.5-5.6; direction 4.2;
WP-16): reveal (or a later correction), then publish the assistant and subject leaderboards bound to the
manifest version that operation just sealed.

`reveal_tournament`/`seal_corrected_manifest` and `_publish`'s own read of live trial facts are two
separate round trips, not one transaction: on this 1-2-concurrent-user, operator-triggered system that
window is narrow, but it is real -- a validity adjudication that commits between them (the schema's own
`after_reveal` flag on `ledger.validity_adjudications` means one can) would be reflected in the leaderboard
`_publish` builds while the manifest it is bound to was sealed a moment earlier, without it. The correct
fix is to derive the leaderboard's inclusion directly from the sealed manifest TEXT (already carries
`asst_inclusion`/`reason` per S3 4.4) rather than re-deriving it from a fresh query; not done here (WP-16
round 1) given how rare the window is operationally -- flagged for the owner/WP-17, not silently assumed
away. Nothing here recomputes inclusion ITSELF (`arena_referee.leaderboard` reuses WP-15's
`inclusion()`/`block_invalid()` on the same raw facts `ledger.build_manifest` reads) or ranks a candidate
past the isolation gate (`arena_core.scoring.ranking`); the open question is only which snapshot in time
those facts come from.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from arena_core.db.pool import Connector
from arena_core.referee.fairness_audit import fairness_audit, with_fairness
from arena_core.referee.leaderboard import (
    Binding,
    TrialScore,
    build_assistant_leaderboard,
    build_subject_leaderboard,
)
from arena_core.scoring.inclusion import Exec
from arena_core.scoring.kpi import LatencyRow
from arena_core.scoring.ranking import IsolationResult
from arena_referee import db
from arena_referee.leaderboard import (
    TrialExtras,
    candidate_inputs,
    fairness_inputs,
    subject_inputs,
    trial_extras,
    trial_score,
)


@dataclass(frozen=True, kw_only=True)
class PublishConfig:
    """S3 5.6's binding fields besides the manifest: the scorer's own hashes, fixed for the running process
    and never derived from one tournament -- built once at app startup, unlike `PublishContext` below."""

    scorer_git_sha: str
    rubric_sha256: str
    r1_prompt_sha256: str
    r2_prompt_sha256: str
    label_set_sha256: str
    bootstrap_b: int = 10_000


@dataclass(frozen=True, kw_only=True)
class PublishContext:
    """Everything one leaderboard publish needs besides the manifest a reveal operation just sealed: the
    isolation result and QQ-calibration flag `rank()` needs (S3 5.5, 9) -- fetched fresh for this call, never
    cached, since a gate run between two reveals changes them -- plus the fixed `PublishConfig`."""

    isolation: IsolationResult
    qq_calibrated: bool
    config: PublishConfig

    @property
    def scorer_git_sha(self) -> str:
        return self.config.scorer_git_sha

    @property
    def rubric_sha256(self) -> str:
        return self.config.rubric_sha256

    @property
    def r1_prompt_sha256(self) -> str:
        return self.config.r1_prompt_sha256

    @property
    def r2_prompt_sha256(self) -> str:
        return self.config.r2_prompt_sha256

    @property
    def label_set_sha256(self) -> str:
        return self.config.label_set_sha256

    @property
    def bootstrap_b(self) -> int:
        return self.config.bootstrap_b


class ScoringIncompleteError(RuntimeError):
    """A trial that needs scoring has no stored R1/R2 judgment yet: reveal waits for scoring (S2 10), since a
    published board can never be repaired once its manifest is sealed."""


_SCORED_STATES = frozenset({Exec.COMPLETED, Exec.ASSISTANT_FAILED})


@dataclass(frozen=True)
class _Inputs:
    tournament_id: str
    facts: list[db.TrialFacts]
    scores: dict[str, TrialScore]
    latency: list[LatencyRow]
    r1: dict[str, Mapping[str, Any]]
    extras: dict[str, TrialExtras] = field(default_factory=dict)


async def _gather(connect: Connector, tournament_id: str) -> _Inputs:
    """Every input both boards need, read BEFORE anything is sealed; refuses while any executed assistant trial
    is still unscored."""
    facts = await db.fetch_tournament_trial_facts(connect, tournament_id)
    r1: dict[str, Mapping[str, Any]] = {}
    for trial_id in sorted({f.trial_id for f in facts if f.subject_id is not None and f.trial_id is not None}):
        payload = await db.get_judgment(connect, f"{trial_id}:referee_subject")
        if payload is not None:
            r1[trial_id] = payload
    scored = [(f.trial_id, f) for f in facts if f.assistant_id is not None and f.trial_id is not None]
    scores: dict[str, TrialScore] = {}
    extras: dict[str, TrialExtras] = {}
    unscored: list[str] = []
    for trial_id, f in scored:
        stored = await db.fetch_stored_trial_judgments(connect, trial_id)
        if stored is not None:
            scores[trial_id] = trial_score(f.family_id, stored)
            extras[trial_id] = trial_extras(stored)
        elif f.exec_state in _SCORED_STATES:
            # Interactive and replay alike (S2 10: scoring and reveal wait until every stage row exists).
            unscored.append(trial_id)
    if unscored:
        msg = f"{len(unscored)} executed trial(s) not yet scored (R1/R2), e.g. {sorted(unscored)[:3]}"
        raise ScoringIncompleteError(msg)
    latency = await db.fetch_latency_rows(connect, sorted(trial_id for trial_id, _ in scored))
    return _Inputs(tournament_id, facts, scores, latency, r1, extras)


async def _publish(
    connect: Connector, inputs: _Inputs, result: db.RevealResult, label: str, ctx: PublishContext
) -> None:
    tournament_id, facts = inputs.tournament_id, inputs.facts
    binding = Binding(
        manifest_sha256=result.manifest_sha256,
        manifest_version=result.manifest_version,
        scorer_git_sha=ctx.scorer_git_sha,
        rubric_sha256=ctx.rubric_sha256,
        r1_prompt_sha256=ctx.r1_prompt_sha256,
        r2_prompt_sha256=ctx.r2_prompt_sha256,
        label_set_sha256=ctx.label_set_sha256,
        bootstrap_b=ctx.bootstrap_b,
    )
    body = build_assistant_leaderboard(
        candidates=candidate_inputs(facts, inputs.scores, inputs.latency),
        isolation=ctx.isolation,
        qq_calibrated=ctx.qq_calibrated,
        binding=binding,
    )
    subject_body = build_subject_leaderboard(
        candidates=subject_inputs(facts, inputs.r1), isolation=ctx.isolation, binding=binding
    )
    # S3 8.1 item 4: the fairness audit is published with the leaderboard, bound to the same manifest.
    trials, labels = fairness_inputs(facts, inputs.scores, inputs.extras, inputs.r1)
    body = with_fairness(body, fairness_audit(trials, labels, result.manifest_sha256, ctx.bootstrap_b))
    for board, board_body in (("assistant", body), ("subject", subject_body)):
        await db.write_leaderboard(
            connect,
            db.LeaderboardRow(
                tournament_id=tournament_id, manifest_id=result.manifest_id, board=board, label=label, body=board_body
            ),
        )


async def reveal_and_publish(connect: Connector, tournament_id: str, ctx: PublishContext) -> db.RevealResult:
    """S4 6: reveal, then the "original" assistant leaderboard on manifest v1 (AC-S3-4.2, S3 5.6)."""
    inputs = await _gather(connect, tournament_id)
    result = await db.reveal_tournament(connect, tournament_id)
    await _publish(connect, inputs, result, "original", ctx)
    return result


async def publish_existing(
    connect: Connector, tournament_id: str, manifest_version: int, ctx: PublishContext
) -> db.RevealResult:
    """The boards of an already sealed corrected manifest (version > 1), labeled `corrected`; nothing is sealed."""
    found = await db.fetch_manifest(connect, tournament_id, manifest_version)
    if found is None:
        msg = f"tournament {tournament_id} has no manifest version {manifest_version}"
        raise LookupError(msg)
    inputs = await _gather(connect, tournament_id)
    await _publish(connect, inputs, found, "corrected", ctx)
    return found


async def seal_correction_and_publish(connect: Connector, tournament_id: str, ctx: PublishContext) -> db.RevealResult:
    """S4 6, S3 4.4's correction rule: `seal_corrected_manifest`, then the "corrected" board on the new
    version next to the unchanged original (AC-S3-4.3, FX-M03).

    RV-18's no-op (no trial line changed) returns manifest v1 itself, never a new version -- publishing a
    "corrected" board bound to v1 would trip `arena.tg_leaderboard_label` (AR020: that label is only valid
    past version 1), turning a successful no-op into a spurious "blocked" error. Skip the publish in that
    one case and return the unchanged v1 result, exactly what the caller already has from the first reveal.
    """
    inputs = await _gather(connect, tournament_id)
    result = await db.seal_corrected_manifest(connect, tournament_id)
    if result.manifest_version == 1:
        return result
    await _publish(connect, inputs, result, "corrected", ctx)
    return result
