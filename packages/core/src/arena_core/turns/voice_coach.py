"""The coach card of a practice voice exchange (UI v2 amendment to D7: voice is coached like text).

After each completed voice exchange, the same coach step a text turn runs (`orchestrator.coach_call` over
`coach.coach_inputs`, stored by `coach.store_card`) reads the session's stored exchanges as turns
(`voice.transcript.voice_turns`), the records released so far and this connection's earlier cards, and produces one
card for the latest turn. The card goes back to the browser on the voice socket (`events.projections`'s
`voice_coach_card_text`), so the earpiece can speak it; it is not stored as a trial event (a voice session writes
no turns, work items or coaching events, S5 7.7), and its `work_item` field carries a deterministic id naming the
exchange, since none exists. Assessment sessions get no live card (S5 6.1, coaching is withheld until the end).

The call goes through the agent port and the spend guard with the investigator as actor, like every coach call.
A failed or refused card is no card: the voice session goes on (a KPI-4 sample exists only for text turns).
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from arena_core.agents.manifests import CandidateManifest
from arena_core.contracts.coaching import CoachingCard, StoredCard
from arena_core.db.arena import ArenaDb, ArenaError
from arena_core.events.projections import voice_coach_card_text
from arena_core.providers.errors import ProviderError
from arena_core.providers.port import AgentPort
from arena_core.providers.types import CallContext
from arena_core.spend.limits import CallType
from arena_core.turns.coach import CardMeta, coach_inputs, store_card
from arena_core.turns.orchestrator import coach_call, request_key
from arena_core.voice.transcript import voice_turns

log = logging.getLogger("arena_core.turns.voice")
#: Fixed namespace for the voice card's stand-in work item id (uuid5 of the trial and exchange).
VOICE_CARD_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "voice-card.arena.unissant.internal")


@dataclass
class VoiceCoach:
    """One voice connection's coach: it keeps that connection's cards as the candidate's earlier output."""

    db: ArenaDb
    port: AgentPort
    trial: UUID
    clock: Callable[[], float] = time.monotonic
    cards: list[StoredCard] = field(default_factory=list)

    async def card_after(self, exchange_no: int) -> str | None:
        """The voice socket's `coach.card` text frame for exchange `exchange_no`, or None when no card is due (not
        a practice session, no turn in that window) or the call failed."""
        try:
            card = await self._card(exchange_no)
        except (ProviderError, ArenaError) as exc:
            log.warning("voice card for exchange %s failed: %s", exchange_no, type(exc).__name__)
            return None
        if card is None:
            return None
        self.cards.append(card)
        return voice_coach_card_text(card, exchange_no)

    async def _card(self, exchange_no: int) -> StoredCard | None:
        meta = await self.db.trial(self.trial)
        if meta is None or meta["mode"] != "practice" or not meta["voice"]:
            return None
        turns = voice_turns(await self.db.voice_exchanges(self.trial))
        turn = next((t for t in turns if t["exchange_no"] == exchange_no), None)
        if turn is None:
            return None
        found = await self.db.manifest(meta["assistant_candidate_id"])
        packet = await self.db.public_packet(meta["variant_id"])
        if found is None or packet is None:
            log.warning("voice card: the trial's coach manifest or public packet is not readable")
            return None
        manifest = CandidateManifest.model_validate(found["manifest"])
        n = int(turn["turn_no"])
        inputs = coach_inputs(self._context(packet, turns, await self.db.released(self.trial)), "card", n)
        ctx = CallContext(
            call_type=CallType.CARD,
            purpose="coach.card",
            step_key=request_key(self.trial, exchange_no, "voice_coaching", "coach.card"),
            trial_id=self.trial,
            actor_user_id=self.db.actor,
            turn_no=n,
            split="dev",
            data_class="public",
        )
        started = self.clock()
        reply = await self.port.run(coach_call(CoachingCard, "card", inputs, manifest, ctx))
        meta_card = CardMeta(
            latency_ms=int((self.clock() - started) * 1000),
            work_item=uuid.uuid5(VOICE_CARD_NAMESPACE, f"{self.trial}:{exchange_no}"),
            transcript_version=int(meta["transcript_version"]),
            candidate_sha256=str(found["sha256"]),
        )
        return store_card(reply.value, inputs, meta_card)

    def _context(
        self, packet: dict[str, Any], turns: list[dict[str, Any]], released: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """`arena.trial_context`'s shape for `coach_inputs`, built from the voice session's own reads."""
        return {
            "public_packet": packet,
            "released_evidence": [
                {
                    "record_id": r["record_id"],
                    "title": r["title"],
                    "content": r["content"],
                    "after_exchanges": int(r["released_after_exchanges"]),
                }
                for r in released
            ],
            "transcript": turns,
            "coaching": [
                {"seq": i, "kind": "coach_card", "card": c.model_dump(mode="json")} for i, c in enumerate(self.cards, 1)
            ],
        }
