"""The export boundary (lift target: TechnoMile T11; S5 8.2, 8.3)."""

from __future__ import annotations

from collections.abc import Mapping

from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.util.instrumentation import InstrumentationScope
from opentelemetry.trace import Link, SpanContext, Status, StatusCode, TraceFlags, TraceState

from arena_core.observability import export_policy as ep
from arena_core.observability.redaction import Redaction

RESOURCE = Resource({"service.name": "arena-api"})


def _ctx(trace_id: int = 1, span_id: int = 1) -> SpanContext:
    return SpanContext(
        trace_id,
        span_id,
        is_remote=False,
        trace_flags=TraceFlags(TraceFlags.SAMPLED),
        trace_state=TraceState([("vendor", "secret-looking-state")]),
    )


def _span(
    *,
    name: str = "arena.turn",
    attributes: dict[str, object] | None = None,
    status: Status | None = None,
    events: tuple[Event, ...] = (),
) -> ReadableSpan:
    return ReadableSpan(
        name=name,
        context=_ctx(),
        parent=_ctx(span_id=2),
        resource=RESOURCE,
        attributes=attributes or {},
        status=status or Status(StatusCode.OK),
        start_time=1_000_000_000,
        end_time=2_000_000_000,
        events=events,
    )


def _sanitizer(*, secrets: tuple[str, ...] = ()) -> ep.Sanitizer:
    return ep.Sanitizer(Redaction(secrets), 32_768, RESOURCE)


def test_envelope_strips_trace_state_and_cleans_scope() -> None:
    span = _span()
    span._instrumentation_scope = InstrumentationScope("some.untrusted.scope.name")
    _sanitizer().envelope(span)
    assert span.context is not None
    assert span.context.trace_state == TraceState()
    assert span.parent is not None
    assert span.parent.trace_state == TraceState()
    assert span.instrumentation_scope is not None
    assert span.instrumentation_scope.name.startswith("scope.")  # not an EXACT_SCOPES name: hashed


def test_envelope_keeps_an_exact_scope_name_in_clear() -> None:
    span = _span()
    span._instrumentation_scope = InstrumentationScope("arena")
    _sanitizer().envelope(span)
    assert span.instrumentation_scope is not None
    assert span.instrumentation_scope.name == "arena"


def test_known_metadata_value_passes_through_in_clear() -> None:
    trial = "3f2b8c1e-5a4d-4e8f-9b2a-1c0d7e6f5a41"
    span = _span(attributes={ep.TRIAL_ID_ATTR: trial, ep.SPLIT_ATTR: "dev"})
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.attributes is not None
    assert span.attributes[ep.TRIAL_ID_ATTR] == trial
    assert span.attributes[ep.SPLIT_ATTR] == "dev"


def test_metadata_value_failing_its_validator_is_hashed() -> None:
    span = _span(attributes={ep.SPLIT_ATTR: "not-a-real-split"})
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.attributes is not None
    assert span.attributes[ep.SPLIT_ATTR] != "not-a-real-split"
    assert str(span.attributes[ep.SPLIT_ATTR]).startswith("sha256:")


def test_structural_key_free_text_is_pii_and_credential_redacted_in_clear() -> None:
    span = _span(attributes={"output": "call me at 415-555-0199, Bearer sk-ant-" + "z" * 24})
    _sanitizer().span(span, sensitive=False, tainted=False)
    attrs: Mapping[str, ep.AttributeValue] = span.attributes or {}
    out = attrs["output"]
    assert isinstance(out, str)
    assert "415-555-0199" not in out
    assert "sk-ant-" not in out


def test_unknown_key_is_hashed_not_shown() -> None:
    span = _span(attributes={"totally.unknown.key": "some value"})
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.attributes is not None
    keys = list(span.attributes)
    assert "totally.unknown.key" not in keys
    assert any(k.startswith("arena.hashed_key.") for k in keys)


def test_sensitive_span_hashes_free_text_even_on_structural_keys() -> None:
    span = _span(attributes={"output": "the investigator's real name is Jordan"})
    _sanitizer().span(span, sensitive=True, tainted=True)
    assert span.attributes is not None
    out = span.attributes["output"]
    assert "Jordan" not in str(out)
    assert str(out).startswith("sha256:")


def test_credential_named_field_is_masked_regardless_of_shape() -> None:
    """A credential-named field's value is masked whatever its key becomes (an unstructured key like
    "api_key" is hashed too, which is more conservative, never less)."""
    span = _span(attributes={"api_key": "not-even-secret-shaped-value"})
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.attributes is not None
    assert "not-even-secret-shaped-value" not in span.attributes.values()


PROMPT_TOKENS = 42
INPUT_TOKENS = 7


def test_token_count_prefix_is_renamed_and_kept_numeric() -> None:
    span = _span(attributes={"llm.token_count.prompt": PROMPT_TOKENS, "gen_ai.usage.input_tokens": INPUT_TOKENS})
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.attributes is not None
    assert "llm.token_count.prompt" not in span.attributes
    assert "gen_ai.usage.input_tokens" not in span.attributes
    assert span.attributes[ep.OBSERVED_COUNT_PREFIX + "prompt"] == PROMPT_TOKENS
    assert span.attributes["arena.observed.gen_ai.usage.input_tokens"] == INPUT_TOKENS


def test_renamed_count_key_with_a_non_numeric_value_is_hashed() -> None:
    span = _span(attributes={"llm.token_count.prompt": "not-a-number"})
    _sanitizer().span(span, sensitive=False, tainted=False)
    attrs: Mapping[str, ep.AttributeValue] = span.attributes or {}
    value = attrs[ep.OBSERVED_COUNT_PREFIX + "prompt"]
    assert isinstance(value, str)
    assert value.startswith("sha256:")


def test_exception_text_is_hashed_on_a_tainted_span_even_if_structural() -> None:
    span = _span(attributes={"exception.message": "leaked the subject's secret answer"})
    _sanitizer().span(span, sensitive=False, tainted=True)
    assert span.attributes is not None
    assert "leaked the subject's secret answer" not in str(span.attributes["exception.message"])


def test_registered_span_name_kept_in_clear() -> None:
    ep.KNOWN.register_names(["arena.custom.registered"])
    span = _span(name="arena.custom.registered")
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.name == "arena.custom.registered"


def test_unregistered_span_name_is_hashed() -> None:
    span = _span(name="totally-unregistered-name")
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.name != "totally-unregistered-name"
    assert span.name.startswith("sha256:")


def test_sensitive_span_name_keeps_only_the_operation_word() -> None:
    """Regression (Codex self-gate round 2, major): the "arena." namespace prefix is skipped first, so
    different sensitive span kinds stay distinguishable instead of all collapsing to the literal "arena"."""
    span = _span(name="arena.guard")
    _sanitizer().span(span, sensitive=True, tainted=True)
    assert span.name == "guard"


def test_sensitive_span_names_of_different_kinds_stay_distinguishable() -> None:
    for name, expected in (
        ("arena.agent.subject", "agent"),
        ("arena.referee.eval", "referee"),
        ("arena.voice.session", "voice"),
        ("llm.subject", "llm"),
        ("arena.harness", "harness"),
        ("arena.finalize", "finalize"),
    ):
        span = _span(name=name)
        _sanitizer().span(span, sensitive=True, tainted=True)
        assert span.name == expected


def test_sensitive_span_name_not_a_known_operation_is_hashed() -> None:
    span = _span(name="not-an-operation-word")
    _sanitizer().span(span, sensitive=True, tainted=True)
    assert span.name.startswith("sha256:")


def test_status_description_is_credential_redacted_when_public_and_untainted() -> None:
    span = _span(status=Status(StatusCode.ERROR, "token=" + "a" * 20 + " failed"))
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.status.description is not None
    assert "a" * 20 not in span.status.description


def test_status_description_is_hashed_when_tainted() -> None:
    span = _span(status=Status(StatusCode.ERROR, "plain failure text"))
    _sanitizer().span(span, sensitive=False, tainted=True)
    assert span.status.description is not None
    assert span.status.description.startswith("sha256:")


def test_events_and_links_go_through_the_same_attribute_rules() -> None:
    event = Event("exception", attributes={"exception.message": "secret stack trace"}, timestamp=1)
    link = Link(_ctx(span_id=3), attributes={"totally.unknown.key": "x"})
    span = _span(events=(event,))
    span._links = (link,)
    _sanitizer().span(span, sensitive=False, tainted=True)
    assert "secret stack trace" not in str(span.events[0].attributes)
    assert "totally.unknown.key" not in dict(span.links[0].attributes or {})


def test_registered_secret_value_in_a_name_is_hashed_even_if_registered() -> None:
    ep.KNOWN.register_names(["arena.carries.sk-ant-" + "q" * 24])
    name = "arena.carries.sk-ant-" + "q" * 24
    span = _span(name=name)
    sanitizer = ep.Sanitizer(Redaction([]), 32_768, RESOURCE)
    sanitizer.span(span, sensitive=False, tainted=False)
    assert span.name != name  # credential-shaped even though registered: hashed, not shown


def test_is_structural_key_accepts_known_words_and_indices() -> None:
    assert ep.is_structural_key("llm.input_messages.0.message.role") is True
    assert ep.is_structural_key("totally.unknown.path") is False


def test_trusted_exception_type_only_the_fixed_builtin_list() -> None:
    assert ep.trusted_exception_type("ValueError") is True
    assert ep.trusted_exception_type("arena_core.observability.tracing.TracingConfigError") is False


def test_known_values_register_names_evicts_the_oldest_past_the_bound() -> None:
    known = ep.KnownValues(max_names=2)
    known.register_names(["a", "b"])
    known.register_names(["c"])  # evicts "a"
    assert known.span_name("a") is False
    assert known.span_name("b") is True
    assert known.span_name("c") is True


def test_known_values_register_models_and_model() -> None:
    known = ep.KnownValues()
    known.register_models(["gemini-3.5-flash-lite"])
    assert known.model("gemini-3.5-flash-lite") is True
    assert known.model("unregistered-model") is False


def test_candidate_id_pattern() -> None:
    assert ep._candidate_id("A1") is True
    assert ep._candidate_id("S3") is True
    assert ep._candidate_id("Z9") is False


def test_hashed_handles_a_sequence_of_strings_and_a_scalar() -> None:
    out = ep.hashed(["a", "b"])
    assert isinstance(out, list)
    assert all(v.startswith("sha256:") for v in out)
    scalar = ep.hashed(42)
    assert isinstance(scalar, str)
    assert scalar.startswith("sha256:")


def test_payload_hashed_keeps_a_numeric_sequence_but_hashes_a_string_one() -> None:
    assert ep._payload_hashed([1, 2, 3]) == [1, 2, 3]
    assert ep._payload_hashed(["a", "b"]) != ["a", "b"]


def test_sanitizer_text_re_truncates_after_redaction_grows_the_text() -> None:
    # A value right at the length cut gets credential-redacted twice (the tail re-check), which can leave the
    # output longer than one pass expects; `text()` enforces the cap again after redaction.
    sanitizer = _sanitizer()
    value = "x" * (sanitizer._max - 2) + "sk-ant-" + "y" * 10
    out = sanitizer.text(value)
    assert len(out) <= sanitizer._max


def test_sanitizer_name_unregistered_framed_name_keeps_its_head_and_tail() -> None:
    out = _sanitizer().name("llm.unregistered_call_type", sensitive=False)
    assert out.startswith("llm.")
    assert "unregistered_call_type" not in out


def test_sanitizer_name_unregistered_referee_task_name_keeps_its_prefix() -> None:
    out = _sanitizer().name("arena.referee.unregistered_task", sensitive=False)
    assert out.startswith("arena.referee.")
    assert "unregistered_task" not in out


def test_bounded_int_validator() -> None:
    validator = ep._bounded_int(0, 100)
    assert validator(5) is True
    assert validator(101) is False
    assert validator(True) is False  # a bool is not an int for this purpose


def test_number_validator() -> None:
    assert ep._number(1.5) is True
    assert ep._number("1.5") is False


def test_exception_type_validator_rejects_a_non_string() -> None:
    assert ep._exception_type(42) is False


def test_model_validator_rejects_an_unregistered_model() -> None:
    assert ep._model("totally-unregistered-model-id") is False


def test_envelope_with_no_context_or_parent_leaves_them_alone() -> None:
    span = _span()
    span._context = None
    span._parent = None
    _sanitizer().envelope(span)
    assert span.context is None
    assert span.parent is None


def test_public_structural_attribute_with_a_string_list_is_redacted_per_item() -> None:
    span = _span(attributes={"output": ["call 415-555-0199", "plain"]})
    _sanitizer().span(span, sensitive=False, tainted=False)
    attrs: Mapping[str, ep.AttributeValue] = span.attributes or {}
    out = attrs["output"]
    assert isinstance(out, list)
    assert "415-555-0199" not in out[0]
    assert out[1] == "plain"


def test_public_structural_attribute_with_a_numeric_sequence_passes_through() -> None:
    # "input_tokens" is structural (a KEY_WORDS entry) but not a METADATA key and not metric-prefixed, so a
    # homogeneous numeric sequence reaches the final passthrough in `_public`.
    span = _span(attributes={"input_tokens": [1, 2, 3]})
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.attributes is not None
    assert span.attributes["input_tokens"] == [1, 2, 3]


def test_cost_usd_decimal_string_stays_in_clear_as_the_plain_attribute_8_2_requires() -> None:
    """Regression (Codex self-gate round 1): a stray ``**dict.fromkeys(_METRIC_KEYS, _number)`` merge once
    silently overwrote arena.cost_usd's decimal-string validator with the bounds-free numeric one, hashing
    every valid cost value away (S5 8.2: "Phoenix shows arena.cost_usd as a plain attribute")."""
    span = _span(attributes={ep.COST_USD_ATTR: "12.345000"})
    _sanitizer().span(span, sensitive=False, tainted=False)
    assert span.attributes is not None
    assert span.attributes[ep.COST_USD_ATTR] == "12.345000"


def test_arena_attempt_out_of_bounds_is_hashed_not_passed_through() -> None:
    """Regression: arena.attempt must stay bounded to 0-100 (S5 8.2), not accepted as any plain number."""
    out_of_range = 10_000
    span = _span(attributes={"arena.attempt": out_of_range})
    _sanitizer().span(span, sensitive=False, tainted=False)
    attrs: Mapping[str, ep.AttributeValue] = span.attributes or {}
    value = attrs["arena.attempt"]
    assert isinstance(value, str)
    assert value.startswith("sha256:")


def test_coach_free_text_with_an_apostrophe_still_exports_in_clear() -> None:
    """Regression (Codex self-gate round 1, major): ordinary coach text containing an apostrophe or bracket
    must not be blanket-redacted (S5 8.3: "coach payloads ... export in clear for development and revealed
    work")."""
    span = _span(attributes={"output": "Ask about John's timeline, then check the [pending] items."})
    _sanitizer().span(span, sensitive=False, tainted=False)
    attrs: Mapping[str, ep.AttributeValue] = span.attributes or {}
    out = attrs["output"]
    assert out == "Ask about John's timeline, then check the [pending] items."
