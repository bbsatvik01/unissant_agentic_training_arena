"""Vertex Live as a `LiveBackend` (S5 7.4, S2 9.2; lift target: gokbase G1 `_build_config`).

The client is the arena project only (D-015, `build_vertex_client`), ADC per S5 10.2, location `us-central1` (Live
is not served from `global`). The session config is S2 9.2's: audio out, both transcriptions, automatic activity
detection with 700 ms of silence, the packet's prebuilt voice, no tools, proactivity and affective dialog off, no
session resumption, no thinking config. `LiveConnectConfig` has no request-label field, so Live traffic carries no
`app` label (the project scopes it, D-015). A mid-session instruction update goes as system-role client content
with `turn_complete` false (S2 9.2; accepted by the probed model).
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any

from google import genai
from google.genai import types as gtypes
from google.genai.live import AsyncSession

from arena_core.providers.vertex import build_vertex_client, vertex_credentials
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

SILENCE_MS = 700
AUDIO_MIME = "audio/pcm;rate=16000"


def live_config(setup: Mapping[str, Any]) -> gtypes.LiveConnectConfig:
    """The SDK config from `subject_prompts.live_setup`'s plain data."""
    voice = setup["speech_config"]["voice_config"]["prebuilt_voice_config"]["voice_name"]
    return gtypes.LiveConnectConfig(
        response_modalities=[gtypes.Modality.AUDIO],
        system_instruction=str(setup["system_instruction"]),
        input_audio_transcription=gtypes.AudioTranscriptionConfig(),
        output_audio_transcription=gtypes.AudioTranscriptionConfig(),
        realtime_input_config=gtypes.RealtimeInputConfig(
            automatic_activity_detection=gtypes.AutomaticActivityDetection(silence_duration_ms=SILENCE_MS)
        ),
        proactivity=gtypes.ProactivityConfig(proactive_audio=False),
        enable_affective_dialog=False,
        speech_config=gtypes.SpeechConfig(
            voice_config=gtypes.VoiceConfig(prebuilt_voice_config=gtypes.PrebuiltVoiceConfig(voice_name=str(voice)))
        ),
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


class _VertexConnection:
    def __init__(self, session: AsyncSession) -> None:
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
            async with self._client.aio.live.connect(model=self.model, config=live_config(setup)) as session:
                yield _VertexConnection(session)

        return _open()


def vertex_live(env: Mapping[str, str], model: str = LIVE_MODEL) -> VertexLive:
    """The runtime backend: project from ARENA_GCP_PROJECT (boot-checked, D-015), credentials per S5 10.2."""
    project = env.get("ARENA_GCP_PROJECT", "")
    return VertexLive(build_vertex_client(project, LIVE_LOCATION, vertex_credentials(env)), model)
