"""Deterministic export of every contract to `contracts/` (WP-02; S5 1, S6 5.2).

Three audiences, kept apart (SG4-05): model-facing output schemas (sent to Vertex, each passing `lint_schema`),
stored shapes, and wire shapes (the only ones the browser generates types and validators from). The same models
always produce the same bytes: Pydantic's schema generation is deterministic, keys keep model order, and the text
is UTF-8 with a trailing newline. `tools/export_contracts.py` writes the files and the web's generated types; a
test fails when a committed file differs from a fresh export.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping
from typing import Any, cast

from jsonschema import Draft202012Validator, ValidationError, validators
from jsonschema.protocols import Validator
from pydantic import BaseModel, TypeAdapter

from arena_core.contracts.coaching import (
    CoachingCard,
    DeepUpdate,
    FinalFinding,
    StoredCard,
    StoredDeepUpdate,
    TournamentWireCard,
    TrainingWireCard,
)
from arena_core.contracts.common import wire_bytes
from arena_core.contracts.debrief import Debrief
from arena_core.contracts.events import HarnessFrame, ReplayPage, TournamentPoll, TrialFrame
from arena_core.contracts.findings import Finding, StoredFinding
from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.contracts.review import ReviewItem, ReviewList, ReviewSubmission
from arena_core.contracts.routes import (
    CardAck,
    DebriefScoring,
    EvidenceRequest,
    EvidenceResult,
    FindingCommit,
    SessionCreate,
    TurnSubmit,
    VoiceTicketRequest,
    route_table,
)
from arena_core.contracts.snapshot import TrialSnapshot
from arena_core.contracts.subject import SubjectTurn

SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"
ID_BASE = "https://unissant-arena.invalid/contracts/"

# File stem -> model. Model-facing: each is sent as `response_json_schema` and passes `lint_schema`.
MODEL_FACING: Mapping[str, type[BaseModel]] = {
    "finding": Finding,
    "card.v1": CoachingCard,
    "deep.v1": DeepUpdate,
    "final.v1": FinalFinding,
    "subject.v1": SubjectTurn,
    "ref_subj.v5": RefereeSubjectReport,
    "ref_asst.v2": RefereeAssistantReport,
}
STORED: Mapping[str, type[BaseModel]] = {
    "stored-card": StoredCard,
    "stored-finding": StoredFinding,
    "stored-deep": StoredDeepUpdate,
}
# File stem -> (root type name, type). Wire shapes: the browser's types and ajv validators come from these only.
WIRE: Mapping[str, tuple[str, Any]] = {
    "events": ("TrialFrame", TrialFrame),
    "harness-events": ("HarnessFrame", HarnessFrame),
    "training-card": ("TrainingWireCard", TrainingWireCard),
    "tournament-card": ("TournamentWireCard", TournamentWireCard),
    "snapshot": ("TrialSnapshot", TrialSnapshot),
    "debrief.v1": ("Debrief", Debrief),
    "debrief-read": ("DebriefRead", Debrief | DebriefScoring),
    "review-list": ("ReviewList", ReviewList),
    "review-item": ("ReviewItem", ReviewItem),
    "review-submission": ("ReviewSubmission", ReviewSubmission),
    "tournament-poll": ("TournamentPoll", TournamentPoll),
    "replay-page": ("ReplayPage", ReplayPage),
    "session-create": ("SessionCreate", SessionCreate),
    "turn-submit": ("TurnSubmit", TurnSubmit),
    "evidence-request": ("EvidenceRequest", EvidenceRequest),
    "evidence-result": ("EvidenceResult", EvidenceResult),
    "finding-commit": ("FindingCommit", FindingCommit),
    "voice-ticket-request": ("VoiceTicketRequest", VoiceTicketRequest),
    "card-ack": ("CardAck", CardAck),
}


def _with_header(stem: str, title: str, schema: dict[str, Any]) -> dict[str, Any]:
    body = {k: v for k, v in schema.items() if k not in {"$schema", "$id", "title"}}
    return {"$schema": SCHEMA_DIALECT, "$id": f"{ID_BASE}{stem}.schema.json", "title": title, **body}


def schema_of(stem: str) -> dict[str, Any]:
    """The exported JSON Schema for one file stem."""
    if stem in MODEL_FACING:
        model = MODEL_FACING[stem]
        return _with_header(stem, model.__name__, model.model_json_schema())
    if stem in STORED:
        model = STORED[stem]
        return _with_header(stem, model.__name__, model.model_json_schema())
    title, tp = WIRE[stem]
    return _with_header(stem, title, TypeAdapter(tp).json_schema())


def dumps(document: object) -> str:
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def _max_bytes(
    validator: Validator, limit: int, instance: object, schema: Mapping[str, Any]
) -> Iterator[ValidationError]:
    """The arena keyword `maxBytes` (S2 1, Text size; D-019): a string of at most `limit` wire bytes."""
    del validator, schema
    if isinstance(instance, str) and wire_bytes(instance) > limit:
        yield ValidationError(f"longer than {limit} bytes as sent")


# types-jsonschema declares `validators.extend` without parameter types; its documented signature is
# extend(validator, validators) -> a validator class.
_extend = cast("Callable[[type[Validator], dict[str, Any]], type[Validator]]", validators.extend)
ArenaValidator = _extend(Draft202012Validator, {"maxBytes": _max_bytes})


def json_validator(schema: Mapping[str, Any]) -> Validator:
    """A draft 2020-12 validator for an exported schema that also enforces `maxBytes`."""
    validator: Validator = ArenaValidator(schema)
    return validator


def contract_files() -> dict[str, str]:
    """Every generated file under `contracts/`, by name, as text."""
    stems = [*MODEL_FACING, *STORED, *WIRE]
    files = {f"{stem}.schema.json": dumps(schema_of(stem)) for stem in stems}
    files["routes.json"] = dumps(route_table())
    return files
