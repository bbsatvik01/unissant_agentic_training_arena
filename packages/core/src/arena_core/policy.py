"""Per-call-type policy, checked before any reservation (S5 3.2 step 1, 3.3).

Adapted from TechnoMile `bh_core/providers/policy.py` (T1; ATTRIBUTIONS.md): the endpoint-kind rules become "model in
the call type's allowlist" (every route is Vertex, D-001) and the data classes become `public`, `subject_private` and
`evaluator`, each bound to the call types that may carry it. The API-key refusal of the same lift lives in
`arena_core.config` (boot checks, S5 1.3).
"""

from __future__ import annotations

from typing import Any

from arena_core.providers.errors import PolicyRefusedError
from arena_core.providers.types import AgentCall, DataClass, Message
from arena_core.spend.limits import LIMITS, PURPOSES, REFEREE_COMBINATIONS, THINKING, CallLimits, CallType

MESSAGE_ROLES = frozenset({"user", "model"})
# A subject call carries the private packet; referee calls carry evaluator data; everything else is public.
DATA_CLASSES: dict[CallType, frozenset[DataClass]] = {
    CallType.SUBJECT: frozenset({"subject_private"}),
    CallType.CARD: frozenset({"public"}),
    CallType.DEEP: frozenset({"public"}),
    CallType.FINAL: frozenset({"public"}),
    CallType.REFEREE: frozenset({"evaluator"}),
    CallType.PORTRAIT: frozenset({"public"}),
}


def check_call_policy(call: AgentCall[Any], roster_manifest_shas: frozenset[str] | None) -> CallLimits:
    """Return the call type's limits, or raise PolicyRefusedError naming the rule."""
    ctx = call.context
    limits = LIMITS[ctx.call_type]
    if call.model not in limits.models:
        msg = f"model {call.model.value} is not allowed for call type {ctx.call_type.value}"
        raise PolicyRefusedError(msg)
    if ctx.purpose not in PURPOSES[ctx.call_type]:
        msg = f"purpose {ctx.purpose!r} is not a {ctx.call_type.value} purpose"
        raise PolicyRefusedError(msg)
    if ctx.call_type is CallType.REFEREE:
        if (call.model, call.thinking) != REFEREE_COMBINATIONS[ctx.purpose]:
            model, thinking = REFEREE_COMBINATIONS[ctx.purpose]
            msg = f"referee purpose {ctx.purpose} runs on {model.value} with thinking {thinking.value}"
            raise PolicyRefusedError(msg)
    elif call.thinking not in THINKING[ctx.call_type]:
        msg = f"thinking level {call.thinking.value} is not allowed for call type {ctx.call_type.value}"
        raise PolicyRefusedError(msg)
    if ctx.data_class not in DATA_CLASSES[ctx.call_type]:
        msg = f"data class {ctx.data_class} is not allowed on a {ctx.call_type.value} call"
        raise PolicyRefusedError(msg)
    if call.timeout_s is not None and not 0 < call.timeout_s <= limits.timeout_ceiling_s:
        msg = f"timeout {call.timeout_s}s is outside (0, {limits.timeout_ceiling_s}s] for {ctx.call_type.value}"
        raise PolicyRefusedError(msg)
    if call.deadline_s is not None and call.deadline_s <= 0:
        msg = "deadline must be positive"
        raise PolicyRefusedError(msg)
    if ctx.candidate_manifest_sha is not None and (
        roster_manifest_shas is None or ctx.candidate_manifest_sha not in roster_manifest_shas
    ):
        msg = "candidate manifest is not in the frozen roster"
        raise PolicyRefusedError(msg)
    if not call.messages:
        msg = "a call needs at least one message"
        raise PolicyRefusedError(msg)
    if not _text_only(call):
        msg = "messages must be text Message parts with role user or model, and the system instruction text"
        raise PolicyRefusedError(msg)
    return limits


def _text_only(call: AgentCall[Any]) -> bool:
    """S5 3.5: text only. Annotations are not enforced at runtime, so the boundary is checked before any
    reservation: anything but a Message with a known role and string text, or a non-string system, is refused."""
    system: object = call.system
    if not isinstance(system, str):
        return False
    parts: tuple[object, ...] = call.messages
    for part in parts:
        if not isinstance(part, Message):
            return False
        role: object = part.role
        text: object = part.text
        if role not in MESSAGE_ROLES or not isinstance(text, str):
            return False
    return True
