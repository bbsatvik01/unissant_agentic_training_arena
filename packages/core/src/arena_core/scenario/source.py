"""`FamilySource`: the typed model of what an authoring agent writes (S1 8.3; D-014).

A family source is JSON. Its shape is the one the S1 reference kit's Python sources (`SRC` dicts in
`src_f01.py`..`src_f03.py`) dump to; the Python sources use tuples where JSON has arrays (known timeline,
ledger rows, uncertainty rows, release predicates, support links), and the model reads both because a
Python dict is converted through JSON first (`parse_source`).

IDs may be written in the kit's short form or in canonical form; the assembler canonicalizes them:

- fact `f01` -> `f:01`;
- initial documents `D1`..`D4` -> `doc-01`..`doc-04`; releasable records `R1`..`R6` -> `rec-01`..`rec-06`, and
  the kit's scheduled-record names `S1`, `S2` -> `rec-05`, `rec-06`;
- uncertainty `u01`, forbidden assertion `x01`, contradiction `c01`, decisive item `r01`, key question `q01`,
  alternative `a01` -> `u:01`, `x:01`, `c:01`, `r:01`, `q:01`, `a:01`;
- turn-label guide entry `g01` -> `l:01`.

Gate IDs (`g:NN`), case packets, EFM levels and precondition records are derived by the assembler, never
written here. The code-owned fields of S1 8.3 (family ID, split, domain, taxonomy, difficulty level, style,
provenance, agency, presentation) are optional: a family authored from a seed gets them from its seed spec
(`assemble(source, authoring)`), and a source assembled without one must carry them (the committed
development sources do). Each variant's `case_id` and `canaries` are drawn by code
(`assemble.draw_identifiers`, a CSPRNG) and recorded here, never chosen by the author. Ledger rows
(`known`) and unknown-fact views are written in the subject's first person; the assembler renders them in
the second person. Knobs are always computed by the assembler. The model is strict: unknown keys, wrong
types and malformed IDs fail at load time with the path of the bad value.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from arena_core.ids import canonical_json, read_json_text

Variant = Literal["truthful", "deceptive"]
VARIANTS: tuple[Variant, Variant] = ("truthful", "deceptive")

FactRef = Annotated[str, Field(pattern=r"^(?:f[0-9]{2}|f:[0-9]{2,3})$")]
ArtifactRef = Annotated[str, Field(pattern=r"^(?:D[1-4]|R[1-6]|S[12]|doc-0[1-4]|rec-0[1-6])$")]
DocRef = Annotated[str, Field(pattern=r"^(?:D[1-4]|doc-0[1-4])$")]
UncertaintyRef = Annotated[str, Field(pattern=r"^u:?[0-9]{2}$")]
ForbiddenRef = Annotated[str, Field(pattern=r"^x:?[0-9]{2}$")]
ContradictionRef = Annotated[str, Field(pattern=r"^c:?[0-9]{2}$")]
DecisiveRef = Annotated[str, Field(pattern=r"^r:?[0-9]{2}$")]
QuestionRef = Annotated[str, Field(pattern=r"^q:?[0-9]{2}$")]
AlternativeRef = Annotated[str, Field(pattern=r"^a:?[0-9]{2}$")]
LabelRef = Annotated[str, Field(pattern=r"^(?:g[0-9]{2}|l:[0-9]{2})$")]

CASE_ID_PATTERN = r"^C-[0-9A-HJKMNP-TV-Z]{8}$"  # S1 2: C- plus 8 Crockford base32 characters
CANARY_PATTERN = r"^CANARY-[0-9a-f]{16}$"  # private-packet.schema.json#/$defs/canary

Strength = Literal["weak", "strong"]
Precision = Literal["low", "high"]

# Evidence Framing Matrix level (S1 2, 6.1): 1 weak/low, 2 weak/high, 3 strong/low, 4 strong/high.
EFM_LEVEL: dict[tuple[str, str], int] = {
    ("weak", "low"): 1,
    ("weak", "high"): 2,
    ("strong", "low"): 3,
    ("strong", "high"): 4,
}

TimelineRow = tuple[str, str, DocRef]  # (facility-local time, event, source initial document)
SupportRow = tuple[FactRef, Strength, Precision]
KnownRow = tuple[FactRef, str, str]  # (fact, certainty, first-person text; rendered in the second person)
UnknownRow = tuple[FactRef, str]  # (fact, first-person subject view; rendered in the second person)
ActionRow = tuple[FactRef, str]  # (fact, first-person description; only the fact ID is assembled)
UncertaintyRow = tuple[UncertaintyRef, FactRef, str, str, str | None]  # (id, fact, text, answer_form, range_text)
ForbiddenRow = tuple[ForbiddenRef, str, FactRef]  # (id, assertion text, contradicted fact)
LabelRow = tuple[LabelRef, str, str, str]  # (id, situation, EVL-8 label, rationale)
Release = tuple[Literal["initial"]] | tuple[Literal["scheduled", "on_request"], int]


class SourceError(ValueError):
    """A family source cannot be assembled; `problems` lists every reason with its source path."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = list(problems)
        super().__init__("; ".join(self.problems))


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class Knobs(_Model):
    key_record_after_exchanges: int
    evidence_directness: int
    misleading_count: int
    uncertainty_count: int
    gate_level: int


class Difficulty(_Model):
    level: int | None = None  # code-owned when a seed is given; required for a hand-authored source
    knobs: Knobs | None = None  # always computed by the assembler; a value given here must agree


class Taxonomy(_Model):
    violation_type: str
    misleading_types: tuple[str, ...]


class Style(_Model):
    verbosity: str
    fluency: str
    affect: str
    # `register` would shadow ABCMeta.register on the model class; the JSON key stays "register".
    register_: str = Field(alias="register")
    language: str


class Provenance(_Model):
    method: str
    created: str
    generator_model: str | None = None
    prompt_sha256: str | None = None
    seed_spec_sha256: str | None = None
    few_shot_family_ids: tuple[str, ...] | None = None
    notes: str


class FamilyMeta(_Model):
    """Every field but `title` is code-owned when the family is authored from a seed (S1 8.3)."""

    family_id: str | None = None
    revision: int = 1  # S1 8.6: 1, or the next number for a revision (`new_revision`)
    split: str | None = None
    domain: str | None = None
    title: str
    taxonomy: Taxonomy | None = None
    difficulty: Difficulty | None = None
    style: Style | None = None
    provenance: Provenance | None = None


class Persona(_Model):
    name: str
    position: str
    organization: str | None = None  # the agency: code-owned when a seed is given
    unit: str
    tenure_years: int
    background: str


class Subject(_Model):
    name: str
    position: str
    unit: str
    tenure_years: int


class InterviewContext(_Model):
    agency: str | None = None  # code-owned when a seed is given (S1 8.3: "interview context (except agency)")
    facility: str
    timezone: str
    interview_date: str
    setting: str
    investigator_role: str
    subject: Subject
    purpose_statement: str


class SourcePresentation(_Model):
    """Written by the agent from the seed spec; `display_name` is derived (the subject's name)."""

    persona_id: str
    voice_id: str


class SourcePublic(_Model):
    investigation_objective: str
    interview_context: InterviewContext
    presentation: SourcePresentation | None = None  # code-owned when a seed is given
    opening_question: str
    replay_topics: tuple[str, ...]
    known_timeline: tuple[TimelineRow, ...]


class SourceFact(_Model):
    id: FactRef
    statement: str
    kind: str
    time: str | None = None
    actors: tuple[str, ...]
    material: bool
    tags: tuple[str, ...]
    variants: tuple[Variant, ...]


class SourceEdge(_Model):
    from_: FactRef = Field(alias="from")
    to: FactRef
    relation: str


class Table(_Model):
    columns: tuple[str, ...]
    rows: tuple[tuple[str, ...], ...]


class Content(_Model):
    body: str
    table: Table | None = None


class SharedContent(_Model):
    """One content for both variants (required for initial and scheduled records, S1 L2)."""

    shared: Content


class SplitContent(_Model):
    """Per-variant content (allowed for on-request records only; V4a checks the others)."""

    truthful: Content
    deceptive: Content


def content_for(content: SharedContent | SplitContent, variant: Variant) -> Content:
    if isinstance(content, SharedContent):
        return content.shared
    return content.truthful if variant == "truthful" else content.deceptive


class VariantSupports(_Model):
    shared: tuple[SupportRow, ...] = ()
    truthful: tuple[SupportRow, ...] = ()
    deceptive: tuple[SupportRow, ...] = ()

    def for_variant(self, variant: Variant) -> tuple[SupportRow, ...]:
        return self.shared + (self.truthful if variant == "truthful" else self.deceptive)


class SourceArtifact(_Model):
    id: ArtifactRef
    kind: str
    release: Release
    title: str
    date: str | None = None
    description: str | None = None
    content: SharedContent | SplitContent
    supports: VariantSupports

    @model_validator(mode="after")
    def _release_fields(self) -> SourceArtifact:
        on_request = self.release[0] == "on_request"
        if on_request and self.description is None:
            msg = "an on_request record needs a description (it is listed in the public packet)"
            raise ValueError(msg)
        if self.date is not None and not on_request:
            msg = "only an on_request record may carry a date (S1 4.1: the date is listed with requestable records)"
            raise ValueError(msg)
        return self


class GateSpec(_Model):
    min_level: int
    condition: str


class Guarded(_Model):
    """A non-FREE ledger fact: PRIVATE (reason privacy), HOLD (with a gate) or CORE (no gate)."""

    fact_id: FactRef
    reason: Literal["privacy", "concealment_support", "concealed_violation"]
    gate: GateSpec | None = None

    @model_validator(mode="after")
    def _privacy_has_no_gate(self) -> Guarded:
        if self.reason == "privacy" and self.gate is not None:
            msg = "a privacy-guarded fact is PRIVATE and cannot have a gate"
            raise ValueError(msg)
        return self


class ResolvedBy(_Model):
    fact_ids: tuple[FactRef, ...]
    artifact_ids: tuple[ArtifactRef, ...]


class Contradiction(_Model):
    id: ContradictionRef
    type: str
    description: str
    fact_ids: tuple[FactRef, ...]
    artifact_ids: tuple[ArtifactRef, ...]
    forbidden_assertion_ids: tuple[ForbiddenRef, ...] | None = None
    resolution: str
    resolved_by: ResolvedBy


class DecisiveItem(_Model):
    id: DecisiveRef
    description: str
    artifact_ids: tuple[ArtifactRef, ...]
    fact_ids: tuple[FactRef, ...]
    requires_subject_account: bool


class Resolution(_Model):
    correct_finding: str
    decisive_support: tuple[DecisiveItem, ...]
    corroboration_to_name: tuple[ArtifactRef, ...]
    unsupported_grounds: tuple[str, ...]


class KeyQuestion(_Model):
    id: QuestionRef
    intent: str
    target_fact_ids: tuple[FactRef, ...]
    neutral_example: str


class Alternative(_Model):
    id: AlternativeRef
    hypothesis: str
    test: str


class DimensionNotes(_Model):
    clarity_neutrality: str
    response_relevance: str
    evidence_based_followup: str
    testing_alternatives: str
    supported_closure: str


class Rubric(_Model):
    key_questions: tuple[KeyQuestion, ...]
    evidence_to_request: tuple[ArtifactRef, ...]
    alternative_explanations: tuple[Alternative, ...]
    dimension_notes: DimensionNotes


class Canaries(_Model):
    """The variant's two leakage-audit tokens (S3 IG-6), drawn at random by `draw_identifiers`."""

    private: str = Field(pattern=CANARY_PATTERN)
    evaluator: str = Field(pattern=CANARY_PATTERN)


class SourceVariant(_Model):
    # Drawn by code, never written by the agent (S1 8.3): `draw_identifiers` fills both from a CSPRNG the
    # first time the source is assembled and records them here; the assembler only copies them.
    case_id: str | None = Field(default=None, pattern=CASE_ID_PATTERN)
    canaries: Canaries | None = None
    concealment_target: str | None = None
    synopsis: str
    relevant_actions: tuple[ActionRow, ...]
    known: tuple[KnownRow, ...]
    unknown: tuple[UnknownRow, ...]
    guarded: tuple[Guarded, ...]
    uncertainty: tuple[UncertaintyRow, ...]
    forbidden: tuple[ForbiddenRow, ...]
    concealed: tuple[FactRef, ...] | None = None
    contradictions: tuple[Contradiction, ...]
    resolution: Resolution
    rubric: Rubric
    label_guide: tuple[LabelRow, ...]

    @model_validator(mode="after")
    def _guarded_facts_are_known_once(self) -> SourceVariant:
        guarded = [canonical_fact_id(g.fact_id) for g in self.guarded]
        if len(guarded) != len(set(guarded)):
            msg = "a fact is guarded more than once"
            raise ValueError(msg)
        unknown_to_subject = sorted(set(guarded) - {canonical_fact_id(row[0]) for row in self.known})
        if unknown_to_subject:
            msg = f"guarded facts must be in the ledger (known): {unknown_to_subject}"
            raise ValueError(msg)
        if self.concealed is not None:
            violations = {canonical_fact_id(g.fact_id) for g in self.guarded if g.reason == "concealed_violation"}
            if {canonical_fact_id(f) for f in self.concealed} != violations:
                msg = "concealed must list exactly the facts guarded with reason concealed_violation"
                raise ValueError(msg)
        return self


class SourceVariants(_Model):
    truthful: SourceVariant
    deceptive: SourceVariant

    @model_validator(mode="after")
    def _role_fields(self) -> SourceVariants:
        if self.truthful.concealment_target is not None or self.truthful.concealed is not None:
            msg = "the truthful variant has no concealment_target or concealed facts"
            raise ValueError(msg)
        if self.deceptive.concealment_target is None:
            msg = "the deceptive variant needs a concealment_target (it names what the objective protects)"
            raise ValueError(msg)
        return self

    def get(self, variant: Variant) -> SourceVariant:
        return self.truthful if variant == "truthful" else self.deceptive


class FamilySource(_Model):
    """One authored case family source (S1 8.3), before assembly."""

    family: FamilyMeta
    persona: Persona
    public: SourcePublic
    facts: tuple[SourceFact, ...]
    edges: tuple[SourceEdge, ...]
    artifacts: tuple[SourceArtifact, ...]
    variants: SourceVariants

    @model_validator(mode="after")
    def _ids_unique_after_canonicalization(self) -> FamilySource:
        """Two spellings of one ID ("f01" and "f:01", or the kit's "R5" and "S1") would collide silently."""
        for kind, ids in (
            ("fact", [canonical_fact_id(f.id) for f in self.facts]),
            ("record", [canonical_artifact_id(a.id) for a in self.artifacts]),
        ):
            duplicates = sorted({i for i in ids if ids.count(i) > 1})
            if duplicates:
                msg = f"{kind} ids {duplicates} are defined twice (S1 and S2 become rec-05 and rec-06)"
                raise ValueError(msg)
        return self


def parse_source(obj: object) -> FamilySource:
    """Validate an in-memory source (a JSON-compatible dict, tuples allowed) through its JSON form."""
    return FamilySource.model_validate_json(canonical_json(obj))


def parse_source_text(text: str) -> FamilySource:
    """Validate a JSON source text; duplicate keys and non-finite numbers are refused first."""
    return parse_source(read_json_text(text))


def load_source(path: Path) -> FamilySource:
    return parse_source_text(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- ID canonicalization

_SCHEDULED_RECORD = {"S1": "rec-05", "S2": "rec-06"}


def canonical_fact_id(ref: str) -> str:
    return ref if ":" in ref else f"f:{ref[1:]}"


def canonical_artifact_id(ref: str) -> str:
    if ref in _SCHEDULED_RECORD:
        return _SCHEDULED_RECORD[ref]
    if ref[0] == "D":
        return f"doc-0{ref[1:]}"
    if ref[0] == "R":
        return f"rec-0{ref[1:]}"
    return ref


def canonical_prefixed_id(ref: str, prefix: str) -> str:
    """`u01` -> `u:01`; an already canonical `u:01` is returned unchanged."""
    return ref if ":" in ref else f"{prefix}:{ref[1:]}"


def canonical_label_id(ref: str) -> str:
    return ref if ref.startswith("l:") else f"l:{ref[1:]}"


# The S1 reference kit's free-text ID rewrite (assemble.py `ID_RULES`), applied in this order. The
# assembler applies it only to evaluator commentary, where authors cross-reference IDs ("credit
# requesting R1-R3"); world text (records, ledger, public packet) is taken verbatim and refused if it
# holds a token this rewrite would change.
PROSE_ID_RULES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bf(\d{2})\b"), r"f:\1"),
    (re.compile(r"\bu(\d{2})\b"), r"u:\1"),
    (re.compile(r"\bx(\d{2})\b"), r"x:\1"),
    (re.compile(r"\bc(\d{2})\b"), r"c:\1"),
    (re.compile(r"\br(\d{2})\b"), r"r:\1"),
    (re.compile(r"\bq(\d{2})\b"), r"q:\1"),
    (re.compile(r"\ba(\d{2})\b"), r"a:\1"),
    (re.compile(r"\bg(\d{2})\b"), r"l:\1"),
    (re.compile(r"\bD([1-4])\b"), r"doc-0\1"),
    (re.compile(r"\bR([1-6])\b"), r"rec-0\1"),
    (re.compile(r"\bS1\b"), "rec-05"),
    (re.compile(r"\bS2\b"), "rec-06"),
)


def rewrite_prose_ids(text: str) -> str:
    for pattern, replacement in PROSE_ID_RULES:
        text = pattern.sub(replacement, text)
    return text


def prose_id_tokens(text: str) -> list[str]:
    """Tokens in `text` that the commentary rewrite would change (empty for clean world text)."""
    return [m.group(0) for pattern, _ in PROSE_ID_RULES for m in pattern.finditer(text)]
