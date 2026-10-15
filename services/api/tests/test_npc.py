"""`GET /api/npc` and `POST /api/npc/chat` in process (UI v2, D-035): the catalogue, a reply with its voice, the
per-user message limit, refusals, and the 503 when no model answers. Free endpoints are answered in memory (the
client's HTTP seam); the Gemini fallback runs on the fake adapter."""

from __future__ import annotations

import dataclasses
import json
from decimal import Decimal
from http import HTTPStatus
from typing import Any

from arena_api.app import create_app, guard_config
from arena_core.npc.catalogue import NPCS
from arena_core.npc.chat import FAKE_NPC_REPLIES, MessageLimit, NpcChat
from arena_core.providers.fake import FakeAdapter
from arena_core.providers.openai_compat import ChatClient, HttpReply, configured_endpoints
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.memory import RunBudget
from services.api.tests.test_app import Harness


async def _no_sleep(_s: float) -> None:
    return None


def _with_npc(chat: NpcChat | None, per_minute: int = 30) -> Harness:
    h = Harness()
    h.state = dataclasses.replace(h.state, npc=chat, npc_limit=MessageLimit(per_minute))
    h.app = create_app(h.state, guard_config({}), phoenix_url=None)
    return h


def _gemini(ceiling: Decimal = Decimal(100)) -> NpcChat:
    port = AgentPort(FakeAdapter(canned=dict(FAKE_NPC_REPLIES)), RunBudget(ceiling), PortOptions(sleep=_no_sleep))
    return NpcChat(endpoints=[], client=ChatClient(), port=port)


def test_the_npc_list_names_each_npc_and_its_voice() -> None:
    npcs = _with_npc(_gemini()).get("/api/npc").json()["npcs"]
    by_id = {n["npc_id"]: n for n in npcs}
    assert {"receptionist", "sergeant"} <= set(by_id)
    assert by_id["sergeant"]["voice_id"] == NPCS["sergeant"].voice
    assert set(by_id["sergeant"]) == {"npc_id", "name", "role", "voice_id"}


def test_a_reply_comes_with_the_npcs_voice() -> None:
    async def free(_url: str, _body: dict[str, Any], _headers: dict[str, str], _timeout: float) -> HttpReply:
        return HttpReply(200, json.dumps({"choices": [{"message": {"content": "Sign in, please."}}]}), {})

    port = AgentPort(FakeAdapter(), RunBudget(Decimal(0)), PortOptions(sleep=_no_sleep))
    chat = NpcChat(configured_endpoints({"GROQ_API_KEY": "k"}), ChatClient(post=free), port)
    h = _with_npc(chat)
    body = {"npc_id": "receptionist", "message": "Hello", "history": [{"role": "user", "text": "Hi"}]}
    r = h.post("/api/npc/chat", body)
    assert r.status_code == HTTPStatus.OK, r.text
    assert r.json() == {"reply": "Sign in, please.", "voice_id": NPCS["receptionist"].voice}


def test_the_gemini_fallback_answers_in_fake_mode() -> None:
    r = _with_npc(_gemini()).post("/api/npc/chat", {"npc_id": "sergeant", "message": "Any tips?"})
    assert r.status_code == HTTPStatus.OK, r.text
    assert r.json()["voice_id"] == NPCS["sergeant"].voice
    assert r.json()["reply"].startswith("Good to see you.")


def test_the_per_user_limit_answers_429() -> None:
    h = _with_npc(_gemini(), per_minute=2)
    codes = [h.post("/api/npc/chat", {"npc_id": "rookie", "message": "hi"}).status_code for _ in range(3)]
    assert codes == [HTTPStatus.OK, HTTPStatus.OK, HTTPStatus.TOO_MANY_REQUESTS]


def test_an_unknown_npc_or_no_chat_in_the_process_is_404() -> None:
    assert (
        _with_npc(_gemini()).post("/api/npc/chat", {"npc_id": "janitor", "message": "hi"}).status_code
        == HTTPStatus.NOT_FOUND
    )
    assert (
        _with_npc(None).post("/api/npc/chat", {"npc_id": "sergeant", "message": "hi"}).status_code
        == HTTPStatus.NOT_FOUND
    )


def test_a_malformed_request_is_422() -> None:
    h = _with_npc(_gemini())
    for body in (
        {"npc_id": "sergeant", "message": ""},
        {"npc_id": "sergeant", "message": "x" * 401},
        {"npc_id": "Sergeant!", "message": "hi"},
        {"npc_id": "sergeant", "message": "hi", "history": [{"role": "boss", "text": "x"}]},
        {"npc_id": "sergeant", "message": "hi", "history": [{"role": "user", "text": "x"}] * 13},
        {"npc_id": "sergeant", "message": "hi", "case_id": "C-1"},
    ):
        assert h.post("/api/npc/chat", body).status_code == HTTPStatus.UNPROCESSABLE_ENTITY, body


def test_no_reply_from_any_model_is_503() -> None:
    r = _with_npc(_gemini(Decimal(0))).post("/api/npc/chat", {"npc_id": "sergeant", "message": "hi"})
    assert (r.status_code, r.json()) == (HTTPStatus.SERVICE_UNAVAILABLE, {"code": "npc_unavailable"})
