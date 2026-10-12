"""Gemini TTS through the Vertex adapter (stage 5): the request carries audio out in one prebuilt voice, the billing
label, one SDK attempt and a bounded output; the reply's audio and usage are read, and failures are typed like text
calls (a non-200 is not billed, a timeout or a malformed reply may have been)."""

from __future__ import annotations

import asyncio
import io
import json
import wave
from collections.abc import Coroutine
from typing import Any, Protocol, cast

import pytest
from google.oauth2.credentials import Credentials as GoogleTokenCredentials

from arena_core.providers import vertex
from arena_core.providers.errors import ErrorKind, ProviderCallError
from arena_core.providers.types import Usage
from arena_core.spend.limits import LIMITS, CallType
from arena_core.voice.catalogue import MAX_DESCRIPTION_CHARS, MAX_STYLE_CHARS
from arena_core.voice.prebuilt import PREBUILT_VOICES
from arena_core.voice.tts import MAX_LINE_CHARS

gtypes: Any = vertex.SDK_TYPES
httpx: Any = vertex.TRANSPORT
PROMPT_TOKENS = 9
AUDIO_TOKENS = 75
PCM = b"\x01\x00" * 1200
# google-auth ships no annotations for this constructor; a typed alias keeps the test strictly checked.
TokenCredentials: Any = GoogleTokenCredentials


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


def speak(outcome: object, style: str | None = None) -> tuple[tuple[bytes, int, Any], Client]:
    client = Client(outcome)
    speech = vertex.VertexSpeech(cast("vertex.VertexClient", client), "gemini-3.8-flash-tts")
    return run(speech.synthesize("Hello there.", "Kore", style)), client


def test_the_request_asks_for_audio_in_one_voice_labelled_with_one_attempt_and_a_bounded_output() -> None:
    config = vertex.build_speech_config("Kore", 30.0)
    assert config.response_modalities == ["AUDIO"]
    speech_config = config.speech_config
    assert isinstance(speech_config, gtypes.SpeechConfig)
    voice = speech_config.voice_config
    assert voice is not None
    assert voice.voice == "Kore"  # the 3.8 TTS field, which also takes a designed voice id
    assert voice.prebuilt_voice_config is None
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
    assert call["model"] == "gemini-3.8-flash-tts"
    part = call["contents"][0].parts[0]
    assert part.text == "Hello there."
    assert part.speech_metadata is None


def test_a_style_travels_as_speech_metadata_never_in_the_spoken_text() -> None:
    _, client = speak(reply(), style="calm and brief")
    part = client.aio.models.calls[0]["contents"][0].parts[0]
    assert part.text == "Hello there."
    assert part.speech_metadata.style == "calm and brief"


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
    speech = vertex.vertex_speech({"ARENA_GCP_PROJECT": "cna-guardian"}, "gemini-3.8-flash-tts")
    assert (built["project"], built["location"], built["credentials"]) == ("cna-guardian", "global", creds)
    assert speech.model == "gemini-3.8-flash-tts"


class SentRequest(Protocol):
    content: bytes


def wire_body(text: str, voice: str, style: str | None = None) -> bytes:
    """Drive the pinned SDK through the speech client with an in-memory transport and return the raw body it sent."""
    bodies: list[bytes] = []

    def handler(sent: SentRequest) -> object:
        bodies.append(sent.content)
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {
                            "role": "model",
                            "parts": [{"inlineData": {"mimeType": "audio/L16", "data": "AAAA"}}],
                        },
                        "finishReason": "STOP",
                    }
                ],
                "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 1, "totalTokenCount": 4},
            },
        )

    transport = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = vertex.build_vertex_client("cna-guardian", "global", TokenCredentials("t"), http_client=transport)
    run(vertex.VertexSpeech(client, "gemini-3.8-flash-tts").synthesize(text, voice, style))
    [body] = bodies
    return body


@pytest.mark.parametrize(
    "text",
    ["Hello.", "\u20ac" * 900, "\U0001f600" * 300, "\\" * 100 + '"' * 100 + "\x01" * 20, "line\nbreak\ttab"],
    ids=["ascii", "three-byte", "four-byte", "escapes", "whitespace"],
)
@pytest.mark.parametrize("voice", ["Kore", "voice_0a1b2c3d4e5f"], ids=["prebuilt", "designed"])
@pytest.mark.parametrize(
    "style", [None, "plainspoken and casual, keeps answers short", "\u00e9" * 10], ids=["plain", "styled", "accented"]
)
def test_the_measured_request_is_the_body_the_sdk_transmits(text: str, voice: str, style: str | None) -> None:
    raw = wire_body(text, voice, style)
    # the reservation is the transmitted body, byte for byte
    assert vertex.speech_request_bytes(text, voice, style) == len(raw)
    assert json.loads(raw) == vertex.speech_request_body(text, voice, style)


def wav(pcm: bytes, *, rate: int = 24_000, channels: int = 1, width: int = 2) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def test_a_wav_reply_gives_its_samples_and_its_own_rate() -> None:
    # Gemini 3.8 TTS answers a unary request with a complete WAV file; the samples are read out of it, so the room's
    # cache never holds a WAV wrapped inside another WAV.
    (pcm, rate, usage), _ = speak(reply(audio=wav(PCM)))
    assert (pcm, rate) == (PCM, 24_000)
    assert usage is not None
    (pcm16, rate16, _usage), _ = speak(reply(audio=wav(PCM, rate=16_000)))
    assert (pcm16, rate16) == (PCM, 16_000)


def test_a_wav_in_another_format_or_damaged_is_a_malformed_reply_with_its_usage() -> None:
    for bad in (wav(PCM, channels=2), wav(b"\x01" * 1200, width=1), b"RIFF\x00\x00\x00\x00WAVEjunk"):
        with pytest.raises(ProviderCallError) as err:
            speak(reply(audio=bad))
        assert err.value.kind == ErrorKind.TRANSIENT
        assert err.value.maybe_billed
        assert err.value.usage is not None


def test_the_longest_line_fits_the_tts_call_limit_and_the_output_bound_is_the_limit() -> None:
    longest_voice = max([*PREBUILT_VOICES, "voice_" + "x" * 40], key=len)
    worst = vertex.speech_request_bytes("\U0001f600" * MAX_LINE_CHARS, longest_voice, "\U0001f600" * MAX_STYLE_CHARS)
    assert worst <= LIMITS[CallType.TTS].input_bytes
    assert LIMITS[CallType.TTS].output_tokens == vertex.SPEECH_MAX_OUTPUT_TOKENS


class FakeVoices:
    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.calls: list[dict[str, object]] = []

    async def create(self, *, voice: object, store: bool | None = None) -> object:
        self.calls.append({"voice": voice, "store": store})
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class Obj:
    def __init__(self, **kw: object) -> None:
        self.__dict__.update(kw)


def design(outcome: object) -> tuple[vertex.DesignedVoice, FakeVoices]:
    voices = FakeVoices(outcome)
    out = run(
        vertex.VertexVoiceDesigner(voices).design("A clerk in her forties.", "arena subject:A", "female", "en-US")
    )
    return out, voices


def test_a_designed_voice_is_stored_prompted_and_read_with_its_sample_and_usage() -> None:
    reply_ = Obj(
        id="voice_abc", sample_audio=Obj(data="UklGRg=="), usage=Obj(total_input_tokens=220, total_output_tokens=1100)
    )
    out, voices = design(reply_)
    assert (out.voice_id, out.sample, out.usage) == (
        "voice_abc",
        b"RIFF",
        Usage(input_tokens=220, output_tokens=1100),
    )
    assert voices.calls == [
        {
            "voice": {
                "type": "prompted",
                "display_name": "arena subject:A",
                "gender": "female",
                "language_code": "en-US",
                "prompted": {"input": "A clerk in her forties."},
            },
            "store": True,
        }
    ]
    bare, _ = design(Obj(id="voice_x", sample_audio=None, usage=None))
    assert (bare.sample, bare.usage) == (b"", None)


def test_a_design_failure_is_typed_and_a_reply_without_a_stored_id_is_empty() -> None:
    errors: Any = vertex.VOICES_ERRORS
    refused = errors.GenAiError("quota", httpx.Response(429, request=httpx.Request("POST", "https://x/voices")))
    with pytest.raises(ProviderCallError) as rate:
        design(refused)
    assert rate.value.kind == ErrorKind.TRANSIENT
    assert not rate.value.maybe_billed
    with pytest.raises(ProviderCallError) as slow:
        design(httpx.ReadTimeout("slow"))
    assert slow.value.maybe_billed
    with pytest.raises(ProviderCallError) as broken:
        design(ValueError("bad json"))
    assert broken.value.maybe_billed
    with pytest.raises(ProviderCallError) as empty:
        design(Obj(id=None, usage=Obj(total_input_tokens=1, total_output_tokens=2)))
    assert empty.value.kind == ErrorKind.EMPTY
    assert empty.value.usage is not None


def test_the_longest_description_fits_the_voice_design_call_limit() -> None:
    worst = vertex.voice_design_bytes("\U0001f600" * MAX_DESCRIPTION_CHARS, "arena " + "x" * 58, "female", "en-US")
    assert worst <= LIMITS[CallType.VOICE_DESIGN].input_bytes


def test_the_runtime_designer_uses_the_arena_project_in_the_global_location(monkeypatch: pytest.MonkeyPatch) -> None:
    built: dict[str, object] = {}

    class Built:
        def __init__(self) -> None:
            self.aio = Obj(voices=FakeVoices(Obj(id="voice_q")))

    def fake_build(project: str, location: str, credentials: object) -> object:
        built.update(project=project, location=location)
        del credentials
        return Built()

    monkeypatch.setattr(vertex, "build_vertex_client", fake_build)

    def no_credentials(env: dict[str, str]) -> object:
        del env
        return object()

    monkeypatch.setattr(vertex, "vertex_credentials", no_credentials)
    designer = vertex.vertex_voice_designer({"ARENA_GCP_PROJECT": "cna-guardian"})
    assert built == {"project": "cna-guardian", "location": "global"}
    assert run(designer.design("d", "n", "male", "en-US")).voice_id == "voice_q"
