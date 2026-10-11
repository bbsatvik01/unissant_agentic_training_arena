"""Shared fixtures: ``arena_core.observability.tracing`` installs one provider per PROCESS (S5 8.1), so every
test gets a clean, uninstalled singleton before and after it runs, and an ``install_tracing`` fixture that
wires it to in-memory fakes only (no network export in tests)."""

from __future__ import annotations

from collections.abc import Callable, Iterator

import pytest
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from arena_core.observability import processors as proc
from arena_core.observability import tracing

InstallTracing = Callable[..., tuple[tracing.Tracing, InMemorySpanExporter, proc.InMemoryMirrorSink]]


@pytest.fixture(autouse=True)
def _clean_tracing_registry() -> Iterator[None]:
    tracing.shutdown()
    yield
    tracing.shutdown()


def _install(
    *, mode: tracing.Mode = "api", mirror_only: bool = False
) -> tuple[tracing.Tracing, InMemorySpanExporter, proc.InMemoryMirrorSink]:
    exporter = InMemorySpanExporter()
    sink = proc.InMemoryMirrorSink()
    settings = tracing.TracingSettings(service_name="arena-test", mode=mode, mirror_only=mirror_only)
    installed = tracing.install(settings, exporter=exporter, mirror_sink=sink, instrument_genai=False)
    assert installed is not None
    return installed, exporter, sink


@pytest.fixture
def install_tracing() -> InstallTracing:
    """``install_tracing(mode="api", mirror_only=False) -> (Tracing, InMemorySpanExporter, InMemoryMirrorSink)``,
    uninstalled again by ``_clean_tracing_registry`` after the test."""
    return _install
