"""Span hierarchy helpers (S5 8.1; lift target: TechnoMile T12, `observability/spans.py:76-174`; adapted):

```
arena.trial (anchor)                     CHAIN       api/job     none
  arena.request                          CHAIN       every       trial anchor (when bound to a trial)
  arena.turn                             CHAIN       api/job     arena.trial
    arena.agent.subject (traceparent)    AGENT       subject     arena.turn (remote)
      arena.guard                        GUARDRAIL   subject     arena.agent.subject
    arena.agent.coach                    AGENT       api/job     arena.turn
    arena.harness                        CHAIN       job         arena.turn
    llm.<call_type>                      LLM         caller      its agent span
  arena.finalize                         CHAIN       api/job     arena.trial
  arena.referee.<task>                   EVALUATOR   referee     arena.request
  arena.voice.session / .utterance       CHAIN       subject/api arena.trial
```

The trial anchor is created and ended once, by whoever creates the trial; its ids are stored on the trial row
(`arena.trials`) and every later request about it parents on those stored ids (``TrialRef.remote_context``),
the same technique as TechnoMile's run anchor (`SpanRef`/`start_run_anchor`), so a trial's whole lifetime,
turn by turn and process by process, lands in one trace.

``arena.agent.subject`` crosses a process boundary (api/job calling `arena-subject`): its parent is a W3C
``traceparent`` sent on that internal call, never the local Lineage registry (the subject process has no
record of the caller's spans), so its trial id, tournament binding and split are passed explicitly too
(``inject_traceparent`` / ``extract_context``).
"""

from collections.abc import Iterator, Mapping, MutableMapping
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from enum import StrEnum

from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, Span, SpanContext, Status, StatusCode, TraceFlags
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from arena_core.observability.export_policy import (
    BLOCK_ID_ATTR,
    DATA_CLASS_ATTR,
    EVALUATOR,
    KNOWN,
    PUBLIC,
    SESSION_ID_ATTR,
    SPAN_KIND_ATTR,
    SPLIT_ATTR,
    SUBJECT_PRIVATE,
    TOURNAMENT_ID_ATTR,
    TRIAL_ID_ATTR,
)
from arena_core.observability.tracing import get_tracer

AttrValue = str | int | float | bool


class Kind(StrEnum):
    CHAIN = "CHAIN"
    AGENT = "AGENT"
    LLM = "LLM"
    GUARDRAIL = "GUARDRAIL"
    EVALUATOR = "EVALUATOR"


@dataclass(frozen=True)
class TrialRef:
    """Hex ids of the trial anchor span, as stored on the trial row (``^[0-9a-f]{32}$`` / ``{16}``)."""

    trace_id: str
    span_id: str

    @classmethod
    def of(cls, span: Span) -> "TrialRef":
        ctx = span.get_span_context()
        return cls(f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}")

    @property
    def valid(self) -> bool:
        return int(self.trace_id, 16) != 0 and int(self.span_id, 16) != 0

    def remote_context(self) -> otel_context.Context:
        """A context whose parent is this trial's anchor, as stored."""
        parent = SpanContext(
            int(self.trace_id, 16), int(self.span_id, 16), is_remote=True, trace_flags=TraceFlags(TraceFlags.SAMPLED)
        )
        return trace.set_span_in_context(NonRecordingSpan(parent))


@dataclass(frozen=True)
class SpanBinding:
    """The S5 8.5 classification and binding a span carries explicitly (``node()``'s ``binding=``); anything
    left at its default is inherited from the parent through ``Lineage`` (``processors.py``), never
    recomputed here. Bundled into one dataclass so ``node()`` itself stays within this repo's 5-argument
    limit (``ruff`` ``PLR0913``/``PLR0917``)."""

    data_class: str = PUBLIC
    trial_id: str | None = None
    tournament_id: str | None = None
    block_id: str | None = None
    split: str | None = None


def _registered(name: str) -> str:
    """A span name our helper builds: registered, so the export boundary shows it (an unregistered name is
    hashed)."""
    KNOWN.register_names([name])
    return name


def register_span_names(*names: str) -> None:
    KNOWN.register_names(names)


def start_trial_anchor(trial_id: str, *, tournament_id: str | None = None, split: str = "none") -> TrialRef:
    """The trial's root span, ended at once; store the returned ids on the trial row."""
    attrs: dict[str, AttrValue] = {
        SPAN_KIND_ATTR: Kind.CHAIN,
        TRIAL_ID_ATTR: trial_id,
        SESSION_ID_ATTR: trial_id,
        DATA_CLASS_ATTR: PUBLIC,
        SPLIT_ATTR: split,
    }
    if tournament_id is not None:
        attrs[TOURNAMENT_ID_ATTR] = tournament_id
    span = get_tracer().start_span(
        "arena.trial",
        context=otel_context.Context(),  # always a root: never a child of the request that created the trial
        attributes=attrs,
    )
    span.end()
    return TrialRef.of(span)


@contextmanager
def node(
    name: str,
    kind: Kind = Kind.CHAIN,
    *,
    binding: SpanBinding | None = None,
    parent: otel_context.Context | None = None,
    attributes: Mapping[str, AttrValue] | None = None,
) -> Iterator[Span]:
    """A span made current for its block. Everything ``binding`` carries is an explicit, own classification
    (S5 8.5); anything it leaves at its default is inherited from the parent through ``Lineage``
    (``processors.py``), not recomputed here."""
    b = binding if binding is not None else SpanBinding()
    attrs: dict[str, AttrValue] = {SPAN_KIND_ATTR: kind, **(attributes or {})}
    if b.data_class != PUBLIC:
        attrs[DATA_CLASS_ATTR] = b.data_class
    if b.trial_id is not None:
        attrs[TRIAL_ID_ATTR] = b.trial_id
    if b.tournament_id is not None:
        attrs[TOURNAMENT_ID_ATTR] = b.tournament_id
    if b.block_id is not None:
        attrs[BLOCK_ID_ATTR] = b.block_id
    if b.split is not None:
        attrs[SPLIT_ATTR] = b.split
    ctx = parent if parent is not None else otel_context.get_current()
    span = get_tracer().start_span(name, context=ctx, attributes=attrs)
    token = otel_context.attach(trace.set_span_in_context(span, ctx))
    try:
        yield span
    except BaseException as exc:
        span.record_exception(exc)
        span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
        raise
    finally:
        otel_context.detach(token)
        span.end()


def request(
    *,
    trial: TrialRef | None = None,
    trial_id: str | None = None,
    tournament_id: str | None = None,
    block_id: str | None = None,
    split: str | None = None,
) -> AbstractContextManager[Span]:
    """``arena.request``: one per HTTP request or job task, parented on the trial anchor when the request
    belongs to one (S5 8.1). ``split`` left unset (the default) is INHERITED from the current span (S5
    8.5): only a request genuinely bound to a tournament names it explicitly."""
    parent = trial.remote_context() if trial is not None else None
    binding = SpanBinding(trial_id=trial_id, tournament_id=tournament_id, block_id=block_id, split=split)
    return node(_registered("arena.request"), parent=parent, binding=binding)


def turn(
    trial: TrialRef, turn_no: int, *, trial_id: str, tournament_id: str | None = None, split: str | None = None
) -> AbstractContextManager[Span]:
    """``arena.turn``: one per turn, current across every retry of it (S5 8.1 P2), parented on the trial
    anchor directly (a sibling of ``arena.request``, not nested under it: the table names ``arena.trial`` as
    its parent). The anchor is a REMOTE parent with no local ``Lineage`` record, so ``trial_id`` (and the
    binding) are passed explicitly, the same as ``request()``."""
    binding = SpanBinding(trial_id=trial_id, tournament_id=tournament_id, split=split)
    return node(
        _registered("arena.turn"),
        parent=trial.remote_context(),
        binding=binding,
        attributes={"arena.turn.no": turn_no},
    )


def agent_coach(trial_id: str | None = None) -> AbstractContextManager[Span]:
    return node(_registered("arena.agent.coach"), Kind.AGENT, binding=SpanBinding(trial_id=trial_id))


def harness(trial_id: str | None = None) -> AbstractContextManager[Span]:
    return node(_registered("arena.harness"), binding=SpanBinding(trial_id=trial_id))


def llm_call(
    call_type: str, *, attempt: int, model: str | None = None, purpose: str | None = None
) -> AbstractContextManager[Span]:
    """``llm.<call_type>``: one per attempt (S5 8.1 T4), nested under its agent span."""
    attrs: dict[str, AttrValue] = {"arena.call_type": call_type, "arena.attempt": attempt}
    if model is not None:
        attrs["arena.model"] = model
    if purpose is not None:
        attrs["arena.purpose"] = purpose
    return node(_registered(f"llm.{call_type}"), Kind.LLM, attributes=attrs)


def finalize(trial: TrialRef, *, trial_id: str, split: str | None = None) -> AbstractContextManager[Span]:
    """``arena.finalize``: parented on the trial anchor directly, like ``turn()``."""
    binding = SpanBinding(trial_id=trial_id, split=split)
    return node(_registered("arena.finalize"), parent=trial.remote_context(), binding=binding)


def referee_task(task: str, *, split: str | None = None) -> AbstractContextManager[Span]:
    """``arena.referee.<task>``: evaluator data class (S5 8.1); ``task`` is registered so the export boundary
    shows the fixed prefix, the task label hashed if it is not itself a registered name."""
    binding = SpanBinding(data_class=EVALUATOR, split=split)
    return node(_registered(f"arena.referee.{task}"), Kind.EVALUATOR, binding=binding)


def voice_session(trial: TrialRef, *, trial_id: str, split: str | None = None) -> AbstractContextManager[Span]:
    """``arena.voice.session``: parented on the trial anchor directly, like ``turn()``."""
    binding = SpanBinding(data_class=SUBJECT_PRIVATE, trial_id=trial_id, split=split)
    return node(_registered("arena.voice.session"), parent=trial.remote_context(), binding=binding)


def voice_utterance() -> AbstractContextManager[Span]:
    return node(_registered("arena.voice.utterance"), binding=SpanBinding(data_class=SUBJECT_PRIVATE))


def agent_subject(
    parent: otel_context.Context, *, trial_id: str | None = None, split: str | None = None
) -> AbstractContextManager[Span]:
    """``arena.agent.subject``: parented on a REMOTE context extracted from the internal call's W3C
    ``traceparent`` (``extract_context``), never on the current process's own span stack."""
    binding = SpanBinding(data_class=SUBJECT_PRIVATE, trial_id=trial_id, split=split)
    return node(_registered("arena.agent.subject"), Kind.AGENT, binding=binding, parent=parent)


def guard() -> AbstractContextManager[Span]:
    """``arena.guard``: nested under the current ``agent_subject`` span (same process; ordinary nesting)."""
    return node(_registered("arena.guard"), Kind.GUARDRAIL, binding=SpanBinding(data_class=SUBJECT_PRIVATE))


_PROPAGATOR = TraceContextTextMapPropagator()


def inject_traceparent(carrier: MutableMapping[str, str] | None = None) -> dict[str, str]:
    """W3C ``traceparent`` for the current span, to send on an internal call (S5 8.1: ``arena.agent.subject``
    is "parented via W3C traceparent on the internal call")."""
    out: dict[str, str] = {} if carrier is None else dict(carrier)
    _PROPAGATOR.inject(out)
    return out


def extract_context(carrier: Mapping[str, str]) -> otel_context.Context:
    """The remote parent context carried by an internal call's headers."""
    return _PROPAGATOR.extract(carrier)
