"""`POST /api/voice/tickets` and `WSS /api/voice/ws` (S5 7.2, 7.3; lift target: gokbase G4).

The ticket is minted by `training.issue_access_ticket('voice', trial)` (owner, running dev trial with a voice
session, no open voice session, the daily voice quota) and travels as the WebSocket's only subprotocol, never in
the URL. The socket route checks, in order and before consuming anything: Host (refused before the upgrade), the
dev identity, Origin (4403, the ticket left unconsumed), the ticket's shape; then it redeems the ticket once
(4401 on any refusal), echoes the subprotocol and relays to arena-subject (`voice_relay`).
"""

from __future__ import annotations

import contextlib
import logging
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from fastapi.responses import JSONResponse
from websockets.exceptions import WebSocketException

from arena_api.state import ApiState, actor_db, error_response
from arena_api.voice_relay import VoiceRelay
from arena_core.contracts.routes import VoiceTicketRequest
from arena_core.db.arena import ArenaDb, ArenaError
from arena_core.http_guard import GuardConfig
from arena_core.voice import protocol as p
from arena_core.voice.tickets import binding_from, ticket_from_subprotocols

router = APIRouter()
log = logging.getLogger("arena_api.voice")


@router.post("/api/voice/tickets", response_model=None)
async def mint_ticket(
    body: VoiceTicketRequest, db: Annotated[ArenaDb, Depends(actor_db)]
) -> dict[str, Any] | JSONResponse:
    trial = UUID(str(body.trial_id))
    if await db.trial(trial) is None:
        raise HTTPException(status_code=404, detail="not_found")
    try:
        token = await db.issue_ticket("voice", trial)
    except ArenaError as exc:
        return error_response(exc)
    return {"ticket": token, "expires_in": 60}


async def _refuse(ws: WebSocket, code: int, subprotocol: str | None = None) -> None:
    """Accept only to deliver the close code (the browser sees it as the terminal signal)."""
    await ws.accept(subprotocol=subprotocol)
    await ws.close(code)


@router.websocket("/api/voice/ws")
async def voice_ws(ws: WebSocket) -> None:
    state: ApiState = ws.app.state.api
    config: GuardConfig = ws.app.state.guard_config
    if ws.headers.get("host") not in config.allowed_hosts:
        await ws.close()  # before the upgrade: HTTP 403
        return
    ticket = ticket_from_subprotocols(ws.headers.get("sec-websocket-protocol"))
    if state.identity is None:
        await _refuse(ws, p.REFUSED, ticket)
        return
    if ws.headers.get("origin") not in config.allowed_origins:
        await _refuse(ws, p.ORIGIN, ticket)
        return
    if ticket is None or state.voice_dialer is None:
        await _refuse(ws, p.REFUSED, ticket)
        return
    dial = state.voice_dialer
    db = state.db(state.identity.user_id)
    try:
        binding = binding_from(await db.redeem_ticket(ticket, "voice"))
    except ArenaError:  # silent-ok: any refusal is the 4401 close; the reason never reaches the browser
        await _refuse(ws, p.REFUSED, ticket)
        return
    await ws.accept(subprotocol=ticket)
    try:
        async with dial() as leg:
            relay = VoiceRelay(ws, leg)
            state.voice_relays.add(binding.trial_id, relay)
            try:
                code = await relay.run(binding.start())
            finally:
                state.voice_relays.remove(binding.trial_id, relay)
    except (OSError, WebSocketException):
        log.warning("voice: arena-subject unreachable")
        with contextlib.suppress(RuntimeError):
            await ws.close(p.SERVER_ERROR)
        return
    log.info("voice session closed %s", code)
