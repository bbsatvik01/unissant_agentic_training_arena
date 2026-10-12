"""The Live connection as arena-subject's session sees it (S5 7.4): provider-neutral events and the port a backend
implements. `arena_core.providers.vertex_live` is the Vertex backend; `FakeLive` here is the scripted backend for
tests and `ARENA_MODEL_MODE=fake` (E2E-4), which spends nothing and calls no network.
"""

from __future__ import annotations

import asyncio
import math
import struct
from collections.abc import AsyncIterator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Protocol

from arena_core.voice.protocol import INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, Role

#: The model the probe connected on Vertex in cna-guardian (2026-10-12): `gemini-3.8-live` (us-central1), audio out
#: with both transcriptions and a mid-session system-instruction update accepted. Fallback per S2 9.2.
LIVE_MODEL = "gemini-3.8-live"
LIVE_FALLBACK_MODEL = "gemini-live-2.5-flash-native-audio"
LIVE_LOCATION = "us-central1"


@dataclass(frozen=True)
class LiveAudio:
    data: bytes


@dataclass(frozen=True)
class LiveTranscript:
    role: Role
    text: str
    finished: bool


@dataclass(frozen=True)
class LiveInterrupted:
    pass


@dataclass(frozen=True)
class LiveTurnComplete:
    pass


@dataclass(frozen=True)
class LiveUsage:
    """One usage report (Live reports per model turn; the prompt count includes the session's context so far, so
    reports add up to what was billed)."""

    text_in: int
    audio_in: int
    text_out: int
    audio_out: int
    thinking: int


LiveEvent = LiveAudio | LiveTranscript | LiveInterrupted | LiveTurnComplete | LiveUsage


class LiveClosedError(Exception):
    """The Live connection ended underneath the session (provider close, network)."""


class LiveConnection(Protocol):
    async def send_audio(self, pcm: bytes) -> None: ...

    async def update_instruction(self, text: str) -> None: ...

    def events(self) -> AsyncIterator[LiveEvent]: ...


class LiveBackend(Protocol):
    model: str

    def connect(self, setup: Mapping[str, Any]) -> AbstractAsyncContextManager[LiveConnection]: ...


# ------------------------------------------------------------------------------------------------ fake backend


#: A fake-mode sample above this amplitude counts as speech.
LOUD = 500


def tone(seconds: float, rate: int = OUTPUT_SAMPLE_RATE, hz: float = 180.0) -> bytes:
    """A soft voiced tone with a syllable envelope: audible, so the fake room shows a moving mouth."""
    n = int(seconds * rate)
    out = bytearray()
    for i in range(n):
        t = i / rate
        envelope = 0.5 - 0.5 * math.cos(2 * math.pi * 4 * t)
        out += struct.pack("<h", int(3000 * envelope * math.sin(2 * math.pi * hz * t)))
    return bytes(out)


@dataclass
class FakeLiveConnection:
    """Answers each spoken question: after `question_s` of investigator audio followed by `silence_s` of quiet (or a
    scripted `push`), it emits the question's transcription, a spoken answer (tone audio with its transcription)
    and `turn_complete`, then a usage report. Tests can also `push` any event sequence."""

    answer_text: str = "I was at my desk most of that afternoon."
    question_s: float = 0.3
    silence_s: float = 0.7
    answer_s: float = 1.0
    instructions: list[str] = field(default_factory=list)
    audio_in: list[bytes] = field(default_factory=list)
    _queue: asyncio.Queue[LiveEvent | None] = field(default_factory=asyncio.Queue)
    _voiced: float = 0.0
    _quiet: float = 0.0
    _questions: int = 0
    auto: bool = True

    async def send_audio(self, pcm: bytes) -> None:
        self.audio_in.append(pcm)
        if not self.auto:
            return
        seconds = len(pcm) / 2 / INPUT_SAMPLE_RATE
        loud = any(abs(s) > LOUD for (s,) in struct.iter_unpack("<h", pcm[: len(pcm) - len(pcm) % 2]))
        if loud:
            self._voiced += seconds
            self._quiet = 0.0
            return
        self._quiet += seconds
        if self._voiced >= self.question_s and self._quiet >= self.silence_s:
            self._voiced = self._quiet = 0.0
            self._questions += 1
            self.answer(f"Question {self._questions}.")

    def answer(self, question: str) -> None:
        self.push(LiveTranscript("investigator", question, finished=True))
        audio = tone(self.answer_s)
        step = len(audio) // 4 - (len(audio) // 4) % 2
        for i in range(0, len(audio), step):
            self.push(LiveAudio(audio[i : i + step]))
        self.push(LiveTranscript("subject", self.answer_text, finished=True))
        self.push(LiveTurnComplete())
        self.push(LiveUsage(text_in=200, audio_in=0, text_out=20, audio_out=25 * int(self.answer_s), thinking=0))

    async def update_instruction(self, text: str) -> None:
        self.instructions.append(text)

    def push(self, event: LiveEvent | None) -> None:
        self._queue.put_nowait(event)

    async def events(self) -> AsyncIterator[LiveEvent]:
        while True:
            event = await self._queue.get()
            if event is None:
                raise LiveClosedError
            yield event


@dataclass
class FakeLive:
    """`LiveBackend` with a fresh (or given) `FakeLiveConnection` per session; records each setup."""

    model: str = LIVE_MODEL
    setups: list[Mapping[str, Any]] = field(default_factory=list)
    connections: list[FakeLiveConnection] = field(default_factory=list)
    next_connection: FakeLiveConnection | None = None

    def connect(self, setup: Mapping[str, Any]) -> AbstractAsyncContextManager[LiveConnection]:
        @asynccontextmanager
        async def _open() -> AsyncIterator[LiveConnection]:
            self.setups.append(setup)
            conn = self.next_connection or FakeLiveConnection()
            self.next_connection = None
            self.connections.append(conn)
            yield conn

        return _open()
