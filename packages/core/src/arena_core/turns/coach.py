"""From `arena.trial_context` to a coach call and back to a stored card or deep update (S2 4.1, 4.4, 4.6, 4.8, 5.1).

`coach_inputs(context, call, n)` builds what one card or deep call of turn n may read: the `PublicTrialView`
(transcript 1..n, records released before question n, the candidate's own earlier output), the
`CitationContext` its reply is validated against, and the turns and records the S2 4.4 post-checks read.
`store_card` and `store_deep` add the code-filled fields (flag refs, completed citations, `last_revised_turn`,
`validation`, `card_seq`, latency, work item, version, candidate hash). Nothing here calls a model or the
database.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from arena_core.agents.post_checks import card_validation, lexicon_pattern
from arena_core.agents.views import (
    CoachCall,
    EarlierOutput,
    PublicTrialView,
    TranscriptTurn,
    public_case,
    released_record,
    visible_releases_through,
)
from arena_core.contracts.citations import Record, Turn
from arena_core.contracts.coaching import (
    CoachingCard,
    DeepUpdate,
    FinalFinding,
    StoredCard,
    StoredDeepUpdate,
    StoredFlag,
)
from arena_core.contracts.findings import CitationContext, StoredFinding, last_revised_turn, store_finding
from arena_core.safety.demeanor import DEMEANOR_LEXICON
from arena_core.scenario.content import content_text

LEXICON = lexicon_pattern(DEMEANOR_LEXICON)


@dataclass(frozen=True)
class CoachInputs:
    view: PublicTrialView
    citations: CitationContext
    turns: dict[int, Turn]
    records: dict[str, Record]
    earlier_flags: list[StoredFlag]
    previous_finding: StoredFinding | None
    cards: int  # valid cards stored so far


def _coaching(context: Mapping[str, Any]) -> tuple[list[StoredCard], StoredDeepUpdate | None, StoredFinding | None]:
    """The candidate's earlier valid output, in event order: its cards, its latest deep update, and its latest
    running finding (the later of the last card's and the last deep update's, S2 4.1)."""
    cards: list[StoredCard] = []
    deep: StoredDeepUpdate | None = None
    finding: StoredFinding | None = None
    for event in sorted(context.get("coaching", []), key=lambda e: int(e["seq"])):
        if event["kind"] == "coach_card":
            card = StoredCard.model_validate(event["card"])
            cards.append(card)
            finding = card.finding
        elif event["kind"] == "coach_deep":
            deep = StoredDeepUpdate.model_validate(event["card"])
            finding = deep.finding
    return cards, deep, finding


def coach_inputs(context: Mapping[str, Any], call: CoachCall, n: int) -> CoachInputs:
    packet = context["public_packet"]
    through = visible_releases_through(call, n)
    released = [r for r in context.get("released_evidence", []) if int(r["after_exchanges"]) <= through]
    rows = [t for t in context.get("transcript", []) if int(t["turn_no"]) <= n]
    cards, deep, finding = _coaching(context)
    flags = [f for c in cards for f in c.flags]
    view = PublicTrialView(
        call=call,
        case=public_case(packet),
        released=[
            released_record(r["record_id"], r["title"], r["content"], int(r["after_exchanges"])) for r in released
        ],
        transcript=[TranscriptTurn(turn_no=t["turn_no"], question=t["question"], answer=t["answer"]) for t in rows],
        earlier=EarlierOutput(running_finding=finding, flags=flags, deep_update=deep),
        exchange=n,
    )
    docs = {d["doc_id"]: Record(text=content_text(d["content"])) for d in packet["initial_documents"]}
    recs = {
        r["record_id"]: Record(text=content_text(r["content"]), released_after=int(r["after_exchanges"]))
        for r in released
    }
    released_ids = {r["record_id"] for r in context.get("released_evidence", [])}
    turns = {int(t["turn_no"]): Turn(answer=t["answer"], partial=bool(t.get("partial"))) for t in rows}
    citations = CitationContext(
        current_turn=n,
        answered_turns=frozenset(k for k, t in turns.items() if t.answer is not None and not t.partial),
        citable_records=frozenset(docs) | frozenset(recs),
        requestable=frozenset(r["record_id"] for r in packet["requestable_records"]) - released_ids,
        flag_refs=frozenset(f.flag_ref for f in flags),
    )
    return CoachInputs(view, citations, turns, {**docs, **recs}, flags, finding, len(cards))


def _basis(refs: list[str], flags: list[StoredFlag]) -> list[StoredFlag]:
    by_ref = {f.flag_ref: f for f in flags}
    return [by_ref[r] for r in refs if r in by_ref]


@dataclass(frozen=True)
class CardMeta:
    """The code-filled fields a stored card takes from its call (S2 4.1)."""

    latency_ms: int
    work_item: UUID
    transcript_version: int
    candidate_sha256: str


def store_card(card: CoachingCard, inputs: CoachInputs, meta: CardMeta) -> StoredCard:
    n = inputs.view.exchange
    flags = [StoredFlag(**f.model_dump(), flag_ref=f"{card.turn_id}.f{i}") for i, f in enumerate(card.flags, start=1)]
    finding = store_finding(
        card.finding,
        _basis(card.finding.basis_flag_refs, inputs.earlier_flags + flags),
        last_revised_turn(inputs.previous_finding, card.finding, n),
    )
    validation = card_validation(card, inputs.turns, inputs.records, inputs.earlier_flags, LEXICON)
    return StoredCard(
        **card.model_dump(exclude={"flags", "finding"}),
        flags=flags,
        finding=finding,
        card_seq=inputs.cards + 1,
        turn_no=n,
        validation=validation,
        latency_ms=meta.latency_ms,
        work_item=str(meta.work_item),
        transcript_version=meta.transcript_version,
        candidate_sha256=meta.candidate_sha256,
    )


def store_deep(update: DeepUpdate, inputs: CoachInputs) -> StoredDeepUpdate:
    n = inputs.view.exchange
    finding = store_finding(
        update.finding,
        _basis(update.finding.basis_flag_refs, inputs.earlier_flags),
        last_revised_turn(inputs.previous_finding, update.finding, n),
    )
    return StoredDeepUpdate(**update.model_dump(exclude={"finding"}), finding=finding)


def store_final(final: FinalFinding, inputs: CoachInputs) -> StoredFinding:
    """S2 4.7, 4.8: `finalize_trial`'s committed finding for a harness-run trial (S5 5.3), with the same
    code-filled basis flags and `last_revised_turn` as a card or deep update's finding, plus the final call's
    own `alternative_explanations` (null on every earlier coaching finding, S2 4.8)."""
    n = inputs.view.exchange
    return store_finding(
        final.finding,
        _basis(final.finding.basis_flag_refs, inputs.earlier_flags),
        last_revised_turn(inputs.previous_finding, final.finding, n),
        alternative_explanations=list(final.alternative_explanations),
    )


def deep_due(manifest: Mapping[str, Any], n: int, released_this_turn: bool) -> bool:
    """A1's deep update (S2 4.6): every `every_n_exchanges` exchanges, and on each release when `on_release`."""
    policy = (manifest.get("coaching_policy") or {}).get("deep_update")
    if not policy:
        return False
    return n % int(policy["every_n_exchanges"]) == 0 or (bool(policy["on_release"]) and released_this_turn)
