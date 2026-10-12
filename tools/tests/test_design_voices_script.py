"""`python -m scripts.design_voices` (stage 8): the dry run prints the plan and calls nothing; fake mode refuses (a
design is a real, paid call); a real run designs each missing voice through the guard, keeps its id in the catalogue
file at once and saves a playable audition sample."""

from __future__ import annotations

import io
import json
import wave
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

import pytest

from arena_core.providers.types import Usage
from arena_core.voice import catalogue
from arena_core.voice.design import Outcome
from scripts import design_voices

REFUSED = 2
ENTRY = {"prebuilt": "Kore", "gender": "female", "language_code": "en-US", "description": "A clerk.", "style": "brief"}


UNDESIGNED = {"personas": {"subject:A": {**ENTRY, "voice_id": None}, "coach:flags": {**ENTRY, "voice_id": None}}}


@pytest.fixture
def undesigned(monkeypatch: pytest.MonkeyPatch) -> None:
    """A catalogue with voices still to design (the shipped one has every voice designed)."""
    monkeypatch.setattr(design_voices, "load", lambda: catalogue.parse(UNDESIGNED))


@pytest.mark.usefixtures("undesigned")
def test_the_dry_run_prints_each_persona_to_design_and_calls_nothing(capsys: pytest.CaptureFixture[str]) -> None:
    assert design_voices.main(["--dry-run"], env={}) == 0
    out = capsys.readouterr().out
    assert "subject:A" in out
    assert "2 to design (dry run)" in out


def test_the_shipped_catalogue_has_nothing_left_to_design(capsys: pytest.CaptureFixture[str]) -> None:
    assert design_voices.main(["--dry-run"], env={}) == 0
    assert "0 to design" in capsys.readouterr().out


def test_only_named_personas_and_nothing_to_do(capsys: pytest.CaptureFixture[str]) -> None:
    assert design_voices.main(["--only", "nobody"], env={}) == 0
    assert "0 to design" in capsys.readouterr().out


@pytest.mark.usefixtures("undesigned")
def test_fake_mode_refuses_a_paid_design(capsys: pytest.CaptureFixture[str]) -> None:
    assert design_voices.main(["--only", "coach:flags"], env={"ARENA_MODEL_MODE": "fake"}) == REFUSED
    assert "real, paid call" in capsys.readouterr().err


def test_an_audition_sample_is_written_as_a_playable_wav() -> None:
    assert design_voices.sample_wav(b"RIFFxxxx", "audio/wav") == b"RIFFxxxx"
    pcm = b"\x01\x00" * 100
    with wave.open(io.BytesIO(design_voices.sample_wav(pcm, "audio/l16; rate=16000"))) as w:
        assert (w.getframerate(), w.readframes(w.getnframes())) == (16_000, pcm)
    with wave.open(io.BytesIO(design_voices.sample_wav(pcm, ""))) as w:
        assert w.getframerate() == design_voices.PCM_RATE


@dataclass(frozen=True)
class Out:
    voice_id: str
    sample: bytes
    sample_mime: str
    usage: Usage | None


def test_a_real_run_keeps_each_new_voice_in_the_catalogue_and_its_sample(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = tmp_path / "personas.json"
    path.write_text(json.dumps({"personas": {"subject:A": {**ENTRY, "voice_id": None}}}), encoding="utf-8")
    monkeypatch.setattr(design_voices, "CATALOGUE_PATH", path)
    monkeypatch.setattr(design_voices, "load", lambda: catalogue.parse(json.loads(path.read_text(encoding="utf-8"))))
    monkeypatch.setattr(design_voices, "SAMPLES", tmp_path / "samples")
    monkeypatch.setattr(design_voices, "boot", lambda _role, _env: type("S", (), {"dsn": "postgresql://x"})())
    monkeypatch.setattr(design_voices, "vertex_voice_designer", lambda _env: object())
    monkeypatch.setattr(design_voices, "dsn_connector", lambda _dsn: object())
    monkeypatch.setattr(design_voices, "DbSpendGuard", lambda _connect: object())

    async def fake_design_missing(
        personas: Mapping[str, object],
        tools: object,
        *,
        on_designed: Callable[[str, Out], None],
        only: frozenset[str] | None,
    ) -> list[Outcome]:
        del tools, only
        out = Out("voice_new", b"\x01\x00" * 10, "audio/l16; rate=24000", None)
        for key in personas:
            on_designed(key, out)
        return []

    monkeypatch.setattr(design_voices, "design_missing", fake_design_missing)
    assert design_voices.main([], env={"ARENA_MODEL_MODE": "vertex"}) == 0
    assert json.loads(path.read_text(encoding="utf-8"))["personas"]["subject:A"]["voice_id"] == "voice_new"
    assert (tmp_path / "samples" / "subject_A.wav").read_bytes()[:4] == b"RIFF"
    assert "subject:A -> voice_new" in capsys.readouterr().out


def test_a_failed_design_exits_one(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "personas.json"
    path.write_text(json.dumps({"personas": {"subject:A": {**ENTRY, "voice_id": None}}}), encoding="utf-8")
    monkeypatch.setattr(design_voices, "load", lambda: catalogue.parse(json.loads(path.read_text(encoding="utf-8"))))
    monkeypatch.setattr(design_voices, "boot", lambda _role, _env: type("S", (), {"dsn": "postgresql://x"})())
    monkeypatch.setattr(design_voices, "vertex_voice_designer", lambda _env: object())
    monkeypatch.setattr(design_voices, "dsn_connector", lambda _dsn: object())
    monkeypatch.setattr(design_voices, "DbSpendGuard", lambda _connect: object())

    async def failing(
        personas: Mapping[str, object], tools: object, *, on_designed: object, only: frozenset[str] | None
    ) -> list[Outcome]:
        del personas, tools, on_designed, only
        return [Outcome("subject:A", None, "transient: timeout")]

    monkeypatch.setattr(design_voices, "design_missing", failing)
    assert design_voices.main([], env={"ARENA_MODEL_MODE": "vertex"}) == 1
