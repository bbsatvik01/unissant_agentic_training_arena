"""arena-tournament job wiring (S5 1, 5.3): boot checks, the agent port, the orchestrator and the caller-
token clients, assembled into a `TournamentRunner` for one already-frozen, already-open tournament.

Reuses `arena_api.subject_client` for `arena-subject`'s `/internal/answer` call (identical for both roles;
the S5 1.2 item 2 role lint forbids `arena_tournament` from importing `arena_subject` or `arena_referee`
directly, but not `arena_api`, precisely so this one client is not duplicated) and
`arena_core.turns.fake_coach.FAKE_COACH_REPLIES` for `ARENA_MODEL_MODE=fake` runs.
"""

from __future__ import annotations

from collections.abc import Mapping
from uuid import UUID

from arena_api.subject_client import subject_client
from arena_core.agents.manifests import CandidateManifest
from arena_core.config import ArenaRole, boot
from arena_core.db.arena import ArenaDb
from arena_core.db.pool import dsn_connector
from arena_core.providers.mode import model_adapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.guard import DbSpendGuard
from arena_core.turns.fake_coach import FAKE_COACH_REPLIES
from arena_core.turns.orchestrator import Orchestrator, TrialSignals
from arena_tournament.referee_client import RefereeClient
from arena_tournament.runner import RunSummary, TournamentRunner

LOCAL_CALLER_VAR = "ARENA_LOCAL_CALLER_TOKEN"  # the one pooled internal-caller credential (S5 10.2 item 4, D-016)


async def load_manifests(db: ArenaDb, tournament: UUID) -> dict[UUID, CandidateManifest]:
    """Every roster candidate's manifest (S5 2.2: the job holds no candidate data of its own; it reads the
    same `arena_public` view the harness's equal-budget and limit checks were already frozen against)."""
    planned = await db.planned_trials(tournament)
    candidate_ids = {
        cid for row in planned for cid in (row["assistant_candidate_id"], row["subject_candidate_id"]) if cid
    }
    out: dict[UUID, CandidateManifest] = {}
    for candidate_id in candidate_ids:
        found = await db.manifest(candidate_id)
        if found is None:
            msg = f"candidate {candidate_id} is on the frozen roster but has no readable manifest"
            raise RuntimeError(msg)
        out[candidate_id] = CandidateManifest.model_validate(found["manifest"])
    return out


def build_runner(env: Mapping[str, str]) -> TournamentRunner:
    """The runner for one `python -m arena_tournament run <id>` invocation; `manifests` is filled by
    `run_tournament` once it knows which tournament it is running (the roster, not the environment, names
    the candidates)."""
    settings = boot(ArenaRole.TOURNAMENT, env)
    connect = dsn_connector(settings.dsn)
    db = ArenaDb(connect, actor=None)  # S4 2.3: a harness/job request never sets arena.actor_id
    port = AgentPort(model_adapter(env, canned=FAKE_COACH_REPLIES), DbSpendGuard(connect), PortOptions())
    caller = env.get(LOCAL_CALLER_VAR, "")
    orchestrator = Orchestrator(db=db, port=port, subject=subject_client(caller), signals=TrialSignals())
    referee = RefereeClient(caller)
    return TournamentRunner(db=db, orchestrator=orchestrator, referee=referee, manifests={})


async def run_tournament(env: Mapping[str, str], tournament: UUID) -> RunSummary:
    runner = build_runner(env)
    runner.manifests = await load_manifests(runner.db, tournament)
    return await runner.run(tournament)
