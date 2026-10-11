"""Building blocks shared by every contract model: identifier formats, bounded text and the base config.

Identifiers follow S2 1 (C-16): model-facing turn IDs `tNN` (`t01`..`t12`), flag references `tNN.fK`,
records `rec-NN`, initial documents `doc-NN`, private fact, uncertainty and gate IDs. Every character limit S2
sets on a model-written field or on the `Finding` object is also a byte limit of twice that number (S2 1, Text
size; D11), checked by the same validator. Lengths, byte limits and word counts are enforced here in code, not by
the Vertex decoder, which ignores those keywords (S2 1, Structured output).
"""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    GetCoreSchemaHandler,
    GetJsonSchemaHandler,
    StringConstraints,
    WithJsonSchema,
)
from pydantic.json_schema import JsonSchemaValue
from pydantic_core import CoreSchema, core_schema

TURN_ID = r"^t(0[1-9]|1[0-2])$"
FLAG_REF = r"^t(0[1-9]|1[0-2])\.f[1-3]$"
RECORD_ID = r"^rec-0[1-6]$"
CITABLE_RECORD = r"^(doc-0[1-4]|rec-0[1-6])$"
FACT_ID = r"^f:[0-9]{2,3}$"
UNCERTAINTY_ID = r"^u:[0-9]{2}$"
GATE_ID = r"^g:[0-9]{2}$"
UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
SHA256 = r"^[0-9a-f]{64}$"
GIT_SHA = r"^[0-9a-f]{40}$"
CASE_ID = r"^C-[0-9A-HJKMNP-TV-Z]{8}$"
DATE = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
LOCAL_DATE_TIME = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$"
# RFC 3339 with an explicit offset, the form Postgres `timestamptz` serializes to in JSON. A pattern, not
# `format: date-time`: a format keyword is advisory in JSON Schema and unknown to a strict ajv without plugins.
TIMESTAMP = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$"

MAX_TURNS = 12


def _schema_extra(schema: dict[str, Any], cls: type[Any]) -> None:
    """Drop the class docstring and the generated per-field titles (notes for maintainers; a model-facing
    schema reaches the model on every call, S2 1 Structured output), and add the class's `json_rules()`.

    `json_rules()` returns the cross-field rules a class can state in JSON Schema (`if`/`then` entries under
    `allOf`), so the browser's validators refuse what the Python validators refuse. Model-facing classes define
    none: Vertex ignores those keywords and `lint_schema` requires every listed property to be required.
    Descriptions set on a field on purpose (S2's own, e.g. `turn_id`) stay."""
    schema.pop("description", None)
    for prop in schema.get("properties", {}).values():
        if isinstance(prop, dict):
            prop.pop("title", None)
    rules = getattr(cls, "json_rules", None)
    if rules is not None:
        schema["allOf"] = rules()


class Contract(BaseModel):
    """Base for every contract model: unknown keys are refused (`additionalProperties: false`), instances are
    frozen, and nothing is coerced (strict: `"3"` is not a turn number)."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, json_schema_extra=_schema_extra)


def when(
    field: str, values: list[Any], then: dict[str, Any], otherwise: dict[str, Any] | None = None
) -> dict[str, Any]:
    """One JSON Schema rule: when `field` is one of `values`, the properties in `then` hold (else `otherwise`)."""
    rule: dict[str, Any] = {"if": {"properties": {field: {"enum": values}}}, "then": {"properties": then}}
    if otherwise is not None:
        rule["else"] = {"properties": otherwise}
    return rule


def _exact(kind: type) -> BeforeValidator:
    """A BeforeValidator that admits only values of exactly `kind`: a `Literal[1]` or `Literal[True]` compares by
    equality, so without it `True` passes as the integer 1 and `1` as `True`, which the exported schemas refuse."""

    def check(value: object) -> object:
        if type(value) is not kind:
            msg = f"must be a {kind.__name__}, not {type(value).__name__}"
            raise ValueError(msg)
        return value

    return BeforeValidator(check)


def wire_bytes(text: str) -> int:
    """The bytes `text` occupies on the wire inside a request body (D-019): the JSON string google-genai sends
    (`json.dumps`, `ensure_ascii=True`) without its two quotes. ASCII counts 1, `"` and `\\` 2, a control character
    its escape (2 or 6), every other character 6 (12 outside the Basic Multilingual Plane). Every byte cap that
    feeds a request is stated and enforced in this unit, so S2's adversarial maximum fits the input limits."""
    return len(json.dumps(text)) - 2


class ByteLimit:
    """Annotated marker: at most `limit` wire bytes (`wire_bytes`; S2 1: twice the character limit, D-019). Exported
    as the arena keyword `maxBytes`, which the browser's ajv (`web/src/lib/contracts/validate.ts`) and
    `export.json_validator` enforce with the same measure; Vertex drops it like every keyword outside its set."""

    def __init__(self, limit: int) -> None:
        self.limit = limit

    def __get_pydantic_core_schema__(self, source: type[Any], handler: GetCoreSchemaHandler) -> CoreSchema:
        limit = self.limit

        def check(value: str) -> str:
            if wire_bytes(value) > limit:
                msg = f"longer than {limit} bytes as sent"
                raise ValueError(msg)
            return value

        return core_schema.no_info_after_validator_function(check, handler(source))

    def __get_pydantic_json_schema__(self, schema: CoreSchema, handler: GetJsonSchemaHandler) -> JsonSchemaValue:
        out = handler(schema)
        out["maxBytes"] = self.limit
        return out


def _version_schema(tag: str) -> WithJsonSchema:
    """A schema version literal exported as S2 writes it (`{"type": "string", "enum": [tag]}`): Vertex keeps
    `enum` and drops `const` (TechnoMile `structured.py` `_VERTEX_SCHEMA_KEYS`)."""
    return WithJsonSchema({"type": "string", "enum": [tag]})


class _Distinct:
    """Annotated marker for a list of distinct entries: checked in code and exported as `uniqueItems`, so the
    browser's validator refuses a repeated entry too."""

    def __get_pydantic_core_schema__(self, source: type[Any], handler: GetCoreSchemaHandler) -> CoreSchema:
        def check(values: list[Any]) -> list[Any]:
            if len(set(values)) != len(values):
                msg = "entries must be distinct"
                raise ValueError(msg)
            return values

        return core_schema.no_info_after_validator_function(check, handler(source))

    def __get_pydantic_json_schema__(self, schema: CoreSchema, handler: GetJsonSchemaHandler) -> JsonSchemaValue:
        out = handler(schema)
        out["uniqueItems"] = True
        return out


Distinct = _Distinct()

TurnId = Annotated[str, StringConstraints(pattern=TURN_ID)]
FlagRef = Annotated[str, StringConstraints(pattern=FLAG_REF)]
RecordId = Annotated[str, StringConstraints(pattern=RECORD_ID)]
CitableRecordId = Annotated[str, StringConstraints(pattern=CITABLE_RECORD)]
FactId = Annotated[str, StringConstraints(pattern=FACT_ID)]
UncertaintyId = Annotated[str, StringConstraints(pattern=UNCERTAINTY_ID)]
GateId = Annotated[str, StringConstraints(pattern=GATE_ID)]
Uuid = Annotated[str, StringConstraints(pattern=UUID)]
Sha256 = Annotated[str, StringConstraints(pattern=SHA256)]
Timestamp = Annotated[str, StringConstraints(pattern=TIMESTAMP)]
TurnNo = Annotated[int, Field(ge=1, le=MAX_TURNS)]
Exchanges = Annotated[int, Field(ge=0, le=MAX_TURNS)]


def turn_no(turn_id: str) -> int:
    """`t07` -> 7 (S2 1, C-16)."""
    return int(turn_id[1:])


def turn_id(number: int) -> str:
    """7 -> `t07` (S2 1, C-16)."""
    return f"t{number:02d}"


QuestionType = Literal["open", "probing", "closed", "leading", "suggestive", "compound", "forced_choice", "opinion"]
Label = Literal["deceptive", "truthful", "insufficient_evidence"]
Likelihood = Literal[
    "almost_no_chance", "very_unlikely", "unlikely", "roughly_even_chance", "likely", "very_likely", "almost_certain"
]
Confidence = Literal["low", "moderate", "high"]
FlagKind = Literal["gap", "non_responsive", "possible_evasion", "contradiction", "evidence_conflict"]
EvasionLabel = Literal[
    "poorly_framed_question", "genuine_uncertainty", "responsive", "legitimate_non_disclosure", "evasion"
]
EvaSubtype = Literal[
    "omission",
    "deflection",
    "appeal_to_routine",
    "minimization",
    "feigned_non_recall",
    "counter_question",
    "stall",
    "refusal_without_ground",
]
PfqReason = Literal["compound", "ambiguous_referent", "contested_presupposition", "double_negative", "jargon"]
ArtifactKind = Literal[
    "access_exception_report",
    "badge_log",
    "door_log",
    "sensor_metadata",
    "camera_metadata",
    "camera_status",
    "alarm_log",
    "monitor_alert",
    "dispatch_log",
    "work_order",
    "staffing_note",
    "visitor_register",
    "lockbox_log",
    "credential_record",
    "access_change_notice",
    "incident_ticket",
    "seal_audit",
    "witness_statement",
    "supervisor_statement",
    "email",
    "policy_excerpt",
    "procedure_excerpt",
    "facilities_notice",
    "clarification",
    "context_change",
]


# S2 4.3 code-enforced lengths: characters, and twice that in UTF-8 bytes (S2 1).
Assessment = Annotated[str, StringConstraints(min_length=1, max_length=160), ByteLimit(320)]
Quote = Annotated[str, StringConstraints(min_length=1, max_length=200), ByteLimit(400)]
MissingFact = Annotated[str, StringConstraints(min_length=3, max_length=120), ByteLimit(240)]
FollowUpQuestion = Annotated[str, StringConstraints(min_length=1, max_length=300), ByteLimit(600)]
Purpose = Annotated[str, StringConstraints(min_length=1, max_length=160), ByteLimit(320)]
Rationale = Annotated[str, StringConstraints(min_length=1, max_length=600), ByteLimit(1200)]
Corroboration = Annotated[str, StringConstraints(min_length=3, max_length=120), ByteLimit(240)]
AlternativeExplanation = Annotated[str, StringConstraints(min_length=3, max_length=160), ByteLimit(320)]
# A subject's answer (S2 6.8 V1): 900 characters and 1,800 UTF-8 bytes, wherever it is carried.
Answer = Annotated[str, StringConstraints(min_length=1, max_length=900), ByteLimit(1800)]
# An exact span of one answer, which is at most 900 characters (S2 6.8 V1); empty when J1 gives none (S2 7.2).
EvidenceQuote = Annotated[str, StringConstraints(max_length=900), ByteLimit(1800)]

CardVersion = Annotated[Literal["card.v1"], _version_schema("card.v1")]
DeepVersion = Annotated[Literal["deep.v1"], _version_schema("deep.v1")]
FinalVersion = Annotated[Literal["final.v1"], _version_schema("final.v1")]
RefSubjVersion = Annotated[Literal["ref_subj.v5"], _version_schema("ref_subj.v5")]
RefAsstVersion = Annotated[Literal["ref_asst.v2"], _version_schema("ref_asst.v2")]

# Non-string literals, exact in type (see `_exact`).
EnvelopeVersion = Annotated[Literal[1], _exact(int)]
ScoredTrue = Annotated[Literal[True], _exact(bool)]
ScoredFalse = Annotated[Literal[False], _exact(bool)]
