"""The caller-token client `arena-api` uses for `arena-subject`'s `POST /internal/answer` (S5 5.2, 5.5, 10.2 item 4).

The body names the trial, the open `subject_answer` work item and the investigator (D-024: the actor the
per-user daily cap applies to). A refusal arena-subject reports with a code becomes `SubjectUnavailableError`
with that code; a transport failure is `subject_unreachable`. The orchestrator decides what each means.
"""

from __future__ import annotations

from uuid import UUID

import httpx

from arena_core.turns.orchestrator import SubjectCall, SubjectOutcome, SubjectUnavailableError

SUBJECT_URL = "http://127.0.0.1:8081"
ANSWER_TIMEOUT_S = 45.0  # under the turn's 60 s deadline (S5 5.2); the subject call's own deadline is 20 s


def _code(resp: httpx.Response) -> str:
    try:
        detail = resp.json().get("detail")
    except ValueError:  # silent-ok: a non-JSON error body has no code; the HTTP status names it below
        detail = None
    return detail if isinstance(detail, str) else f"http_{resp.status_code}"


def subject_client(
    token: str, base_url: str = SUBJECT_URL, transport: httpx.AsyncBaseTransport | None = None
) -> SubjectCall:
    async def answer(trial: UUID, work_item: UUID, actor: UUID | None) -> SubjectOutcome:
        body = {"trial": str(trial), "work_item": str(work_item), "actor": None if actor is None else str(actor)}
        try:
            async with httpx.AsyncClient(base_url=base_url, transport=transport, timeout=ANSWER_TIMEOUT_S) as client:
                resp = await client.post("/internal/answer", json=body, headers={"Authorization": f"Bearer {token}"})
        except httpx.HTTPError as exc:
            raise SubjectUnavailableError("subject_unreachable") from exc
        if resp.status_code != httpx.codes.OK:
            raise SubjectUnavailableError(_code(resp))
        data = resp.json()
        return SubjectOutcome(outcome=str(data["outcome"]), turn_no=int(data["turn_no"]))

    return answer
