"""CallContext, AgentCall, AgentResult and the adapter boundary (S5 3.1).

`CallType`, `VertexModel` and `ThinkingLevel` live in `arena_core.spend.limits` (the limits table keys on them) and
are re-exported here. `ModelRequest` is the one request shape every adapter receives; `request_bytes` measures it
(S5 3.2 step 2, D11): the complete request (system instruction, contents, response schema, generation limits) as
compact UTF-8 JSON, so a multibyte character counts as its bytes, never as one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel

from arena_core.spend.limits import CallType, ThinkingLevel, VertexModel

__all__ = [
    "AgentCall",
    "AgentResult",
    "CallContext",
    "CallType",
    "Message",
    "ModelAdapter",
    "ModelRequest",
    "RawCompletion",
    "ThinkingLevel",
    "Usage",
    "VertexModel",
    "request_body",
    "request_bytes",
]

Role = Literal["user", "model"]
Split = Literal["dev", "hidden", "none"]
DataClass = Literal["public", "subject_private", "evaluator"]

# Every Vertex request is labeled for billing attribution on the shared project (D-015, S5 3.2 step 4).
APP_LABELS: dict[str, str] = {"app": "unissant-arena"}


@dataclass(frozen=True)
class Message:
    """One text turn. Coaching never receives audio (S5 3.5): the port carries text parts only."""

    role: Role
    text: str


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0  # thinking included (billed as output)
    thinking_tokens: int = 0
    cached_input_tokens: int = 0

    def add(self, other: Usage) -> Usage:
        return Usage(
            self.input_tokens + other.input_tokens,
            self.output_tokens + other.output_tokens,
            self.thinking_tokens + other.thinking_tokens,
            self.cached_input_tokens + other.cached_input_tokens,
        )


@dataclass(frozen=True, kw_only=True)
class CallContext:
    call_type: CallType
    purpose: str  # fixed label list (S5 3.3); stored by ops.reserve_model_call
    # The caller's step identity: the work item's request key for turn work (S5 5.1), else the caller's own step id.
    # The reservation key is f"{step_key}:{n}", so a restarted process finds its reservation again.
    step_key: str
    bucket: Literal["global"] = "global"  # D-013: every reservation names the one global bucket
    work_item_id: UUID | None = None
    trial_id: UUID | None = None
    tournament_id: UUID | None = None
    actor_user_id: UUID | None = None
    turn_no: int = 0  # the trial's own turn; 0 for calls not tied to a turn (S2 2, seed rule)
    split: Split = "none"
    data_class: DataClass = "public"
    candidate_manifest_sha: str | None = None
    # Set only by the step's owner (its work item, S5 5.1) after it found the previous attempt dead: an open
    # reservation under the step is then resumed or settled usage_unknown instead of refusing the call.
    recover: bool = False


@dataclass(frozen=True, kw_only=True)
class AgentCall[T: BaseModel]:
    model: VertexModel
    thinking: ThinkingLevel
    system: str
    messages: tuple[Message, ...]
    schema: type[T]
    context: CallContext
    timeout_s: float | None = None  # per attempt; defaults to the call type's ceiling and may not exceed it
    deadline_s: float | None = None  # bounds every attempt of the call, repair and retries included (S2 2)
    # Passed to the schema's validators on every reply (for example a SubjectContext or a CitationContext): the
    # context-dependent rules of S2 4.2, 6.8 and 7.2 are part of the schema the one repair answers (S2 10).
    validation_context: object | None = None


@dataclass(frozen=True)
class AgentResult[T]:
    value: T
    attempts: int
    usage: Usage
    cost_usd: Decimal
    latency_ms: float
    trace_id: str | None
    span_id: str | None
    reservation_id: UUID


@dataclass(frozen=True, kw_only=True)
class ModelRequest:
    """Exactly what one attempt sends."""

    model: VertexModel
    system: str
    messages: tuple[Message, ...]
    json_schema: dict[str, Any]  # already filtered to the keywords Vertex accepts
    max_output_tokens: int
    thinking: ThinkingLevel
    seed: int
    labels: dict[str, str] = field(default_factory=lambda: dict(APP_LABELS))


def request_body(request: ModelRequest) -> dict[str, Any]:
    """The Vertex `generateContent` JSON body google-genai 2.24.0 sends for this request, field for field (the Vertex
    adapter's tests compare it with the body the pinned SDK actually puts on the wire)."""
    return {
        "contents": [{"parts": [{"text": m.text}], "role": m.role} for m in request.messages],
        "systemInstruction": {"parts": [{"text": request.system}], "role": "user"},
        "labels": dict(request.labels),
        "generationConfig": {
            "maxOutputTokens": request.max_output_tokens,
            "seed": request.seed,
            "responseMimeType": "application/json",
            "responseJsonSchema": request.json_schema,
            "thinkingConfig": {"thinking_level": request.thinking.value.upper()},
        },
    }


def request_bytes(request: ModelRequest) -> int:
    """The exact byte length of the body google-genai 2.24.0 transmits for this request (D11, SG2-25): the SDK
    serializes `request_body` with `json.dumps` defaults (`ensure_ascii=True`, separators ", " and ": "), so every
    non-ASCII character is sent as a six-byte `\\uXXXX` escape (twelve for a character outside the BMP), and every
    backslash, quote and control character as its escape. The reservation and the repair limit use this number; the
    Vertex adapter's tests assert it equals the raw bytes the SDK put on the wire."""
    return len(json.dumps(request_body(request)).encode("ascii"))


@dataclass(frozen=True)
class RawCompletion:
    text: str
    usage: Usage | None
    finish_reason: str | None = None


class ModelAdapter(Protocol):
    """One attempt against a model. Failures raise `ProviderCallError`; the SDK never retries on its own."""

    async def generate(self, request: ModelRequest, *, timeout_s: float) -> RawCompletion: ...
