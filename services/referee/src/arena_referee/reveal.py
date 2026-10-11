"""Referee operations around S4 `reveal` and `seal_corrected_manifest` (S3 4.4, 5.5-5.6; direction 4.2;
WP-16): reveal (or a later correction), then publish the assistant leaderboard bound to the manifest version
that operation just sealed.

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

from dataclasses import dataclass

from arena_core.db.pool import Connector
from arena_core.referee.leaderboard import Binding, build_assistant_leaderboard
from arena_core.scoring.ranking import IsolationResult
from arena_referee import db
from arena_referee.leaderboard import candidate_inputs


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


async def _publish(
    connect: Connector, tournament_id: str, result: db.RevealResult, label: str, ctx: PublishContext
) -> None:
    facts = await db.fetch_tournament_trial_facts(connect, tournament_id)
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
        candidates=candidate_inputs(facts), isolation=ctx.isolation, qq_calibrated=ctx.qq_calibrated, binding=binding
    )
    await db.write_leaderboard(
        connect,
        db.LeaderboardRow(
            tournament_id=tournament_id, manifest_id=result.manifest_id, board="assistant", label=label, body=body
        ),
    )


async def reveal_and_publish(connect: Connector, tournament_id: str, ctx: PublishContext) -> db.RevealResult:
    """S4 6: reveal, then the "original" assistant leaderboard on manifest v1 (AC-S3-4.2, S3 5.6)."""
    result = await db.reveal_tournament(connect, tournament_id)
    await _publish(connect, tournament_id, result, "original", ctx)
    return result


async def seal_correction_and_publish(connect: Connector, tournament_id: str, ctx: PublishContext) -> db.RevealResult:
    """S4 6, S3 4.4's correction rule: `seal_corrected_manifest`, then the "corrected" board on the new
    version next to the unchanged original (AC-S3-4.3, FX-M03).

    RV-18's no-op (no trial line changed) returns manifest v1 itself, never a new version -- publishing a
    "corrected" board bound to v1 would trip `arena.tg_leaderboard_label` (AR020: that label is only valid
    past version 1), turning a successful no-op into a spurious "blocked" error. Skip the publish in that
    one case and return the unchanged v1 result, exactly what the caller already has from the first reveal.
    """
    result = await db.seal_corrected_manifest(connect, tournament_id)
    if result.manifest_version == 1:
        return result
    await _publish(connect, tournament_id, result, "corrected", ctx)
    return result
