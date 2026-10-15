"""Per-call-type limits, allowlists and the attempt rule (S5 3.3, 3.4; S2 2), parity-tested against cost_model.py.

The byte and token limits equal `docs/research/synthesis/cost_model.py` `LIMITS` for the seven runtime call types and
S4's `ops.call_limits` seeds; `portrait` (absent from `LIMITS`) holds S5 3.3's initial values. `ATTEMPTS` equals
`cost_model.ATTEMPTS`. A parity test compares them with the script's own output (S5 4.9). The database stays the
authority for every amount: the port sends sizes, never dollars.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

# cost_model.py line 34: first try + one schema repair + two transient retries. The port never sends a fifth request.
ATTEMPTS = 4
# S2 2: the most a repair re-prompt may grow the serialized request; a reservation prices B + REPAIR_BYTES.
REPAIR_BYTES = 5_200
# S2 10 (TechnoMile a2a.py REPAIRS = 1).
MAX_REPAIRS = 1


class CallType(StrEnum):
    SUBJECT = "subject"
    CARD = "card"
    DEEP = "deep"
    FINAL = "final"
    REFEREE = "referee"
    PORTRAIT = "portrait"
    TTS = "tts"
    VOICE_DESIGN = "voice_design"
    NPC = "npc"


class VertexModel(StrEnum):
    """Every model id the port knows (S5 3.3, 4.2); `gemini-3.8-flash` is priced for reference and in no allowlist."""

    FLASH_LITE_31 = "gemini-3.1-flash-lite"
    FLASH_LITE_35 = "gemini-3.5-flash-lite"
    FLASH_38 = "gemini-3.8-flash"


class ThinkingLevel(StrEnum):
    MINIMAL = "minimal"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass(frozen=True)
class CallLimits:
    input_bytes: int  # UTF-8 bytes of the largest request, the repair allowance included (D11)
    output_tokens: int  # max_output_tokens, thinking included
    timeout_ceiling_s: float  # per-attempt timeout ceiling; a requested timeout above it is refused (C-31)
    models: frozenset[VertexModel]  # allowlist


_LITES = frozenset({VertexModel.FLASH_LITE_31, VertexModel.FLASH_LITE_35})

LIMITS: dict[CallType, CallLimits] = {
    CallType.SUBJECT: CallLimits(80_000, 1_600, 15.0, _LITES),
    CallType.CARD: CallLimits(128_000, 1_600, 6.0, _LITES),
    CallType.DEEP: CallLimits(128_000, 3_000, 15.0, frozenset({VertexModel.FLASH_LITE_35})),
    CallType.FINAL: CallLimits(128_000, 3_000, 20.0, _LITES),
    CallType.REFEREE: CallLimits(160_000, 4_000, 60.0, _LITES),
    # Initial values, tuned in the dev pilot (S5 3.3). The image model is named by the day-1 lookup (UI direction
    # 1.2); until it joins VertexModel, this allowlist and ops.model_prices, no portrait call passes policy.
    CallType.PORTRAIT: CallLimits(2_000, 2_000, 60.0, frozenset()),
    # One spoken line (stage 8, arena_core.voice.tts): the speech service reserves on the guard itself and never goes
    # through the text port, so no text model is allowed here. Input: a 900-character line (MAX_LINE_CHARS) and its
    # 120-character style, every character of which may cost a 12-byte surrogate-pair escape, plus the request's
    # JSON; output: 80 s of audio at 25 tokens a second (cost_model.LIMITS['tts']).
    CallType.TTS: CallLimits(14_000, 2_000, 60.0, frozenset()),
    # One designed voice (stage 8, scripts/design_voices.py), reserved on the guard by the script itself: a
    # 400-character description at up to 12 escaped bytes each plus the request JSON; output: the model's hard
    # output-token limit (16,384), since CreateVoice takes no output cap (the sample is about 1,100 tokens).
    CallType.VOICE_DESIGN: CallLimits(6_000, 16_384, 60.0, frozenset()),
    # A colleague NPC's reply on the Gemini fallback (UI v2, D-035; the free endpoints spend nothing): the persona
    # prompt plus at most 12 history lines and the message, each at most 400 characters at up to 12 escaped bytes
    # a character, and the repair allowance; output: a short spoken reply at MINIMAL thinking
    # (cost_model.LIMITS['npc']).
    CallType.NPC: CallLimits(72_000, 1_000, 15.0, frozenset({VertexModel.FLASH_LITE_35})),
}


@dataclass(frozen=True)
class CallTiming:
    attempt_timeout_s: float  # per attempt
    deadline_s: float  # all attempts of one call, repair, retries and backoff included


# S2 2: the effective per-attempt timeouts and call deadlines when a call (or its candidate manifest) sets none;
# each is at or below S5 3.3's ceiling. The four referee purposes share 30 s / 90 s. Portrait has no S2 row: its
# initial value is the S5 ceiling with a two-attempt deadline, tuned with the image model in the dev pilot.
DEFAULT_TIMING: dict[CallType, CallTiming] = {
    CallType.SUBJECT: CallTiming(8.0, 20.0),
    CallType.CARD: CallTiming(6.0, 12.0),
    CallType.DEEP: CallTiming(10.0, 20.0),
    CallType.FINAL: CallTiming(15.0, 30.0),
    CallType.REFEREE: CallTiming(30.0, 90.0),
    CallType.PORTRAIT: CallTiming(60.0, 120.0),
    CallType.TTS: CallTiming(60.0, 60.0),
    CallType.VOICE_DESIGN: CallTiming(60.0, 60.0),
    CallType.NPC: CallTiming(10.0, 20.0),
}

# S5 3.3 / S2 1, 2: thinking is MINIMAL on every call type except the referee. The referee's rows pair model and
# thinking (S5 3.3: gemini-3.1-flash-lite with LOW, gemini-3.5-flash-lite with MINIMAL) and S2 2 gives each referee
# purpose its level (R1 and r3_subject LOW; R2 and r3_investigator MINIMAL), so each purpose has one combination.
THINKING: dict[CallType, frozenset[ThinkingLevel]] = {t: frozenset({ThinkingLevel.MINIMAL}) for t in CallType}
REFEREE_COMBINATIONS: dict[str, tuple[VertexModel, ThinkingLevel]] = {
    # MINIMAL, not S2's LOW: at LOW the R1 report overran its output tokens on long transcripts (manifests.py).
    "referee_subject": (VertexModel.FLASH_LITE_31, ThinkingLevel.MINIMAL),
    "r3_subject": (VertexModel.FLASH_LITE_31, ThinkingLevel.MINIMAL),
    "referee_assistant": (VertexModel.FLASH_LITE_35, ThinkingLevel.MINIMAL),
    "r3_investigator": (VertexModel.FLASH_LITE_35, ThinkingLevel.MINIMAL),
}

# S5 3.3 / S2 2: the fixed purpose labels per call type. S4 accepts exactly the four referee labels on `referee`.
REFEREE_PURPOSES: frozenset[str] = frozenset({"referee_subject", "referee_assistant", "r3_subject", "r3_investigator"})
PURPOSES: dict[CallType, frozenset[str]] = {
    CallType.SUBJECT: frozenset({"subject.answer", "experiment.fidelity"}),
    CallType.CARD: frozenset({"coach.card", "experiment.latency"}),
    CallType.DEEP: frozenset({"coach.deep", "experiment.latency"}),
    CallType.FINAL: frozenset({"coach.final", "experiment.latency"}),
    CallType.REFEREE: REFEREE_PURPOSES,
    CallType.PORTRAIT: frozenset({"portrait.image"}),
    CallType.TTS: frozenset({"tts"}),
    CallType.VOICE_DESIGN: frozenset({"voice_design"}),
    CallType.NPC: frozenset({"npc.chat"}),
}
