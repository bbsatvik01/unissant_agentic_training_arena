"""Gemini TTS through the Vertex adapter (stage 5): the request carries audio out in one prebuilt voice, the billing
label, one SDK attempt and a bounded output; the reply's audio and usage are read, and failures are typed like text
calls (a non-200 is not billed, a timeout or a malformed reply may have been)."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any, cast

import pytest

from arena_core.providers import vertex
from arena_core.providers.errors import ErrorKind, ProviderCallError

gtypes: Any = vertex.SDK_TYPES
httpx: Any = vertex.TRANSPORT
PROMPT_TOKENS = 9
AUDIO_TOKENS = 75
PCM = b"\x01\x00" * 1200


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def reply(*, audio: bytes | None = PCM, usage: bool = True, finish: object = "STOP") -> object:
    parts = (
        [] if audio is None else [gtypes.Part(inline_data=gtypes.Blob(data=audio, mime_type="audio/L16;rate=24000"))]
    )
    meta = (
        gtypes.GenerateContentResponseUsageMetadata(
            prompt_token_count=PROMPT_TOKENS, candidates_token_count=AUDIO_TOKENS
        )
        if usage
        else None
    )
    return gtypes.GenerateContentResponse(
        candidates=[gtypes.Candidate(content=gtypes.Content(role="model", parts=parts), finish_reason=finish)],
        usage_metadata=meta,
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


def speak(outcome: object) -> tuple[tuple[bytes, int, Any], Client]:
    client = Client(outcome)
    speech = vertex.VertexSpeech(cast("vertex.VertexClient", client), "gemini-2.5-flash-tts")
    return run(speech.synthesize("Hello there.", "Kore")), client


def test_the_request_asks_for_audio_in_one_voice_labelled_with_one_attempt_and_a_bounded_output() -> None:
    config = vertex.build_speech_config("Kore", 30.0)
    assert config.response_modalities == ["AUDIO"]
    speech_config = config.speech_config
    assert isinstance(speech_config, gtypes.SpeechConfig)
    voice = speech_config.voice_config
    assert voice is not None
    assert voice.prebuilt_voice_config is not None
    assert voice.prebuilt_voice_config.voice_name == "Kore"
    assert config.labels == {"app": "unissant-arena"}
    assert config.max_output_tokens == vertex.SPEECH_MAX_OUTPUT_TOKENS
    assert config.http_options is not None
    assert config.http_options.retry_options is not None
    assert config.http_options.retry_options.attempts == 1
    assert config.system_instruction is None


def test_a_reply_gives_its_pcm_at_24_khz_and_its_usage() -> None:
    (pcm, rate, usage), client = speak(reply())
    assert (pcm, rate) == (PCM, vertex.SPEECH_SAMPLE_RATE)
    assert usage is not None
    assert (usage.input_tokens, usage.output_tokens) == (PROMPT_TOKENS, AUDIO_TOKENS)
    call = client.aio.models.calls[0]
    assert call["model"] == "gemini-2.5-flash-tts"
    assert call["contents"][0].parts[0].text == "Hello there."


def test_a_reply_without_usage_still_gives_its_audio() -> None:
    (pcm, _rate, usage), _ = speak(reply(usage=False))
    assert pcm == PCM
    assert usage is None


def test_no_audio_is_empty_and_a_safety_stop_blocked_both_with_their_usage() -> None:
    with pytest.raises(ProviderCallError) as empty:
        speak(reply(audio=None))
    assert empty.value.kind == ErrorKind.EMPTY
    assert empty.value.usage is not None
    with pytest.raises(ProviderCallError) as blocked:
        speak(reply(finish=gtypes.FinishReason.SAFETY))
    assert blocked.value.kind == ErrorKind.BLOCKED


def test_failures_are_typed_and_say_whether_they_may_have_been_billed() -> None:
    api = vertex.SDK_ERRORS.APIError(429, {"error": {"code": 429, "message": "busy"}})
    with pytest.raises(ProviderCallError) as rate:
        speak(api)
    assert not rate.value.maybe_billed
    with pytest.raises(ProviderCallError) as timeout:
        speak(httpx.ReadTimeout("slow"))
    assert timeout.value.maybe_billed
    with pytest.raises(ProviderCallError) as refused:
        speak(httpx.ConnectError("no route"))
    assert not refused.value.maybe_billed
    with pytest.raises(ProviderCallError) as broken:
        speak(ValueError("bad json"))
    assert broken.value.maybe_billed


def test_the_runtime_client_is_on_the_arena_project_in_the_global_location(monkeypatch: pytest.MonkeyPatch) -> None:
    built: dict[str, object] = {}

    creds = object()

    def fake_build(project: str, location: str, credentials: object) -> object:
        built.update(project=project, location=location, credentials=credentials)
        return Client(reply())

    def fake_credentials(env: dict[str, str]) -> object:
        built["env"] = dict(env)
        return creds

    monkeypatch.setattr(vertex, "build_vertex_client", fake_build)
    monkeypatch.setattr(vertex, "vertex_credentials", fake_credentials)
    speech = vertex.vertex_speech({"ARENA_GCP_PROJECT": "cna-guardian"}, "gemini-2.5-flash-tts")
    assert (built["project"], built["location"], built["credentials"]) == ("cna-guardian", "global", creds)
    assert speech.model == "gemini-2.5-flash-tts"
