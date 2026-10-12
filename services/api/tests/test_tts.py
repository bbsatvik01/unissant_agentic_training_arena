"""`POST /api/tts` (stage 5) in process: a line comes back as WAV audio from the cache-backed service, an unknown
voice or an overlong line is 422, an unavailable synthesis is 503 (the browser speaks it instead), the route needs the
CSRF header like every POST, and the service is built once from the environment (fake mode spends nothing)."""

from __future__ import annotations

import io
import wave
from http import HTTPStatus
from pathlib import Path
from typing import Any

import pytest
from starlette.requests import Request

from arena_api.routes import tts as route
from arena_core.providers.errors import KillSwitchOnError
from arena_core.voice import tts
from services.api.tests.test_app import Harness


class Refusing:
    async def synthesize(self, text: str, voice: str) -> tts.SpeechAudio:
        del text, voice
        msg = "kill switch"
        raise KillSwitchOnError(msg)

    def request_bytes(self, text: str, voice: str) -> int:
        return len(text) + len(voice)


def harness(tmp_path: Path, synth: tts.SpeechSynth | None = None) -> Harness:
    h = Harness()
    h.app.state.tts = tts.TtsService(synth or tts.FakeSpeech(), None, tmp_path)
    return h


def test_a_line_comes_back_as_wav_audio_flagged_as_silence_in_fake_mode(tmp_path: Path) -> None:
    h = harness(tmp_path)
    r = h.post("/api/tts", {"voice": "Kore", "text": "Where were you at two?"})
    assert r.status_code == HTTPStatus.OK, r.text
    assert r.headers["content-type"] == "audio/wav"
    assert "immutable" in r.headers["cache-control"]
    assert r.headers["x-arena-speech"] == "silent"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getnchannels() == 1
    # Fake silence is never cached.
    assert not list(tmp_path.rglob("*.wav"))


@pytest.mark.parametrize(
    "body",
    [
        {"voice": "Robot", "text": "Hi."},
        {"voice": "Kore", "text": "x" * 901},
        {"voice": "Kore", "text": ""},
        {"voice": "Kore", "text": "Hi.", "style": "angry"},
    ],
)
def test_an_unknown_voice_a_bad_line_or_an_extra_field_is_422(tmp_path: Path, body: dict[str, Any]) -> None:
    assert harness(tmp_path).post("/api/tts", body).status_code == HTTPStatus.UNPROCESSABLE_ENTITY


def test_an_unavailable_synthesis_is_503(tmp_path: Path) -> None:
    r = harness(tmp_path, Refusing()).post("/api/tts", {"voice": "Kore", "text": "Hello."})
    assert r.status_code == HTTPStatus.SERVICE_UNAVAILABLE
    assert r.json() == {"detail": "speech unavailable"}


def test_the_route_needs_the_csrf_header(tmp_path: Path) -> None:
    r = harness(tmp_path).post("/api/tts", {"voice": "Kore", "text": "Hello."}, raw=True)
    assert r.status_code == HTTPStatus.FORBIDDEN


def test_fake_mode_builds_a_silent_service_without_a_guard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARENA_MODEL_MODE", "fake")
    monkeypatch.setenv("ARENA_TTS_CACHE", str(tmp_path))
    h = Harness()
    r = h.post("/api/tts", {"voice": "Puck", "text": "Hello."})
    assert r.status_code == HTTPStatus.OK
    built = h.app.state.tts
    assert isinstance(built, tts.TtsService)
    assert built.silent
    assert not list(tmp_path.rglob("*.wav"))


def test_vertex_mode_builds_the_paid_service_behind_the_guard(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARENA_MODEL_MODE", "vertex")
    monkeypatch.setenv("ARENA_TTS_CACHE", str(tmp_path))
    seen: list[str] = []

    class Sender:
        async def synthesize(self, text: str, voice: str) -> tuple[bytes, int, None]:
            del text, voice
            return b"", 24_000, None

    def fake_speech(env: object, model: str) -> Sender:
        del env
        seen.append(model)
        return Sender()

    monkeypatch.setattr(route, "vertex_speech", fake_speech)
    h = Harness()
    service = route.service(Request({"type": "http", "app": h.app}))
    assert isinstance(service, tts.TtsService)
    assert not service.silent
    assert seen == [tts.TTS_MODEL]
    assert route.service(Request({"type": "http", "app": h.app})) is service
