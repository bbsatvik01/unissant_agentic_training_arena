"""Relay frames, size limits and close codes shared by arena-api and arena-subject (S5 7.3, 7.5; gokbase G3).

Browser to arena-api: binary PCM16 16 kHz audio (at most 3,200 bytes a frame, at most 15 frames a second averaged
over 2 s) and the text frames `stop` and `interrupt`. arena-api adds `start` (first frame) and `context_changed`
on the internal leg; a browser sending either, or anything else, is a protocol violation (4400). Every text frame is
at most 512 bytes and matches one closed shape. There is no frame for prompts, tool calls, configuration, provider
handles, playback progress or resumption.

arena-subject to arena-api to browser: binary PCM16 24 kHz audio (at most 9,600 bytes a frame) and the text frames
in `SUBJECT_FRAME_TYPES`; arena-api drops anything outside that allowlist (defence in depth).
"""

from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

MAX_TEXT_FRAME_BYTES = 512
MAX_AUDIO_IN_BYTES = 3_200  # 100 ms of PCM16 at 16 kHz
MAX_AUDIO_OUT_BYTES = 9_600  # 200 ms of PCM16 at 24 kHz
AUDIO_RATE_WINDOW_S = 2.0
AUDIO_RATE_MAX_FRAMES = 30  # 15 frames a second averaged over 2 s
INPUT_SAMPLE_RATE = 16_000
OUTPUT_SAMPLE_RATE = 24_000

MAX_CAPTION_CHARS = 500
MAX_LINE_CHARS = 900
EXCHANGE_CAP = 12
AUDIO_CAP_S = 480
IDLE_S = 90
WARNING_BEFORE_S = 60
HELD_AUDIO_MAX_BYTES = 5 * INPUT_SAMPLE_RATE * 2  # 5 s of investigator audio held across an exchange store

# S5 7.5 close codes. Every close is terminal; there is no `ended` frame.
NORMAL = 1000
PROTOCOL = 4400
REFUSED = 4401
ORIGIN = 4403
NOT_FOUND = 4404
IDLE = 4408
SUBJECT_GUARD = 4409
EXCHANGE_CAP_REACHED = 4410
COST = 4413
KILL = 4423
TRANSPORT = 1006
SERVER_ERROR = 1011

SUBJECT_FRAME_TYPES = frozenset(
    {
        "utterance_start",
        "utterance_end",
        "transcription",
        "interrupted",
        "exchange",
        "exchange_count",
        "timer_tick",
        "warning",
    }
)

Role = Literal["investigator", "subject"]


class ProtocolViolationError(ValueError):
    """A frame outside S5 7.3: the session closes 4400."""


@dataclass(frozen=True)
class Start:
    ticket_id: UUID
    user_id: UUID
    trial_id: UUID
    mode: str


@dataclass(frozen=True)
class Control:
    kind: Literal["stop", "interrupt", "context_changed"]


def _decode(raw: str) -> dict[str, Any]:
    if len(raw.encode()) > MAX_TEXT_FRAME_BYTES:
        msg = "text frame over 512 bytes"
        raise ProtocolViolationError(msg)
    try:
        value = json.loads(raw)
    except ValueError as exc:
        msg = "text frame is not JSON"
        raise ProtocolViolationError(msg) from exc
    if not isinstance(value, dict):
        msg = "text frame is not an object"
        raise ProtocolViolationError(msg)
    return value


def parse_browser_text(raw: str) -> Control:
    """A browser's text frame: `stop` or `interrupt`, nothing else (`start`, `context_changed`, `played`: 4400)."""
    frame = _decode(raw)
    kind = frame.get("type")
    if frame.keys() != {"type"} or kind not in ("stop", "interrupt"):
        msg = "unknown browser frame"
        raise ProtocolViolationError(msg)
    return Control("stop" if kind == "stop" else "interrupt")


def check_browser_audio(data: bytes) -> None:
    """A browser audio frame: whole PCM16 samples, 1 to 3,200 bytes."""
    if not data or len(data) > MAX_AUDIO_IN_BYTES or len(data) % 2:
        msg = "audio frame size"
        raise ProtocolViolationError(msg)


def start_frame(start: Start) -> str:
    return json.dumps(
        {
            "type": "start",
            "ticket_id": str(start.ticket_id),
            "user_id": str(start.user_id),
            "trial_id": str(start.trial_id),
            "mode": start.mode,
        }
    )


def parse_start(raw: str) -> Start:
    frame = _decode(raw)
    if frame.keys() != {"type", "ticket_id", "user_id", "trial_id", "mode"} or frame["type"] != "start":
        msg = "the first relay frame is start"
        raise ProtocolViolationError(msg)
    try:
        return Start(UUID(frame["ticket_id"]), UUID(frame["user_id"]), UUID(frame["trial_id"]), str(frame["mode"]))
    except (TypeError, ValueError, AttributeError) as exc:
        msg = "start frame fields"
        raise ProtocolViolationError(msg) from exc


def parse_relay_text(raw: str) -> Control:
    """arena-subject's view of a relayed text frame after `start`: `stop`, `interrupt` or `context_changed`."""
    frame = _decode(raw)
    kind = frame.get("type")
    if frame.keys() != {"type"} or kind not in ("stop", "interrupt", "context_changed"):
        msg = "unknown relay frame"
        raise ProtocolViolationError(msg)
    return Control(kind)


CONTEXT_CHANGED = json.dumps({"type": "context_changed"})


def subject_frame_allowed(raw: str) -> bool:
    """arena-api's allowlist for text frames from arena-subject (defence in depth, G9's default branch)."""
    try:
        value = json.loads(raw)
    except ValueError:  # silent-ok: an unparseable frame is dropped, which is the allowlist's whole answer
        return False
    return isinstance(value, dict) and value.get("type") in SUBJECT_FRAME_TYPES


class AudioRate:
    """At most `AUDIO_RATE_MAX_FRAMES` audio frames in any `AUDIO_RATE_WINDOW_S` window."""

    def __init__(self) -> None:
        self._at: deque[float] = deque()

    def admit(self, now: float) -> None:
        while self._at and now - self._at[0] > AUDIO_RATE_WINDOW_S:
            self._at.popleft()
        if len(self._at) >= AUDIO_RATE_MAX_FRAMES:
            msg = "audio frame rate"
            raise ProtocolViolationError(msg)
        self._at.append(now)


def cut_words(text: str, limit: int) -> str:
    """`text` with its whitespace collapsed, cut at a word boundary to at most `limit` characters."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    head = text[: limit + 1]
    space = head.rfind(" ")
    return (head[:space] if space > 0 else text[:limit]).rstrip()


def frame(kind: str, **fields: object) -> str:
    return json.dumps({"type": kind, **fields}, ensure_ascii=False)


def close_code_text(code: int, guard_rule: str | None = None) -> str:
    """The voice session's stored close code: `guard:<rule>` for a guard hit (S2 9.4), else the number."""
    if code == SUBJECT_GUARD and guard_rule is not None:
        return f"guard:{guard_rule}"
    return str(code)
