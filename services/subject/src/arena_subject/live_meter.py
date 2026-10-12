"""Per-modality Live usage meter (S5 4.7; lift target: gokbase G2): every Live usage report becomes one
`ops.model_calls` receipt on the session's reservation (`ops.record_usage`, numbered from 1), and the database
answers whether the session has reached its shutoff (two thirds of the hold, or the kill switch).

Live reports usage once per model turn, so what the session sent or received after the last report (the investigator
audio Live listened to, an answer cut off by the close) has no report of its own. Live bills listening input and
any output it produced. At the close the meter records that remainder as one estimated receipt from the bytes
themselves (25 audio tokens a second, Live's audio rate) plus, when output was produced, the context its turn
re-read (the last report's prompt count), so the settlement stays a measured `committed` rather than charging
the whole hold."""

from __future__ import annotations

import math
import time
from collections.abc import Awaitable, Callable
from uuid import UUID

from arena_core.db.calls import SettleOutcome, UsageReport, UsageResult
from arena_core.voice.live import LiveUsage
from arena_core.voice.protocol import INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE

Recorder = Callable[[UsageReport], Awaitable[UsageResult]]
AUDIO_TOKENS_PER_S = 25


def audio_tokens(pcm_bytes: int, sample_rate: int) -> int:
    return math.ceil(pcm_bytes / 2 / sample_rate * AUDIO_TOKENS_PER_S)


class LiveMeter:
    def __init__(self, record: Recorder, reservation_id: UUID, model: str) -> None:
        self._record = record
        self._reservation = reservation_id
        self._model = model
        self._seq = 0
        self._started = time.monotonic()
        self._in_bytes = 0
        self._out_bytes = 0
        self._speech = False
        self._context_text = 0
        self._context_audio = 0
        self._failed = False
        self.spend_usd = 0.0

    def audio_in(self, pcm_bytes: int) -> None:
        self._in_bytes += pcm_bytes

    def audio_out(self, pcm_bytes: int) -> None:
        self._out_bytes += pcm_bytes

    def speech_seen(self) -> None:
        self._speech = True

    @property
    def awaiting_report(self) -> bool:
        """A model turn is under way (speech transcribed or output produced) whose report has not arrived."""
        return self._speech or self._out_bytes > 0

    async def _send(self, report: UsageReport) -> bool:
        result = await self._record(report)
        self.spend_usd = float(result.spend_usd)
        return result.shutoff

    def _report(self, text_in: int, audio_in: int, text_out: int, audio_out: int, thinking: int) -> UsageReport:
        self._seq += 1
        return UsageReport(
            reservation_id=self._reservation,
            seq=self._seq,
            model=self._model,
            input_tokens=text_in,
            output_tokens=text_out,
            thinking_tokens=thinking,
            audio_input_tokens=audio_in,
            audio_output_tokens=audio_out,
            status="usage",
            latency_ms=int((time.monotonic() - self._started) * 1000),
            trace_id=None,
            span_id=None,
        )

    async def record(self, usage: LiveUsage) -> bool:
        """Record one Live report; True when the session must stop (shutoff or overrun)."""
        report = self._report(usage.text_in, usage.audio_in, usage.text_out, usage.audio_out, usage.thinking)
        shutoff = await self._send(report)
        # Cleared only once the receipt is written: a close during the write still estimates what it covered.
        self._in_bytes = self._out_bytes = 0
        self._speech = False
        self._context_text = usage.text_in + usage.text_out
        self._context_audio = usage.audio_in + usage.audio_out
        return shutoff

    async def close_out(self) -> None:
        """At the close: one estimated receipt for what no report covered (see the module note)."""
        if self._in_bytes == 0 and self._out_bytes == 0 and not self._speech:
            return
        produced = self._out_bytes > 0
        report = self._report(
            text_in=self._context_text if produced else 0,
            audio_in=audio_tokens(self._in_bytes, INPUT_SAMPLE_RATE) + (self._context_audio if produced else 0),
            text_out=0,
            audio_out=audio_tokens(self._out_bytes, OUTPUT_SAMPLE_RATE),
            thinking=0,
        )
        try:
            await self._send(report)
        except Exception:
            self._failed = True
            raise
        self._in_bytes = self._out_bytes = 0
        self._speech = False

    def outcome(self) -> SettleOutcome:
        """`committed` once every byte is on a receipt; `usage_unknown` (the whole hold stays charged) otherwise."""
        return "usage_unknown" if self._failed or self._in_bytes or self._out_bytes or self._speech else "committed"
