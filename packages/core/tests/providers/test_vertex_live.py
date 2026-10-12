"""The Vertex Live backend's pure parts (S2 9.2, S5 7.4): the session config, server messages to Live events, and
usage split by modality. A fake session stands in for the SDK's; no network."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Coroutine
from typing import Any

import pytest

from arena_core.providers import vertex
from arena_core.providers.vertex import events_of, live_config, live_usage
from arena_core.voice.live import (
    LIVE_FALLBACK_MODEL,
    LiveAudio,
    LiveClosedError,
    LiveInterrupted,
    LiveTranscript,
    LiveTurnComplete,
    LiveUsage,
)

gtypes: Any = vertex.SDK_TYPES  # the adapter module stays the only importer of google.genai (check_roles)

SETUP = {
    "system_instruction": "You are speaking as Jordan Pell.",
    "speech_config": {"voice_config": {"prebuilt_voice_config": {"voice_name": "Charon"}}},
}


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


def test_the_live_config_is_audio_with_both_transcriptions_the_voice_and_no_tools_or_proactivity() -> None:
    cfg = live_config(SETUP)
    assert cfg.response_modalities == [gtypes.Modality.AUDIO]
    assert cfg.system_instruction == SETUP["system_instruction"]
    assert cfg.input_audio_transcription is not None
    assert cfg.output_audio_transcription is not None
    assert cfg.tools is None
    assert cfg.session_resumption is None
    assert cfg.thinking_config is None
    # gemini-3.8-live refuses both switches (proactive audio always on, affective dialog removed)...
    assert cfg.proactivity is None
    assert cfg.enable_affective_dialog is None
    detect = cfg.realtime_input_config
    assert detect is not None
    assert detect.automatic_activity_detection is not None
    assert detect.automatic_activity_detection.silence_duration_ms == vertex.SILENCE_MS
    voice = cfg.speech_config
    assert voice is not None
    assert voice.voice_config is not None
    assert voice.voice_config.prebuilt_voice_config is not None
    assert voice.voice_config.prebuilt_voice_config.voice_name == "Charon"


def test_the_native_audio_fallback_turns_proactivity_and_affective_dialog_off() -> None:
    cfg = live_config(SETUP, LIVE_FALLBACK_MODEL)
    assert cfg.proactivity == gtypes.ProactivityConfig(proactive_audio=False)
    assert cfg.enable_affective_dialog is False


def _usage() -> gtypes.UsageMetadata:
    return gtypes.UsageMetadata(
        prompt_token_count=147,
        prompt_tokens_details=[
            gtypes.ModalityTokenCount(modality=gtypes.MediaModality.TEXT, token_count=100),
            gtypes.ModalityTokenCount(modality=gtypes.MediaModality.AUDIO, token_count=47),
        ],
        response_token_count=97,
        response_tokens_details=[
            gtypes.ModalityTokenCount(modality=gtypes.MediaModality.TEXT, token_count=17),
            gtypes.ModalityTokenCount(modality=gtypes.MediaModality.AUDIO, token_count=80),
        ],
        thoughts_token_count=53,
        total_token_count=297,
    )


def test_usage_is_split_by_modality_with_thinking_billed_as_text_out() -> None:
    assert live_usage(_usage()) == LiveUsage(text_in=100, audio_in=47, text_out=70, audio_out=80, thinking=53)
    # A total beyond the parts raises text out to everything the total reports past the prompt and audio.
    raised = _usage().model_copy(update={"total_token_count": 400})
    assert live_usage(raised).text_out == 400 - 147 - 80
    # Counts given only by their details still add up.
    bare = _usage().model_copy(
        update={"prompt_token_count": None, "response_token_count": None, "total_token_count": None}
    )
    assert live_usage(bare) == LiveUsage(text_in=100, audio_in=47, text_out=70, audio_out=80, thinking=53)


def test_a_server_message_becomes_audio_captions_interruption_turn_complete_and_usage_in_that_order() -> None:
    message = gtypes.LiveServerMessage(
        server_content=gtypes.LiveServerContent(
            model_turn=gtypes.Content(
                role="model", parts=[gtypes.Part(inline_data=gtypes.Blob(data=b"\x01\x02", mime_type="audio/pcm"))]
            ),
            input_transcription=gtypes.Transcription(text="Where were you", finished=False),
            output_transcription=gtypes.Transcription(text="In the hall.", finished=True),
            interrupted=True,
            turn_complete=True,
        ),
        usage_metadata=_usage(),
    )
    events = events_of(message)
    assert events[:5] == [
        LiveAudio(b"\x01\x02"),
        LiveTranscript("investigator", "Where were you", finished=False),
        LiveTranscript("subject", "In the hall.", finished=True),
        LiveInterrupted(),
        LiveTurnComplete(),
    ]
    assert isinstance(events[5], LiveUsage)
    assert events_of(gtypes.LiveServerMessage()) == []


class FakeSdkSession:
    """The SDK session's shape: receive() ends after each turn_complete; send calls are recorded."""

    def __init__(self, turns: list[list[gtypes.LiveServerMessage]], fail: bool = False) -> None:
        self.turns = turns
        self.fail = fail
        self.sent: list[tuple[str, Any]] = []

    async def receive(self) -> AsyncIterator[gtypes.LiveServerMessage]:
        if self.fail:
            msg = "socket closed"
            raise ConnectionError(msg)
        for message in self.turns.pop(0) if self.turns else []:
            yield message

    async def send_realtime_input(self, *, audio: gtypes.Blob) -> None:
        self.sent.append(("audio", audio))

    async def send_client_content(self, *, turns: gtypes.Content, turn_complete: bool) -> None:
        self.sent.append(("content", (turns, turn_complete)))


def _done() -> gtypes.LiveServerMessage:
    return gtypes.LiveServerMessage(server_content=gtypes.LiveServerContent(turn_complete=True))


def test_the_connection_sends_pcm_and_system_role_updates_and_reads_turns_until_the_session_ends() -> None:
    sdk = FakeSdkSession([[_done()], [_done()]])
    conn = vertex.LiveSessionConnection(sdk)

    async def go() -> list[object]:
        await conn.send_audio(b"\x00\x00")
        await conn.update_instruction("CASE LEDGER UPDATE")
        seen: list[object] = []

        async def drain() -> None:
            async for event in conn.events():
                seen.append(event)

        with pytest.raises(LiveClosedError):
            await drain()
        return seen

    seen = run(go())
    assert seen == [LiveTurnComplete(), LiveTurnComplete()]
    kind, blob = sdk.sent[0]
    assert kind == "audio"
    assert blob.mime_type == "audio/pcm;rate=16000"
    content, complete = sdk.sent[1][1]
    assert content.role == "system"
    assert complete is False


def test_a_receive_failure_is_a_closed_live_session() -> None:
    conn = vertex.LiveSessionConnection(FakeSdkSession([], fail=True))

    async def go() -> None:
        async for _ in conn.events():
            pass

    with pytest.raises(LiveClosedError):
        run(go())
