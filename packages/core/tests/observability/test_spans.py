"""Span hierarchy helpers (S5 8.1; lift target: TechnoMile T12, adapted)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence

import pytest
from opentelemetry.sdk.trace import ReadableSpan

from arena_core.observability import export_policy as ep
from arena_core.observability import spans
from arena_core.observability import tracing as tracing_module

from .conftest import InstallTracing

TRIAL_ID = "3f2b8c1e-5a4d-4e8f-9b2a-1c0d7e6f5a41"
TOURNAMENT_ID = "9c6a0e3a-5d1a-4a4a-8e7e-7a0d4c6b1a22"
THIRD_TURN = 3


def _by_name(spans_list: Sequence[ReadableSpan], name: str) -> ReadableSpan:
    return next(s for s in spans_list if s.name == name)


def _attrs(span: ReadableSpan) -> Mapping[str, ep.AttributeValue]:
    return span.attributes or {}


def _by_data_class(spans_list: Sequence[ReadableSpan], data_class: str) -> ReadableSpan:
    """Finds a SENSITIVE span by its (METADATA-validated, still visible) ``arena.data_class``: its NAME was
    reduced to a bare operation word by the export boundary (S5 8.3), so looking it up by name would not
    distinguish it from any other sensitive span in the same batch."""
    return next(s for s in spans_list if _attrs(s).get(ep.DATA_CLASS_ATTR) == data_class)


def test_trial_anchor_is_a_public_chain_root_ended_immediately(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    ref = spans.start_trial_anchor(TRIAL_ID, split="dev")
    assert ref.valid
    anchor = _by_name(exporter.get_finished_spans(), "arena.trial")
    assert _attrs(anchor)[ep.TRIAL_ID_ATTR] == TRIAL_ID
    assert _attrs(anchor)[ep.SPLIT_ATTR] == "dev"
    assert _attrs(anchor)[ep.DATA_CLASS_ATTR] == ep.PUBLIC  # a METADATA key: visible even though it is public


def test_request_parents_on_the_trial_anchor_when_bound_to_one(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    ref = spans.start_trial_anchor(TRIAL_ID)
    with spans.request(trial=ref, trial_id=TRIAL_ID, split="dev"):
        pass
    req = _by_name(exporter.get_finished_spans(), "arena.request")
    assert req.parent is not None
    assert f"{req.parent.span_id:016x}" == ref.span_id
    assert f"{req.parent.trace_id:032x}" == ref.trace_id


def test_request_without_a_trial_has_no_parent(install_tracing: InstallTracing) -> None:
    install_tracing()
    with spans.request(tournament_id=TOURNAMENT_ID, split="hidden"):
        pass


def test_turn_parents_on_the_trial_anchor_directly_with_its_number(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    ref = spans.start_trial_anchor(TRIAL_ID)
    with spans.turn(ref, THIRD_TURN, trial_id=TRIAL_ID):
        pass
    turn_span = _by_name(exporter.get_finished_spans(), "arena.turn")
    assert turn_span.parent is not None
    assert f"{turn_span.parent.span_id:016x}" == ref.span_id
    assert _attrs(turn_span)["arena.turn.no"] == THIRD_TURN


def test_agent_coach_and_harness_and_llm_call_nest_under_the_current_turn(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    ref = spans.start_trial_anchor(TRIAL_ID)
    with spans.turn(ref, 1, trial_id=TRIAL_ID) as turn_span:
        with spans.agent_coach():
            pass
        with spans.harness():
            pass
        with spans.llm_call("card", attempt=1, model="gemini-3.5-flash-lite", purpose="coach.card"):
            pass
    finished = exporter.get_finished_spans()
    coach = _by_name(finished, "arena.agent.coach")
    harness_span = _by_name(finished, "arena.harness")
    llm_span = _by_name(finished, "llm.card")
    turn_span_id = f"{turn_span.get_span_context().span_id:016x}"
    for child in (coach, harness_span, llm_span):
        assert child.parent is not None
        assert f"{child.parent.span_id:016x}" == turn_span_id
    assert _attrs(llm_span)[ep.CALL_TYPE_ATTR] == "card"
    assert _attrs(llm_span)["arena.attempt"] == 1
    assert _attrs(llm_span)[ep.MODEL_ATTR] != "gemini-3.5-flash-lite"  # unregistered model id: hashed


def test_finalize_and_voice_session_parent_on_the_trial_anchor(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    ref = spans.start_trial_anchor(TRIAL_ID)
    with spans.finalize(ref, trial_id=TRIAL_ID):
        pass
    with spans.voice_session(ref, trial_id=TRIAL_ID):
        pass
    finished = exporter.get_finished_spans()
    finalize_span = _by_name(finished, "arena.finalize")  # public: keeps its real name
    voice_span = _by_data_class(finished, ep.SUBJECT_PRIVATE)  # sensitive: its name was hashed away
    for span in (finalize_span, voice_span):
        assert span.parent is not None
        assert f"{span.parent.span_id:016x}" == ref.span_id


def test_voice_utterance_is_subject_private(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    with spans.voice_utterance():
        pass
    utterance = _by_data_class(exporter.get_finished_spans(), ep.SUBJECT_PRIVATE)
    assert utterance.name != "arena.voice.utterance"  # the real name is hashed away, not exported


def test_referee_task_is_evaluator_kind_and_data_class(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    with spans.referee_task("subject"):  # split="none" by default: reaches the direct exporter
        pass
    task = _by_data_class(exporter.get_finished_spans(), ep.EVALUATOR)
    assert task.name == "referee"  # sensitive name reduced to its discriminating operation word
    assert _attrs(task)[ep.SPAN_KIND_ATTR] == spans.Kind.EVALUATOR.value


def test_referee_task_hidden_split_never_reaches_the_direct_exporter(install_tracing: InstallTracing) -> None:
    """S5 8.5: a hidden span's sanitized copy still reaches the mirror; it is only withheld from the LIVE
    exporter."""
    installed, exporter, sink = install_tracing()
    with spans.referee_task("subject", split="hidden"):
        pass
    installed.flush()
    assert exporter.get_finished_spans() == ()
    assert len(sink.rows) == 1
    assert sink.rows[0].split == "hidden"


def test_guard_nests_under_the_current_agent_subject_span(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    with spans.agent_subject(spans.extract_context({}), trial_id=TRIAL_ID) as subject_span, spans.guard():
        pass
    finished = exporter.get_finished_spans()
    guard_span = next(s for s in finished if _attrs(s).get(ep.SPAN_KIND_ATTR) == "GUARDRAIL")
    subject_span_id = f"{subject_span.get_span_context().span_id:016x}"
    assert guard_span.parent is not None
    assert f"{guard_span.parent.span_id:016x}" == subject_span_id


def test_cross_service_trace_agent_subject_parents_on_the_injected_turn_span(install_tracing: InstallTracing) -> None:
    """S5 8.9: "a turn's arena.agent.subject span (subject process) has the turn span as parent" --
    two in-process Tracing installs, connected only by a W3C traceparent carrier."""
    api_tracing, api_exporter, _api_sink = install_tracing(mode="api")
    ref = spans.start_trial_anchor(TRIAL_ID)
    carrier: dict[str, str] = {}
    with spans.turn(ref, 1, trial_id=TRIAL_ID) as turn_span:
        carrier = spans.inject_traceparent()
    turn_ctx = turn_span.get_span_context()
    api_tracing.flush()

    # "Subject process": a second, independent Tracing install in the same test process.
    tracing_module.shutdown()
    subject_tracing, subject_exporter, _subject_sink = install_tracing(mode="api")
    remote = spans.extract_context(carrier)
    with spans.agent_subject(remote, trial_id=TRIAL_ID) as subject_span:
        pass
    subject_tracing.flush()

    exported_subject = _by_data_class(subject_exporter.get_finished_spans(), ep.SUBJECT_PRIVATE)
    assert exported_subject.parent is not None
    assert exported_subject.parent.span_id == turn_ctx.span_id
    assert exported_subject.parent.trace_id == turn_ctx.trace_id
    assert subject_span.get_span_context().trace_id == turn_ctx.trace_id
    assert api_exporter.get_finished_spans()  # the api side also exported its own turn span


def test_register_span_names_registers_every_name_given() -> None:
    spans.register_span_names("arena.custom.a", "arena.custom.b")
    assert ep.KNOWN.span_name("arena.custom.a") is True
    assert ep.KNOWN.span_name("arena.custom.b") is True


def test_start_trial_anchor_with_a_tournament_id(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    spans.start_trial_anchor(TRIAL_ID, tournament_id=TOURNAMENT_ID, split="dev")
    anchor = _by_name(exporter.get_finished_spans(), "arena.trial")
    assert _attrs(anchor)[ep.TOURNAMENT_ID_ATTR] == TOURNAMENT_ID


BLOCK_ID = "6e1a5c2d-9f3b-4a7c-8d1e-2f4b6a8c0d1e"


def test_request_carries_a_block_id(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    with spans.request(tournament_id=TOURNAMENT_ID, block_id=BLOCK_ID, split="dev"):
        pass
    req = _by_name(exporter.get_finished_spans(), "arena.request")
    assert _attrs(req)[ep.BLOCK_ID_ATTR] == BLOCK_ID


def test_llm_call_with_only_a_model_or_only_a_purpose(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    with spans.llm_call("card", attempt=1, model="registered-model-id"):
        pass
    with spans.llm_call("card", attempt=2, purpose="coach.card"):
        pass
    finished = [s for s in exporter.get_finished_spans() if s.name == "llm.card"]
    attempt_count = 2
    assert len(finished) == attempt_count
    assert ep.MODEL_ATTR in _attrs(finished[0])
    assert ep.PURPOSE_ATTR in _attrs(finished[1])


def test_node_records_an_exception_and_reraises(install_tracing: InstallTracing) -> None:
    _tracing, exporter, _sink = install_tracing()
    with pytest.raises(ValueError, match="boom"), spans.agent_coach():
        raise ValueError("boom")
    coach = _by_name(exporter.get_finished_spans(), "arena.agent.coach")
    assert coach.status.status_code.name == "ERROR"
    assert coach.events  # the exception event was recorded before re-raising
