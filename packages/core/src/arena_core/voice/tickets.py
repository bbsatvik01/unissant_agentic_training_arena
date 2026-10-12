"""Voice ticket shape (S5 7.2): what `training.redeem_access_ticket(token, 'voice')` binds a ticket to, and the
subprotocol the browser carries it in (never the URL; G4)."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from arena_core.voice.protocol import Start

#: `training.issue_access_ticket` returns 32 random bytes as hex: exactly this shape, which is also a valid
#: WebSocket subprotocol token (RFC 6455).
TICKET_PATTERN = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class VoiceBinding:
    ticket_id: UUID
    user_id: UUID
    trial_id: UUID
    mode: str
    split: str

    def start(self) -> Start:
        return Start(self.ticket_id, self.user_id, self.trial_id, self.mode)


def binding_from(raw: Mapping[str, Any]) -> VoiceBinding:
    return VoiceBinding(
        ticket_id=UUID(str(raw["ticket_id"])),
        user_id=UUID(str(raw["user_id"])),
        trial_id=UUID(str(raw["trial_id"])),
        mode=str(raw["mode"]),
        split=str(raw["split"]),
    )


def ticket_from_subprotocols(header: str | None) -> str | None:
    """The ticket the browser offered as its only subprotocol, or None."""
    if header is None:
        return None
    offered = [p.strip() for p in header.split(",") if p.strip()]
    if len(offered) != 1 or not TICKET_PATTERN.fullmatch(offered[0]):
        return None
    return offered[0]
