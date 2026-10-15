"""The canonical REST route table (S5 5.5; C-18, C-19, C-42, D10) and the request and response bodies WP-02 owns.

S6 consumes this table (exported to `contracts/routes.json`) in place of its own route list; the FastAPI apps
(WP-13, WP-14) implement it, and the generated `contracts/openapi.json` they add must agree with it. A route's
`request` and `response` name a schema file in `contracts/` when this package defines the body; `None` means the
owning work package defines it. Every POST on a browser-facing origin carries an allowed Origin and the
`X-Arena-CSRF` header (D10). No body takes `presented_record_ids` (C-19) or a client work item.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import AfterValidator, Field, StringConstraints

from arena_core.contracts.common import (
    CASE_ID,
    ArtifactKind,
    Contract,
    Distinct,
    RecordId,
    TurnNo,
    Uuid,
)
from arena_core.contracts.events import Text600
from arena_core.contracts.findings import InvestigatorFinding
from arena_core.contracts.rendered import check_question

Service = Literal["arena-api", "arena-subject", "arena-referee"]
Method = Literal["GET", "POST"]


class SessionCreate(Contract):
    """`POST /api/sessions`: the phase is never sent; the database derives it (SG4-10)."""

    case_id: Annotated[str, StringConstraints(pattern=CASE_ID)]
    mode: Literal["practice", "assessment"]
    voice: bool
    idem_key: Uuid


class TurnSubmit(Contract):
    """`POST /api/trials/{id}/turns`: the question is capped at 600 characters and 1,800 bytes as rendered
    (D11, `contracts.rendered.check_question`), refused before commit; the room sends `release_ids: []` and
    requests records through the evidence route (S6 5.5)."""

    question: Annotated[Text600, AfterValidator(check_question)]
    release_ids: Annotated[list[RecordId], Field(max_length=6), Distinct]
    expected_version: Annotated[int, Field(ge=0)]
    idem_key: Uuid


class EvidenceRequest(Contract):
    """`POST /api/trials/{id}/evidence-requests` (S5 5.4)."""

    record_ids: Annotated[list[RecordId], Field(min_length=1, max_length=6), Distinct]
    idem_key: Uuid


class ReleasedRef(Contract):
    record_id: RecordId
    kind: Literal["record", "clarification", "context_change"]
    doc_kind: ArtifactKind | None


class EvidenceResult(Contract):
    """The evidence route's 200 (S5 5.4, S4 `release_evidence`; SG1-15): no content; `denied` lists known ids
    requested too early, with no reason."""

    released: Annotated[list[ReleasedRef], Field(max_length=6)]
    already_released: Annotated[list[RecordId], Field(max_length=6)]
    denied: Annotated[list[RecordId], Field(max_length=6)]
    transcript_version: Annotated[int, Field(ge=0)]


class FindingCommit(Contract):
    """`POST /api/trials/{id}/finding`: the one `Finding` object as the investigator enters it (C-27, D5)."""

    finding: InvestigatorFinding
    idem_key: Uuid


class VoiceTicketRequest(Contract):
    trial_id: Uuid


class CardAck(Contract):
    """`POST /api/telemetry/kpi4`: exactly `{trial_id, turn_no, client_valid}`; no client clock (S6 5.6)."""

    trial_id: Uuid
    turn_no: TurnNo
    client_valid: bool


class DebriefScoring(Contract):
    """`GET /api/sessions/{id}/debrief` before the debrief is published (S5 5.4)."""

    status: Literal["scoring"]


Auth = Literal[
    "none",
    "ticket",
    "session",
    "session:admin",
    "session:trainer",
    "session:admin_or_trainer",
    "caller:api",
    "caller:tournament",
    "caller:api_or_tournament",
]


@dataclass(frozen=True)
class Route:
    service: Service
    method: Method
    path: str
    auth: Auth
    purpose: str
    request: str | None = None
    response: str | None = None

    @property
    def csrf(self) -> bool:
        """D10: every state-changing request from a browser origin carries Origin and `X-Arena-CSRF`."""
        return self.method == "POST" and not self.auth.startswith("caller:")


API: Service = "arena-api"
REFEREE: Service = "arena-referee"
SUBJECT: Service = "arena-subject"

ROUTES: tuple[Route, ...] = (
    Route(API, "GET", "/api/me", "session", "Identity, roles, quotas, EX-4 status, KPI-1 study status, CSRF token"),
    Route(API, "POST", "/api/me/ack-ex4", "session", "Record the EX-4 acknowledgement (idempotent)"),
    Route(API, "GET", "/api/config", "session", "Public flags and quotas"),
    Route(API, "GET", "/api/cases", "session", "Assigned development variants or the participant's test set"),
    Route(API, "GET", "/api/cases/{id}", "session", "Case brief (public packet); 404 unless listed"),
    Route(API, "POST", "/api/sessions", "session", "Start a session", "session-create.schema.json"),
    Route(API, "GET", "/api/sessions/{id}", "session", "Session and trial state"),
    Route(API, "GET", "/api/trials/{id}/snapshot", "session", "Absolute trial state", response="snapshot.schema.json"),
    Route(API, "POST", "/api/trials/{id}/turns", "session", "One turn", "turn-submit.schema.json"),
    Route(
        API,
        "POST",
        "/api/trials/{id}/evidence-requests",
        "session",
        "Release between turns",
        "evidence-request.schema.json",
        "evidence-result.schema.json",
    ),
    Route(
        API,
        "POST",
        "/api/trials/{id}/finding",
        "session",
        "Commit the investigator's finding",
        "finding-commit.schema.json",
    ),
    Route(API, "POST", "/api/trials/{id}/stream-tickets", "session", "Mint an SSE ticket (catch-up until debrief)"),
    Route(API, "GET", "/api/trials/{id}/events", "ticket", "Trial SSE stream of deltas", response="events.schema.json"),
    Route(
        API,
        "POST",
        "/api/sessions/{id}/debrief",
        "session",
        "Run or return the debrief",
        response="debrief.v1.schema.json",
    ),
    Route(
        API,
        "GET",
        "/api/sessions/{id}/debrief",
        "session",
        "Read the published debrief (`scoring` until then)",
        response="debrief-read.schema.json",
    ),
    Route(API, "GET", "/api/progress", "session", "Score series and KPI-1 status"),
    Route(API, "GET", "/api/tournaments", "session", "Tournament list"),
    Route(API, "GET", "/api/tournaments/{id}", "session", "Progress counts per track and block"),
    Route(
        API,
        "GET",
        "/api/tournaments/{id}/events",
        "session",
        "Tournament poll on the global ledger cursor",
        response="tournament-poll.schema.json",
    ),
    Route(
        API,
        "GET",
        "/api/trials/{id}/replay",
        "session",
        "A visible tournament trial's frames by its own seq",
        response="replay-page.schema.json",
    ),
    Route(API, "GET", "/api/leaderboards/{tournament_id}", "session", "Leaderboards after reveal"),
    Route(API, "GET", "/api/trust/{section}", "session", "Trust-center data"),
    Route(API, "GET", "/api/coach-lab/versions", "session", "Coach Gym versions: status, parent, holdout metrics"),
    Route(API, "GET", "/api/coach-lab/versions/{id}/lessons", "session", "Playbook lessons of one coach version"),
    Route(API, "GET", "/api/coach-lab/experiments", "session", "Coach Gym runs: before/after metrics and series"),
    Route(API, "POST", "/api/voice/tickets", "session", "Mint a voice ticket", "voice-ticket-request.schema.json"),
    Route(API, "GET", "/api/voice/ws", "ticket", "Voice WebSocket (ticket in the subprotocol)"),
    Route(API, "POST", "/api/telemetry/kpi4", "session", "Card acknowledgement (KPI-4)", "card-ack.schema.json"),
    Route(API, "POST", "/api/telemetry/contract-violation", "session", "Client projection re-check failed (log only)"),
    Route(API, "GET", "/api/health", "none", "Liveness only"),
    Route(SUBJECT, "POST", "/internal/answer", "caller:api_or_tournament", "One subject turn"),
    Route(SUBJECT, "GET", "/internal/voice/ws", "caller:api", "Voice relay leg"),
    Route(REFEREE, "GET", "/api/me", "session:admin_or_trainer", "Console bootstrap on the referee origin"),
    Route(REFEREE, "GET", "/api/config", "session:admin_or_trainer", "Console flags"),
    Route(
        REFEREE,
        "POST",
        "/internal/sessions/{id}/debrief",
        "caller:api",
        "R3 stages and the published debrief",
        response="debrief.v1.schema.json",
    ),
    Route(REFEREE, "POST", "/internal/blocks/{id}/score", "caller:tournament", "Online block scoring"),
    Route(REFEREE, "POST", "/internal/trials/{id}/score", "caller:tournament", "R1 on a corpus transcript or R2"),
    Route(REFEREE, "POST", "/internal/tournaments/{id}/corpus-seal", "caller:tournament", "Seal the replay corpus"),
    Route(
        REFEREE,
        "GET",
        "/api/review/items",
        "session:trainer",
        "Assigned review items",
        response="review-list.schema.json",
    ),
    Route(
        REFEREE,
        "GET",
        "/api/review/items/{id}",
        "session:trainer",
        "One review task",
        response="review-item.schema.json",
    ),
    Route(
        REFEREE,
        "POST",
        "/api/review/items/{id}",
        "session:trainer",
        "Submit one review task",
        "review-submission.schema.json",
    ),
    Route(REFEREE, "GET", "/api/admin/tournaments", "session:admin", "Tournaments"),
    Route(REFEREE, "GET", "/api/admin/tournaments/{id}", "session:admin", "One tournament"),
    Route(REFEREE, "POST", "/api/admin/tournaments", "session:admin", "Create (idempotent by name)"),
    Route(REFEREE, "POST", "/api/admin/tournaments/{id}/roster", "session:admin", "Add planned trials (draft only)"),
    Route(REFEREE, "POST", "/api/admin/tournaments/{id}/freeze", "session:admin", "Freeze"),
    Route(REFEREE, "POST", "/api/admin/tournaments/{id}/open", "session:admin", "Hidden-text scan, then open"),
    Route(REFEREE, "POST", "/api/admin/tournaments/{id}/close", "session:admin", "Close the run"),
    Route(REFEREE, "POST", "/api/admin/tournaments/{id}/scoring", "session:admin", "Begin scoring"),
    Route(REFEREE, "GET", "/api/admin/reviews", "session:admin", "Blinded validity review queue"),
    Route(REFEREE, "POST", "/api/admin/reviews/{trial_id}", "session:admin", "Validity verdict"),
    Route(REFEREE, "POST", "/api/admin/tournaments/{id}/reveal", "session:admin", "Reveal"),
    Route(REFEREE, "POST", "/api/admin/tournaments/{id}/corrections", "session:admin", "Seal a corrected manifest"),
    Route(REFEREE, "POST", "/api/admin/tournaments/{id}/publish", "session:admin", "Publish scores and boards"),
    Route(REFEREE, "POST", "/api/admin/cases", "session:admin", "Ingest an authored family"),
    Route(REFEREE, "POST", "/api/admin/hidden-split/seal", "session:admin", "Seal the hidden split"),
    Route(REFEREE, "GET", "/api/admin/budget", "session:admin", "Budget view"),
    Route(REFEREE, "POST", "/api/admin/traces/export", "session:admin", "Export held spans after reveal"),
)


def route_table() -> list[dict[str, object]]:
    """The table as exported to `contracts/routes.json`."""
    return [
        {
            "service": r.service,
            "method": r.method,
            "path": r.path,
            "auth": r.auth,
            "csrf": r.csrf,
            "purpose": r.purpose,
            "request": r.request,
            "response": r.response,
        }
        for r in ROUTES
    ]
