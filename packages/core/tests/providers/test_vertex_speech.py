"""Gemini TTS through the Vertex adapter (stages 5 and 8): the request carries audio out in one voice, the billing
label and one SDK attempt (no output cap: the 3.8 TTS models refuse one); the reply's audio and usage are read, and
failures are typed like text calls (a non-200 is not billed, a timeout or a malformed reply may have been)."""

from __future__ import annotations

import asyncio
import io
import json
import wave
from collections.abc import Callable, Coroutine
from typing import Any, Protocol, cast
from uuid import uuid4

import pytest
from google.oauth2.credentials import Credentials as GoogleTokenCredentials

from arena_core.providers import vertex
from arena_core.providers.errors import ConfigError, ErrorKind, ProviderCallError
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


def test_the_request_asks_for_audio_in_one_voice_labelled_with_one_attempt_and_no_output_cap() -> None:
    config = vertex.build_speech_config("Kore", 30.0)
    assert config.response_modalities == ["AUDIO"]
    speech_config = config.speech_config
    assert isinstance(speech_config, gtypes.SpeechConfig)
    voice = speech_config.voice_config
    assert voice is not None
    assert voice.voice == "Kore"  # the 3.8 TTS field, which also takes a designed voice id
    assert voice.prebuilt_voice_config is None
    assert config.labels == {"app": "unissant-arena"}
    assert config.max_output_tokens is None  # the 3.8 TTS models refuse it (400 on the first real call)
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
                            "parts": [{"inlineData": {"mimeType": "audio/L16", "data": "AAAAAA=="}}],
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


class Creds:
    """A credential that is already valid (no refresh), with a random bearer token."""

    def __init__(self) -> None:
        self.valid = True
        self.token = uuid4().hex


Handler = Callable[[object], object]


def designer_with(handler: Handler) -> tuple[vertex.VertexVoiceDesigner, list[Any]]:
    sent: list[Any] = []

    def record(request: object) -> object:
        sent.append(request)
        return handler(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(record))
    return vertex.VertexVoiceDesigner("cna-guardian", cast("Any", CREDS), http), sent


CREDS = Creds()
# The CreateVoice reply as Google's REST reference prints it (snake_case).
REPLY = {
    "id": "voice_abc",
    "sample_audio": {"mime_type": "audio/l16; rate=24000", "data": "UklGRg=="},
    "usage": {"total_input_tokens": 220, "total_output_tokens": 1100},
}
CAMEL_REPLY = {
    "id": "voice_abc",
    "sampleAudio": {"mimeType": "audio/wav", "data": "UklGRg=="},
    "usage": {"totalInputTokens": 3, "totalOutputTokens": 4},
}


def design(designer: vertex.VertexVoiceDesigner, description: str = "A clerk in her forties.") -> vertex.DesignedVoice:
    return run(designer.design(description, "arena subject:A", "female", "en-US"))


def test_a_designed_voice_is_one_post_of_the_measured_bytes_and_reads_its_id_sample_and_usage() -> None:
    designer, sent = designer_with(lambda _request: httpx.Response(200, json=REPLY))
    out = design(designer)
    assert (out.voice_id, out.sample, out.sample_mime) == ("voice_abc", b"RIFF", "audio/l16; rate=24000")
    assert out.usage == Usage(input_tokens=220, output_tokens=1100)
    [request] = sent
    assert str(request.url) == "https://aiplatform.googleapis.com/v1beta1/projects/cna-guardian/locations/global/voices"
    assert request.headers["authorization"] == f"Bearer {CREDS.token}"
    assert request.headers["x-goog-user-project"] == "cna-guardian"  # the quota project local ADC lacks
    # The reservation is the body on the wire, byte for byte, with every character escaped as sent.
    assert len(request.content) == vertex.voice_design_bytes(
        "A clerk in her forties.", "arena subject:A", "female", "en-US"
    )
    assert json.loads(request.content) == {
        "store": True,
        "voice": {
            "type": "VOICE_TYPE_PROMPTED",
            "displayName": "arena subject:A",
            "gender": "female",
            "languageCode": "en-US",
            "prompted": {"input": "A clerk in her forties."},
        },
    }
    camel = design(designer_with(lambda _request: httpx.Response(200, json=CAMEL_REPLY))[0])
    assert (camel.sample, camel.sample_mime, camel.usage) == (
        b"RIFF",
        "audio/wav",
        Usage(input_tokens=3, output_tokens=4),
    )
    accented, sent2 = designer_with(lambda _request: httpx.Response(200, json=REPLY))
    design(accented, 'Une voix \u00e9l\u00e9gante \U0001f600 \\ "q"')
    assert len(sent2[0].content) == vertex.voice_design_bytes(
        'Une voix \u00e9l\u00e9gante \U0001f600 \\ "q"', "arena subject:A", "female", "en-US"
    )


@pytest.mark.parametrize("status", [400, 429, 503])
def test_a_refused_design_is_sent_once_typed_and_not_billed(status: int) -> None:
    designer, sent = designer_with(lambda _request: httpx.Response(status, json={"error": {"code": status}}))
    with pytest.raises(ProviderCallError) as err:
        design(designer)
    assert len(sent) == 1  # no retry layer: one send is one attempt
    assert err.value.status == status
    assert not err.value.maybe_billed


def test_a_timeout_or_broken_reply_may_have_been_billed_and_a_reply_without_an_id_is_empty() -> None:
    def slow(request: object) -> object:
        msg = "slow"
        raise httpx.ReadTimeout(msg, request=request)

    with pytest.raises(ProviderCallError) as timeout:
        design(designer_with(slow)[0])
    assert timeout.value.maybe_billed

    def refused(request: object) -> object:
        msg = "no route"
        raise httpx.ConnectError(msg, request=request)

    with pytest.raises(ProviderCallError) as never:
        design(designer_with(refused)[0])
    assert not never.value.maybe_billed
    with pytest.raises(ProviderCallError) as broken:
        design(designer_with(lambda _request: httpx.Response(200, content=b"not json"))[0])
    assert broken.value.maybe_billed
    with pytest.raises(ProviderCallError) as empty:
        design(designer_with(lambda _request: httpx.Response(200, json={"usage": REPLY["usage"]}))[0])
    assert empty.value.kind == ErrorKind.EMPTY
    assert empty.value.usage is not None
    garbled = {"id": "voice_g", "sample_audio": {"mime_type": "audio/wav", "data": "not base64!"}}
    assert design(designer_with(lambda _request: httpx.Response(200, json=garbled))[0]).sample == b""
    bare = design(designer_with(lambda _request: httpx.Response(200, json={"id": "voice_x"}))[0])
    assert (bare.sample, bare.usage) == (b"", None)


def test_the_designer_refuses_another_project_and_a_credential_without_a_token() -> None:
    other = vertex.VertexVoiceDesigner("other", cast("Any", Creds()))
    with pytest.raises(ConfigError):
        design(other)

    class NoToken:
        valid = True
        token = None

    with pytest.raises(ProviderCallError) as err:
        design(vertex.VertexVoiceDesigner("cna-guardian", cast("Any", NoToken())))
    assert err.value.kind == ErrorKind.BAD_REQUEST


def test_the_longest_description_fits_the_voice_design_call_limit() -> None:
    worst = vertex.voice_design_bytes("\U0001f600" * MAX_DESCRIPTION_CHARS, "arena " + "x" * 58, "female", "en-US")
    assert worst <= LIMITS[CallType.VOICE_DESIGN].input_bytes


def test_the_runtime_designer_uses_the_arena_project(monkeypatch: pytest.MonkeyPatch) -> None:
    creds = object()

    def fake_credentials(env: dict[str, str]) -> object:
        del env
        return creds

    monkeypatch.setattr(vertex, "vertex_credentials", fake_credentials)
    designer = vertex.vertex_voice_designer({"ARENA_GCP_PROJECT": "cna-guardian"})
    assert (designer.project, designer.credentials, designer.http) == ("cna-guardian", creds, None)


@pytest.mark.parametrize(
    "audio",
    [b"", b"\x01\x00\x02", "truncated", "empty"],
    ids=["no-pcm", "odd-pcm", "truncated-wav", "empty-wav"],
)
def test_empty_odd_or_truncated_audio_is_a_malformed_reply_never_a_clip(audio: object) -> None:
    if audio == "truncated":
        data = wav(PCM)[: 44 + 100]
    elif audio == "empty":
        data = wav(b"")
    else:
        data = cast("bytes", audio)
    with pytest.raises(ProviderCallError) as err:
        speak(reply(audio=data or None) if data else reply(audio=b"\x00"))
    assert err.value.maybe_billed


def riff(chunks: list[tuple[bytes, bytes]], declared: dict[bytes, int] | None = None) -> bytes:
    body = b"WAVE"
    for name, data in chunks:
        size = (declared or {}).get(name, len(data))
        body += name + size.to_bytes(4, "little") + data + (b"\x00" if len(data) % 2 else b"")
    return b"RIFF" + len(body).to_bytes(4, "little") + body


def fmt(rate: int = 24_000, channels: int = 1, bits: int = 16, kind: int = 1) -> bytes:
    return (
        kind.to_bytes(2, "little")
        + channels.to_bytes(2, "little")
        + rate.to_bytes(4, "little")
        + (rate * channels * bits // 8).to_bytes(4, "little")
        + (channels * bits // 8).to_bytes(2, "little")
        + bits.to_bytes(2, "little")
    )


def test_a_well_formed_wav_is_read_by_its_chunks() -> None:
    assert vertex.pcm_from(riff([(b"fmt ", fmt()), (b"LIST", b"xx"), (b"data", PCM)])) == (PCM, 24_000)
    assert vertex.pcm_from(wav(PCM, rate=16_000)) == (PCM, 16_000)


@pytest.mark.parametrize(
    "audio",
    [
        b"RIFF\x00\x00\x00\x00",  # a truncated header is never taken for PCM
        riff([(b"fmt ", fmt()), (b"data", b"\x01\x00\x02")]),  # not whole frames
        riff([(b"fmt ", fmt(rate=0)), (b"data", PCM)]),  # no sample rate
        riff([(b"fmt ", fmt(kind=3)), (b"data", PCM)]),  # float samples
        riff([(b"fmt ", fmt()), (b"data", PCM)], {b"data": len(PCM) + 100}),  # cut short
        riff([(b"data", PCM)]),  # data before fmt
        riff([(b"fmt ", fmt())]),  # no data
        riff([(b"fmt ", fmt()), (b"data", b"")]),  # empty
        riff([(b"fmt ", b"\x01\x00")]),  # short fmt
    ],
    ids=["truncated", "odd", "zero-rate", "float", "cut-short", "data-first", "no-data", "empty", "short-fmt"],
)
def test_a_damaged_wav_is_refused_with_the_reply_s_usage(audio: bytes) -> None:
    with pytest.raises(ProviderCallError) as err:
        speak(reply(audio=audio))
    assert err.value.maybe_billed
    assert err.value.usage is not None
