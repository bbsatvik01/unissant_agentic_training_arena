"""Designing the catalogue's voices (stage 8): each persona without a stored voice is designed once behind the spend
guard (reserve, dispatch, one send, its usage, settle), kept at once, and a failure never stops the next persona."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from arena_core.db.calls import ModelCallRequest, UsageReport, UsageResult
from arena_core.providers.errors import ErrorKind, KillSwitchOnError, ProviderCallError
from arena_core.providers.types import Usage
from arena_core.spend.guard import Reservation
from arena_core.voice.catalogue import parse
from arena_core.voice.design import Tools, design_missing, write_voice_id

ENTRY = {"prebuilt": "Kore", "gender": "female", "language_code": "en-US", "description": "A clerk.", "style": "brief"}
MEASURED = 300
IN_TOKENS, OUT_TOKENS = 220, 1100


class Session:
    def __init__(self, log: list[Any], refuse_dispatch: BaseException | None) -> None:
        self.log = log
        self.refuse_dispatch = refuse_dispatch

    async def reserve(self, req: ModelCallRequest) -> Reservation:
        self.log.append(("reserve", req))
        return Reservation(
            id=UUID(int=1), reserved_usd=Decimal("0.1"), existed=False, state="reserved", dispatched=False
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
        del reservation_id
        self.log.append(("settle", outcome))
        return Decimal(0)


class Guard:
    def __init__(self, refuse_dispatch: BaseException | None = None) -> None:
        self.log: list[Any] = []
        self.refuse_dispatch = refuse_dispatch

    @asynccontextmanager
    async def _open(self) -> AsyncIterator[Session]:
        yield Session(self.log, self.refuse_dispatch)

    def session(self) -> AbstractAsyncContextManager[Session]:
        return self._open()


@dataclass(frozen=True)
class Out:
    voice_id: str
    sample: bytes
    usage: Usage | None


class Designer:
    def __init__(self, *outcomes: Out | BaseException) -> None:
        self.outcomes = list(outcomes)
        self.calls: list[tuple[str, str, str, str]] = []

    async def design(self, description: str, display_name: str, gender: str, language_code: str) -> Out:
        self.calls.append((description, display_name, gender, language_code))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def measure(description: str, name: str, gender: str, language: str) -> int:
    del name, gender, language
    return MEASURED + len(description)


def ignore(key: str, out: object) -> None:
    del key, out


def kinds(log: list[Any]) -> list[str]:
    return [e[0] for e in log]


def test_each_undesigned_persona_is_designed_once_behind_the_guard_and_kept() -> None:
    personas = parse({"personas": {"subject:A": ENTRY, "subject:B": {**ENTRY, "voice_id": "voice_done"}}})
    guard = Guard()
    designer = Designer(Out("voice_new", b"RIFF", Usage(input_tokens=IN_TOKENS, output_tokens=OUT_TOKENS)))
    kept: list[tuple[str, str]] = []
    outcomes = asyncio.run(
        design_missing(personas, Tools(designer, guard, measure), on_designed=lambda k, o: kept.append((k, o.voice_id)))
    )
    assert kept == [("subject:A", "voice_new")]
    assert [o.voice_id for o in outcomes] == ["voice_new"]
    assert designer.calls == [("A clerk.", "arena subject:A", "female", "en-US")]
    assert kinds(guard.log) == ["reserve", "dispatch", "record", "settle"]
    req = guard.log[0][1]
    assert (req.call_kind, req.purpose, req.bucket, req.input_bytes) == (
        "voice_design",
        "voice_design",
        "global",
        MEASURED + 8,
    )
    report = guard.log[2][1]
    assert (report.input_tokens, report.audio_output_tokens, report.status) == (IN_TOKENS, OUT_TOKENS, "ok")
    assert guard.log[3] == ("settle", "committed")


def test_a_failed_design_is_settled_by_the_port_rule_reported_and_the_next_goes_on() -> None:
    personas = parse({"personas": {"subject:A": ENTRY, "subject:B": ENTRY}})
    guard = Guard()
    designer = Designer(ProviderCallError(ErrorKind.TRANSIENT, "timeout", maybe_billed=True), Out("voice_b", b"", None))
    outcomes = asyncio.run(design_missing(personas, Tools(designer, guard, measure), on_designed=ignore))
    assert [(o.key, o.voice_id, o.error is not None) for o in outcomes] == [
        ("subject:A", None, True),
        ("subject:B", "voice_b", False),
    ]
    settles = [e[1] for e in guard.log if e[0] == "settle"]
    assert settles == ["usage_unknown", "usage_unknown"]  # billed without a usage; a reply without usage


def test_only_named_personas_and_a_refusal_at_dispatch_releases_the_hold() -> None:
    personas = parse({"personas": {"subject:A": ENTRY, "subject:B": ENTRY}})
    guard = Guard(refuse_dispatch=KillSwitchOnError("kill switch"))
    with pytest.raises(KillSwitchOnError):
        asyncio.run(
            design_missing(
                personas,
                Tools(Designer(), guard, measure),
                on_designed=ignore,
                only=frozenset({"subject:B"}),
            )
        )
    assert kinds(guard.log) == ["reserve", "dispatch", "settle"]
    assert guard.log[-1] == ("settle", "released")
    assert guard.log[0][1].key.startswith("voice_design:subject:B:")


def test_a_new_voice_id_is_written_into_the_catalogue_file_alone(tmp_path: Path) -> None:
    path = tmp_path / "personas.json"
    path.write_text(
        json.dumps({"_note": "x", "personas": {"subject:A": {**ENTRY, "voice_id": None}}}), encoding="utf-8"
    )
    write_voice_id(path, "subject:A", "voice_new")
    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["_note"] == "x"
    assert doc["personas"]["subject:A"]["voice_id"] == "voice_new"
    assert parse(doc)["subject:A"].voice_id == "voice_new"
