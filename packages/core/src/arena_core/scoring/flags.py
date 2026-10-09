"""Flag scoring (S3 5.3, M06-M08; C-05, S3-D5, S3-D6): citation existence, support, duplicates and evasion matching.

Citation existence is S2 4.4.1's `flag_citations_ok`, the one citation module (D6). Flags are never carried
forward: a re-emitted flag (same kind, cited turn and normalized quote) counts once for support and as a false
positive for evasion precision.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from arena_core.contracts.adapter import Card, Flag, flag_key
from arena_core.contracts.citations import Record, Turn, flag_citations_ok
from arena_core.contracts.referee import FlagVerdict

STRICT = frozenset({"possible_evasion"})  # primary evasion metrics (S3-D5)
BROAD = frozenset({"possible_evasion", "non_responsive"})  # secondary
REASONS = ("citation", "demeanor", "claim")

Key = tuple[str, int, str]


@dataclass(frozen=True)
class TrialRows:
    """The trial's own committed turns and records (initial documents included) as S2 4.4.1 values; a replay
    trial's are its copies (D2)."""

    turns: Mapping[int, Turn]
    records: Mapping[str, Record]


class FlagScoringError(ValueError):
    """A flag passed citation existence but the referee returned no verdict for its key (fails closed)."""


def emitted_flags(cards: Iterable[Card]) -> list[tuple[int, int, Flag]]:
    """Every flag of every valid card, ordered by (card turn, position in the card)."""
    return [(c.turn_no, i, f) for c in sorted(cards, key=lambda c: c.turn_no) if c.valid for i, f in enumerate(c.flags)]


def unique_flags(cards: Iterable[Card]) -> list[tuple[int, int, Flag]]:
    """The first occurrence of each `flag_key`: the M08 denominator."""
    seen: set[Key] = set()
    out = []
    for turn, i, f in emitted_flags(cards):
        if flag_key(f) not in seen:
            seen.add(flag_key(f))
            out.append((turn, i, f))
    return out


def flag_status(f: Flag, card_turn: int, trial: TrialRows, verdicts: Mapping[Key, FlagVerdict]) -> tuple[bool, str]:
    """(supported, reason): `citation`, `demeanor`, `claim` or `supported` (S3-D6). `verdicts` maps each key to
    J3's verdict on its first occurrence."""
    if not flag_citations_ok(f.kind, list(f.citations), trial.turns, trial.records, card_turn):
        return False, "citation"
    v = verdicts.get(flag_key(f))
    if v is None:
        msg = f"flag {f.flag_ref} passed citation existence but has no J3 verdict"
        raise FlagScoringError(msg)
    if f.demeanor_based or not v.content_based:
        return False, "demeanor"
    if not (v.quote_relevant and v.claim_holds and v.no_outside_facts):
        return False, "claim"
    return True, "supported"


@dataclass(frozen=True)
class EvasionCounts:
    tp: int
    flags: int  # evasion flags emitted (precision denominator)
    events: int  # evasion events (recall denominator)


def evasion_counts(
    cards: Iterable[Card],
    labels: Mapping[int, str],
    trial: TrialRows,
    verdicts: Mapping[Key, FlagVerdict],
    kinds: frozenset[str] = STRICT,
) -> EvasionCounts:
    """S3 5.3: a flag is a true positive when supported, it cites an evasion event (a turn labeled `evasion`;
    PFQ turns never are), and it is the first such flag on that event; every other emitted flag of an evasion
    kind is a false positive (unsupported, non-event, second flag on a matched event, or duplicate)."""
    events = {t for t, lab in labels.items() if lab == "evasion"}
    matched: set[int] = set()
    tp = fp = 0
    for turn, _, f in emitted_flags(cards):
        if f.kind not in kinds:
            continue
        ok, _ = flag_status(f, turn, trial, verdicts)
        if ok and f.turn_no in events and f.turn_no not in matched:
            matched.add(f.turn_no)
            tp += 1
        else:
            fp += 1
    return EvasionCounts(tp, tp + fp, len(events))


@dataclass(frozen=True)
class SupportCounts:
    unique: int  # M08 denominator
    unsupported: Mapping[str, int]  # by reason: citation, demeanor, claim
    demeanor_based: int  # FA-3: unique flags the lexicon marked

    @property
    def unsupported_total(self) -> int:
        return sum(self.unsupported.values())


def support_counts(cards: Iterable[Card], trial: TrialRows, verdicts: Mapping[Key, FlagVerdict]) -> SupportCounts:
    """M08 over unique flags (a duplicate is counted once for support), with reasons split."""
    reasons = dict.fromkeys(REASONS, 0)
    uniq = unique_flags(cards)
    for turn, _, f in uniq:
        ok, why = flag_status(f, turn, trial, verdicts)
        if not ok:
            reasons[why] += 1
    return SupportCounts(len(uniq), reasons, sum(f.demeanor_based for _, _, f in uniq))
