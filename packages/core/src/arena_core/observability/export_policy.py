"""The export boundary (lift target: TechnoMile T11, `observability/export_policy.py:1-491`; adapted, S5 8.2):
one default-deny sanitizer every exported span passes through, hashing re-export (``phoenix.py``'s re-export of
a span read back from the mirror) and the fail-closed path included.

For each surface the exporter serializes:

- resource: always the provider's fixed resource;
- instrumentation scope: the name only if it is one of ``EXACT_SCOPES`` (no version, schema URL or
  attributes), else hashed;
- span, parent and link contexts: ids and flags only (``trace_state`` dropped);
- attributes (span, event, link): clear only if the key has a validator and the value passes it
  (``METADATA``, S5 8.2), or, on a public (and untainted) span, the key is a known structural key (text then
  PII- and credential-redacted); every other key and value is hashed (sha256 + length);
- span and event names: a sensitive span keeps only a leading word from ``OPERATIONS`` (else hashed); public
  names are PII- and credential-redacted;
- status text: PII- and credential-redacted on a public, untainted span; hashed otherwise.

A ``subject_private`` or ``evaluator`` span taints every ancestor the moment it STARTS (``processors.Lineage``):
tainted spans export any ``exception.*`` text (event or span attribute) and their status text hashed, however
the exception reached them. Caller-supplied labels are untrusted even when shaped like ids: a candidate id is
clear only in ``A1``..``A3``/``S1``..``S3`` form AND registered by ``spans`` (its own helper); a model id only
when registered by the provider port.

``ops.model_calls`` is the only cost source (direction 10, S5 8.2): Phoenix's own cost engine is disabled by
renaming the token-count attributes it keys on (``RENAMED_PREFIXES``), so ``arena.cost_usd`` reaches Phoenix
only as a plain, inert attribute.
"""

import re
import threading
from collections.abc import Callable, Iterable, Mapping, Sequence

from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import Link, Status

from arena_core.observability import pii
from arena_core.observability.redaction import REDACTED, Redaction, hash_payload, is_credential_name

# `opentelemetry.util.types.AttributeValue` is a CHAINED assignment (`AnyValue = AttributeValue = <union>`),
# which mypy does not treat as an implicit type alias (it falls back to `Any`, defeating this module's own
# narrowing checks under this repo's strict config). Declared here instead, explicitly and narrower: the real
# OTel span-attribute spec (never the broader, log-oriented `AnyValue` that also allows `None`, `bytes` and
# `Mapping`), so every other module imports it from here.
type AttributeValue = str | bool | int | float | Sequence[str | bool | int | float]

# ------------------------------------------------------------------------------------------- attribute keys
DATA_CLASS_ATTR = "arena.data_class"
PUBLIC = "public"
SUBJECT_PRIVATE = "subject_private"
EVALUATOR = "evaluator"
DATA_CLASSES = frozenset({PUBLIC, SUBJECT_PRIVATE, EVALUATOR})
# S5 8.3: "a subject_private or evaluator span taints its ancestors at start"; both are hashed alike (8.3's
# "Class C rule"). PUBLIC is the only class that may ever export free text in clear.
SENSITIVE_CLASSES = frozenset({SUBJECT_PRIVATE, EVALUATOR})
SPAN_KIND_ATTR = "openinference.span.kind"

TRIAL_ID_ATTR = "arena.trial.id"
WORK_ITEM_ID_ATTR = "arena.work_item.id"
SESSION_ID_ATTR = "arena.session.id"
TOURNAMENT_ID_ATTR = "arena.tournament.id"
BLOCK_ID_ATTR = "arena.block.id"
SPLIT_ATTR = "arena.split"
MODE_ATTR = "arena.mode"
CALL_TYPE_ATTR = "arena.call_type"
PURPOSE_ATTR = "arena.purpose"
MODEL_ATTR = "arena.model"
THINKING_ATTR = "arena.thinking"
CANDIDATE_ID_ATTR = "arena.candidate.id"
CANDIDATE_MANIFEST_SHA_ATTR = "arena.candidate.manifest_sha"
COST_USD_ATTR = "arena.cost_usd"
LATENCY_MS_ATTR = "arena.latency_ms"
KPI4_SERVER_MS_ATTR = "arena.kpi4.server_ms"
OUTCOME_ATTR = "arena.outcome"
EXCEPTION_PREFIX = "exception."

# Token counts Phoenix prices on. Phoenix 20 also derives llm.token_count.* from the GenAI convention's
# gen_ai.usage.* on ingest, so both namespaces move out of reach, as numbers only (S5 8.2, direction 10).
COST_DRIVING_PREFIX = "llm.token_count."
OBSERVED_COUNT_PREFIX = "arena.observed.token_count."
RENAMED_PREFIXES: tuple[tuple[str, str], ...] = (
    (COST_DRIVING_PREFIX, OBSERVED_COUNT_PREFIX),
    ("gen_ai.usage.", "arena.observed.gen_ai.usage."),
    ("gen_ai.aggregated_usage.", "arena.observed.gen_ai.aggregated_usage."),
)

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
# S5 8.2: candidate ids are A1..A3 (coach) or S1..S3 (subject); the manifest sha is a 64-hex digest.
CANDIDATE_ID_RE = re.compile(r"[AS][1-3]")
MANIFEST_SHA_RE = re.compile(r"[0-9a-f]{64}")
SPLITS = frozenset({"dev", "hidden", "none"})
MODES = frozenset({"practice", "assessment", "tournament", "replay"})
CALL_TYPES = frozenset({"subject", "card", "deep", "final", "referee", "portrait"})
PURPOSES = frozenset(
    {
        "subject.answer",
        "coach.card",
        "coach.deep",
        "coach.final",
        "referee_subject",
        "referee_assistant",
        "r3_subject",
        "r3_investigator",
        "portrait.image",
        "experiment.latency",
        "experiment.fidelity",
        "voice.session",
        "voice.probe",
    }
)
THINKING_LEVELS = frozenset({"minimal", "low", "medium", "high"})
OUTCOMES = frozenset({"ok", "repair", "timeout", "blocked", "budget", "quarantined"})
_EXCEPTION_TYPE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,6}")
_OPERATION = re.compile(r"[A-Za-z_]{1,64}")
EXACT_SCOPES = frozenset({"arena", "openinference.instrumentation.google_genai"})
# S5 8.1 span names, matched on their leading word for a sensitive (subject_private / evaluator) span.
OPERATIONS = frozenset(
    {
        "arena",
        "request",
        "trial",
        "turn",
        "agent",
        "guard",
        "harness",
        "llm",
        "finalize",
        "referee",
        "voice",
    }
)
_PROVIDERS = frozenset({"vertex", "google"})
_KINDS = frozenset(
    {"CHAIN", "AGENT", "LLM", "TOOL", "RETRIEVER", "EMBEDDING", "RERANKER", "GUARDRAIL", "EVALUATOR", "PROMPT"}
)
_MIME = frozenset({"text/plain", "application/json"})
_GENAI_OPERATIONS = frozenset({"chat", "generate_content", "text_completion", "embeddings"})
# S5 8.4: "larger attribute values are cut by the Redactor first" -- applies to a sequence's ELEMENT COUNT
# too, not only a string's character length: a JSONB array's per-element storage overhead means many small
# elements can need far more than their JSON-text byte length once actually stored (measured against a real
# PostgreSQL 17: a 9,000-element array of zero is 27 KB as JSON text but 108 KB of `pg_column_size()`), so
# the mirror's aggregate byte-budget heuristic (a cheap JSON-text proxy, `processors._bounded_otlp`) cannot
# be trusted alone for a value shaped like this. Bounding the element count at the source, here, closes it
# regardless of how the DB's JSONB encodes whatever survives.
MAX_SEQUENCE_ELEMENTS = 256
# Structural key words (OpenInference core conventions, the GenAI semantic convention and this repo's own
# "arena.*" names). On a PUBLIC, untainted span a key made only of these words, "arena" and indices exports its
# (PII- and credential-redacted) text; any other key is hashed on every span.
KEY_WORDS = frozenset(
    [
        "agent",
        "aggregated_usage",
        "arena",
        "arguments",
        "attempt",
        "block",
        "cache_read",
        "cache_write",
        "call",
        "call_type",
        "candidate",
        "completion",
        "completion_details",
        "content",
        "contents",
        "cost_estimated",
        "cost_usd",
        "data_class",
        "description",
        "document",
        "documents",
        "embedding",
        "embeddings",
        "error",
        "exception",
        "finish_reason",
        "format",
        "function",
        "gcp",
        "gen_ai",
        "guard",
        "harness",
        "id",
        "image",
        "input",
        "input_messages",
        "input_tokens",
        "invocation_parameters",
        "json_schema",
        "kind",
        "latency_ms",
        "llm",
        "manifest_sha",
        "message",
        "message_content",
        "messages",
        "metadata",
        "mime_type",
        "mode",
        "model",
        "model_name",
        "model_version",
        "msg",
        "name",
        "no",
        "observed",
        "openinference",
        "operation",
        "outcome",
        "output",
        "output_messages",
        "output_tokens",
        "parameters",
        "portrait",
        "prompt",
        "prompt_details",
        "provider",
        "purpose",
        "query",
        "referee",
        "request",
        "response",
        "response_id",
        "result",
        "retrieval",
        "role",
        "session",
        "split",
        "status",
        "subject",
        "system",
        "task",
        "thinking",
        "token_count",
        "tool",
        "tool_call",
        "tool_call_args",
        "tool_call_id",
        "tool_calls",
        "tool_response",
        "tools",
        "total",
        "tournament",
        "trial",
        "turn",
        "type",
        "url",
        "usage",
        "user",
        "utterance",
        "value",
        "version",
        "vertex",
        "voice",
        "work_item",
    ]
)
_METRIC_PREFIXES = ("arena.observed.",)


class KnownValues:
    """Values our own code registers as safe to show: model ids (the provider port) and span names our span
    helpers, or the frameworks they call, build from our code (``framework_names``). A model's output never
    registers anything: a name it chose (an unknown tool) stays unregistered and is hashed."""

    def __init__(self, max_names: int = 100_000) -> None:
        self._lock = threading.Lock()
        self._models: set[str] = set()
        self._names: dict[str, None] = {}
        self._max_names = max_names

    def register_names(self, names: Iterable[str]) -> None:
        with self._lock:
            for name in names:
                self._names[name] = None
            while len(self._names) > self._max_names:  # the oldest go first; a forgotten name is hashed
                del self._names[next(iter(self._names))]

    def span_name(self, value: str) -> bool:
        with self._lock:
            return value in self._names

    def register_models(self, models: Iterable[str]) -> None:
        with self._lock:
            self._models.update(models)

    def model(self, value: str) -> bool:
        with self._lock:
            return value in self._models


KNOWN = KnownValues()

Validator = Callable[[AttributeValue], bool]


def _enum(values: frozenset[str]) -> Validator:
    return lambda v: isinstance(v, str) and v in values


def _pattern(pattern: re.Pattern[str]) -> Validator:
    return lambda v: isinstance(v, str) and pattern.fullmatch(v) is not None


def _bounded_int(low: int, high: int) -> Validator:
    def check(v: AttributeValue) -> bool:
        return isinstance(v, int) and not isinstance(v, bool) and low <= v <= high

    return check


def _number(v: AttributeValue) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


FIXED_NAMES = frozenset(
    {
        "arena.request",
        "arena.trial",
        "arena.turn",
        "arena.agent.subject",
        "arena.guard",
        "arena.agent.coach",
        "arena.harness",
        "arena.finalize",
        "arena.voice.session",
        "arena.voice.utterance",
    }
)
FIXED_EVENT_NAMES = frozenset({"exception"})
# A known operation whose label is unregistered keeps its operation word; the label is hashed.
_FRAMED_NAMES = (
    re.compile(r"(?P<head>llm\.)(?P<label>.+)(?P<tail>)", re.DOTALL),
    re.compile(r"(?P<head>arena\.referee\.)(?P<label>.+)(?P<tail>)", re.DOTALL),
)
# Common builtin exception names, named directly rather than discovered through `builtins`/`sys.modules`
# introspection (this repo's role-boundary gate, S5 1.2 item 2 rule "dyn", forbids product code from touching
# either: tools/check_roles.py's DYNAMIC_LOADER_MODULES bans `import builtins`, and IMPORT_STATE bans
# `sys.modules`). A dotted, our-package exception class (TechnoMile's T11 also resolved
# ``arena_core.observability.tracing.TracingConfigError``-shaped names) is out of scope for the same reason:
# any such class is hashed here, the conservative direction (safe default: hide more, never less).
BUILTIN_EXCEPTIONS = frozenset(
    {
        "ArithmeticError",
        "AssertionError",
        "AttributeError",
        "BaseException",
        "ConnectionError",
        "Exception",
        "FileNotFoundError",
        "FloatingPointError",
        "ImportError",
        "IndexError",
        "IOError",
        "KeyError",
        "KeyboardInterrupt",
        "LookupError",
        "MemoryError",
        "ModuleNotFoundError",
        "NameError",
        "NotImplementedError",
        "OSError",
        "OverflowError",
        "PermissionError",
        "RecursionError",
        "RuntimeError",
        "StopIteration",
        "SystemExit",
        "TimeoutError",
        "TypeError",
        "UnboundLocalError",
        "UnicodeDecodeError",
        "UnicodeEncodeError",
        "ValueError",
        "ZeroDivisionError",
    }
)


def trusted_exception_type(value: str) -> bool:
    """``exception.type`` is shown only for one of the well-known builtin exception names above; any other
    name (ours or a model's) is hashed."""
    return value in BUILTIN_EXCEPTIONS


def _exception_type(v: AttributeValue) -> bool:
    return isinstance(v, str) and _EXCEPTION_TYPE.fullmatch(v) is not None and trusted_exception_type(v)


def _model(v: AttributeValue) -> bool:
    return isinstance(v, str) and KNOWN.model(v)


def _candidate_id(v: AttributeValue) -> bool:
    return isinstance(v, str) and CANDIDATE_ID_RE.fullmatch(v) is not None


METADATA: Mapping[str, Validator] = {
    SPAN_KIND_ATTR: _enum(_KINDS),
    DATA_CLASS_ATTR: _enum(DATA_CLASSES),
    "llm.provider": _enum(_PROVIDERS),
    "llm.system": _enum(_PROVIDERS),
    "gen_ai.system": _enum(_PROVIDERS),
    "gen_ai.provider.name": _enum(_PROVIDERS),
    "input.mime_type": _enum(_MIME),
    "output.mime_type": _enum(_MIME),
    "gen_ai.operation.name": _enum(_GENAI_OPERATIONS),
    TRIAL_ID_ATTR: _pattern(UUID_RE),
    WORK_ITEM_ID_ATTR: _pattern(UUID_RE),
    SESSION_ID_ATTR: _pattern(UUID_RE),
    TOURNAMENT_ID_ATTR: _pattern(UUID_RE),
    BLOCK_ID_ATTR: _pattern(UUID_RE),
    "arena.turn.no": _bounded_int(0, 100),
    "arena.version": _bounded_int(0, 100),
    "arena.attempt": _bounded_int(0, 100),
    SPLIT_ATTR: _enum(SPLITS),
    MODE_ATTR: _enum(MODES),
    CALL_TYPE_ATTR: _enum(CALL_TYPES),
    PURPOSE_ATTR: _enum(PURPOSES),
    MODEL_ATTR: _model,
    "llm.model_name": _model,
    "gen_ai.request.model": _model,
    "gen_ai.response.model": _model,
    THINKING_ATTR: _enum(THINKING_LEVELS),
    CANDIDATE_ID_ATTR: _candidate_id,
    CANDIDATE_MANIFEST_SHA_ATTR: _pattern(MANIFEST_SHA_RE),
    COST_USD_ATTR: _pattern(re.compile(r"-?[0-9]+(\.[0-9]+)?")),
    LATENCY_MS_ATTR: _number,
    KPI4_SERVER_MS_ATTR: _number,
    OUTCOME_ATTR: _enum(OUTCOMES),
    "exception.type": _exception_type,
}


def _bounded_sequence(value: AttributeValue) -> AttributeValue:
    """Cuts a sequence value to ``MAX_SEQUENCE_ELEMENTS`` elements (never a string, itself a ``Sequence`` of
    characters but handled by its own, separate character-length cut in ``Sanitizer.text()``). Run before
    anything else in ``_value()``: none of the paths after it (``hashed()`` included -- it maps each element
    to its own hash, never fewer of them) touch element count at all."""
    if isinstance(value, Sequence) and not isinstance(value, str) and len(value) > MAX_SEQUENCE_ELEMENTS:
        return list(value[:MAX_SEQUENCE_ELEMENTS])
    return value


def hashed(value: AttributeValue) -> AttributeValue:
    if isinstance(value, str):
        return hash_payload(value)
    if isinstance(value, Sequence):
        return [hash_payload(v if isinstance(v, str) else repr(v)) for v in value]
    return hash_payload(repr(value))


def _payload_hashed(value: AttributeValue) -> AttributeValue:
    """Text hashed; numbers and booleans (and sequences of them) kept, as they carry no free text."""
    if isinstance(value, str) or (isinstance(value, Sequence) and any(isinstance(v, str) for v in value)):
        return hashed(value)
    return value


def is_structural_key(key: str) -> bool:
    return all(seg.isdigit() or seg in KEY_WORDS for seg in key.split("."))


def clean_context(ctx: trace.SpanContext) -> trace.SpanContext:
    """The ids and flags only: ``trace_state`` is caller-controlled text and nothing here needs it."""
    return trace.SpanContext(ctx.trace_id, ctx.span_id, is_remote=ctx.is_remote, trace_flags=ctx.trace_flags)


def clean_scope(scope: InstrumentationScope | None) -> InstrumentationScope:
    name = scope.name if scope is not None else "arena"
    return InstrumentationScope(name if name in EXACT_SCOPES else "scope." + hash_payload(name)[7:23])


class Sanitizer:
    """Applies the export policy (S5 8.2, 8.3) to one ended span, in place."""

    def __init__(self, redaction: Redaction, max_length: int, resource: Resource) -> None:
        self._redaction = redaction
        self._max = max_length
        self._resource = resource

    def span(self, span: ReadableSpan, *, sensitive: bool, tainted: bool) -> None:
        exposed = sensitive or tainted
        attrs = self.attributes(span.attributes or {}, sensitive=sensitive, tainted=exposed)
        span._attributes = attrs
        span._events = tuple(
            Event(
                self.name(ev.name, sensitive=sensitive),
                self.attributes(ev.attributes or {}, sensitive=sensitive, tainted=exposed),
                ev.timestamp,
            )
            for ev in span.events
        )
        span._links = tuple(
            Link(
                clean_context(link.context),
                self.attributes(link.attributes or {}, sensitive=sensitive, tainted=exposed),
            )
            for link in span.links
        )
        description = span.status.description
        if description:
            readable = not exposed
            span._status = Status(
                span.status.status_code, self.text(description) if readable else hash_payload(description)
            )
        span._name = self.name(span.name, sensitive=sensitive)
        self.envelope(span)

    def envelope(self, span: ReadableSpan) -> None:
        """Resource, scope and contexts: applied on every path, the fail-closed one included."""
        if span.context is not None:
            span._context = clean_context(span.context)
        if span.parent is not None:
            span._parent = clean_context(span.parent)
        span._instrumentation_scope = clean_scope(span.instrumentation_scope)
        span._instrumentation_info = None
        span._resource = self._resource

    def text(self, value: str) -> str:
        """A registered secret's exact text is masked FIRST, before anything else can mutate it (regression,
        Codex self-gate round 3, major: a secret with an email- or phone-shaped tail, e.g. a DSN password
        immediately followed by "@host", had its exact string broken by the PII pass before the credential
        pass ever got to match it, leaving the password itself exposed in clear next to a redacted "[email]").
        Then PII-redacted (``pii.redact_text``, C1), then the REST of credential redaction (T16) -- both
        before the length cut, so a secret or an email cannot survive by sitting across the truncation
        boundary from its pattern and only its tail gets cut."""
        value = self._redaction.mask_registered(value)
        value = pii.redact_text(value) or ""
        out = self._redaction.text(value, truncated=len(value) >= self._max)
        if len(out) > self._max:
            out = self._redaction.text(out[: self._max], truncated=True)[: self._max]
        return out

    def name(self, name: str, *, sensitive: bool) -> str:
        """Public: kept only when it is a fixed name or a REGISTERED one (our span helpers; names built from
        our code) and holds no credential-shaped token or registered secret, else hashed. Sensitive
        (subject_private or evaluator): the discriminating operation word if it is a known one, else a hash
        -- the shared "arena." namespace prefix is skipped first (S5 8.1's span names almost all carry it;
        matching on the bare leading word would otherwise collapse every one of them to the same "arena",
        losing the kind distinction OPERATIONS exists to keep: regression, Codex self-gate round 2, major)."""
        if not sensitive:
            registered = name in FIXED_NAMES or name in FIXED_EVENT_NAMES or KNOWN.span_name(name)
            if registered and not self._redaction.credential_shaped(name):
                return name
            for framed in _FRAMED_NAMES:
                match = framed.fullmatch(name)
                if match is not None:
                    return match.group("head") + hash_payload(match.group("label")) + match.group("tail")
            return hash_payload(name)
        operation = self._operation_word(name)
        return operation if operation in OPERATIONS else hash_payload(name)

    def _operation_word(self, name: str) -> str:
        match = _OPERATION.match(name)
        operation = match.group(0) if match else ""
        if operation == "arena" and name.startswith("arena."):
            match = _OPERATION.match(name[len("arena.") :])
            operation = match.group(0) if match else ""
        return operation

    def attributes(
        self, attrs: Mapping[str, AttributeValue], *, sensitive: bool, tainted: bool
    ) -> dict[str, AttributeValue]:
        out: dict[str, AttributeValue] = {}
        for key, value in attrs.items():
            renamed = next((new + key[len(old) :] for old, new in RENAMED_PREFIXES if key.startswith(old)), None)
            name = renamed if renamed is not None else key
            out[self._key(name)] = self._value(
                name, value, sensitive=sensitive, tainted=tainted, count=renamed is not None
            )
        return out

    def _key(self, key: str) -> str:
        if key in METADATA or is_structural_key(key):
            return key
        return "arena.hashed_key." + hash_payload(key)[7:23]

    def _value(self, key: str, value: AttributeValue, *, sensitive: bool, tainted: bool, count: bool) -> AttributeValue:
        value = _bounded_sequence(value)
        if is_credential_name(key):
            return REDACTED  # a credential-named field is masked whatever its value looks like
        numeric = isinstance(value, int | float) and not isinstance(value, bool)
        if count or key.startswith(_METRIC_PREFIXES):
            return value if numeric else hashed(value)  # counts and metrics are numbers only
        exception_text = tainted and key.startswith(EXCEPTION_PREFIX)  # the type too: user classes can be labels
        validator = METADATA.get(key)
        if validator is not None:
            return value if validator(value) and not exception_text and self._inert(value) else hashed(value)
        if sensitive or exception_text or not is_structural_key(key):
            return hashed(value)
        return self._public(value)

    def _inert(self, value: AttributeValue) -> bool:
        """A validated value is kept only if CREDENTIAL redaction (T16) would not change it (shape is not
        safety): checked against ``self._redaction`` directly, not the full ``self.text()`` pipeline. A
        METADATA-constrained value (a UUID, an enum member, a bounded int, a decimal string) is a structured
        system value, never free text, so the broader PII pass (``pii.redact_text``'s email/phone/card
        patterns, run by ``self.text()`` for actual free text) does not apply to it: a plain decimal cost
        like "12.345000" would otherwise false-positive-match the phone pattern and be hashed away, breaking
        S5 8.2's "Phoenix shows arena.cost_usd as a plain attribute"."""
        return not isinstance(value, str) or self._redaction.text(value) == value

    def _public(self, value: AttributeValue) -> AttributeValue:
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, Sequence) and all(isinstance(v, str) for v in value):
            return [self.text(str(v)) for v in value]
        return value  # a number, or a homogeneous sequence of numbers or booleans
