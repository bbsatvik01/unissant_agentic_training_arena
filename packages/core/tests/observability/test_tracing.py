"""Tracing install (S5 8.1, 8.3, 8.6; lift target: TechnoMile T13, adapted)."""

from __future__ import annotations

import os
import signal
import time as time_module

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from arena_core.observability import processors as proc
from arena_core.observability import spans, tracing

from .conftest import InstallTracing


def test_install_is_a_noop_with_no_endpoint_and_no_exporter() -> None:
    settings = tracing.TracingSettings(service_name="arena-test", mode="api")
    assert tracing.install(settings, instrument_genai=False) is None
    assert tracing.active() is None


def test_install_with_an_injected_exporter_does_not_need_an_endpoint(install_tracing: InstallTracing) -> None:
    installed, _exporter, _sink = install_tracing()
    assert tracing.active() is installed


def test_install_is_idempotent_within_one_process(install_tracing: InstallTracing) -> None:
    first, _exporter, _sink = install_tracing()
    settings = tracing.TracingSettings(service_name="arena-test-2", mode="api")
    second = tracing.install(settings, exporter=InMemorySpanExporter(), instrument_genai=False)
    assert second is first  # the second call returns the already-installed instance, unchanged


def test_settings_from_env_reads_phoenix_variables() -> None:
    env = {
        "PHOENIX_OTLP_ENDPOINT": "http://127.0.0.1:6006",
        "PHOENIX_API_KEY": "a-key",
        "PHOENIX_PROJECT": "arena-dev",
    }
    settings = tracing.TracingSettings.from_env(env, service_name="arena-api", mode="api")
    assert settings.endpoint == "http://127.0.0.1:6006"
    assert settings.api_key == "a-key"
    assert settings.project == "arena-dev"
    assert settings.mirror_only is False


def test_settings_from_env_reads_mirror_only_mode() -> None:
    env = {"ARENA_TRACE_EXPORT": "mirror_only"}
    settings = tracing.TracingSettings.from_env(env, service_name="arena-tournament", mode="job")
    assert settings.mirror_only is True


def test_identifier_validation_rejects_an_uppercase_service_name() -> None:
    settings = tracing.TracingSettings(service_name="Arena-API", mode="api")
    with pytest.raises(tracing.TracingConfigError):
        tracing.install(settings, exporter=InMemorySpanExporter(), instrument_genai=False)


def test_flush_exports_a_pending_span_in_api_mode(install_tracing: InstallTracing) -> None:
    installed, exporter, _sink = install_tracing(mode="api")
    with spans.referee_task("subject"):
        pass
    assert installed.flush() is True
    assert len(exporter.get_finished_spans()) == 1


def test_flush_exports_a_pending_span_in_job_mode_after_batching(install_tracing: InstallTracing) -> None:
    installed, exporter, _sink = install_tracing(mode="job")
    with spans.referee_task("subject"):
        pass
    assert installed.flush() is True
    assert len(exporter.get_finished_spans()) == 1


def test_mirror_only_mode_withholds_a_non_hidden_span_from_the_exporter(install_tracing: InstallTracing) -> None:
    installed, exporter, sink = install_tracing(mode="job", mirror_only=True)
    with spans.referee_task("subject"):  # split="none": would normally export directly
        pass
    installed.flush()
    assert exporter.get_finished_spans() == ()
    assert len(sink.rows) == 1


def test_shutdown_clears_the_active_registry(install_tracing: InstallTracing) -> None:
    install_tracing()
    assert tracing.active() is not None
    tracing.shutdown()
    assert tracing.active() is None


def test_install_sigterm_flush_runs_a_bounded_flush_on_sigterm(install_tracing: InstallTracing) -> None:
    installed, exporter, _sink = install_tracing(mode="job")
    with spans.referee_task("subject"):
        pass
    previous = signal.getsignal(signal.SIGTERM)
    tracing.install_sigterm_flush(installed, timeout_millis=500)
    try:
        with pytest.raises(SystemExit):
            os.kill(os.getpid(), signal.SIGTERM)
    finally:
        signal.signal(signal.SIGTERM, previous)
    assert len(exporter.get_finished_spans()) == 1


def test_otlp_exporter_appends_the_v1_traces_path() -> None:
    settings = tracing.TracingSettings(service_name="arena-test", mode="api", endpoint="http://127.0.0.1:6006")
    exporter = tracing.otlp_exporter(settings)
    assert exporter._endpoint == "http://127.0.0.1:6006/v1/traces"


def test_get_tracer_falls_back_to_a_noop_tracer_when_not_installed() -> None:
    tracer = tracing.get_tracer()
    with tracer.start_as_current_span("x") as span:
        assert span.get_span_context().trace_id == 0  # the global, never-configured provider's no-op span


def test_killed_exporter_still_leaves_the_span_mirrored() -> None:
    """S5 8.9 durability: killing the exporter mid-request still leaves the span in the mirror."""

    class _Killed(InMemorySpanExporter):
        def export(self, _spans: object) -> SpanExportResult:
            raise RuntimeError(self.__class__.__name__)

    sink = proc.InMemoryMirrorSink()
    settings = tracing.TracingSettings(service_name="arena-test", mode="api")
    installed = tracing.install(settings, exporter=_Killed(), mirror_sink=sink, instrument_genai=False)
    assert installed is not None
    with spans.referee_task("subject"):
        pass
    installed.flush()
    assert len(sink.rows) == 1  # the response can complete even though the direct export failed


def test_at_exit_shuts_down_the_active_registry(install_tracing: InstallTracing) -> None:
    install_tracing()
    tracing._at_exit()
    assert tracing.active() is None


def test_bounded_catches_an_exception_from_the_call() -> None:
    def _raises() -> bool:
        raise RuntimeError("boom")

    assert tracing._bounded(_raises, 1.0, "failure") is False


def test_bounded_returns_false_when_the_call_outlives_the_budget() -> None:
    def _slow() -> bool:
        time_module.sleep(0.3)
        return True

    assert tracing._bounded(_slow, 0.01, "failure") is False


class _FailingInstrumentor:
    is_instrumented_by_opentelemetry = False

    def instrument(self, *, tracer_provider: TracerProvider) -> None:
        raise RuntimeError(tracer_provider.__class__.__name__)


def test_instrument_genai_failure_is_caught_and_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tracing, "GoogleGenAIInstrumentor", _FailingInstrumentor)
    assert tracing._instrument_genai(TracerProvider()) == "google-genai instrumentation failed"


def test_install_with_instrument_genai_true_succeeds_when_the_sdk_is_absent() -> None:
    """``google-genai`` is not a dependency here (D-001: only `providers/vertex.py` may import it); the real
    instrumentor just no-ops when the target SDK is missing, so `install(instrument_genai=True)` (the
    default) still succeeds."""
    sink = proc.InMemoryMirrorSink()
    settings = tracing.TracingSettings(service_name="arena-test", mode="api")
    installed = tracing.install(settings, exporter=InMemorySpanExporter(), mirror_sink=sink)
    assert installed is not None


class _InstalledInstrumentor:
    is_instrumented_by_opentelemetry = True

    def uninstrument(self) -> None:
        raise RuntimeError("boom")


def test_shutdown_uninstruments_genai_and_survives_a_failure(
    install_tracing: InstallTracing, monkeypatch: pytest.MonkeyPatch
) -> None:
    install_tracing()
    monkeypatch.setattr(tracing, "GoogleGenAIInstrumentor", _InstalledInstrumentor)
    tracing.shutdown()  # the uninstrument failure is logged, never raised
    assert tracing.active() is None


def test_install_sigterm_flush_delegates_to_a_callable_previous_handler(install_tracing: InstallTracing) -> None:
    installed, _exporter, _sink = install_tracing(mode="job")
    delegated: list[int] = []

    def _previous(signum: int, _frame: object) -> None:
        delegated.append(signum)

    old = signal.signal(signal.SIGTERM, _previous)
    try:
        tracing.install_sigterm_flush(installed, timeout_millis=500)
        os.kill(os.getpid(), signal.SIGTERM)  # delegates, rather than raising SystemExit
        assert delegated == [signal.SIGTERM]
    finally:
        signal.signal(signal.SIGTERM, old)
