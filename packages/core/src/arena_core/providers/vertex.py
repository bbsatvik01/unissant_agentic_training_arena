"""Vertex AI Gemini through google-genai: the only `google.genai` importer in the repo (S5 1.1, 1.2 item 2 rule c).

Adapted from TechnoMile `bh_core/providers/adapters/vertex.py` lines 1-192 (T7; ATTRIBUTIONS.md):

- `max_output_tokens` is the call type's output limit, never the model's own maximum (TechnoMile sent 65,536, which
  would invalidate every reservation; S2 2 lift fix);
- the SDK never retries on its own: `HttpRetryOptions(attempts=1)` on the client and on every request (google-genai
  retries 5 times when `attempts` is unset or 0); the port owns the attempt count (S5 3.4);
- every request carries `labels={"app": "unissant-arena"}` (D-015, S5 3.2 step 4) and `thinking_level`, never
  `thinking_budget` (S5 3.6); no temperature, top_p or top_k (S2 1); the per-call `seed` of S2 1;
- the client is `genai.Client(vertexai=True, project=..., location=...)` with the project passed explicitly and
  checked against the D-015 allowlist of one (`cna-guardian`); the gcloud default project is never read;
- `_parse` kept: thinking tokens bill as output, MAX_TOKENS and safety stops are typed.

Credentials: an impersonated service account when VERTEX_IMPERSONATE_SERVICE_ACCOUNT is set (local runs, S5 10.2),
else Application Default Credentials. API keys are never used (D-001, boot check).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Any, Protocol

import google.auth
import httpx
from google import genai
from google.auth import exceptions as google_auth_exceptions
from google.auth import impersonated_credentials
from google.auth.credentials import Credentials
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.genai import errors as genai_errors
from google.genai import types as gtypes

from arena_core.config import ALLOWED_GCP_PROJECT
from arena_core.providers.errors import ConfigError, ErrorKind, ProviderCallError, kind_for_status
from arena_core.providers.types import ModelRequest, RawCompletion, Usage
from arena_core.spend.limits import LIMITS, CallType, ThinkingLevel
from arena_core.voice.catalogue import VOICE_ID_PREFIX
from arena_core.voice.live import (
    LIVE_LOCATION,
    LIVE_MODEL,
    LiveAudio,
    LiveClosedError,
    LiveConnection,
    LiveEvent,
    LiveInterrupted,
    LiveTranscript,
    LiveTurnComplete,
    LiveUsage,
)

log = logging.getLogger("arena_core.providers.vertex")

# The SDK and transport modules this adapter consumes, named for the adapter's own tests: no other module imports
# google.genai (S5 1.2 item 2 rule c) or a raw HTTP client (semgrep arena-no-raw-http), so the tests build SDK
# responses and errors through these names. Product code never uses them.
SDK_TYPES = gtypes
SDK_ERRORS = genai_errors
TRANSPORT = httpx

CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
IMPERSONATION_LIFETIME_S = 3600
TEXT_LOCATION = "global"  # S5 T7: `global` for text calls
IMPERSONATE_VAR = "VERTEX_IMPERSONATE_SERVICE_ACCOUNT"

_BLOCKED_REASONS = frozenset(
    {
        gtypes.FinishReason.SAFETY,
        gtypes.FinishReason.RECITATION,
        gtypes.FinishReason.BLOCKLIST,
        gtypes.FinishReason.PROHIBITED_CONTENT,
        gtypes.FinishReason.SPII,
        gtypes.FinishReason.LANGUAGE,
    }
)
_THINKING = {
    ThinkingLevel.MINIMAL: gtypes.ThinkingLevel.MINIMAL,
    ThinkingLevel.LOW: gtypes.ThinkingLevel.LOW,
    ThinkingLevel.MEDIUM: gtypes.ThinkingLevel.MEDIUM,
    ThinkingLevel.HIGH: gtypes.ThinkingLevel.HIGH,
}
_MULTI_REGIONS = frozenset({"us", "eu"})

DefaultCredentialsFn = Callable[..., tuple[Credentials, str | None]]
ImpersonateFn = Callable[..., Credentials]


def no_sdk_retries() -> gtypes.HttpRetryOptions:
    """One attempt per SDK call: the port counts every send (google-genai treats attempts=0 as its default 5)."""
    return gtypes.HttpRetryOptions(attempts=1)


def vertex_credentials(
    env: Mapping[str, str],
    *,
    default_fn: DefaultCredentialsFn = google.auth.default,
    impersonate_fn: ImpersonateFn = impersonated_credentials.Credentials,
) -> Credentials:
    """ADC, or the service account named by VERTEX_IMPERSONATE_SERVICE_ACCOUNT impersonated from it."""
    source, _ = default_fn(scopes=[CLOUD_PLATFORM_SCOPE])
    target = env.get(IMPERSONATE_VAR, "").strip()
    if not target:
        return source
    return impersonate_fn(
        source_credentials=source,
        target_principal=target,
        target_scopes=[CLOUD_PLATFORM_SCOPE],
        lifetime=IMPERSONATION_LIFETIME_S,
    )


def vertex_base_url(location: str) -> str:
    """The Google Vertex host for ``location``, pinned so no SDK env or global override can redirect traffic."""
    if location == "global":
        return "https://aiplatform.googleapis.com/"
    if location in _MULTI_REGIONS:
        return f"https://aiplatform.{location}.rep.googleapis.com/"
    return f"https://{location}-aiplatform.googleapis.com/"


def build_vertex_client(
    project: str, location: str, credentials: Credentials, *, http_client: httpx.AsyncClient | None = None
) -> genai.Client:
    """A Vertex client on the arena project only (D-015), explicit location and host, SDK retries off.
    ``http_client`` replaces the SDK's own async HTTP client (tests capture the wire body with it)."""
    if project != ALLOWED_GCP_PROJECT:
        msg = f"Vertex project {project!r} refused: D-015 allows only {ALLOWED_GCP_PROJECT!r}"
        raise ConfigError(msg)
    return genai.Client(
        vertexai=True,
        project=project,
        location=location,
        credentials=credentials,
        http_options=gtypes.HttpOptions(
            base_url=vertex_base_url(location), retry_options=no_sdk_retries(), httpx_async_client=http_client
        ),
    )


def build_config(request: ModelRequest, timeout_s: float) -> gtypes.GenerateContentConfig:
    """The exact generation config one attempt sends (asserted by S5 3.6 and S2 AT-PORT-1)."""
    return gtypes.GenerateContentConfig(
        system_instruction=request.system,
        max_output_tokens=request.max_output_tokens,
        thinking_config=gtypes.ThinkingConfig(thinking_level=_THINKING[request.thinking]),
        response_mime_type="application/json",
        response_json_schema=request.json_schema,
        seed=request.seed,
        labels=dict(request.labels),
        automatic_function_calling=gtypes.AutomaticFunctionCallingConfig(disable=True),
        http_options=gtypes.HttpOptions(retry_options=no_sdk_retries(), timeout=max(1, int(timeout_s * 1000))),
    )


def build_contents(request: ModelRequest) -> list[gtypes.ContentUnion]:
    """Text parts only (S5 3.5: coaching never receives audio)."""
    return [gtypes.Content(role=m.role, parts=[gtypes.Part(text=m.text)]) for m in request.messages]


class _AsyncModels(Protocol):
    async def generate_content(
        self, *, model: str, contents: list[gtypes.ContentUnion], config: gtypes.GenerateContentConfig
    ) -> gtypes.GenerateContentResponse: ...


class _AsyncClient(Protocol):
    @property
    def models(self) -> _AsyncModels: ...


class VertexClient(Protocol):
    @property
    def aio(self) -> _AsyncClient: ...


@dataclass(frozen=True)
class VertexAdapter:
    client: VertexClient

    async def generate(self, request: ModelRequest, *, timeout_s: float) -> RawCompletion:
        config = build_config(request, timeout_s)
        try:
            resp = await self.client.aio.models.generate_content(
                model=request.model.value, contents=build_contents(request), config=config
            )
        except genai_errors.APIError as exc:
            # Vertex does not bill input or output for a non-200 response: nothing unknown to charge.
            raise ProviderCallError(kind_for_status(exc.code), f"HTTP {exc.code}", status=exc.code) from exc
        except google_auth_exceptions.GoogleAuthError as exc:
            raise ProviderCallError(ErrorKind.BAD_REQUEST, f"credentials: {type(exc).__name__}") from exc
        except httpx.TimeoutException as exc:
            raise ProviderCallError(ErrorKind.TRANSIENT, "timeout", maybe_billed=True) from exc
        except httpx.TransportError as exc:
            never_sent = isinstance(exc, httpx.ConnectError)
            raise ProviderCallError(
                ErrorKind.TRANSIENT, f"transport error: {type(exc).__name__}", maybe_billed=not never_sent
            ) from exc
        except httpx.HTTPError as exc:
            # Any other client-side HTTP failure after the request left (a corrupt or undecodable body,
            # httpx.DecodingError; a stream error): it may have been billed. Typed, sanitized, retried.
            msg = f"response error: {type(exc).__name__}"
            raise ProviderCallError(ErrorKind.TRANSIENT, msg, maybe_billed=True) from exc
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            # The SDK could not decode, validate or convert the response envelope (JSON and pydantic errors are
            # ValueErrors; a wrongly typed field fails conversion with TypeError, KeyError or AttributeError): the
            # request was sent and may have been billed, and no usage is readable. Typed, sanitized, retried.
            msg = f"malformed response: {type(exc).__name__}"
            raise ProviderCallError(ErrorKind.TRANSIENT, msg, maybe_billed=True) from exc
        return parse_response(resp)


def billed_usage(meta: gtypes.GenerateContentResponseUsageMetadata | None) -> Usage | None:
    """The attempt's billed tokens, or None when the metadata cannot bound them (the call then settles usage_unknown
    and keeps its full hold). Input is the prompt plus any tool-use prompt; output is the candidates plus thinking,
    raised to everything the total reports beyond the input, so a partial report never under-counts. Without a
    prompt count, or with neither a candidates count nor a total, the usage is unknown."""
    if meta is None or meta.prompt_token_count is None:
        return None
    input_tokens = meta.prompt_token_count + (meta.tool_use_prompt_token_count or 0)
    thinking = meta.thoughts_token_count or 0
    if meta.total_token_count is None and meta.candidates_token_count is None:
        return None
    output = (meta.candidates_token_count or 0) + thinking
    if meta.total_token_count is not None:
        output = max(output, meta.total_token_count - input_tokens)
    return Usage(
        input_tokens=input_tokens,
        output_tokens=output,
        thinking_tokens=min(thinking, output),
        cached_input_tokens=min(meta.cached_content_token_count or 0, input_tokens),
    )


def parse_response(resp: gtypes.GenerateContentResponse) -> RawCompletion:
    """Usage (thinking billed as output), then the typed stops, then the text."""
    usage = billed_usage(resp.usage_metadata)
    candidate = resp.candidates[0] if resp.candidates else None
    if candidate is None:
        block = resp.prompt_feedback.block_reason if resp.prompt_feedback else None
        kind = ErrorKind.BLOCKED if block else ErrorKind.EMPTY
        raise ProviderCallError(kind, f"no candidates (block_reason={block})", usage=usage, maybe_billed=True)
    finish = candidate.finish_reason
    parts = candidate.content.parts if candidate.content and candidate.content.parts else []
    text = "".join(p.text for p in parts if p.text and not p.thought)
    stop = None
    if finish == gtypes.FinishReason.MAX_TOKENS:
        stop = ProviderCallError(ErrorKind.TRUNCATED, "finish_reason=MAX_TOKENS", usage=usage, maybe_billed=True)
    elif finish in _BLOCKED_REASONS:
        stop = ProviderCallError(ErrorKind.BLOCKED, f"finish_reason={finish}", usage=usage, maybe_billed=True)
    if stop is not None:
        stop.reply_text = text  # the repair echoes the visible part of the cut-off or blocked reply (S2 10)
        raise stop
    if not text.strip():
        msg = f"empty reply (finish_reason={finish})"
        raise ProviderCallError(ErrorKind.EMPTY, msg, usage=usage, maybe_billed=True)
    return RawCompletion(text=text, usage=usage, finish_reason=str(finish) if finish is not None else None)


def vertex_adapter(env: Mapping[str, str], *, location: str = TEXT_LOCATION) -> VertexAdapter:
    """The runtime adapter: project from ARENA_GCP_PROJECT (boot-checked, D-015), credentials per S5 10.2."""
    project = env.get("ARENA_GCP_PROJECT", "")
    return VertexAdapter(build_vertex_client(project, location, vertex_credentials(env)))


# ============================================================================================= text-to-speech
# Stage 5: one spoken line in one prebuilt voice (arena_core.voice.tts owns the cache and the spend guard). The same
# client rules as text calls: the arena project only, a pinned host, no SDK retries, the billing label.

SPEECH_LOCATION = "global"
SPEECH_SAMPLE_RATE = 24_000
# The `tts` call limit's output tokens (ops.call_limits, cost_model.LIMITS): 80 s of audio at 25 tokens a second, past
# the longest line's reading time (a 900-character line, about 60 s). The Gemini 3.8 TTS models refuse a
# max_output_tokens field (400 INVALID_ARGUMENT, found on the first real call), so the request cannot carry this
# bound: the line's own length bounds its audio, and a reservation, attempts_per_call (4) times this limit for a line
# sent once, covers 320 s of audio.
SPEECH_MAX_OUTPUT_TOKENS = LIMITS[CallType.TTS].output_tokens
_PCM_SAMPLE_WIDTH = 2


def build_speech_config(voice: str, timeout_s: float) -> gtypes.GenerateContentConfig:
    """Audio out in one voice (a prebuilt name or a designed voice id, both in ``voiceConfig.voice`` for the Gemini 3.8
    TTS models), labelled, one attempt; no sampling parameters and no max_output_tokens (the 3.8 TTS models reject
    both)."""
    return gtypes.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=gtypes.SpeechConfig(voice_config=gtypes.VoiceConfig(voice=voice)),
        labels={"app": "unissant-arena"},
        automatic_function_calling=gtypes.AutomaticFunctionCallingConfig(disable=True),
        http_options=gtypes.HttpOptions(retry_options=no_sdk_retries(), timeout=max(1, int(timeout_s * 1000))),
    )


def speech_part(text: str, style: str | None) -> gtypes.Part:
    """The line as a verbatim transcript, with its delivery style as structured metadata (the 3.8 TTS models speak
    any direction written into the text aloud)."""
    return gtypes.Part(text=text, speech_metadata=None if style is None else gtypes.SpeechMetadata(style=style))


def speech_request_body(text: str, voice: str, style: str | None = None) -> dict[str, object]:
    """The Vertex `generateContent` JSON body the pinned google-genai sends for one spoken line, field for field (the
    speech tests compare it with the body the pinned SDK actually puts on the wire)."""
    part: dict[str, object] = {"text": text}
    if style is not None:
        part["speechMetadata"] = {"style": style}
    return {
        "contents": [{"parts": [part], "role": "user"}],
        "labels": {"app": "unissant-arena"},
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"voice": voice}},
        },
    }


def speech_request_bytes(text: str, voice: str, style: str | None = None) -> int:
    """The exact byte length of that body as transmitted (``json.dumps`` defaults, so every non-ASCII character costs
    its escape): what a line's reservation is measured on (S5 3.2, D11)."""
    return len(json.dumps(speech_request_body(text, voice, style)).encode("ascii"))


def speech_from(resp: gtypes.GenerateContentResponse) -> tuple[bytes, Usage | None]:
    """The response's audio and billed usage (prompt tokens in, audio tokens out); typed errors otherwise."""
    meta = resp.usage_metadata
    usage = None
    if meta is not None and meta.prompt_token_count is not None and meta.candidates_token_count is not None:
        usage = Usage(input_tokens=meta.prompt_token_count, output_tokens=meta.candidates_token_count)
    candidate = resp.candidates[0] if resp.candidates else None
    parts = candidate.content.parts if candidate and candidate.content and candidate.content.parts else []
    audio = b"".join(p.inline_data.data for p in parts if p.inline_data is not None and p.inline_data.data)
    if candidate is not None and candidate.finish_reason in _BLOCKED_REASONS:
        raise ProviderCallError(
            ErrorKind.BLOCKED, f"finish_reason={candidate.finish_reason}", usage=usage, maybe_billed=True
        )
    if not audio:
        raise ProviderCallError(ErrorKind.EMPTY, "no audio in the reply", usage=usage, maybe_billed=True)
    return audio, usage


def _malformed(why: str) -> ProviderCallError:
    return ProviderCallError(ErrorKind.TRANSIENT, f"malformed audio: {why}", maybe_billed=True)


_PCM_FORMAT = 1  # WAVE_FORMAT_PCM
_RIFF_HEADER = 12  # "RIFF", the file size, "WAVE"
_FMT_MIN = 16  # the fmt chunk's PCM fields


def _wav_pcm(audio: bytes) -> tuple[bytes, int]:
    """A RIFF/WAVE file's 16-bit mono PCM and rate, every chunk read by its declared size: a short or truncated file,
    another sample format, a zero rate, or a data chunk that is not whole frames is refused."""
    if len(audio) < _RIFF_HEADER or audio[8:12] != b"WAVE":
        why = "a RIFF file without its WAVE header"
        raise _malformed(why)
    fmt: tuple[int, int, int, int] | None = None
    pos = 12
    while pos + 8 <= len(audio):
        chunk, size = audio[pos : pos + 4], int.from_bytes(audio[pos + 4 : pos + 8], "little")
        body = audio[pos + 8 : pos + 8 + size]
        if len(body) < size:
            why = f"the {chunk!r} chunk is cut short"
            raise _malformed(why)
        if chunk == b"fmt ":
            if size < _FMT_MIN:
                why = "a short fmt chunk"
                raise _malformed(why)
            fmt = (
                int.from_bytes(body[0:2], "little"),
                int.from_bytes(body[2:4], "little"),
                int.from_bytes(body[4:8], "little"),
                int.from_bytes(body[14:16], "little"),
            )
        elif chunk == b"data":
            if fmt is None:
                why = "data before its fmt chunk"
                raise _malformed(why)
            kind, channels, rate, bits = fmt
            if kind != _PCM_FORMAT or channels != 1 or bits != 8 * _PCM_SAMPLE_WIDTH:
                why = f"WAV of format {kind}, {channels} channel(s) at {bits} bits"
                raise _malformed(why)
            if rate <= 0:
                why = "a WAV with no sample rate"
                raise _malformed(why)
            if size == 0 or size % _PCM_SAMPLE_WIDTH:
                why = f"a data chunk of {size} bytes"
                raise _malformed(why)
            return body, rate
        pos += 8 + size + (size & 1)  # chunks are word-aligned
    why = "a WAV without a data chunk"
    raise _malformed(why)


def pcm_from(audio: bytes) -> tuple[bytes, int]:
    """The reply's 16-bit mono PCM and its sample rate. The Gemini 3.8 TTS models answer a unary request with a
    complete WAV file (16-bit mono PCM, 24 kHz, standard RIFF header); earlier models answered headerless PCM at
    24 kHz. Either way the caller gets the samples and writes its own WAV, so a cached line is always one well-formed
    file. Anything starting as a RIFF file is read as one (a damaged one is refused, never taken for PCM); headerless
    PCM must be whole 16-bit frames."""
    if audio[:4] == b"RIFF":
        return _wav_pcm(audio)
    if not audio or len(audio) % _PCM_SAMPLE_WIDTH:
        why = f"PCM of {len(audio)} bytes"
        raise _malformed(why)
    return audio, SPEECH_SAMPLE_RATE


@dataclass(frozen=True)
class VertexSpeech:
    """Gemini TTS on Vertex AI (``arena_core.voice.tts.TTS_MODEL``): 16-bit mono PCM and its rate (24 kHz)."""

    client: VertexClient
    model: str
    timeout_s: float = 60.0

    async def synthesize(self, text: str, voice: str, style: str | None = None) -> tuple[bytes, int, Usage | None]:
        contents: list[gtypes.ContentUnion] = [gtypes.Content(role="user", parts=[speech_part(text, style)])]
        try:
            resp = await self.client.aio.models.generate_content(
                model=self.model, contents=contents, config=build_speech_config(voice, self.timeout_s)
            )
        except genai_errors.APIError as exc:
            raise ProviderCallError(kind_for_status(exc.code), f"HTTP {exc.code}", status=exc.code) from exc
        except google_auth_exceptions.GoogleAuthError as exc:
            raise ProviderCallError(ErrorKind.BAD_REQUEST, f"credentials: {type(exc).__name__}") from exc
        except httpx.TimeoutException as exc:
            raise ProviderCallError(ErrorKind.TRANSIENT, "timeout", maybe_billed=True) from exc
        except httpx.TransportError as exc:
            never_sent = isinstance(exc, httpx.ConnectError)
            raise ProviderCallError(
                ErrorKind.TRANSIENT, f"transport error: {type(exc).__name__}", maybe_billed=not never_sent
            ) from exc
        except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError) as exc:
            raise ProviderCallError(
                ErrorKind.TRANSIENT, f"malformed response: {type(exc).__name__}", maybe_billed=True
            ) from exc
        audio, usage = speech_from(resp)
        try:
            pcm, rate = pcm_from(audio)
        except ProviderCallError as exc:
            raise ProviderCallError(exc.kind, str(exc), usage=usage, maybe_billed=True) from exc
        return pcm, rate, usage


def vertex_speech(env: Mapping[str, str], model: str) -> VertexSpeech:
    """The runtime speech client: project from ARENA_GCP_PROJECT (D-015), credentials per S5 10.2, global location."""
    project = env.get("ARENA_GCP_PROJECT", "")
    return VertexSpeech(build_vertex_client(project, SPEECH_LOCATION, vertex_credentials(env)), model)


# ============================================================================================== voice design
# Stage 8: one designed voice per persona (scripts/design_voices.py), stored in the arena project through the Voices
# API (CreateVoice, type prompted, store true), billed like speech: the description as text in, the voice sample as
# audio out. Sent as one plain REST request on the pinned host (no SDK retry layer, so one send is one attempt, and
# the reserved bytes are the bytes on the wire). Synthetic characters only: never a replicated voice.

VOICE_DESIGN_TIMEOUT_S = 60.0
VOICES_API_VERSION = "v1beta1"
_STATUS_OK = 200


@dataclass(frozen=True)
class DesignedVoice:
    voice_id: str
    sample: bytes  # the voice sample as returned, for an audition
    sample_mime: str  # its encoding (``audio/wav``, or ``audio/l16; rate=24000`` for headerless PCM)
    usage: Usage | None


def voice_design_body(description: str, display_name: str, gender: str, language_code: str) -> dict[str, object]:
    """The CreateVoice request body (REST, camelCase)."""
    return {
        "store": True,
        "voice": {
            "type": "VOICE_TYPE_PROMPTED",
            "displayName": display_name,
            "gender": gender,
            "languageCode": language_code,
            "prompted": {"input": description},
        },
    }


def voice_design_wire(description: str, display_name: str, gender: str, language_code: str) -> bytes:
    """The exact bytes sent (``json.dumps`` defaults: every non-ASCII character as its escape)."""
    return json.dumps(voice_design_body(description, display_name, gender, language_code)).encode("ascii")


def voice_design_bytes(description: str, display_name: str, gender: str, language_code: str) -> int:
    """What a design is reserved on: the request's own byte length (D11)."""
    return len(voice_design_wire(description, display_name, gender, language_code))


def voices_url(project: str) -> str:
    host = vertex_base_url(SPEECH_LOCATION)
    return f"{host}{VOICES_API_VERSION}/projects/{project}/locations/{SPEECH_LOCATION}/voices"


def _access_token(credentials: Credentials) -> str:
    """A fresh bearer token (google-auth refreshes synchronously; the caller runs this off the event loop). google-auth
    ships no annotations, so the credential is handled as untyped here."""
    creds: Any = credentials
    if not creds.valid:
        creds.refresh(GoogleAuthRequest())
    token = creds.token
    if not isinstance(token, str) or not token:
        raise ProviderCallError(ErrorKind.BAD_REQUEST, "credentials: no access token")
    return token


def _count(obj: Mapping[str, object], *names: str) -> int | None:
    for name in names:
        value = obj.get(name)
        if isinstance(value, int) and not isinstance(value, bool):
            return value
    return None


def _field(obj: Mapping[str, object], snake: str, camel: str) -> object:
    """A reply field by its REST name (snake_case, as Google's CreateVoice reference prints it) or its JSON-mapping
    camelCase twin."""
    return obj[snake] if snake in obj else obj.get(camel)


def designed_voice_from(data: object) -> DesignedVoice:
    """The CreateVoice reply: the stored voice id, its sample and the billed usage (input and output tokens); a reply
    without a stored id is empty (with its usage)."""
    if not isinstance(data, dict):
        raise ProviderCallError(ErrorKind.TRANSIENT, "malformed reply", maybe_billed=True)
    raw_usage = data.get("usage")
    usage = None
    if isinstance(raw_usage, dict):
        tokens_in = _count(raw_usage, "total_input_tokens", "totalInputTokens")
        tokens_out = _count(raw_usage, "total_output_tokens", "totalOutputTokens")
        if tokens_in is not None and tokens_out is not None:
            usage = Usage(input_tokens=tokens_in, output_tokens=tokens_out)
    voice_id = data.get("id")
    if not isinstance(voice_id, str) or not voice_id.startswith("voice_"):
        raise ProviderCallError(ErrorKind.EMPTY, "no stored voice id in the reply", usage=usage, maybe_billed=True)
    sample_obj = _field(data, "sample_audio", "sampleAudio")
    sample, mime = b"", ""
    if isinstance(sample_obj, dict):
        raw = sample_obj.get("data")
        mime_raw = _field(sample_obj, "mime_type", "mimeType")
        mime = mime_raw if isinstance(mime_raw, str) else ""
        if isinstance(raw, str):
            try:
                sample = base64.b64decode(raw, validate=True)
            except ValueError as exc:
                # The voice is stored and usable; only its audition sample is unreadable, so it is reported, not fatal.
                log.warning("voice %s: unreadable sample audio (%s)", voice_id, exc)
                sample = b""
    return DesignedVoice(voice_id=voice_id, sample=sample, sample_mime=mime, usage=usage)


@dataclass(frozen=True)
class VertexVoiceDesigner:
    """Creates one stored, prompted voice in the arena project: one POST, no retries."""

    project: str
    credentials: Credentials
    http: httpx.AsyncClient | None = None  # tests pass an in-memory transport

    async def design(self, description: str, display_name: str, gender: str, language_code: str) -> DesignedVoice:
        if self.project != ALLOWED_GCP_PROJECT:
            msg = f"Vertex project {self.project!r} refused: D-015 allows only {ALLOWED_GCP_PROJECT!r}"
            raise ConfigError(msg)
        try:
            token = await asyncio.to_thread(_access_token, self.credentials)
        except google_auth_exceptions.GoogleAuthError as exc:
            raise ProviderCallError(ErrorKind.BAD_REQUEST, f"credentials: {type(exc).__name__}") from exc
        # The quota project names who pays: user credentials (local ADC) carry none, and the Voices API refuses a
        # call without one (403 SERVICE_DISABLED). The arena project, as the SDK does for the model calls.
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-goog-user-project": self.project,
        }
        body = voice_design_wire(description, display_name, gender, language_code)
        client = self.http or httpx.AsyncClient(timeout=VOICE_DESIGN_TIMEOUT_S)
        try:
            resp = await client.post(voices_url(self.project), content=body, headers=headers)
        except httpx.TimeoutException as exc:
            raise ProviderCallError(ErrorKind.TRANSIENT, "timeout", maybe_billed=True) from exc
        except httpx.TransportError as exc:
            never_sent = isinstance(exc, httpx.ConnectError)
            raise ProviderCallError(
                ErrorKind.TRANSIENT, f"transport error: {type(exc).__name__}", maybe_billed=not never_sent
            ) from exc
        finally:
            if self.http is None:
                await client.aclose()
        if resp.status_code != _STATUS_OK:
            # A refused request (4xx) or a server error (5xx) created no voice and was not billed.
            status = resp.status_code
            raise ProviderCallError(kind_for_status(status), f"HTTP {status}", status=status)
        try:
            data = resp.json()
        except ValueError as exc:
            raise ProviderCallError(ErrorKind.TRANSIENT, "malformed reply", maybe_billed=True) from exc
        return designed_voice_from(data)


def vertex_voice_designer(env: Mapping[str, str]) -> VertexVoiceDesigner:
    """The Voices API on the arena project (D-015), global location, credentials per S5 10.2."""
    return VertexVoiceDesigner(env.get("ARENA_GCP_PROJECT", ""), vertex_credentials(env))


# Live (WP-22): Vertex Live as a `LiveBackend` (S5 7.4, S2 9.2; lift target: gokbase G1 `_build_config`).
#
# The client is the arena project only (D-015, `build_vertex_client`), ADC per S5 10.2, location `us-central1` (Live
# is not served from `global`). The session config is S2 9.2's: audio out, both transcriptions, automatic activity
# detection with 700 ms of silence, the packet's prebuilt voice, no tools, proactivity and affective dialog off, no
# session resumption, no thinking config. `LiveConnectConfig` has no request-label field, so Live traffic carries no
# `app` label (the project scopes it, D-015). A mid-session instruction update goes as system-role client content
# with `turn_complete` false (S2 9.2; accepted by the probed model).

SILENCE_MS = 700
AUDIO_MIME = "audio/pcm;rate=16000"


def live_config(setup: Mapping[str, Any], model: str = LIVE_MODEL) -> gtypes.LiveConnectConfig:
    """The SDK config from `subject_prompts.live_setup`'s plain data. `gemini-3.8-live` has proactive audio always
    on and affective dialog removed (setting either is refused, per its Vertex migration guide), so both are sent
    off only to the 2.5 native-audio fallback, where S2 9.2 turns them off."""
    voice = str(setup["speech_config"]["voice_config"]["prebuilt_voice_config"]["voice_name"])
    # A designed voice id (`voice_...`, the persona catalogue) goes in `voice`; a prebuilt name in its own config.
    voice_config = (
        gtypes.VoiceConfig(voice=voice)
        if voice.startswith(VOICE_ID_PREFIX)
        else gtypes.VoiceConfig(prebuilt_voice_config=gtypes.PrebuiltVoiceConfig(voice_name=voice))
    )
    switches: dict[str, Any] = {}
    if model != LIVE_MODEL:
        switches = {"proactivity": gtypes.ProactivityConfig(proactive_audio=False), "enable_affective_dialog": False}
    return gtypes.LiveConnectConfig(
        response_modalities=[gtypes.Modality.AUDIO],
        system_instruction=str(setup["system_instruction"]),
        input_audio_transcription=gtypes.AudioTranscriptionConfig(),
        output_audio_transcription=gtypes.AudioTranscriptionConfig(),
        realtime_input_config=gtypes.RealtimeInputConfig(
            automatic_activity_detection=gtypes.AutomaticActivityDetection(silence_duration_ms=SILENCE_MS)
        ),
        speech_config=gtypes.SpeechConfig(voice_config=voice_config),
        **switches,
    )


def _by_modality(details: list[gtypes.ModalityTokenCount] | None, modality: gtypes.MediaModality) -> int:
    return sum(d.token_count or 0 for d in details or [] if d.modality == modality)


def live_usage(meta: gtypes.UsageMetadata) -> LiveUsage:
    """One report, split by modality; thinking is billed as text output, and the output is raised to everything
    the total reports beyond the prompt, so a partial report never under-counts (as `billed_usage`)."""
    prompt = meta.prompt_token_count or sum(d.token_count or 0 for d in meta.prompt_tokens_details or [])
    audio_in = _by_modality(meta.prompt_tokens_details, gtypes.MediaModality.AUDIO)
    response = meta.response_token_count or sum(d.token_count or 0 for d in meta.response_tokens_details or [])
    audio_out = _by_modality(meta.response_tokens_details, gtypes.MediaModality.AUDIO)
    thinking = meta.thoughts_token_count or 0
    text_out = response - audio_out + thinking
    if meta.total_token_count is not None:
        text_out = max(text_out, meta.total_token_count - prompt - audio_out)
    return LiveUsage(
        text_in=max(0, prompt - audio_in),
        audio_in=audio_in,
        text_out=max(0, text_out),
        audio_out=audio_out,
        thinking=thinking,
    )


def events_of(message: gtypes.LiveServerMessage) -> list[LiveEvent]:
    out: list[LiveEvent] = []
    content = message.server_content
    if content is not None:
        if content.model_turn is not None:
            out.extend(
                LiveAudio(p.inline_data.data)
                for p in content.model_turn.parts or []
                if p.inline_data is not None and p.inline_data.data
            )
        if content.input_transcription is not None and content.input_transcription.text is not None:
            t = content.input_transcription
            out.append(LiveTranscript("investigator", t.text or "", bool(t.finished)))
        if content.output_transcription is not None and content.output_transcription.text is not None:
            t = content.output_transcription
            out.append(LiveTranscript("subject", t.text or "", bool(t.finished)))
        if content.interrupted:
            out.append(LiveInterrupted())
        if content.turn_complete:
            out.append(LiveTurnComplete())
    if message.usage_metadata is not None:
        out.append(live_usage(message.usage_metadata))
    return out


class LiveSdkSession(Protocol):
    """The part of the SDK's `AsyncSession` the connection uses."""

    def receive(self) -> AsyncIterator[gtypes.LiveServerMessage]: ...

    async def send_realtime_input(self, *, audio: gtypes.Blob) -> None: ...

    async def send_client_content(self, *, turns: gtypes.Content, turn_complete: bool) -> None: ...


class LiveSessionConnection:
    """One Live session as a `LiveConnection`."""

    def __init__(self, session: LiveSdkSession) -> None:
        self._s = session

    async def send_audio(self, pcm: bytes) -> None:
        await self._s.send_realtime_input(audio=gtypes.Blob(data=pcm, mime_type=AUDIO_MIME))

    async def update_instruction(self, text: str) -> None:
        await self._s.send_client_content(
            turns=gtypes.Content(role="system", parts=[gtypes.Part(text=text)]), turn_complete=False
        )

    async def events(self) -> AsyncIterator[LiveEvent]:
        # The SDK's receive() ends after each turn_complete; the session goes on until either side closes it.
        while True:
            got = False
            try:
                async for message in self._s.receive():
                    got = True
                    for event in events_of(message):
                        yield event
            except Exception as exc:  # silent-ok: any receive failure ends the session as a transport drop
                raise LiveClosedError(str(exc)) from exc
            if not got:
                msg = "the Live session closed"
                raise LiveClosedError(msg)


class VertexLive:
    """`LiveBackend` on Vertex for the arena project."""

    def __init__(self, client: genai.Client, model: str = LIVE_MODEL) -> None:
        self._client = client
        self.model = model

    def connect(self, setup: Mapping[str, Any]) -> AbstractAsyncContextManager[LiveConnection]:
        @asynccontextmanager
        async def _open() -> AsyncIterator[LiveConnection]:
            async with self._client.aio.live.connect(
                model=self.model, config=live_config(setup, self.model)
            ) as session:
                yield LiveSessionConnection(session)

        return _open()


def vertex_live(env: Mapping[str, str], model: str = LIVE_MODEL) -> VertexLive:
    """The runtime backend: project from ARENA_GCP_PROJECT (boot-checked, D-015), credentials per S5 10.2."""
    project = env.get("ARENA_GCP_PROJECT", "")
    return VertexLive(build_vertex_client(project, LIVE_LOCATION, vertex_credentials(env)), model)
