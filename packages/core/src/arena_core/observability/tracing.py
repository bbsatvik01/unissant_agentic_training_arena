"""Tracing install (S5 8.1, 8.3, 8.6; lift target: TechnoMile T13, `observability/tracing.py:41-211`; adapted:
ADK instrumentation replaced by OpenInference `google_genai` instrumentation, S5 PROBE P7).

One dedicated ``TracerProvider``, never set as the global provider, so any library's own tracers stay on the
no-op global provider and only our spans (and the GenAI instrumentor's) are exported. Install it at boot,
before any ``google.genai`` import. Tracing is off (a no-op tracer) unless ``PHOENIX_OTLP_ENDPOINT`` is set or
an exporter is passed in.

Chain (S5 8.3): ``LineagePropagator`` -> ``Redactor`` -> ``SpanMirror`` -> the exporter, wrapped in
``ExportGate``. The api role exports each span synchronously when it ends (``SimpleSpanProcessor``:
request-billed Cloud Run gives a background exporter no CPU in the hosted variant, and local mode keeps the
same code path); the tournament job batches and flushes at block boundaries and on SIGTERM
(``install_sigterm_flush``), and may run with ``ARENA_TRACE_EXPORT=mirror_only`` (S5 8.5).
"""

import atexit
import logging
import os
import re
import signal
import threading
import time
from collections.abc import Callable, MutableMapping
from dataclasses import dataclass
from types import FrameType
from typing import Literal

from openinference.instrumentation.google_genai import GoogleGenAIInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanLimits, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor, SpanExporter
from opentelemetry.trace import Tracer

from arena_core.observability.export_policy import Sanitizer
from arena_core.observability.processors import (
    ExportGate,
    InMemoryMirrorSink,
    Lineage,
    LineagePropagator,
    MirrorSink,
    Redactor,
    SpanMirror,
)
from arena_core.observability.redaction import Redaction, secret_values_from_env

logger = logging.getLogger(__name__)

TRACER_NAME = "arena"
DEFAULT_MAX_ATTRIBUTE_LENGTH = 32_768
DEFAULT_EXPORT_TIMEOUT_S = 3.0
SIGTERM_FLUSH_MS = 8_000  # inside Cloud Run's 10 s SIGTERM -> SIGKILL window in the hosted variant
SHUTDOWN_MS = 5_000
# S5 8.5: the tournament job's mirror-only mode for a hidden, unrevealed tournament's traces.
MIRROR_ONLY_ENV = "ARENA_TRACE_EXPORT"
MIRROR_ONLY_VALUE = "mirror_only"

Mode = Literal["api", "job"]


class TracingConfigError(ValueError):
    """A tracing setting or boot-order rule was violated."""


@dataclass(frozen=True)
class TracingSettings:
    service_name: str
    mode: Mode
    endpoint: str = ""  # PHOENIX_OTLP_ENDPOINT, e.g. http://127.0.0.1:6006; empty = off
    api_key: str = ""  # PHOENIX_API_KEY (a Phoenix system or user key)
    project: str = "arena"  # PHOENIX_PROJECT
    max_attribute_length: int = DEFAULT_MAX_ATTRIBUTE_LENGTH
    export_timeout_s: float = DEFAULT_EXPORT_TIMEOUT_S
    mirror_only: bool = False  # ARENA_TRACE_EXPORT=mirror_only (S5 8.5)

    @classmethod
    def from_env(cls, env: MutableMapping[str, str], *, service_name: str, mode: Mode) -> "TracingSettings":
        endpoint = env.get("PHOENIX_OTLP_ENDPOINT", "").strip()
        return cls(
            service_name=service_name,
            mode=mode,
            endpoint=endpoint,
            api_key=env.get("PHOENIX_API_KEY", "").strip(),
            project=env.get("PHOENIX_PROJECT", "").strip() or "arena",
            mirror_only=env.get(MIRROR_ONLY_ENV, "").strip() == MIRROR_ONLY_VALUE,
        )


@dataclass(frozen=True)
class Tracing:
    provider: TracerProvider
    tracer: Tracer
    mirror: SpanMirror
    lineage: Lineage
    settings: TracingSettings
    sanitizer: Sanitizer  # the export boundary; also used by a later re-export (``pump.py``)

    def flush(self, timeout_millis: int = SIGTERM_FLUSH_MS) -> bool:
        """Best effort: mirror rows written and pending spans exported, all within ONE deadline. The provider
        flushes its processors in chain order (mirror, then export) and hands each what is left of that
        deadline; the whole flush also runs on a daemon worker the caller waits on for at most the deadline,
        because a processor or exporter may ignore the budget it is given. False when the deadline passed.
        Never proof of delivery."""
        return _bounded(
            lambda: self.provider.force_flush(timeout_millis), timeout_millis / 1000, "tracing flush failed"
        )


def _bounded(call: Callable[[], bool], timeout_s: float, failure: str) -> bool:
    """Run ``call`` on a daemon worker and wait at most ``timeout_s``: False when it failed or is still running
    (a daemon worker never holds up interpreter exit)."""
    result: list[bool] = []

    def run() -> None:
        try:
            result.append(bool(call()))
        except Exception:
            logger.exception(failure)
            result.append(False)

    worker = threading.Thread(target=run, name="arena-tracing-bounded", daemon=True)
    worker.start()
    worker.join(max(timeout_s, 0.0))
    if not result:
        logger.warning("%s: still running after %.3f s", failure, timeout_s)
        return False
    return result[0]


class _Registry:
    """The one installed provider per process, set at boot."""

    lock = threading.Lock()
    active: Tracing | None = None
    at_exit_registered = False
    exit_deadline: float | None = None  # monotonic; set by the SIGTERM flush so exit teardown shares its deadline


def install(
    settings: TracingSettings,
    *,
    env: MutableMapping[str, str] | None = None,
    exporter: SpanExporter | None = None,
    mirror_sink: MirrorSink | None = None,
    instrument_genai: bool = True,
) -> Tracing | None:
    """Install once per process; returns None when tracing is off.

    S5 1.3's fifth boot-check row ("tracing installed before any instrumented import") has no runtime check
    here: this repo's role-boundary gate (S5 1.2 item 2 rule "dyn", `tools/check_roles.py`) forbids product
    code from reaching `sys.modules`, the only way to detect that `google.genai` was already imported (as
    TechnoMile's `_adk_imported()` did). The ordering is structural instead: `providers/vertex.py` is the only
    module allowed to import `google.genai` (S5 1.2 item 2 rule c) and calls `install()` before doing so.
    """
    boot_env = os.environ if env is None else env
    if not settings.endpoint and exporter is None:
        return None
    with _Registry.lock:
        if _Registry.active is not None:
            return _Registry.active
        _Registry.exit_deadline = None
        limit = settings.max_attribute_length
        # Built directly, never Resource.create(): that merges OTEL_RESOURCE_ATTRIBUTES and detectors, which
        # could put arbitrary text (a key) on every exported span.
        resource = Resource(
            {
                "service.name": _identifier(settings.service_name, "service_name"),
                "openinference.project.name": _identifier(settings.project, "project"),
            }
        )
        provider = TracerProvider(
            resource=resource,
            span_limits=SpanLimits(max_attribute_length=limit, max_span_attribute_length=limit),
            shutdown_on_exit=False,  # the SDK's own exit hook is unbounded; ours (``_at_exit``) is bounded
        )
        lineage = Lineage()
        provider.add_span_processor(LineagePropagator(lineage))
        redaction = Redaction(secret_values_from_env(boot_env))
        sanitizer = Sanitizer(redaction, limit, resource)
        provider.add_span_processor(Redactor(sanitizer, lineage))
        mirror = SpanMirror(mirror_sink if mirror_sink is not None else InMemoryMirrorSink(), lineage)
        provider.add_span_processor(mirror)
        gate = ExportGate(
            exporter if exporter is not None else otlp_exporter(settings), lineage, mirror_only=settings.mirror_only
        )
        if settings.mode == "api":
            provider.add_span_processor(SimpleSpanProcessor(gate))
        else:
            provider.add_span_processor(BatchSpanProcessor(gate))
        if not _Registry.at_exit_registered:
            atexit.register(_at_exit)
            _Registry.at_exit_registered = True
        if instrument_genai:
            _instrument_genai(provider)
        tracing = Tracing(provider, provider.get_tracer(TRACER_NAME), mirror, lineage, settings, sanitizer)
        _Registry.active = tracing
        return tracing


_IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9_.\-]{0,62}")


def _identifier(value: str, what: str) -> str:
    if not _IDENTIFIER.fullmatch(value):
        msg = f"tracing {what} must be a lowercase identifier"
        raise TracingConfigError(msg)
    return value


def otlp_exporter(settings: TracingSettings) -> OTLPSpanExporter:
    """The direct OTLP/HTTP exporter to Phoenix (S5 8.6); also used by ``pump.py`` to re-export mirror rows
    through the same endpoint. ``PHOENIX_OTLP_ENDPOINT`` is the Phoenix base URL
    (``.env.local.example``: "http://127.0.0.1:6006"); the raw ``OTLPSpanExporter``, unlike
    ``phoenix.otel.register()``, needs the full "/v1/traces" path itself."""
    endpoint = settings.endpoint.rstrip("/") + "/v1/traces"
    headers = {"authorization": f"Bearer {settings.api_key}"} if settings.api_key else None
    return OTLPSpanExporter(endpoint=endpoint, headers=headers, timeout=settings.export_timeout_s)


def _instrument_genai(provider: TracerProvider) -> str:
    """Observability fails open (a broken instrumentor must not stop a trial), but this process's telemetry is
    then incomplete for any LLM span: returns why, or "" when the GenAI SDK is traced."""
    instrumentor = GoogleGenAIInstrumentor()
    try:
        instrumentor.instrument(tracer_provider=provider)
    except Exception:
        logger.exception("google-genai instrumentation failed; LLM spans will be missing")
        return "google-genai instrumentation failed"
    return ""


def active() -> Tracing | None:
    return _Registry.active


def get_tracer() -> Tracer:
    """The installed tracer, or a no-op tracer from the (never configured) global provider."""
    tracing = _Registry.active
    return tracing.tracer if tracing is not None else trace.get_tracer(TRACER_NAME)


def _at_exit() -> None:
    shutdown()


def shutdown(timeout_millis: int = SHUTDOWN_MS) -> None:
    """Best-effort teardown within ``timeout_millis`` (and within what is left of a SIGTERM flush's deadline):
    uninstrument the GenAI SDK, write mirror rows, flush and stop the provider."""
    with _Registry.lock:
        tracing, _Registry.active = _Registry.active, None
    if tracing is None:
        return
    budget_s = timeout_millis / 1000
    if _Registry.exit_deadline is not None:
        budget_s = min(budget_s, _Registry.exit_deadline - time.monotonic())
        _Registry.exit_deadline = None
    instrumentor = GoogleGenAIInstrumentor()
    if instrumentor.is_instrumented_by_opentelemetry:
        try:
            instrumentor.uninstrument()
        except Exception:
            logger.exception("google-genai uninstrument failed at shutdown")

    def stop() -> bool:
        tracing.provider.shutdown()
        return True

    _bounded(stop, budget_s, "tracer provider shutdown failed")


def install_sigterm_flush(tracing: Tracing, timeout_millis: int = SIGTERM_FLUSH_MS) -> None:
    """Job mode: on SIGTERM, flush spans and mirror rows, then run the previous handler (or exit 143)."""
    previous = signal.getsignal(signal.SIGTERM)

    def _handler(signum: int, frame: FrameType | None) -> None:
        _Registry.exit_deadline = time.monotonic() + timeout_millis / 1000  # exit teardown shares this deadline
        tracing.flush(timeout_millis)
        if callable(previous):
            previous(signum, frame)
            return
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _handler)
