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

import json
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
from google.genai import errors as genai_errors
from google.genai import types as gtypes

from arena_core.config import ALLOWED_GCP_PROJECT
from arena_core.providers.errors import ConfigError, ErrorKind, ProviderCallError, kind_for_status
from arena_core.providers.types import ModelRequest, RawCompletion, Usage
from arena_core.spend.limits import ThinkingLevel
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
SPEECH_MAX_OUTPUT_TOKENS = 2_000  # 25 audio tokens a second: 80 s, past the longest line's reading time (60 s)


def build_speech_config(voice: str, timeout_s: float) -> gtypes.GenerateContentConfig:
    """Audio out in one prebuilt voice, labelled, one attempt, bounded output."""
    return gtypes.GenerateContentConfig(
        response_modalities=["AUDIO"],
        speech_config=gtypes.SpeechConfig(
            voice_config=gtypes.VoiceConfig(prebuilt_voice_config=gtypes.PrebuiltVoiceConfig(voice_name=voice))
        ),
        max_output_tokens=SPEECH_MAX_OUTPUT_TOKENS,
        labels={"app": "unissant-arena"},
        automatic_function_calling=gtypes.AutomaticFunctionCallingConfig(disable=True),
        http_options=gtypes.HttpOptions(retry_options=no_sdk_retries(), timeout=max(1, int(timeout_s * 1000))),
    )


def speech_request_body(text: str, voice: str) -> dict[str, object]:
    """The Vertex `generateContent` JSON body google-genai 2.24.0 sends for one spoken line, field for field (the
    speech tests compare it with the body the pinned SDK actually puts on the wire)."""
    return {
        "contents": [{"parts": [{"text": text}], "role": "user"}],
        "labels": {"app": "unissant-arena"},
        "generationConfig": {
            "maxOutputTokens": SPEECH_MAX_OUTPUT_TOKENS,
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voice_name": voice}}},
        },
    }


def speech_request_bytes(text: str, voice: str) -> int:
    """The exact byte length of that body as transmitted (``json.dumps`` defaults, so every non-ASCII character costs
    its escape): what a line's reservation is measured on (S5 3.2, D11)."""
    return len(json.dumps(speech_request_body(text, voice)).encode("ascii"))


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


@dataclass(frozen=True)
class VertexSpeech:
    """Gemini TTS on Vertex AI (``arena_core.voice.tts.TTS_MODEL``): 16-bit mono PCM at 24 kHz."""

    client: VertexClient
    model: str
    timeout_s: float = 60.0

    async def synthesize(self, text: str, voice: str) -> tuple[bytes, int, Usage | None]:
        contents: list[gtypes.ContentUnion] = [gtypes.Content(role="user", parts=[gtypes.Part(text=text)])]
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
        return audio, SPEECH_SAMPLE_RATE, usage


def vertex_speech(env: Mapping[str, str], model: str) -> VertexSpeech:
    """The runtime speech client: project from ARENA_GCP_PROJECT (D-015), credentials per S5 10.2, global location."""
    project = env.get("ARENA_GCP_PROJECT", "")
    return VertexSpeech(build_vertex_client(project, SPEECH_LOCATION, vertex_credentials(env)), model)


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
    voice = setup["speech_config"]["voice_config"]["prebuilt_voice_config"]["voice_name"]
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
        speech_config=gtypes.SpeechConfig(
            voice_config=gtypes.VoiceConfig(prebuilt_voice_config=gtypes.PrebuiltVoiceConfig(voice_name=str(voice)))
        ),
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
