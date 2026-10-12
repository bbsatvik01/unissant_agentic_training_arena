"""The Live meter (S5 4.7): reports recorded as receipts, and the closing estimate for what no report covered."""

from __future__ import annotations

import asyncio
from decimal import Decimal
from uuid import uuid4

import pytest

from arena_core.db.calls import UsageReport, UsageResult
from arena_core.voice.live import LiveUsage
from arena_subject.live_meter import LiveMeter, audio_tokens

ONE_S_IN, ONE_S_OUT = 32_000, 48_000
PER_S = 25


class Recorder:
    def __init__(self, fail: bool = False) -> None:
        self.reports: list[UsageReport] = []
        self.fail = fail

    async def __call__(self, report: UsageReport) -> UsageResult:
        if self.fail:
            msg = "write failed"
            raise ConnectionError(msg)
        self.reports.append(report)
        return UsageResult("recorded", Decimal(0), Decimal(0), Decimal(3), shutoff=False)


def test_audio_tokens_are_25_a_second() -> None:
    assert audio_tokens(ONE_S_IN, 16_000) == PER_S
    assert audio_tokens(ONE_S_OUT // 2, 24_000) == (PER_S + 1) // 2


def test_a_cut_off_turn_is_estimated_with_its_context_kept_by_modality() -> None:
    rec = Recorder()
    meter = LiveMeter(rec, uuid4(), "gemini-3.8-live")

    async def go() -> None:
        await meter.record(LiveUsage(text_in=100, audio_in=1500, text_out=20, audio_out=80, thinking=0))
        meter.audio_in(ONE_S_IN)
        meter.audio_out(ONE_S_OUT)
        assert meter.awaiting_report
        await meter.close_out()

    asyncio.run(go())
    est = rec.reports[-1]
    assert (est.input_tokens, est.audio_input_tokens, est.audio_output_tokens) == (120, 1580 + 25, 25)
    assert meter.outcome() == "committed"


def test_input_only_is_estimated_without_context_and_a_failed_estimate_is_usage_unknown() -> None:
    rec = Recorder()
    meter = LiveMeter(rec, uuid4(), "gemini-3.8-live")
    meter.audio_in(ONE_S_IN)
    assert not meter.awaiting_report
    asyncio.run(meter.close_out())
    assert [(r.input_tokens, r.audio_input_tokens) for r in rec.reports] == [(0, 25)]

    failing = LiveMeter(Recorder(fail=True), uuid4(), "gemini-3.8-live")
    failing.audio_in(ONE_S_IN)
    with pytest.raises(ConnectionError):
        asyncio.run(failing.close_out())
    assert failing.outcome() == "usage_unknown"
    assert LiveMeter(rec, uuid4(), "m").outcome() == "committed"


def test_a_report_whose_write_fails_leaves_its_bytes_for_the_estimate() -> None:
    rec = Recorder(fail=True)
    meter = LiveMeter(rec, uuid4(), "gemini-3.8-live")
    meter.audio_in(ONE_S_IN)
    with pytest.raises(ConnectionError):
        asyncio.run(meter.record(LiveUsage(text_in=1, audio_in=25, text_out=0, audio_out=0, thinking=0)))
    assert meter.outcome() == "usage_unknown"
