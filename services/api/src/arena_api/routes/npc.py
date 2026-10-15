"""`GET /api/npc` and `POST /api/npc/chat` (UI v2, owner D-035): the precinct's colleague NPCs and one reply.

The reply comes from a free open-model endpoint when one is configured and answers, else from Gemini on Vertex
through the spend guard (`arena_core.npc.chat`). An NPC never receives a case fact: the route reads no case, trial
or session, only the catalogue entry and the trainee's own words. `voice_id` is the persona key `POST /api/tts`
speaks the reply with. A user may send at most `ARENA_NPC_MESSAGES_PER_MIN` messages a minute (default 30; 429).
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from arena_api.state import ApiState, api_state, identity
from arena_core.contracts.routes import NpcChatRequest
from arena_core.db.calls import GUARD_ERRORS
from arena_core.identity import DevIdentity
from arena_core.npc.catalogue import NPCS
from arena_core.npc.chat import Line
from arena_core.providers.errors import ProviderError

router = APIRouter()
log = logging.getLogger("arena_api.npc")

#: Why the Gemini fallback gave no reply: refused or failed at the port, the guard or its database, or timed out.
UNAVAILABLE: tuple[type[Exception], ...] = (ProviderError, TimeoutError, *GUARD_ERRORS)


@router.get("/api/npc")
async def list_npcs() -> dict[str, Any]:
    return {"npcs": [{"npc_id": n.npc_id, "name": n.name, "role": n.role, "voice_id": n.voice} for n in NPCS.values()]}


@router.post("/api/npc/chat", response_model=None)
async def npc_chat(
    body: NpcChatRequest,
    state: Annotated[ApiState, Depends(api_state)],
    who: Annotated[DevIdentity, Depends(identity)],
) -> dict[str, Any] | JSONResponse:
    npc = NPCS.get(body.npc_id)
    if npc is None or state.npc is None:
        raise HTTPException(status_code=404, detail="not_found")
    if not state.npc_limit.admit(who.user_id):
        return JSONResponse({"code": "npc_rate_limited"}, status_code=429)
    history = [Line("investigator" if t.role in ("investigator", "user") else "npc", t.text) for t in body.history]
    try:
        answer = await state.npc.reply(npc, body.message, history, who.user_id)
    except UNAVAILABLE as exc:
        log.info("npc unavailable: %s", type(exc).__name__)
        return JSONResponse({"code": "npc_unavailable"}, status_code=503)
    log.info("npc %s answered by %s", npc.npc_id, answer.provider)
    return {"reply": answer.reply, "voice_id": npc.voice}
