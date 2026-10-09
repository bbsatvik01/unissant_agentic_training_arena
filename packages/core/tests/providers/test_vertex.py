"""The Vertex adapter (S5 3.6, T7; S2 AT-PORT-1): the built request for every call type, the client's project and
retry settings, and the parsing of every typed stop. No test reaches the network: the client is a stand-in.

The adapter module stays the only importer of google.genai (S5 1.2 item 2 rule c, tools/check_roles.py) and of a raw
HTTP client (tools/semgrep arena-no-raw-http): the SDK response, error and transport types these tests feed it are
reached through the names the adapter module declares for this purpose (`SDK_TYPES`, `SDK_ERRORS`, `TRANSPORT`)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any, cast

import pytest
from google.auth.credentials import AnonymousCredentials, Credentials
from google.auth.exceptions import DefaultCredentialsError

from arena_core.providers import vertex
from arena_core.providers.errors import ConfigError, ErrorKind, ProviderCallError
from arena_core.providers.types import Message, ModelRequest, Usage
from arena_core.spend.limits import LIMITS, CallType, ThinkingLevel, VertexModel

gtypes: Any = vertex.SDK_TYPES
genai_errors: Any = vertex.SDK_ERRORS
httpx: Any = vertex.TRANSPORT
PROMPT_TOKENS, ANSWER_TOKENS, THOUGHT_TOKENS, CACHED_TOKENS = 900, 120, 30, 50
HTTP_BAD, HTTP_UNAVAILABLE, HTTP_RATE = 400, 503, 429
TIMEOUT_S = 6.0
# google-auth ships no annotations for these constructors; typed aliases keep the tests strictly checked.
anonymous: Callable[[], Credentials] = AnonymousCredentials
no_adc: Callable[[str], Exception] = DefaultCredentialsError


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def request(call_type: CallType = CallType.CARD, thinking: ThinkingLevel = ThinkingLevel.MINIMAL) -> ModelRequest:
    return ModelRequest(
        model=VertexModel.FLASH_LITE_35,
        system="You are a coach.",
        messages=(Message("user", "Q"), Message("model", "A"), Message("user", "fix it")),
        json_schema={"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]},
        max_output_tokens=LIMITS[call_type].output_tokens,
        thinking=thinking,
        seed=1234,
    )


@pytest.mark.parametrize("call_type", [t for t in CallType if t is not CallType.PORTRAIT])
def test_the_built_config_carries_the_output_limit_one_sdk_attempt_and_the_app_label(call_type: CallType) -> None:
    config = vertex.build_config(request(call_type), TIMEOUT_S)
    assert config.max_output_tokens == LIMITS[call_type].output_tokens
    assert config.http_options is not None
    assert config.http_options.retry_options is not None
    assert config.http_options.retry_options.attempts == 1
    assert config.labels == {"app": "unissant-arena"}


def test_thinking_is_sent_as_thinking_level_never_thinking_budget_and_no_sampling_knobs() -> None:
    config = vertex.build_config(request(thinking=ThinkingLevel.LOW), TIMEOUT_S)
    assert config.thinking_config is not None
    assert config.thinking_config.thinking_level == gtypes.ThinkingLevel.LOW
    assert config.thinking_config.thinking_budget is None
    assert (config.temperature, config.top_p, config.top_k) == (None, None, None)
    assert config.response_mime_type == "application/json"
    assert config.response_json_schema == request().json_schema
    assert config.seed == request().seed
    assert config.system_instruction == "You are a coach."


def test_contents_are_text_parts_with_the_model_role_kept() -> None:
    contents = vertex.build_contents(request())
    assert [(c.role, c.parts[0].text) for c in contents if isinstance(c, gtypes.Content) and c.parts] == [
        ("user", "Q"),
        ("model", "A"),
        ("user", "fix it"),
    ]


def test_the_client_is_built_on_cna_guardian_only_with_sdk_retries_off() -> None:
    client = vertex.build_vertex_client("cna-guardian", "global", anonymous())
    options = client._api_client._http_options  # the SDK keeps the effective options here
    assert options.retry_options is not None
    assert options.retry_options.attempts == 1
    assert options.base_url == "https://aiplatform.googleapis.com/"
    assert client._api_client.project == "cna-guardian"
    assert client._api_client.vertexai is True


@pytest.mark.parametrize("project", ["kbg-production", "gen-lang-client-0635695834", ""])
def test_any_other_project_is_refused(project: str) -> None:
    with pytest.raises(ConfigError, match="D-015"):
        vertex.build_vertex_client(project, "global", anonymous())


@pytest.mark.parametrize(
    ("location", "url"),
    [
        ("global", "https://aiplatform.googleapis.com/"),
        ("us", "https://aiplatform.us.rep.googleapis.com/"),
        ("us-central1", "https://us-central1-aiplatform.googleapis.com/"),
    ],
)
def test_the_host_is_pinned_per_location(location: str, url: str) -> None:
    assert vertex.vertex_base_url(location) == url


def test_credentials_are_adc_unless_impersonation_is_named() -> None:
    source = anonymous()
    seen: dict[str, Any] = {}

    def default_fn(**_kw: object) -> tuple[Credentials, str | None]:
        return source, None

    def impersonate_fn(**kw: object) -> Credentials:
        seen.update(kw)
        return anonymous()

    assert vertex.vertex_credentials({}, default_fn=default_fn, impersonate_fn=impersonate_fn) is source
    target = "arena@cna-guardian.iam.gserviceaccount.com"
    vertex.vertex_credentials({vertex.IMPERSONATE_VAR: target}, default_fn=default_fn, impersonate_fn=impersonate_fn)
    assert seen["target_principal"] == target
    assert seen["source_credentials"] is source


def test_vertex_adapter_reads_the_project_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vertex, "vertex_credentials", lambda _env: anonymous())
    adapter = vertex.vertex_adapter({"ARENA_GCP_PROJECT": "cna-guardian"})
    assert isinstance(adapter, vertex.VertexAdapter)
    with pytest.raises(ConfigError):
        vertex.vertex_adapter({"ARENA_GCP_PROJECT": "kbg-production"})


# ---------------------------------------------------------------- the adapter against a stand-in client


def response(
    *,
    text: str | None = '{"a": "x"}',
    finish: object = "STOP",
    usage: bool = True,
    candidates: bool = True,
    block: object = None,
) -> object:
    parts = [gtypes.Part(text="thinking...", thought=True)]  # a thought part is never part of the answer
    if text is not None:
        parts.append(gtypes.Part(text=text))
    meta = (
        gtypes.GenerateContentResponseUsageMetadata(
            prompt_token_count=PROMPT_TOKENS,
            candidates_token_count=ANSWER_TOKENS,
            thoughts_token_count=THOUGHT_TOKENS,
            cached_content_token_count=CACHED_TOKENS,
        )
        if usage
        else None
    )
    return gtypes.GenerateContentResponse(
        candidates=[gtypes.Candidate(content=gtypes.Content(role="model", parts=parts), finish_reason=finish)]
        if candidates
        else [],
        usage_metadata=meta,
        prompt_feedback=gtypes.GenerateContentResponsePromptFeedback(block_reason=block) if block else None,
    )


class Models:
    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, Any]] = []

    async def generate_content(self, *, model: str, contents: list[object], config: object) -> object:
        self.calls.append({"model": model, "contents": contents, "config": config})
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class Aio:
    def __init__(self, models: Models) -> None:
        self.models = models


class Client:
    def __init__(self, outcome: object) -> None:
        self.aio = Aio(Models(outcome))


def generate(outcome: object) -> tuple[Any, Client]:
    client = Client(outcome)
    adapter = vertex.VertexAdapter(cast("vertex.VertexClient", client))
    return run(adapter.generate(request(), timeout_s=TIMEOUT_S)), client


def test_a_reply_is_parsed_with_thinking_billed_as_output() -> None:
    raw, client = generate(response())
    assert raw.text == '{"a": "x"}'  # thought parts are never part of the answer
    assert raw.usage == Usage(PROMPT_TOKENS, ANSWER_TOKENS + THOUGHT_TOKENS, THOUGHT_TOKENS, CACHED_TOKENS)
    sent = client.aio.models.calls[0]
    assert sent["model"] == "gemini-3.5-flash-lite"
    assert sent["config"].labels == {"app": "unissant-arena"}


def call_error(outcome: object) -> ProviderCallError:
    with pytest.raises(ProviderCallError) as failed:
        generate(outcome)
    return failed.value


def test_max_tokens_is_truncated_and_carries_its_usage() -> None:
    err = call_error(response(finish=gtypes.FinishReason.MAX_TOKENS))
    assert (err.kind, err.maybe_billed, err.usage is not None) == (ErrorKind.TRUNCATED, True, True)


def test_a_safety_stop_is_blocked() -> None:
    assert call_error(response(finish=gtypes.FinishReason.SAFETY)).kind == ErrorKind.BLOCKED


def test_no_candidates_with_a_block_reason_is_blocked_and_without_one_empty() -> None:
    assert call_error(response(candidates=False, block=gtypes.BlockedReason.SAFETY)).kind == ErrorKind.BLOCKED
    assert call_error(response(candidates=False)).kind == ErrorKind.EMPTY


def test_an_empty_text_is_empty_and_missing_usage_stays_unknown() -> None:
    err = call_error(response(text="  ", usage=False))
    assert (err.kind, err.usage) == (ErrorKind.EMPTY, None)


@pytest.mark.parametrize(
    ("status", "kind"),
    [(HTTP_UNAVAILABLE, ErrorKind.TRANSIENT), (HTTP_RATE, ErrorKind.TRANSIENT), (HTTP_BAD, ErrorKind.BAD_REQUEST)],
)
def test_an_api_error_is_typed_by_status_and_never_billed(status: int, kind: ErrorKind) -> None:
    err = call_error(genai_errors.APIError(status, {"error": {"message": "echoed prompt text", "status": "X"}}))
    assert (err.kind, err.status, err.maybe_billed) == (kind, status, False)
    assert "echoed" not in err.message


def test_a_timeout_may_have_been_billed_and_a_refused_connection_was_not() -> None:
    assert call_error(httpx.ReadTimeout("slow")).maybe_billed is True
    assert call_error(httpx.ReadError("dropped")).maybe_billed is True
    refused = call_error(httpx.ConnectError("refused"))
    assert (refused.kind, refused.maybe_billed) == (ErrorKind.TRANSIENT, False)


def test_a_credentials_failure_is_a_bad_request() -> None:
    assert call_error(no_adc("no adc")).kind == ErrorKind.BAD_REQUEST
