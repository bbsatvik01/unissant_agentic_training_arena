"""Candidate manifest model, hash rule, runtime verification and roster freeze checks (S2 3; AST-5, BKO-5).

- `CandidateManifest` is manifest.v1 (S2 3.1). Integers only: a float anywhere is a validation error (AT-MAN-6),
  so canonical JSON is unambiguous.
- `manifest_sha256` is the S2 3.2 hash rule: drop `sha256` and `frozen_at`, canonical JSON
  (`arena_core.ids.canonical_json`, the gokbase rule), sha256, lowercase hex. The manifest carries the hash of
  every prompt file, user template and output schema, so its hash certifies behavior, not only metadata.
- `load_prompts` is the runtime check of S2 3.3: it reads every file the manifest names, recomputes each hash, the
  output schema hashes and the manifest hash, and raises `ManifestMismatchError` (reason `manifest_mismatch`) on
  any difference; the port records that as `infra_failed` for the trial (WP-05).
- `check_roster` is the freeze check of S2 3.3 and S5 3.3: no negative control or other non-slot kind, no
  exhibition entry, every limit at or below its call-kind ceiling, every model in the allowlist, equal budgets.
- `official_manifests` builds the official candidates of S2 5.3 and 6.5 from the prompt files;
  `python -m arena_core.agents.manifests check` compares them with the committed `prompts/manifests/*.json` and
  `write` regenerates those files after a prompt change (a new prompt is a new version, S2 3.3).

Output schema hashes are of `providers.structured.sent_schema(model)`, the schema a request carries after
`vertex_schema` (S2 3.1); the port sends the same function's output.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, Field, StringConstraints, model_validator

from arena_core.agents.rubric import RUBRIC_FILE, parse_rubric, rubric_path, rubric_text
from arena_core.agents.templates import REPO_ROOT, TemplateError, check_rel_path, file_sha256, read_text
from arena_core.contracts.coaching import CoachingCard, DeepUpdate, FinalFinding
from arena_core.contracts.common import Contract, Sha256
from arena_core.contracts.referee import RefereeAssistantReport, RefereeSubjectReport
from arena_core.contracts.subject import SubjectTurn
from arena_core.ids import canonical_sha256, sha256_hex
from arena_core.providers.structured import sent_schema

MANIFEST_DIR = "prompts/manifests"

Kind = Literal["assistant", "subject", "referee", "negative_control"]
ThinkingLevel = Literal["MINIMAL", "LOW", "MEDIUM", "HIGH"]
RelPath = Annotated[str, StringConstraints(min_length=3, max_length=160)]
PositiveInt = Annotated[int, Field(ge=1)]

# Output models by the `name` and `version` a manifest records (S2 3.1 `output_schemas`).
OUTPUT_MODELS: dict[tuple[str, str], type[BaseModel]] = {
    ("CoachingCard", "card.v1"): CoachingCard,
    ("DeepUpdate", "deep.v1"): DeepUpdate,
    ("FinalFinding", "final.v1"): FinalFinding,
    ("SubjectTurn", "subject.v1"): SubjectTurn,
    ("RefereeSubjectReport", "ref_subj.v5"): RefereeSubjectReport,
    ("RefereeAssistantReport", "ref_asst.v2"): RefereeAssistantReport,
}


class ManifestMismatchError(Exception):
    """A file, schema or manifest hash differs from the manifest (S2 3.3); the port refuses to call the model."""

    reason = "manifest_mismatch"


class RosterRefusedError(Exception):
    """The roster-freeze check refuses to freeze (S2 3.3, S5 3.3)."""

    def __init__(self, reasons: Sequence[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = tuple(reasons)


def output_schema_sha256(model: type[BaseModel]) -> str:
    return canonical_sha256(sent_schema(model))


class FileRef(Contract):
    path: RelPath
    sha256: Sha256

    @model_validator(mode="after")
    def _path(self) -> Self:
        try:
            check_rel_path(self.path)
        except TemplateError as exc:
            raise ValueError(str(exc)) from exc
        return self


class SchemaRef(Contract):
    name: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    version: Annotated[str, StringConstraints(min_length=1, max_length=32)]
    sha256: Sha256


class PromptSpec(Contract):
    files: Annotated[list[FileRef], Field(min_length=1, max_length=16)]
    assembly: Annotated[dict[str, Annotated[list[RelPath], Field(min_length=1, max_length=8)]], Field(max_length=8)]
    user_templates: Annotated[list[FileRef], Field(max_length=8)]
    output_schemas: Annotated[list[SchemaRef], Field(min_length=1, max_length=4)]

    @model_validator(mode="after")
    def _assembly_names_files(self) -> Self:
        paths = [f.path for f in [*self.files, *self.user_templates]]
        if len(set(paths)) != len(paths):
            msg = "prompt.files, prompt.user_templates: each path at most once"
            raise ValueError(msg)
        unknown = sorted({p for parts in self.assembly.values() for p in parts} - {f.path for f in self.files})
        if unknown:
            msg = f"prompt.assembly: {unknown} not in prompt.files"
            raise ValueError(msg)
        return self


class ModelSpec(Contract):
    provider: Literal["vertex"]
    location: Annotated[str, StringConstraints(min_length=1, max_length=32)]


class CallLimit(Contract):
    model_id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9.-]{2,63}$")]
    max_input_tokens: PositiveInt
    max_output_tokens: PositiveInt
    thinking_level: ThinkingLevel
    attempt_timeout_ms: PositiveInt
    deadline_ms: PositiveInt

    def budget(self) -> tuple[int, int, str, int, int]:
        """Everything but the model: what equal budgets compare (S2 3.3; the model is part of the candidate)."""
        return (
            self.max_input_tokens,
            self.max_output_tokens,
            self.thinking_level,
            self.attempt_timeout_ms,
            self.deadline_ms,
        )


class DeepUpdatePolicy(Contract):
    every_n_exchanges: PositiveInt
    on_release: bool


class CoachingPolicy(Contract):
    design: Literal["single_call", "two_stage"]
    deep_update: DeepUpdatePolicy | None
    max_flags_per_card: Annotated[int, Field(ge=0, le=3)]
    may_request_commit: bool

    @model_validator(mode="after")
    def _deep(self) -> Self:
        if (self.design == "two_stage") != (self.deep_update is not None):
            msg = "coaching_policy.deep_update: set exactly for two_stage"
            raise ValueError(msg)
        return self


class SubjectPolicy(Contract):
    policy: Literal["standard", "skilled_deceiver"]


class RepairPolicy(Contract):
    schema_repairs: Literal[1]
    transient_retries: Literal[2]


class Sampling(Contract):
    temperature: None
    seed_rule: Literal["sha256(trial:turn:purpose:attempt)[:4]"]


class Lineage(Contract):
    parent_sha256: Sha256 | None
    change_note: Annotated[str, StringConstraints(min_length=1, max_length=300)]


# The `limits` keys each kind makes (S2 3.1): call kinds, or the referee's purpose labels (C-31).
_COACH_KEYS = (frozenset({"card", "final"}), frozenset({"card", "deep", "final"}))
_LIMIT_KEYS: dict[str, tuple[frozenset[str], ...]] = {
    "assistant": _COACH_KEYS,
    "negative_control": _COACH_KEYS,
    "subject": (frozenset({"subject"}),),
    "referee": (frozenset({"referee_subject", "referee_assistant"}),),
}


def float_paths(node: object, path: str = "manifest") -> list[str]:
    """Every path in a raw JSON value that holds a float."""
    if isinstance(node, float):
        return [path]
    if isinstance(node, Mapping):
        return [p for key, value in node.items() for p in float_paths(value, f"{path}.{key}")]
    if isinstance(node, list | tuple):
        return [p for i, value in enumerate(node) for p in float_paths(value, f"{path}[{i}]")]
    return []


class CandidateManifest(Contract):
    """manifest.v1 (S2 3.1)."""

    manifest_version: Literal["manifest.v1"]
    candidate_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")]
    kind: Kind
    display_name: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    version: Annotated[str, StringConstraints(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")]
    official: bool
    transport: Literal["in_process", "a2a_exhibition"]
    model: ModelSpec | None
    prompt: PromptSpec | None
    tools: Annotated[list[Literal["record_request"]], Field(max_length=1)]
    coaching_policy: CoachingPolicy | None
    subject_policy: SubjectPolicy | None
    limits: Annotated[dict[str, CallLimit], Field(max_length=3)]
    repair: RepairPolicy
    sampling: Sampling
    lineage: Lineage
    sha256: Sha256 | None = None
    frozen_at: Annotated[str, StringConstraints(min_length=1, max_length=40)] | None = None

    @model_validator(mode="before")
    @classmethod
    def _no_floats(cls, data: object) -> object:
        floats = float_paths(data)
        if floats:
            msg = f"{', '.join(floats)}: a float (a manifest holds integers only, S2 3.1)"
            raise ValueError(msg)
        return data

    @model_validator(mode="after")
    def _kind_rules(self) -> Self:
        errors: list[str] = []
        coach = self.kind in ("assistant", "negative_control")
        if self.transport == "in_process" and (self.model is None or self.prompt is None):
            errors.append("model, prompt: required for an in_process candidate")
        if coach != (self.tools == ["record_request"]):
            errors.append('tools: exactly ["record_request"] for assistants, [] otherwise (C-32)')
        if coach != (self.coaching_policy is not None):
            errors.append("coaching_policy: set exactly for assistants")
        if (self.kind == "subject") != (self.subject_policy is not None):
            errors.append("subject_policy: set exactly for subjects")
        keys = frozenset(self.limits)
        if keys not in _LIMIT_KEYS[self.kind]:
            errors.append(f"limits: keys {sorted(keys)} are not the call kinds of a {self.kind}")
        elif self.coaching_policy is not None and (self.coaching_policy.design == "two_stage") != ("deep" in keys):
            errors.append("limits.deep: exists exactly for a two_stage assistant")
        elif self.prompt is not None:
            errors += _prompt_shape_errors(self.kind, keys, self.prompt)
        if errors:
            raise ValueError("; ".join(errors))
        return self


# What each call kind needs in `prompt` (S2 3.1): its assembly, its user template (by file name) and its output
# schema, so every behavior-defining text and schema a call uses is named, hashed and verified.
_CALL_SHAPE: dict[str, tuple[str, str, tuple[str, str]]] = {
    "card": ("card", "user.card.v1.txt", ("CoachingCard", "card.v1")),
    "deep": ("deep", "user.deep.v1.txt", ("DeepUpdate", "deep.v1")),
    "final": ("final", "user.final.v1.txt", ("FinalFinding", "final.v1")),
    "subject": ("subject", "user.turn.v1.txt", ("SubjectTurn", "subject.v1")),
    "referee_subject": ("referee_subject", "subject.user.v1.txt", ("RefereeSubjectReport", "ref_subj.v5")),
    "referee_assistant": ("referee_assistant", "assistant.user.v2.txt", ("RefereeAssistantReport", "ref_asst.v2")),
}
# Subjects also render the Live instruction from their own assembly (S2 9.3).
_EXTRA_ASSEMBLY = {"subject": frozenset({"live"})}


def _prompt_shape_errors(kind: str, keys: frozenset[str], prompt: PromptSpec) -> list[str]:
    """Exactly the assemblies, user templates and output schemas the candidate's call kinds use, each once."""
    errors: list[str] = []
    assemblies = {_CALL_SHAPE[k][0] for k in keys} | _EXTRA_ASSEMBLY.get(kind, frozenset())
    if set(prompt.assembly) != assemblies:
        errors.append(f"prompt.assembly: keys {sorted(prompt.assembly)} are not {sorted(assemblies)}")
    names = sorted(t.path.rsplit("/", 1)[-1] for t in prompt.user_templates)
    if names != sorted(_CALL_SHAPE[k][1] for k in keys):
        errors.append(f"prompt.user_templates: {names} are not the templates of {sorted(keys)}")
    schemas = sorted((s.name, s.version) for s in prompt.output_schemas)
    if schemas != sorted(_CALL_SHAPE[k][2] for k in keys):
        errors.append(f"prompt.output_schemas: {schemas} are not the schemas of {sorted(keys)}")
    return errors


def manifest_sha256(manifest: CandidateManifest | Mapping[str, Any]) -> str:
    """S2 3.2: drop `sha256` and `frozen_at`, canonical JSON, sha256, lowercase hex."""
    obj = manifest.model_dump(mode="json") if isinstance(manifest, CandidateManifest) else dict(manifest)
    obj.pop("sha256", None)
    obj.pop("frozen_at", None)
    return canonical_sha256(obj)


@dataclass(frozen=True)
class PromptSet:
    """The verified texts of one manifest: every prompt file and user template by path."""

    manifest: CandidateManifest
    texts: Mapping[str, str]

    def text(self, path: str) -> str:
        if path not in self.texts:
            msg = f"{path} is not a file of manifest {self.manifest.candidate_id}"
            raise ManifestMismatchError(msg)
        return self.texts[path]

    def user_template(self, name: str) -> str:
        """The manifest's user template whose file name is `name`, wherever the manifest keeps it."""
        prompt = self.manifest.prompt
        paths = [t.path for t in prompt.user_templates if t.path.rsplit("/", 1)[-1] == name] if prompt else []
        if len(paths) != 1:
            msg = f"manifest {self.manifest.candidate_id} has no single user template {name}"
            raise ManifestMismatchError(msg)
        return self.text(paths[0])

    def assembly(self, key: str) -> list[str]:
        prompt = self.manifest.prompt
        if prompt is None or key not in prompt.assembly:
            msg = f"manifest {self.manifest.candidate_id} has no assembly for {key}"
            raise ManifestMismatchError(msg)
        return [self.text(p) for p in prompt.assembly[key]]


def load_prompts(manifest: CandidateManifest, root: Path = REPO_ROOT) -> PromptSet:
    """S2 3.3 runtime check: every named file, every output schema and the manifest itself hash as recorded."""
    if manifest.prompt is None:
        msg = f"manifest_mismatch for {manifest.candidate_id}: no prompt"
        raise ManifestMismatchError(msg)
    problems: list[str] = []
    # S2 3.3: the recorded manifest hash is compared every time; a manifest without one is not verifiable.
    if manifest.sha256 is None:
        problems.append("manifest sha256 missing")
    elif manifest.sha256 != manifest_sha256(manifest):
        problems.append("manifest sha256")
    texts: dict[str, str] = {}
    for ref in [*manifest.prompt.files, *manifest.prompt.user_templates]:
        try:
            text = read_text(ref.path, root)
        except (OSError, TemplateError) as exc:
            problems.append(f"{ref.path} unreadable ({type(exc).__name__})")
            continue
        # One read: the hash is of the very text returned (UTF-8 round-trips exactly), never of a second read.
        if sha256_hex(text.encode("utf-8")) != ref.sha256:
            problems.append(f"{ref.path} sha256")
        texts[ref.path] = text
    for schema in manifest.prompt.output_schemas:
        model = OUTPUT_MODELS.get((schema.name, schema.version))
        if model is None or output_schema_sha256(model) != schema.sha256:
            problems.append(f"output schema {schema.name} {schema.version}")
    if problems:
        msg = f"manifest_mismatch for {manifest.candidate_id}: {', '.join(problems)}"
        raise ManifestMismatchError(msg)
    return PromptSet(manifest, texts)


# S5 3.3 per-call-kind ceilings: (input limit, output limit, attempt timeout ms); and the model allowlist with the
# thinking level each model runs at. The referee's purposes are checked against call kind `referee`.
_CEILINGS: dict[str, tuple[int, int, int]] = {
    "subject": (80_000, 1_600, 15_000),
    "card": (128_000, 1_600, 6_000),
    "deep": (128_000, 3_000, 15_000),
    "final": (128_000, 3_000, 20_000),
    "referee": (160_000, 4_000, 60_000),
}
_FLASH_35 = "gemini-3.5-flash-lite"
_FLASH_31 = "gemini-3.1-flash-lite"
_ALLOWED: dict[str, dict[str, str]] = {
    "subject": {_FLASH_31: "MINIMAL", _FLASH_35: "MINIMAL"},
    "card": {_FLASH_35: "MINIMAL", _FLASH_31: "MINIMAL"},
    "deep": {_FLASH_35: "MINIMAL"},
    "final": {_FLASH_35: "MINIMAL", _FLASH_31: "MINIMAL"},
    # S2 3.1, 7.1: R1 on gemini-3.1-flash-lite, R2 on gemini-3.5-flash-lite, both at MINIMAL (R1 was LOW in S2;
    # see REFEREE_SUBJECT_BUDGET).
    "referee_subject": {_FLASH_31: "MINIMAL"},
    "referee_assistant": {_FLASH_35: "MINIMAL"},
}


def limit_errors(manifest: CandidateManifest) -> list[str]:
    """Every `limits` entry at or below S5 3.3's ceiling for its call kind, with an allowlisted model."""
    errors: list[str] = []
    for key, limit in manifest.limits.items():
        call_kind = "referee" if key.startswith("referee_") else key
        max_in, max_out, max_timeout = _CEILINGS[call_kind]
        where = f"{manifest.candidate_id} limits.{key}"
        if limit.max_input_tokens > max_in or limit.max_output_tokens > max_out:
            errors.append(f"{where}: token limit above the {call_kind} ceiling")
        if limit.attempt_timeout_ms > max_timeout:
            errors.append(f"{where}: attempt timeout above the {call_kind} ceiling")
        if limit.deadline_ms < limit.attempt_timeout_ms:
            errors.append(f"{where}: deadline shorter than one attempt")
        thinking = _ALLOWED[key].get(limit.model_id)
        if thinking is None:
            errors.append(f"{where}: model {limit.model_id} not in the {key} allowlist")
        elif thinking != limit.thinking_level:
            errors.append(f"{where}: thinking level {limit.thinking_level}, the allowlist says {thinking}")
    return errors


def _unequal(
    manifests: Iterable[CandidateManifest], what: str, value: Callable[[CandidateManifest], object]
) -> list[str]:
    """Every entry compared (a list, never a dict keyed by candidate, so no version hides another)."""
    seen = [(f"{m.candidate_id}@{m.version}", value(m)) for m in manifests]
    if len({json.dumps(v, sort_keys=True) for _, v in seen}) > 1:
        return [f"unequal {what}: {seen}"]
    return []


def _card(m: CandidateManifest) -> object:
    return m.limits["card"].budget() if "card" in m.limits else None


def _final(m: CandidateManifest) -> object:
    return m.limits["final"].budget() if "final" in m.limits else None


def _max_flags(m: CandidateManifest) -> object:
    return m.coaching_policy.max_flags_per_card if m.coaching_policy else None


DEEP_CANDIDATE = "A1"


def check_roster(manifests: Sequence[CandidateManifest]) -> None:
    """S2 3.3 and S5 3.3: refuse to freeze unless the roster is official in-process assistants and subjects with
    equal budgets, limits within the ceilings and allowlisted models."""
    errors: list[str] = []
    ids = [m.candidate_id for m in manifests]
    errors += [f"{c}: on the roster more than once" for c in sorted({c for c in ids if ids.count(c) > 1})]
    for m in manifests:
        if m.kind not in ("assistant", "subject"):
            errors.append(f"{m.candidate_id}: a {m.kind} cannot be on a tournament roster")
        if not m.official or m.transport != "in_process":
            errors.append(f"{m.candidate_id}: only official in_process candidates are frozen")
        # S2 3.3, 5.3: the deep update is A1's design (two_stage); every other official assistant is single_call.
        if m.kind == "assistant" and m.candidate_id != DEEP_CANDIDATE and "deep" in m.limits:
            errors.append(f"{m.candidate_id}: limits.deep (a two_stage design) exists only for {DEEP_CANDIDATE}")
        errors += limit_errors(m)
    assistants = [m for m in manifests if m.kind == "assistant"]
    subjects = [m for m in manifests if m.kind == "subject"]
    errors += _unequal(assistants, "limits.card", _card)
    errors += _unequal(assistants, "limits.final", _final)
    errors += _unequal(assistants, "max_flags_per_card", _max_flags)
    errors += _unequal(assistants, "tools", lambda m: m.tools)
    errors += _unequal(subjects, "limits.subject", lambda m: m.limits["subject"].budget())
    if errors:
        raise RosterRefusedError(errors)


def check_referee_freeze(manifest: CandidateManifest, root: Path = REPO_ROOT) -> None:
    """S2 7.4: the referee manifest cannot freeze without the real `rubric.v1` among its hashed files, read from
    the verified bytes and valid as `rubric.v1`."""
    errors = limit_errors(manifest)
    if manifest.kind != "referee":
        errors.append(f"{manifest.candidate_id}: not a referee manifest")
    files = [f.path for f in manifest.prompt.files] if manifest.prompt else []
    path = rubric_path(files)
    if path is None:
        errors.append(f"{manifest.candidate_id}: no {RUBRIC_FILE} hash; the referee cannot freeze on a placeholder")
    else:
        try:
            parse_rubric(load_prompts(manifest, root).text(path))
        except (ValueError, ManifestMismatchError) as exc:
            errors.append(f"{manifest.candidate_id}: {RUBRIC_FILE} is not a valid rubric.v1 ({type(exc).__name__})")
    if errors:
        raise RosterRefusedError(errors)


# ---------------------------------------------------------------- official candidates (S2 5.3, 6.5, 7.1)

COACH_DIR = "prompts/coach/"
SUBJECT_DIR = "prompts/subject/"
REFEREE_DIR = "prompts/referee/"
COMMON_V1 = f"{COACH_DIR}common.v1.txt"
COMMON = f"{COACH_DIR}common.v2.txt"
FINAL = f"{COACH_DIR}final.v1.txt"
DEEP = f"{COACH_DIR}a1.deep.v1.txt"
USER_CARD = f"{COACH_DIR}user.card.v1.txt"
USER_DEEP = f"{COACH_DIR}user.deep.v1.txt"
USER_FINAL = f"{COACH_DIR}user.final.v1.txt"
SUBJECT_SYSTEM = f"{SUBJECT_DIR}system.v1.txt"
SUBJECT_LIVE = f"{SUBJECT_DIR}live.v1.txt"
ROLE_T_V1 = f"{SUBJECT_DIR}role.t.v1.txt"
ROLE_T = f"{SUBJECT_DIR}role.t.v2.txt"
ROLE_D_V1 = f"{SUBJECT_DIR}role.d.v1.txt"
ROLE_D = f"{SUBJECT_DIR}role.d.v2.txt"
STYLE_V1 = f"{SUBJECT_DIR}style.v1.txt"
STYLE = f"{SUBJECT_DIR}style.v2.txt"
# Every style table a registered subject version may name (the subject builder renders the manifest's own).
STYLES = (STYLE_V1, STYLE)
# Every role block T and D a registered subject version may name.
ROLE_TS = (ROLE_T_V1, ROLE_T)
ROLE_DS = (ROLE_D_V1, ROLE_D)
POLICY = {"standard": f"{SUBJECT_DIR}policy.standard.v1.txt", "skilled_deceiver": f"{SUBJECT_DIR}policy.skilled.v1.txt"}
SUBJECT_USER = f"{SUBJECT_DIR}user.turn.v1.txt"
REFEREE_SUBJECT = f"{REFEREE_DIR}subject.v2.txt"
REFEREE_ASSISTANT = f"{REFEREE_DIR}assistant.v2.txt"
REFEREE_SUBJECT_USER = f"{REFEREE_DIR}subject.user.v1.txt"
REFEREE_ASSISTANT_USER = f"{REFEREE_DIR}assistant.user.v2.txt"
# S2 3.4/7.4: the published rubric.v1 file (`rubric_text`), registered on the referee manifest by default.
REFEREE_RUBRIC = f"{REFEREE_DIR}{RUBRIC_FILE}"


# S2 2 per call kind: (input tokens, output tokens incl. thinking, thinking level, attempt timeout ms, deadline ms).
CARD_BUDGET = (128_000, 1_600, "MINIMAL", 6_000, 12_000)
DEEP_BUDGET = (128_000, 3_000, "MINIMAL", 10_000, 20_000)
FINAL_BUDGET = (128_000, 3_000, "MINIMAL", 15_000, 30_000)
SUBJECT_BUDGET = (80_000, 1_600, "MINIMAL", 8_000, 20_000)
# MINIMAL, not S2's LOW: at LOW the 12-turn R1 report ran out of its 4,000 output tokens in 30 of 71 real calls
# (thinking averaged 2,378 tokens on those); at MINIMAL it used 1,400-2,900 (real pilot, 2026-10-12).
REFEREE_SUBJECT_BUDGET = (160_000, 4_000, "MINIMAL", 30_000, 90_000)
REFEREE_ASSISTANT_BUDGET = (160_000, 4_000, "MINIMAL", 30_000, 90_000)


def _limit(model_id: str, budget: tuple[int, int, str, int, int]) -> dict[str, Any]:
    max_in, max_out, thinking, timeout, deadline = budget
    return {
        "model_id": model_id,
        "max_input_tokens": max_in,
        "max_output_tokens": max_out,
        "thinking_level": thinking,
        "attempt_timeout_ms": timeout,
        "deadline_ms": deadline,
    }


def _refs(paths: Iterable[str], root: Path) -> list[dict[str, str]]:
    return [{"path": p, "sha256": file_sha256(p, root)} for p in paths]


def _schemas(*keys: tuple[str, str]) -> list[dict[str, str]]:
    return [{"name": n, "version": v, "sha256": output_schema_sha256(OUTPUT_MODELS[(n, v)])} for n, v in keys]


@dataclass(frozen=True)
class Release:
    """One version of the official coaches and subjects: the shared files and why they changed (S2 3.3: a new
    prompt is a new version whose `lineage.parent_sha256` names the version it replaces). A candidate whose files
    did not change keeps its version, and so its manifest."""

    coach_version: str
    subject_version: str
    common: str
    style: str
    role_t: str
    role_d: str
    coach_note: str
    subject_note: str


_COACH_1_1_NOTE = (
    "common.v2: an unexplained 'do not remember' about a point the subject could answer is possible_evasion and is"
    " flagged; neutrality issues are the investigator's own wording only; follow-ups never repeat a question and"
    " stay a question at the last exchange."
)
INITIAL = Release("1.0.0", "1.0.0", COMMON_V1, STYLE_V1, ROLE_T_V1, ROLE_D_V1, "initial", "initial")
RELEASES: tuple[Release, ...] = (
    INITIAL,
    Release(
        "1.1.0",
        "1.1.0",
        COMMON,
        STYLE,
        ROLE_T_V1,
        ROLE_D_V1,
        _COACH_1_1_NOTE,
        "style.v2: anxious affect said aloud at most once and no repeated remarks about feelings; varied fillers.",
    ),
    Release(
        "1.1.0",
        "1.2.0",
        COMMON,
        STYLE,
        ROLE_T,
        ROLE_D,
        _COACH_1_1_NOTE,
        "role.d.v2: a HOLD or CORE fact is never denied, claimed forgotten or explained away under pressure; a"
        " permitted behavior or a short non-answer instead. role.t.v2: nothing is said not to exist or not to have"
        " happened, and no method described, beyond the ledger.",
    ),
)
CURRENT = RELEASES[-1]


def _base(
    candidate_id: str, kind: str, display_name: str, version: str = "1.0.0", note: str = "initial"
) -> dict[str, Any]:
    return {
        "manifest_version": "manifest.v1",
        "candidate_id": candidate_id,
        "kind": kind,
        "display_name": display_name,
        "version": version,
        "official": True,
        "transport": "in_process",
        "model": {"provider": "vertex", "location": "global"},
        "repair": {"schema_repairs": 1, "transient_retries": 2},
        "sampling": {"temperature": None, "seed_rule": "sha256(trial:turn:purpose:attempt)[:4]"},
        "lineage": {"parent_sha256": None, "change_note": note},
    }


@dataclass(frozen=True)
class CoachSpec:
    """One S2 5.3 assistant: identity, strategy file, model and design."""

    candidate_id: str
    display_name: str
    strategy: str
    model_id: str
    two_stage: bool


def assistant_manifest(spec: CoachSpec, root: Path = REPO_ROOT, release: Release = CURRENT) -> dict[str, Any]:
    """An S2 5.3 coach: the common contract, its strategy block and the final block; A1 adds the deep call."""
    candidate_id, display_name, strategy, model_id, two_stage = (
        spec.candidate_id,
        spec.display_name,
        spec.strategy,
        spec.model_id,
        spec.two_stage,
    )
    common = release.common
    files = [common, strategy, *([DEEP] if two_stage else []), FINAL]
    assembly = {"card": [common, strategy], "final": [common, strategy, FINAL]}
    templates = [USER_CARD, USER_FINAL]
    schemas = [("CoachingCard", "card.v1"), ("FinalFinding", "final.v1")]
    limits = {
        "card": _limit(model_id, CARD_BUDGET),
        "final": _limit(model_id, FINAL_BUDGET),
    }
    if two_stage:
        assembly["deep"] = [DEEP]
        templates.insert(1, USER_DEEP)
        schemas.insert(1, ("DeepUpdate", "deep.v1"))
        limits["deep"] = _limit(model_id, DEEP_BUDGET)
    return {
        **_base(candidate_id, "assistant", display_name, release.coach_version, release.coach_note),
        "prompt": {
            "files": _refs(files, root),
            "assembly": assembly,
            "user_templates": _refs(templates, root),
            "output_schemas": _schemas(*schemas),
        },
        "tools": ["record_request"],
        "coaching_policy": {
            "design": "two_stage" if two_stage else "single_call",
            "deep_update": {"every_n_exchanges": 3, "on_release": True} if two_stage else None,
            "max_flags_per_card": 3,
            "may_request_commit": True,
        },
        "subject_policy": None,
        "limits": limits,
    }


@dataclass(frozen=True)
class SubjectSpec:
    """One S2 6.5 subject: identity, model and policy."""

    candidate_id: str
    display_name: str
    model_id: str
    policy: str


def subject_manifest(spec: SubjectSpec, root: Path = REPO_ROOT, release: Release = CURRENT) -> dict[str, Any]:
    """An S2 6.5 subject: base, role blocks T and D, its policy block and the style table; the Live instruction
    (S2 9.3) renders from the same blocks. The builder picks the role block by the packet's role."""
    candidate_id, display_name, model_id, policy = spec.candidate_id, spec.display_name, spec.model_id, spec.policy
    behavior = [release.role_t, release.role_d, POLICY[policy], release.style]
    return {
        **_base(candidate_id, "subject", display_name, release.subject_version, release.subject_note),
        "prompt": {
            "files": _refs([SUBJECT_SYSTEM, *behavior, SUBJECT_LIVE], root),
            "assembly": {"subject": [SUBJECT_SYSTEM, *behavior], "live": [SUBJECT_LIVE, *behavior]},
            "user_templates": _refs([SUBJECT_USER], root),
            "output_schemas": _schemas(("SubjectTurn", "subject.v1")),
        },
        "tools": [],
        "coaching_policy": None,
        "subject_policy": {"policy": policy},
        "limits": {"subject": _limit(model_id, SUBJECT_BUDGET)},
    }


def referee_manifest(root: Path = REPO_ROOT, rubric: str | None = REFEREE_RUBRIC) -> dict[str, Any]:
    """The S2 7.1 referee: J1+J2 and J3+J4 prompts, plus the published `rubric.v1` file (S2 3.4/7.4), registered
    by default so `check_referee_freeze` accepts the manifest without a `rubric=` override. Pass `rubric=None`
    to build the pre-publication shape (no rubric.v1 hashed, J4 needs a development placeholder,
    `arena_referee.scoring.default_dev_rubric`) that a few tests still exercise, or another path to register a
    fixture rubric instead."""
    files = [REFEREE_SUBJECT, REFEREE_ASSISTANT, *([rubric] if rubric else [])]
    return {
        **_base("referee", "referee", "Referee"),
        "prompt": {
            "files": _refs(files, root),
            "assembly": {"referee_subject": [REFEREE_SUBJECT], "referee_assistant": [REFEREE_ASSISTANT]},
            "user_templates": _refs([REFEREE_SUBJECT_USER, REFEREE_ASSISTANT_USER], root),
            "output_schemas": _schemas(
                ("RefereeSubjectReport", "ref_subj.v5"), ("RefereeAssistantReport", "ref_asst.v2")
            ),
        },
        "tools": [],
        "coaching_policy": None,
        "subject_policy": None,
        "limits": {
            "referee_subject": _limit(_FLASH_31, REFEREE_SUBJECT_BUDGET),
            "referee_assistant": _limit(_FLASH_35, REFEREE_ASSISTANT_BUDGET),
        },
    }


def with_hash(raw: Mapping[str, Any]) -> CandidateManifest:
    manifest = CandidateManifest.model_validate(raw)
    return manifest.model_copy(update={"sha256": manifest_sha256(manifest)})


def official_manifests(root: Path = REPO_ROOT, release: Release = CURRENT) -> dict[str, CandidateManifest]:
    """The official roster of S2 5.3 and 6.5 at `release`, each with its `sha256` filled in. A candidate whose
    version changed from the previous release names that release's manifest in `lineage.parent_sha256`; one whose
    version did not keeps the previous lineage (S2 3.3)."""
    raw = _official_raw(root, release)
    index = RELEASES.index(release)
    if index:
        earlier = official_manifests(root, RELEASES[index - 1])
        for m in raw:
            prev = earlier[m["candidate_id"]]
            if prev.version == m["version"]:
                m["lineage"] = prev.lineage.model_dump(mode="json")
            else:
                m["lineage"]["parent_sha256"] = prev.sha256
    return {m.candidate_id: m for m in map(with_hash, raw)}


def _official_raw(root: Path, release: Release) -> list[dict[str, Any]]:
    coaches = [
        CoachSpec("A1", "Evidence Strategist", f"{COACH_DIR}a1.strategy.v1.txt", _FLASH_35, two_stage=True),
        CoachSpec("A2", "Cognitive-Load Prober", f"{COACH_DIR}a2.strategy.v1.txt", _FLASH_35, two_stage=False),
        CoachSpec("A3", "Conservative Corroborator", f"{COACH_DIR}a3.strategy.v1.txt", _FLASH_31, two_stage=False),
    ]
    return [
        *(assistant_manifest(spec, root, release) for spec in coaches),
        subject_manifest(SubjectSpec("S1", "Subject S1", _FLASH_31, "standard"), root, release),
        subject_manifest(SubjectSpec("S2", "Subject S2", _FLASH_35, "standard"), root, release),
        subject_manifest(SubjectSpec("S3", "Subject S3", _FLASH_35, "skilled_deceiver"), root, release),
    ]


def manifest_text(manifest: CandidateManifest) -> str:
    """The committed form: pretty JSON, sorted keys, final newline (the hash itself is of canonical JSON)."""
    return json.dumps(manifest.model_dump(mode="json", exclude={"frozen_at"}), indent=2, sort_keys=True) + "\n"


def committed_manifest(candidate_id: str, root: Path = REPO_ROOT) -> CandidateManifest:
    return CandidateManifest.model_validate(json.loads(read_text(f"{MANIFEST_DIR}/{candidate_id}.json", root)))


def main(argv: Sequence[str], root: Path = REPO_ROOT) -> int:
    """`check`: the committed manifests and `rubric.v1.json` equal what the prompt files and `canonical_rubric`
    give; `write`: regenerate them."""
    if list(argv) not in (["check"], ["write"]):
        sys.stderr.write("usage: python -m arena_core.agents.manifests check|write\n")
        return 2
    stale = []
    for candidate_id, manifest in official_manifests(root).items():
        path = root / MANIFEST_DIR / f"{candidate_id}.json"
        text = manifest_text(manifest)
        if argv[0] == "write":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        elif not path.is_file() or path.read_text(encoding="utf-8") != text:
            stale.append(candidate_id)
    # S2 3.4/7.4: the committed rubric.v1 the default referee manifest registers must itself be exactly
    # `canonical_rubric()`'s text, never hand-edited out of step with spec S3's published checks and anchors.
    rubric_file_path = root / REFEREE_RUBRIC
    rubric_file_text = rubric_text()
    if argv[0] == "write":
        rubric_file_path.parent.mkdir(parents=True, exist_ok=True)
        rubric_file_path.write_text(rubric_file_text, encoding="utf-8")
    elif not rubric_file_path.is_file() or rubric_file_path.read_text(encoding="utf-8") != rubric_file_text:
        stale.append("referee rubric.v1")
    if stale:
        sys.stderr.write(f"stale manifests {stale}: a prompt changed; bump the version and run `write`\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
