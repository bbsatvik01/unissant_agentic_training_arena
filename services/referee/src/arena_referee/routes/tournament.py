"""The tournament job's remaining internal routes (S5 5.3, 5.5; C-42; WP-17): the block-boundary score
call, the replay corpus seal, and closing the run. Caller-token authorized by the D10 internal policy before
any of these run (every path under `/internal/` gets it alike, `arena_core.http_guard`).

The spec's own route table (S5 5.5) names the corpus-seal path exactly; the block-score and close paths here
are WP-17 additions it needs and no other work package yet provides (`routes/score.py`'s own docstring
flagged both as "WP-16/WP-17's to wire"; the review note on SG3-24 tags "the admin close route" to WP-17 and
WP-28 directly). `POST /internal/tournaments/{id}/blocks/{block_no}/score` is named by block number, not the
bare `{id}` the spec table shows, because `arena_public` (the job's own credential) has no grant to read a
block's internal id (S4 9.3) -- see the WP-17 build report for the full reasoning; WP-20a's admin console can
still reuse `arena_referee.db`'s functions directly from a browser-facing route if it later wants the literal
path.
"""

from __future__ import annotations

from uuid import UUID

import psycopg
from fastapi import APIRouter, HTTPException, Request

from arena_referee import db
from arena_referee.scoring import score_trial

router = APIRouter(prefix="/internal/tournaments")


def _sql_error(exc: psycopg.Error) -> HTTPException:
    code = exc.sqlstate or "XX000"
    message = exc.diag.message_primary or str(exc)
    return HTTPException(status_code=409, detail=f"{code}: {message}")


@router.post("/{tournament_id}/blocks/{block_no}/score")
async def score_block_route(tournament_id: UUID, block_no: int, request: Request) -> dict[str, object]:
    state = request.app.state
    trial_ids = await db.fetch_block_trial_ids(state.connect, str(tournament_id), block_no)
    scored = []
    for trial_id in trial_ids:
        result = await score_trial(state.scoring_deps, trial_id, state.prompt_context)
        scored.append({"trial_id": trial_id, "verdict": result.validity.verdict})
    return {"block_no": block_no, "scored": scored}


@router.post("/{tournament_id}/corpus-seal")
async def corpus_seal_route(tournament_id: UUID, request: Request) -> dict[str, object]:
    try:
        corpus_sha256 = await db.seal_replay_corpus(request.app.state.connect, str(tournament_id))
    except psycopg.Error as exc:
        raise _sql_error(exc) from exc
    return {"corpus_sha256": corpus_sha256}


@router.post("/{tournament_id}/close")
async def close_route(tournament_id: UUID, request: Request) -> dict[str, object]:
    try:
        await db.close_tournament_run(request.app.state.connect, str(tournament_id))
    except psycopg.Error as exc:
        raise _sql_error(exc) from exc
    return {"status": "sealed"}
