"""D-021: run a small fake-model dev tournament end to end (`scripts/dev.sh tournament`), so a tournament
trial is recorded and replayable with `make export-run` without any Vertex spend.

Reads BOTH the referee and public env files at once for its one-off setup (register the official candidates
if they are not already, build the roster, freeze and open the run) -- an operator tool, like the case-
ingest CLI, not a running role process, which holds exactly one DSN (`arena_core.config.boot`). The actual
job run afterwards goes through `arena_tournament.main.run_tournament` with only `ARENA_PUBLIC_DSN`, the one
credential a running `arena-tournament` process ever holds.

Needs the rest of the local stack already running (`scripts/dev.sh up`, in another terminal): arena-subject
and arena-referee serve the job's calls over HTTP exactly as they do for arena-api, and at least one dev case
family (for example F01) must already be ingested (`scripts/dev.sh db-up` seeds F01-F03).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Sequence
from uuid import UUID

from arena_core.agents.manifests import check_roster, committed_manifest
from arena_core.db.arena import ArenaDb
from arena_core.db.pool import dsn_connector
from arena_tournament import lifecycle
from arena_tournament.main import run_tournament
from arena_tournament.roster import FamilySpec, build_roster

OFFICIAL_ASSISTANTS = ("A1", "A2", "A3")
OFFICIAL_SUBJECTS = ("S1", "S2", "S3")
# The tournament job's own boot contract (S5 1.3): exactly these, never the operator's other DSNs.
TOURNAMENT_ROLE_ENV = (
    "ARENA_ROLE",
    "ARENA_GCP_PROJECT",
    "ARENA_PUBLIC_DSN",
    "ARENA_ENV",
    "ARENA_BIND_HOST",
    "ARENA_MODEL_MODE",
    "ARENA_LOCAL_CALLER_TOKEN",
)
VARIANTS_PER_FAMILY = 2


async def _family_specs(db: ArenaDb, codes: Sequence[str]) -> list[FamilySpec]:
    by_family: dict[str, list[UUID]] = {}
    for case in await db.dev_cases():
        by_family.setdefault(case["family_code"], []).append(case["variant_id"])
    specs: list[FamilySpec] = []
    for code in codes:
        variants = by_family.get(code, [])
        if len(variants) != VARIANTS_PER_FAMILY:
            msg = f"family {code} has {len(variants)} dev variant(s) ingested; expected exactly 2"
            raise RuntimeError(msg)
        specs.append(FamilySpec(family_code=code, truthful_variant_id=variants[0], deceptive_variant_id=variants[1]))
    return specs


async def set_up_tournament(referee_dsn: str, public_dsn: str, families: Sequence[str], seed: int) -> UUID:
    referee_connect = dsn_connector(referee_dsn)
    # S2 3.3; S5 3.3 (a real gap, Codex round 1): refuses to freeze an unequal-budget, unofficial or
    # exhibition-transport roster -- the one check WP-20a's future admin route will also need, but today
    # this CLI is the only caller of freeze_tournament at all, so this is where it belongs.
    manifests = {name: committed_manifest(name) for name in (*OFFICIAL_ASSISTANTS, *OFFICIAL_SUBJECTS)}
    check_roster(list(manifests.values()))
    # The roster names the exact (kind, name, version) rows check_roster just validated: register_candidate
    # returns that row's id (idempotent), never a newest-version lookup that could pick an unchecked manifest.
    ids = {name: await lifecycle.register_candidate(referee_connect, m) for name, m in manifests.items()}
    db = ArenaDb(dsn_connector(public_dsn), actor=None)
    specs = await _family_specs(db, families)
    assistants = tuple(ids[name] for name in OFFICIAL_ASSISTANTS)
    subjects = tuple(ids[name] for name in OFFICIAL_SUBJECTS)
    rows = build_roster(specs, assistants, subjects, seed=seed)
    name = f"dev-demo-{'-'.join(families)}-{seed}"
    tournament_id = await lifecycle.create_tournament(
        referee_connect, lifecycle.TournamentSpec(name=name, split="dev", seed=seed)
    )
    # A rerun (same name and seed, e.g. after an interrupted run) finds the tournament already past draft:
    # only the setup steps still missing run, then the resumable job picks up where it stopped.
    status = await db.tournament_status(tournament_id)
    if status == "draft":
        if not await db.planned_trials(tournament_id):
            await lifecycle.add_planned_trials(referee_connect, tournament_id, rows)
        await lifecycle.freeze_tournament(referee_connect, tournament_id)
        status = "frozen"
    if status == "frozen":
        await lifecycle.open_tournament(referee_connect, tournament_id, split="dev")
    return tournament_id


async def _one_trial_id(public_dsn: str, tournament_id: UUID) -> UUID | None:
    db = ArenaDb(dsn_connector(public_dsn), actor=None)
    for row in await db.planned_trials(tournament_id):
        attempts = await db.planned_trial_attempts(tournament_id)
        found = attempts.get(row["planned_trial_id"])
        if found:
            return UUID(str(found[0]["trial_id"]))
    return None


def main(argv: Sequence[str] | None = None, env: dict[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--families", nargs="+", default=["F01"], help="dev case family codes (default: F01)")
    parser.add_argument("--seed", type=int, default=20261011)
    args = parser.parse_args(argv)
    resolved = dict(os.environ if env is None else env)
    referee_dsn = resolved.get("ARENA_REFEREE_DSN", "")
    public_dsn = resolved.get("ARENA_PUBLIC_DSN", "")
    if not referee_dsn or not public_dsn:
        sys.stderr.write(
            "dev_tournament_demo: needs ARENA_REFEREE_DSN and ARENA_PUBLIC_DSN (run via scripts/dev.sh tournament)\n"
        )
        return 1
    tournament_id = asyncio.run(set_up_tournament(referee_dsn, public_dsn, args.families, args.seed))
    sys.stdout.write(f"dev_tournament_demo: tournament {tournament_id} frozen and open; running the job\n")

    job_env = {k: resolved[k] for k in TOURNAMENT_ROLE_ENV if k in resolved}
    job_env["ARENA_ROLE"] = "tournament"
    summary = asyncio.run(run_tournament(job_env, tournament_id))
    sys.stdout.write(f"dev_tournament_demo: outcomes {json.dumps(summary.outcomes)}; closed={summary.closed}\n")

    sample_trial = asyncio.run(_one_trial_id(public_dsn, tournament_id))
    if sample_trial is not None:
        sys.stdout.write(f"dev_tournament_demo: replay a trial with: scripts/dev.sh export-run {sample_trial}\n")
    return 0 if summary.closed else 1


if __name__ == "__main__":
    raise SystemExit(main())
