"""Spoken lines (stage 5, `arena_core.voice.tts`): the allowlisted voice and line limits, the cache by (model, voice,
text), fake mode without a reservation, and the spend guard around every paid synthesis: reserve, dispatch, one
send, its usage receipt and the settlement the port's own rule gives."""

from __future__ import annotations

import asyncio
import io
import wave
from collections.abc import AsyncIterator, Coroutine
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

from arena_core.db.calls import ModelCallRequest, UsageReport, UsageResult
from arena_core.providers.errors import ErrorKind, KillSwitchOnError, ProviderCallError
from arena_core.providers.types import Usage
from arena_core.spend.guard import Reservation
from arena_core.voice import tts

ACTOR = uuid4()
RESERVATION = UUID(int=1)
MEASURED = 250
MEASURED_AB = 204
KEY_MIN, KEY_MAX = 8, 200  # S4 idempotency keys
TWO_ATTEMPTS = 2
PREBUILT_COUNT = 30
SHA256_HEX = 64
VERTEX_RATE = 24_000


def run[T](coro: Coroutine[Any, Any, T]) -> T:
    return asyncio.run(coro)


class Session:
    def __init__(self, log: list[Any], refuse: BaseException | None, refuse_dispatch: BaseException | None) -> None:
        self.log = log
        self.refuse = refuse
        self.refuse_dispatch = refuse_dispatch

    async def reserve(self, req: ModelCallRequest) -> Reservation:
        self.log.append(("reserve", req))
        if self.refuse is not None:
            raise self.refuse
        return Reservation(
            id=UUID(int=1), reserved_usd=Decimal("0.08"), existed=False, state="reserved", dispatched=False
        )

    async def dispatch(self, reservation_id: UUID) -> None:
        self.log.append(("dispatch", reservation_id))
        if self.refuse_dispatch is not None:
            raise self.refuse_dispatch

    async def record(self, report: UsageReport) -> UsageResult:
        self.log.append(("record", report))
        return UsageResult(
            outcome="recorded", cost_usd=Decimal(0), spend_usd=Decimal(0), reserved_usd=Decimal(0), shutoff=False
        )

    async def settle(self, reservation_id: UUID, outcome: str) -> Decimal:
        assert reservation_id == RESERVATION
        self.log.append(("settle", outcome))
        return Decimal(0)


class Guard:
    def __init__(self, refuse: BaseException | None = None, refuse_dispatch: BaseException | None = None) -> None:
        self.log: list[Any] = []
        self.refuse = refuse
        self.refuse_dispatch = refuse_dispatch

    @asynccontextmanager
    async def _open(self) -> AsyncIterator[Session]:
        yield Session(self.log, self.refuse, self.refuse_dispatch)

    def session(self) -> AbstractAsyncContextManager[Session]:
        return self._open()


class Synth:
    def __init__(self, *outcomes: tts.SpeechAudio | BaseException) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, str]] = []

    async def synthesize(self, text: str, voice: str) -> tts.SpeechAudio:
        self.calls.append((text, voice))
        outcome = self.outcomes[min(len(self.calls), len(self.outcomes)) - 1]
        await asyncio.sleep(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def request_bytes(self, text: str, voice: str) -> int:
        return MEASURED + len(text) + len(voice)


AUDIO = tts.SpeechAudio(
    pcm=b"\x01\x00" * 2400, sample_rate=VERTEX_RATE, usage=tts.SpeechUsage(input_tokens=12, audio_output_tokens=25)
)


def kinds(log: list[Any]) -> list[str]:
    return [entry[0] for entry in log]


def test_only_prebuilt_voices_and_lines_of_one_to_900_characters() -> None:
    assert tts.check_line("  Hello.  ", "Kore") == "Hello."
    assert len(tts.PREBUILT_VOICES) == PREBUILT_COUNT
    for text, voice in (("Hi", "Bad"), ("", "Kore"), ("   ", "Kore"), ("x" * 901, "Kore")):
        with pytest.raises(tts.LineRefusedError):
            tts.check_line(text, voice)
    assert tts.check_line("x" * 900, "Kore") == "x" * 900


def test_the_cache_key_names_model_voice_and_text() -> None:
    key = tts.line_key("m", "Kore", "Hello.")
    assert len(key) == SHA256_HEX
    assert key != tts.line_key("m", "Puck", "Hello.")
    assert key != tts.line_key("m2", "Kore", "Hello.")
    assert key != tts.line_key("m", "Kore", "Hello")


def test_wav_bytes_wrap_mono_16_bit_pcm() -> None:
    data = tts.wav_bytes(b"\x00\x00" * 100, VERTEX_RATE)
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, VERTEX_RATE, 100)


def test_fake_mode_is_silence_of_the_reading_length_without_a_reservation_and_never_cached(tmp_path: Path) -> None:
    service = tts.TtsService(tts.FakeSpeech(), None, tmp_path)
    assert service.silent
    audio = run(service.speak("a" * 30, "Kore", ACTOR))
    with wave.open(io.BytesIO(audio)) as w:
        assert w.getnframes() / w.getframerate() == pytest.approx(2.0)
        assert set(w.readframes(w.getnframes())) == {0}
    short = run(service.speak("Hi.", "Kore", ACTOR))
    with wave.open(io.BytesIO(short)) as w:
        assert w.getnframes() / w.getframerate() == pytest.approx(0.5)
    assert not list(tmp_path.rglob("*.wav"))
    # So the same cache under Vertex later synthesizes the line for real, never serving the silence.
    guard, synth = Guard(), Synth(AUDIO)
    real = tts.TtsService(synth, guard, tmp_path)
    assert not real.silent
    run(real.speak("Hi.", "Kore", ACTOR))
    assert synth.calls == [("Hi.", "Kore")]


def test_a_new_line_is_reserved_dispatched_sent_once_recorded_and_settled_committed(tmp_path: Path) -> None:
    guard, synth = Guard(), Synth(AUDIO)
    service = tts.TtsService(synth, guard, tmp_path)
    audio = run(service.speak("Where were you at two?", "Kore", ACTOR))
    assert kinds(guard.log) == ["reserve", "dispatch", "record", "settle"]
    req = guard.log[0][1]
    assert (req.model, req.call_kind, req.purpose, req.bucket, req.actor_user_id) == (
        tts.TTS_MODEL,
        "tts",
        "tts",
        "global",
        ACTOR,
    )
    # Measured on the whole request the synth sends, not the bare text.
    assert req.input_bytes == MEASURED + len("Where were you at two?") + len("Kore")
    assert req.key.startswith("tts:")
    assert KEY_MIN <= len(req.key) <= KEY_MAX
    report = guard.log[2][1]
    assert (report.input_tokens, report.output_tokens, report.audio_output_tokens, report.status, report.seq) == (
        12,
        0,
        25,
        "ok",
        1,
    )
    assert guard.log[3] == ("settle", "committed")
    assert synth.calls == [("Where were you at two?", "Kore")]
    with wave.open(io.BytesIO(audio)) as w:
        assert w.getframerate() == VERTEX_RATE
    # The same line again is free: from the cache, no reservation, no send.
    assert run(service.speak("Where were you at two?", "Kore", ACTOR)) == audio
    assert kinds(guard.log) == ["reserve", "dispatch", "record", "settle"]
    assert len(synth.calls) == 1
    assert service.cached("Where were you at two?", "Kore") == audio
    assert service.cached("Something else.", "Kore") is None


def test_a_reply_without_usage_settles_usage_unknown(tmp_path: Path) -> None:
    guard = Guard()
    service = tts.TtsService(
        Synth(tts.SpeechAudio(pcm=b"\x00\x00", sample_rate=VERTEX_RATE, usage=None)), guard, tmp_path
    )
    run(service.speak("Hello.", "Kore", ACTOR))
    assert guard.log[2][1].status == "ok"
    assert guard.log[-1] == ("settle", "usage_unknown")


@pytest.mark.parametrize(
    ("error", "settled"),
    [
        (ProviderCallError(ErrorKind.TRANSIENT, "timeout", maybe_billed=True), "usage_unknown"),
        (ProviderCallError(ErrorKind.BAD_REQUEST, "HTTP 400", status=400), "committed"),
        (
            ProviderCallError(
                ErrorKind.EMPTY, "no audio", usage=Usage(input_tokens=3, output_tokens=0), maybe_billed=True
            ),
            "committed",
        ),
    ],
)
def test_a_failed_send_is_recorded_settled_by_the_port_rule_and_not_cached(
    tmp_path: Path, error: ProviderCallError, settled: str
) -> None:
    guard = Guard()
    service = tts.TtsService(Synth(error), guard, tmp_path)
    with pytest.raises(ProviderCallError):
        run(service.speak("Hello.", "Kore", ACTOR))
    assert kinds(guard.log) == ["reserve", "dispatch", "record", "settle"]
    assert guard.log[2][1].status == "error"
    assert guard.log[-1] == ("settle", settled)
    assert service.cached("Hello.", "Kore") is None


def test_a_send_past_its_time_settles_usage_unknown(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    class Slow(Synth):
        async def synthesize(self, text: str, voice: str) -> tts.SpeechAudio:
            del text, voice
            await asyncio.sleep(1)
            return AUDIO

    monkeypatch.setattr(tts, "SEND_TIMEOUT_S", 0.01)
    guard = Guard()
    service = tts.TtsService(Slow(AUDIO), guard, tmp_path)
    with pytest.raises(TimeoutError):
        run(service.speak("Hello.", "Kore", ACTOR))
    assert guard.log[2][1].status == "timeout"
    assert guard.log[-1] == ("settle", "usage_unknown")


def test_a_refused_reservation_sends_nothing(tmp_path: Path) -> None:
    guard, synth = Guard(refuse=KillSwitchOnError("kill switch")), Synth(AUDIO)
    service = tts.TtsService(synth, guard, tmp_path)
    with pytest.raises(KillSwitchOnError):
        run(service.speak("Hello.", "Kore", ACTOR))
    assert kinds(guard.log) == ["reserve"]
    assert synth.calls == []


def test_the_vertex_client_is_wrapped_with_its_usage_as_audio_out() -> None:
    class Sender:
        async def synthesize(self, text: str, voice: str) -> tuple[bytes, int, Usage | None]:
            del text, voice
            return b"\x00\x00", VERTEX_RATE, Usage(input_tokens=5, output_tokens=40)

    audio = run(tts.VertexSynth(Sender(), lambda text, voice: len(text) + len(voice)).synthesize("Hi.", "Kore"))
    assert audio.usage == tts.SpeechUsage(input_tokens=5, audio_output_tokens=40)
    assert audio.sample_rate == VERTEX_RATE


def test_a_failed_line_can_be_tried_again_with_a_new_reservation(tmp_path: Path) -> None:
    guard = Guard()
    synth = Synth(ProviderCallError(ErrorKind.TRANSIENT, "HTTP 429", status=429), AUDIO)
    service = tts.TtsService(synth, guard, tmp_path)
    with pytest.raises(ProviderCallError):
        run(service.speak("Hello.", "Kore", ACTOR))
    run(service.speak("Hello.", "Kore", ACTOR))
    keys = [entry[1].key for entry in guard.log if entry[0] == "reserve"]
    assert len(keys) == len(set(keys)) == TWO_ATTEMPTS
    assert service.cached("Hello.", "Kore") is not None


def test_one_line_asked_for_twice_at_once_is_paid_for_once(tmp_path: Path) -> None:
    guard, synth = Guard(), Synth(AUDIO)
    service = tts.TtsService(synth, guard, tmp_path)

    async def both() -> tuple[bytes, bytes]:
        a, b = await asyncio.gather(service.speak("Hello.", "Kore", ACTOR), service.speak("Hello.", "Kore", ACTOR))
        return a, b

    a, b = run(both())
    assert a == b
    assert len(synth.calls) == 1
    assert kinds(guard.log).count("reserve") == 1


def test_the_vertex_measure_is_used_for_the_reservation() -> None:
    class Sender:
        async def synthesize(self, text: str, voice: str) -> tuple[bytes, int, Usage | None]:
            del text, voice
            return b"", VERTEX_RATE, None

    synth = tts.VertexSynth(Sender(), lambda text, voice: len(text) * 100 + len(voice))
    assert synth.request_bytes("ab", "Kore") == MEASURED_AB


def test_a_refusal_at_dispatch_releases_the_hold_and_sends_nothing(tmp_path: Path) -> None:
    guard, synth = Guard(refuse_dispatch=KillSwitchOnError("kill switch")), Synth(AUDIO)
    service = tts.TtsService(synth, guard, tmp_path)
    with pytest.raises(KillSwitchOnError):
        run(service.speak("Hello.", "Kore", ACTOR))
    assert kinds(guard.log) == ["reserve", "dispatch", "settle"]
    assert guard.log[-1] == ("settle", "released")
    assert synth.calls == []
