"""Per-modality Live usage meter (S5 4.7; lift target: gokbase G2): every Live usage report becomes one
`ops.model_calls` receipt on the session's reservation (`ops.record_usage`, numbered from 1), and the database
answers whether the session has reached its shutoff (two thirds of the hold, or the kill switch)."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from uuid import UUID

from arena_core.db.calls import SettleOutcome, UsageReport, UsageResult
from arena_core.voice.live import LiveUsage

Recorder = Callable[[UsageReport], Awaitable[UsageResult]]


class LiveMeter:
    def __init__(self, record: Recorder, reservation_id: UUID, model: str) -> None:
        self._record = record
        self._reservation = reservation_id
        self._model = model
        self._seq = 0
        self._started = time.monotonic()
        #: Model output arrived after the last usage report: the session may have been billed for it unread.
        self.unmetered = False
        self.spend_usd = 0.0

    def output_seen(self) -> None:
        self.unmetered = True

    async def record(self, usage: LiveUsage) -> bool:
        """Record one report; True when the session must stop (shutoff or overrun)."""
        self._seq += 1
        result = await self._record(
            UsageReport(
                reservation_id=self._reservation,
                seq=self._seq,
                model=self._model,
                input_tokens=usage.text_in,
                output_tokens=usage.text_out,
                thinking_tokens=usage.thinking,
                audio_input_tokens=usage.audio_in,
                audio_output_tokens=usage.audio_out,
                status="usage",
                latency_ms=int((time.monotonic() - self._started) * 1000),
                trace_id=None,
                span_id=None,
            )
        )
        self.unmetered = False
        self.spend_usd = float(result.spend_usd)
        return result.shutoff

    def outcome(self) -> SettleOutcome:
        """`committed` when every output was metered; `usage_unknown` (the whole hold stays charged) otherwise."""
        return "usage_unknown" if self.unmetered else "committed"
