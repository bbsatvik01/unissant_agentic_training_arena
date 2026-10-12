"""Spoken lines for the room (stage 5): one line of text in one prebuilt Gemini voice, synthesized once and cached on
disk by (model, voice, text), so a line is paid for once and a recorded run replays for free (D-021).

A synthesis that is not cached goes through the spend guard exactly like a model call: reserve on the request's
measured bytes (call kind ``tts``, purpose ``tts``, bucket ``global``), mark dispatched, send once (no retries: a
failed line falls back to the browser's own voice), record the attempt's usage (prompt tokens as input, audio
tokens as audio output) and settle: ``committed`` when the usage is known, ``usage_unknown`` when the send may have
been billed without a readable usage (the whole hold stays charged), ``released`` when nothing was sent. The kill
switch is read inside the reservation and again at dispatch.

``ARENA_MODEL_MODE=fake`` synthesizes silence of the line's reading length without a reservation or a network
call, so tests and local runs spend nothing.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import os
import tempfile
import time
import wave
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import UUID, uuid4

from arena_core.db.calls import ModelCallRequest, UsageReport, UsageStatus
from arena_core.providers.errors import ProviderCallError
from arena_core.providers.types import Usage
from arena_core.spend.guard import GuardSession, SpendGuard

#: The model (S5 3.2 extension, stage 5): Gemini 2.5 Flash TTS, GA on Vertex AI, served by the pinned SDK.
TTS_MODEL = "gemini-2.5-flash-tts"
#: The call kind and purpose label its reservations carry (an ``ops.call_limits`` row must name the kind).
TTS_CALL_KIND = "tts"
TTS_PURPOSE = "tts"
BUDGET_BUCKET = "global"
#: The longest line the room voices: a subject answer's maxLength (events.schema.json SubjectAnswer).
MAX_LINE_CHARS = 900
#: Vertex returns 16-bit mono PCM at 24 kHz for this model.
SAMPLE_RATE = 24_000
#: Fake mode reads at the room's cadence (web/src/lib/world/cadence.ts CHARS_PER_SECOND), at a low sample rate.
FAKE_CHARS_PER_SECOND = 15
FAKE_SAMPLE_RATE = 8_000
#: One send's limit; a line that takes longer falls back to the browser's voice.
SEND_TIMEOUT_S = 60.0

#: The 30 prebuilt voices (Vertex AI "Generate speech with Gemini TTS", checked 2026-10-11): the only names a line
#: may ask for.
PREBUILT_VOICES = frozenset(
    {
        "Achernar",
        "Achird",
        "Algenib",
        "Algieba",
        "Alnilam",
        "Aoede",
        "Autonoe",
        "Callirrhoe",
        "Charon",
        "Despina",
        "Enceladus",
        "Erinome",
        "Fenrir",
        "Gacrux",
        "Iapetus",
        "Kore",
        "Laomedeia",
        "Leda",
        "Orus",
        "Puck",
        "Pulcherrima",
        "Rasalgethi",
        "Sadachbia",
        "Sadaltager",
        "Schedar",
        "Sulafat",
        "Umbriel",
        "Vindemiatrix",
        "Zephyr",
        "Zubenelgenubi",
    }
)


class LineRefusedError(ValueError):
    """The line cannot be synthesized as asked: an unknown voice, or empty or overlong text."""


@dataclass(frozen=True)
class SpeechUsage:
    input_tokens: int
    audio_output_tokens: int


@dataclass(frozen=True)
class SpeechAudio:
    """One synthesized line: 16-bit mono PCM and its rate, and the billed usage when the response reported it."""

    pcm: bytes
    sample_rate: int
    usage: SpeechUsage | None


class FakeSpeech:
    """Silence of the line's reading length: zero spend, no network (ARENA_MODEL_MODE=fake)."""

    async def synthesize(self, text: str, voice: str) -> SpeechAudio:
        del voice
        seconds = max(0.5, len(text) / FAKE_CHARS_PER_SECOND)
        return SpeechAudio(pcm=bytes(int(seconds * FAKE_SAMPLE_RATE) * 2), sample_rate=FAKE_SAMPLE_RATE, usage=None)

    def request_bytes(self, text: str, voice: str) -> int:
        return len(f"{voice}{text}".encode())


class SpeechSender(Protocol):
    """The Vertex speech client's shape (``arena_core.providers.vertex.VertexSpeech``)."""

    async def synthesize(self, text: str, voice: str) -> tuple[bytes, int, Usage | None]: ...


class SpeechSynth(Protocol):
    async def synthesize(self, text: str, voice: str) -> SpeechAudio: ...

    def request_bytes(self, text: str, voice: str) -> int:
        """The byte length of the request a line sends: what its reservation is measured on."""
        ...


class VertexSynth:
    """The Vertex client as a ``SpeechSynth``: its usage as prompt tokens in and audio tokens out, its request measured
    as the body the SDK transmits."""

    def __init__(self, sender: SpeechSender, measure: Callable[[str, str], int]) -> None:
        self._sender = sender
        self._measure = measure

    def request_bytes(self, text: str, voice: str) -> int:
        return self._measure(text, voice)

    async def synthesize(self, text: str, voice: str) -> SpeechAudio:
        pcm, rate, usage = await self._sender.synthesize(text, voice)
        billed = None if usage is None else SpeechUsage(usage.input_tokens, usage.output_tokens)
        return SpeechAudio(pcm=pcm, sample_rate=rate, usage=billed)


def wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    """16-bit mono PCM as a WAV file."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return out.getvalue()


def check_line(text: str, voice: str) -> str:
    """The text to speak, trimmed; refuses an unknown voice and empty or overlong text."""
    if voice not in PREBUILT_VOICES:
        msg = "unknown voice"
        raise LineRefusedError(msg)
    line = text.strip()
    if not line or len(line) > MAX_LINE_CHARS:
        msg = f"a line is 1 to {MAX_LINE_CHARS} characters"
        raise LineRefusedError(msg)
    return line


def line_key(model: str, voice: str, text: str) -> str:
    """The cache key and the reservation's identity: sha256 of model, voice and text."""
    return hashlib.sha256(f"{model}\n{voice}\n{text}".encode()).hexdigest()


class TtsService:
    """Cached synthesis with the spend guard around every paid call (``guard`` is None only in fake mode)."""

    def __init__(
        self, synth: SpeechSynth, guard: SpendGuard | None, cache_dir: Path, *, model: str = TTS_MODEL
    ) -> None:
        self._synth = synth
        self._guard = guard
        self._cache = cache_dir / model
        self._model = model
        # One synthesis per line at a time in this process: a second request for the same line waits for the first
        # and then reads the cache instead of paying again.
        self._locks: dict[str, asyncio.Lock] = {}

    @property
    def silent(self) -> bool:
        """Fake mode: the audio is silence, so the browser should speak the line with its own voice."""
        return isinstance(self._synth, FakeSpeech)

    def _path(self, key: str) -> Path:
        return self._cache / f"{key}.wav"

    def cached(self, text: str, voice: str) -> bytes | None:
        """The line's audio when it was synthesized before (free), else None."""
        path = self._path(line_key(self._model, voice, check_line(text, voice)))
        return path.read_bytes() if path.is_file() else None

    def _store(self, key: str, audio: bytes) -> None:
        self._cache.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self._cache, suffix=".part")
        with os.fdopen(fd, "wb") as f:
            f.write(audio)
        Path(tmp).replace(self._path(key))

    async def speak(self, text: str, voice: str, actor: UUID | None) -> bytes:
        """The line's WAV audio: from the cache, or synthesized once (through the guard unless in fake mode). Fake
        silence is never cached, so a later run against Vertex never serves it."""
        line = check_line(text, voice)
        key = line_key(self._model, voice, line)
        path = self._path(key)
        if path.is_file():
            return path.read_bytes()
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            if path.is_file():
                return path.read_bytes()
            if self._guard is None:
                audio = await self._synth.synthesize(line, voice)
                return wav_bytes(audio.pcm, audio.sample_rate)
            audio = await self._paid(self._guard, line, voice, key, actor)
            out = wav_bytes(audio.pcm, audio.sample_rate)
            self._store(key, out)
            return out

    async def _paid(self, guard: SpendGuard, line: str, voice: str, key: str, actor: UUID | None) -> SpeechAudio:
        # Each paid attempt is its own reservation: a line whose attempt failed can be tried again later.
        request = ModelCallRequest(
            key=f"tts:{key[:40]}:{uuid4().hex[:16]}",
            bucket=BUDGET_BUCKET,
            model=self._model,
            call_kind=TTS_CALL_KIND,
            purpose=TTS_PURPOSE,
            trial_id=None,
            actor_user_id=actor,
            input_bytes=self._synth.request_bytes(line, voice),
        )
        async with guard.session() as session:
            reservation = await session.reserve(request)
            try:
                await session.dispatch(reservation.id)
            except BaseException:
                # Refused at dispatch (the kill switch turned on) or interrupted: nothing was sent, the hold is
                # released (S5 3.2), and the refusal goes on to the caller.
                await session.settle(reservation.id, "released")
                raise
            started = time.monotonic()
            try:
                async with asyncio.timeout(SEND_TIMEOUT_S):
                    audio = await self._synth.synthesize(line, voice)
            except TimeoutError:
                # The request left and may have been billed: no usage is readable, the hold stays charged.
                await self._record(session, reservation.id, None, "timeout", started)
                await session.settle(reservation.id, "usage_unknown")
                raise
            except ProviderCallError as exc:
                usage = None if exc.usage is None else SpeechUsage(exc.usage.input_tokens, exc.usage.output_tokens)
                await self._record(session, reservation.id, usage, "error", started)
                await session.settle(
                    reservation.id, "usage_unknown" if usage is None and exc.maybe_billed else "committed"
                )
                raise
            await self._record(session, reservation.id, audio.usage, "ok", started)
            await session.settle(reservation.id, "committed" if audio.usage is not None else "usage_unknown")
            return audio

    async def _record(
        self,
        session: GuardSession,
        reservation_id: UUID,
        usage: SpeechUsage | None,
        status: UsageStatus,
        started: float,
    ) -> None:
        """The attempt's ``ops.model_calls`` row: prompt tokens as input, audio tokens as audio output."""
        await session.record(
            UsageReport(
                reservation_id=reservation_id,
                seq=1,
                model=self._model,
                input_tokens=usage.input_tokens if usage is not None else 0,
                output_tokens=0,
                thinking_tokens=0,
                audio_output_tokens=usage.audio_output_tokens if usage is not None else 0,
                status=status,
                latency_ms=int((time.monotonic() - started) * 1000),
                trace_id=None,
                span_id=None,
            )
        )
