"""`POST /api/tts {voice, text}` (stage 5): one spoken line as WAV audio, for the room's voices.

The line is synthesized once and cached on disk by (model, voice, text) under ``.run/tts-cache`` (``ARENA_TTS_CACHE``
overrides it), so a recorded run replays for free (D-021). A line not yet cached goes through the spend guard
(``arena_core.voice.tts``); with ``ARENA_MODEL_MODE=fake`` it is silence of the line's reading length and spends
nothing and answers with ``X-Arena-Speech: silent``. When synthesis is refused or fails the route answers 503; in
both cases the browser speaks the line with its own voice.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from arena_api.state import api_state, identity
from arena_core.db.calls import GUARD_ERRORS
from arena_core.identity import DevIdentity
from arena_core.providers.errors import ProviderError
from arena_core.providers.mode import FAKE, MODE_VAR
from arena_core.providers.vertex import speech_request_bytes, vertex_speech
from arena_core.spend.guard import DbSpendGuard
from arena_core.voice.tts import MAX_LINE_CHARS, TTS_MODEL, FakeSpeech, LineRefusedError, TtsService, VertexSynth

router = APIRouter()
log = logging.getLogger("arena_api.tts")

CACHE_VAR = "ARENA_TTS_CACHE"
#: Why a line may not be synthesized now: refused by the guard or its database, or failed or timed out at Vertex.
UNAVAILABLE: tuple[type[Exception], ...] = (ProviderError, TimeoutError, *GUARD_ERRORS)
DEFAULT_CACHE = Path(".run/tts-cache")


class SpeakRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    voice: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=MAX_LINE_CHARS)


def service(request: Request) -> TtsService:
    """The process's speech service, built once: fake silence without a guard, or Vertex behind the spend guard."""
    built: TtsService | None = getattr(request.app.state, "tts", None)
    if built is None:
        cache = Path(os.environ.get(CACHE_VAR, "").strip() or DEFAULT_CACHE)
        if os.environ.get(MODE_VAR, "").strip() == FAKE:
            built = TtsService(FakeSpeech(), None, cache)
        else:
            built = TtsService(
                VertexSynth(vertex_speech(os.environ, TTS_MODEL), speech_request_bytes),
                DbSpendGuard(api_state(request).connect),
                cache,
            )
        request.app.state.tts = built
    return built


@router.post("/api/tts", response_model=None)
async def speak(
    body: SpeakRequest,
    who: Annotated[DevIdentity, Depends(identity)],
    tts: Annotated[TtsService, Depends(service)],
) -> Response:
    try:
        audio = await tts.speak(body.text, body.voice, who.user_id)
    except LineRefusedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except UNAVAILABLE as exc:
        # Refused by the guard (budget, kill switch, unknown call kind) or failed at Vertex: the browser's voice speaks.
        log.info("tts unavailable: %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="speech unavailable") from exc
    headers = {"Cache-Control": "private, max-age=31536000, immutable"}
    if tts.silent:
        headers["X-Arena-Speech"] = "silent"
    return Response(content=audio, media_type="audio/wav", headers=headers)
