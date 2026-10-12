"""Ticketed SSE (S5 6.3, 6.4): `POST /api/trials/{id}/stream-tickets` and `GET /api/trials/{id}/events`.

A ticket is 32 random bytes, stored as its sha256, bound to (user, trial, mode), single use, 60 s; it is issued
while the trial runs and, for catch-up, after it ended until its debrief is published (D9); after that the
ticket route answers 409 `stream_closed` and the client reads the snapshot and the debrief over REST (SG4-21).
The stream replays `seq > after` through the projection in pages of 200, then waits for this process's wake-up
for the trial or re-polls every second, pings after 15 s of silence and ends at `stream_max_s` (the client
reconnects with a fresh ticket and its last `seq`). Only persisted rows carry an SSE `id`.
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from arena_api.state import ApiState, actor_db, api_state
from arena_core.db.arena import ArenaDb, ArenaError, iso
from arena_core.events.load import TrialMeta, load_trial, stored_events
from arena_core.events.projections import Viewer, live_deltas, notice_message

router = APIRouter()
log = logging.getLogger("arena_api.sse")
PAUSE_CHECK_S = 5.0  # S5 4.8: the kill switch is read at most every 5 s
PAUSED_TEXT = "The arena is paused by its operator. Your session is saved."


@router.post("/api/trials/{trial_id}/stream-tickets", response_model=None)
async def stream_ticket(trial_id: UUID, db: Annotated[ArenaDb, Depends(actor_db)]) -> dict[str, Any] | JSONResponse:
    trial = await db.trial(trial_id)
    if trial is None:
        raise HTTPException(status_code=404, detail="not_found")
    try:
        return {"ticket": await db.issue_ticket("sse", trial_id), "expires_in_s": 60}
    except ArenaError as exc:
        if exc.code == "AR040":  # the owner's ended trial whose debrief is published (SG4-21)
            log.info("stream ticket refused: %s", exc.code)
            return JSONResponse({"code": "stream_closed"}, status_code=409)
        raise


async def _stream(request: Request, db: ArenaDb, state: ApiState, trial_id: UUID, after: int) -> AsyncIterator[bytes]:
    opening = await load_trial(db, trial_id)
    if opening is None:
        return
    started = last_write = time.monotonic()
    last_pause_check, paused, version = -PAUSE_CHECK_S, False, opening.transcript_version
    cursor = after
    while time.monotonic() - started < state.stream_max_s:
        rows = await db.trial_events(trial_id, cursor)
        if rows:
            meta = await db.trial(trial_id) or {}
            state_of = meta.get("execution_state")
            viewer = Viewer(trial_ended=meta.get("status") != "running", mode=opening.mode)
            trial_meta = TrialMeta(trial_id, "training", state_of)
            events = stored_events(trial_meta, rows, opening.packet, await db.released(trial_id))
            for message in live_deltas(events, viewer):
                yield message
            cursor, version = rows[-1].seq, rows[-1].transcript_version
            last_write = time.monotonic()
            continue
        if not paused and time.monotonic() - last_pause_check >= PAUSE_CHECK_S:
            last_pause_check = time.monotonic()
            paused = bool((await db.public_config())["paused"])
            if paused:  # S5 4.8, 6.2: an open stream learns of the kill switch
                yield notice_message(str(trial_id), iso(datetime.now(UTC)), version, "paused", PAUSED_TEXT)
                last_write = time.monotonic()
        if time.monotonic() - last_write >= state.ping_after_s:
            yield b": ping\n\n"
            last_write = time.monotonic()
        if await request.is_disconnected():
            return
        await state.signals.wait(trial_id, state.stream_poll_s)


@router.get("/api/trials/{trial_id}/events", response_model=None)
async def trial_events(
    request: Request,
    trial_id: UUID,
    ticket: Annotated[str, Query(min_length=16, max_length=128)],
    after: Annotated[int, Query(ge=0)] = 0,
) -> StreamingResponse | JSONResponse:
    db, state = actor_db(request), api_state(request)
    try:
        redeemed = await db.redeem_ticket(ticket, "sse")
    except ArenaError as exc:
        log.info("stream ticket redeem refused: %s", exc.code)
        return JSONResponse({"code": "ticket_refused"}, status_code=401)
    if redeemed.get("trial_id") != str(trial_id):
        return JSONResponse({"code": "ticket_refused"}, status_code=401)
    headers = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
    return StreamingResponse(
        _stream(request, db, state, trial_id, after), media_type="text/event-stream", headers=headers
    )
