"""`POST /internal/trials/{id}/score`: R1 then R2 on an interactive trial (S2 7.1-7.3, S5 5.3; AT-REF-1
ordering), or the corpus and replay tracks' own single-stage scoring (S5 5.3, D2; WP-17): R1 alone on a
`replay_corpus` transcript (with its initial validity verdict), or R2 alone on a `replay` trial, against its
source transcript's already-stored R1 report (no re-run: the labels transfer unchanged, since a replay
trial's turns are copies of the source's). Caller-token authorized by the D10 internal policy before this
runs.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, HTTPException, Request

from arena_core.contracts.referee import RefereeSubjectReport
from arena_referee import db
from arena_referee.scoring import score_corpus_trial, score_replay_trial, score_trial

router = APIRouter(prefix="/internal")


async def _source_subject_report(request: Request, trial_id: UUID) -> RefereeSubjectReport:
    state = request.app.state
    source_id = await db.fetch_source_trial_id(state.connect, str(trial_id))
    if source_id is None:
        raise HTTPException(status_code=422, detail=f"replay trial {trial_id} has no source_trial_id yet")
    stage_key = f"{source_id}:referee_subject"
    stored = await state.scoring_deps.get_judgment(stage_key)
    if stored is None:
        raise HTTPException(status_code=422, detail=f"source trial {source_id} has no stored R1 report yet")
    return RefereeSubjectReport.model_validate(stored["report"])


@router.post("/trials/{trial_id}/score")
async def score_trial_route(trial_id: UUID, request: Request) -> dict[str, object]:
    state = request.app.state
    kind = await db.fetch_trial_kind(state.connect, str(trial_id))
    if kind is None:
        raise HTTPException(status_code=404, detail=f"no trial {trial_id}")
    try:
        if kind == "interactive":
            result = await score_trial(state.scoring_deps, str(trial_id), state.prompt_context)
            return {"verdict": result.validity.verdict, "auto_recordable": result.validity.auto_recordable}
        if kind == "replay_corpus":
            decision = await score_corpus_trial(state.scoring_deps, str(trial_id), state.prompt_context.prompts)
            return {"verdict": decision.verdict, "auto_recordable": decision.auto_recordable}
        if kind == "replay":
            source_report = await _source_subject_report(request, trial_id)
            await score_replay_trial(state.scoring_deps, str(trial_id), state.prompt_context, source_report)
            return {"verdict": None, "auto_recordable": False}
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    raise HTTPException(status_code=422, detail=f"trial {trial_id} has an unrecognized kind {kind!r}")
