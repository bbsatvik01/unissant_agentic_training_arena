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
import importlib
import io
import json
import wave
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Protocol, cast

import google.auth
import httpx
from google import genai
from google.auth import exceptions as google_auth_exceptions
from google.auth import impersonated_credentials
from google.auth.credentials import Credentials
from google.genai import errors as genai_errors
from google.genai import types as gtypes

from arena_core.config import ALLOWED_GCP_PROJECT
from arena_core.providers.errors import ConfigError, ErrorKind, ProviderCallError, kind_for_status
from arena_core.providers.types import ModelRequest, RawCompletion, Usage
from arena_core.spend.limits import LIMITS, CallType, ThinkingLevel

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
# 25 audio tokens a second: 80 s, past the longest line's reading time (60 s). The `tts` call limit's output tokens
# (ops.call_limits, cost_model.LIMITS), so a reservation prices exactly the output this request allows.
SPEECH_MAX_OUTPUT_TOKENS = LIMITS[CallType.TTS].output_tokens
_PCM_SAMPLE_WIDTH = 2


def build_speech_config(voice: str, timeout_s: float) -> gtypes.GenerateContentConfig:
    """Audio out in one voice (a prebuilt name or a designed voice id, both in ``voiceConfig.voice`` for the Gemini 3.8
    TTS models), labelled, one attempt, bounded output; no sampling parameters (the 3.8 TTS models reject them)."""
    return gtypes.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=gtypes.SpeechConfig(voice_config=gtypes.VoiceConfig(voice=voice)),
        max_output_tokens=SPEECH_MAX_OUTPUT_TOKENS,
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
            "maxOutputTokens": SPEECH_MAX_OUTPUT_TOKENS,
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


def pcm_from(audio: bytes) -> tuple[bytes, int]:
    """The reply's 16-bit mono PCM and its sample rate. The Gemini 3.8 TTS models answer a unary request with a
    complete WAV file (16-bit mono PCM, 24 kHz, standard RIFF header); earlier models answered headerless PCM at
    24 kHz. Either way the caller gets the samples and writes its own WAV, so a cached line is always one well-formed
    file. A WAV in another sample format, or a damaged one, is a malformed reply."""
    if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
        return audio, SPEECH_SAMPLE_RATE
    try:
        with wave.open(io.BytesIO(audio), "rb") as w:
            if w.getsampwidth() != _PCM_SAMPLE_WIDTH or w.getnchannels() != 1:
                raise ProviderCallError(
                    ErrorKind.TRANSIENT,
                    f"WAV of {w.getnchannels()} channel(s) at {8 * w.getsampwidth()} bits",
                    maybe_billed=True,
                )
            return w.readframes(w.getnframes()), w.getframerate()
    except (wave.Error, EOFError) as exc:
        raise ProviderCallError(ErrorKind.TRANSIENT, f"malformed WAV: {exc}", maybe_billed=True) from exc


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
# API (``voices.create``, type prompted, store true). Billed like speech: the description as text in, the voice sample
# as audio out. Synthetic characters only: this module never creates a replicated voice.

VOICE_DESIGN_TIMEOUT_S = 60.0
# The Voices API client google-genai generates (2.25.0+) raises its own error types.
VOICES_ERRORS = importlib.import_module("google.genai._gaos.errors")


@dataclass(frozen=True)
class DesignedVoice:
    voice_id: str
    sample: bytes  # the sample audio as returned (WAV or 16-bit PCM), for an audition
    usage: Usage | None


def voice_design_body(description: str, display_name: str, gender: str, language_code: str) -> dict[str, object]:
    """The CreateVoice request, as JSON: what a design is reserved on (its bytes bound its text tokens, D11)."""
    return {
        "store": True,
        "voice": {
            "type": "prompted",
            "display_name": display_name,
            "gender": gender,
            "language_code": language_code,
            "prompted": {"input": description},
        },
    }


def voice_design_bytes(description: str, display_name: str, gender: str, language_code: str) -> int:
    return len(json.dumps(voice_design_body(description, display_name, gender, language_code)).encode("ascii"))


class _VoicesApi(Protocol):
    async def create(self, *, voice: object, store: bool | None = None) -> object: ...


def _int_or_none(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


@dataclass(frozen=True)
class VertexVoiceDesigner:
    """Creates one stored, prompted voice in the arena project."""

    voices: _VoicesApi

    async def design(self, description: str, display_name: str, gender: str, language_code: str) -> DesignedVoice:
        body = voice_design_body(description, display_name, gender, language_code)
        try:
            async with asyncio.timeout(VOICE_DESIGN_TIMEOUT_S):
                out = await self.voices.create(voice=body["voice"], store=True)
        except VOICES_ERRORS.GenAiError as exc:
            # The generated Voices client's HTTP error: a non-200 was not billed.
            raise ProviderCallError(
                kind_for_status(exc.status_code), f"HTTP {exc.status_code}", status=exc.status_code
            ) from exc
        except (httpx.TimeoutException, TimeoutError) as exc:
            raise ProviderCallError(ErrorKind.TRANSIENT, "timeout", maybe_billed=True) from exc
        except (httpx.HTTPError, VOICES_ERRORS.NoResponseError, ValueError) as exc:
            raise ProviderCallError(
                ErrorKind.TRANSIENT, f"voice design failed: {type(exc).__name__}", maybe_billed=True
            ) from exc
        usage_obj = getattr(out, "usage", None)
        tokens_in = _int_or_none(getattr(usage_obj, "total_input_tokens", None))
        tokens_out = _int_or_none(getattr(usage_obj, "total_output_tokens", None))
        usage = (
            None if tokens_in is None or tokens_out is None else Usage(input_tokens=tokens_in, output_tokens=tokens_out)
        )
        voice_id = getattr(out, "id", None)
        if not isinstance(voice_id, str) or not voice_id.startswith("voice_"):
            raise ProviderCallError(ErrorKind.EMPTY, "no stored voice id in the reply", usage=usage, maybe_billed=True)
        sample_obj = getattr(out, "sample_audio", None)
        raw = getattr(sample_obj, "data", None)
        sample = base64.b64decode(raw) if isinstance(raw, str) else raw if isinstance(raw, bytes) else b""
        return DesignedVoice(voice_id=voice_id, sample=sample, usage=usage)


def vertex_voice_designer(env: Mapping[str, str]) -> VertexVoiceDesigner:
    """The Voices API on the arena project (D-015), global location, credentials per S5 10.2."""
    project = env.get("ARENA_GCP_PROJECT", "")
    client = build_vertex_client(project, SPEECH_LOCATION, vertex_credentials(env))
    return VertexVoiceDesigner(cast("_VoicesApi", client.aio.voices))
