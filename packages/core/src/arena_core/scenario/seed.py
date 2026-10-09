"""Seed sampler (S1 8.1) with the style and difficulty factorial (S1 7.5). Deterministic, no model call.

`sample_seed_plan(SamplerConfig(n=..., split=..., seed=..., ...), pools, existing)` draws, from one recorded
integer seed, the seed spec of each of n families:
family ID (dev: next `Fnn`; hidden: `H` plus 10 hex), violation type (balanced over the 12-type catalog,
so at most 2 per type for a hidden split of up to 24 families, S1 8.1), one to three misleading types
(signature unique within the split), difficulty level and knob
targets, style, presentation (portrait from the pool with its neutral description, Live voice), facility
(from the split's own list, disjoint from the other split's, L4), occupation, incident date (a weekday,
February to April 2026) and interview date (2 to 7 days later), and the persona names already used. The
agency is fixed. Case IDs are not seed draws: the assembler draws them from a CSPRNG (S1 8.3,
`assemble.draw_identifiers`), so nothing recorded here can recompute them.

The factorial (S1 7.5): each family gets one style shared by both variants; for every axis in use each of
the two levels goes to floor(n/2) or ceil(n/2) families; difficulty levels go to floor(n/3) or ceil(n/3)
families each; 10,000 such balanced assignments are drawn and the one minimizing the largest absolute phi
coefficient between any two axes and between any axis and any difficulty indicator is kept (first
minimum wins). The seed, the assignment and its largest phi are recorded in the plan and in every spec.
`second_language_allowed` is the owner's OD-9 / S1 OD-1 answer: when false, `language` is fixed to
`native` and the other four axes are balanced.

The hidden split is drawn once, as a whole, so its quotas hold over the split: a hidden plan is refused while
any hidden family exists. A seed discarded by the authoring loop (S1 8.5 step 4) is replaced in its slot
by `replacement_spec`, which keeps the slot's violation type, difficulty level and style, so the split's
balance and coverage stay exactly the plan's.

Draws come from SHAKE-256 in counter mode (`DrawStream`) rather than `random`, so a recorded seed
reproduces the same plan on any Python version.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import math
import struct
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ConfigDict

from arena_core.ids import canonical_sha256
from arena_core.scenario.difficulty import LEVEL_BANDS, LEVELS
from arena_core.scenario.guardscan import identity_key
from arena_core.scenario.schema import schema_enum
from arena_core.scenario.validators import Issue

T = TypeVar("T")

DRAWS = 10_000
PHI_MAX = 0.40  # AC-S1-16, initial value tuned in the dev pilot
AGENCY = "Brannock Administrative Services Agency"
DOMAIN = "facility_access"
SEED_SPEC_VERSION: Literal["seed_spec.v1"] = "seed_spec.v1"
STYLE_AXES: dict[str, tuple[str, str]] = {
    "verbosity": ("terse", "expansive"),
    "fluency": ("fluent", "disfluent"),
    "affect": ("calm", "anxious"),
    "register": ("formal", "informal"),
    "language": ("native", "second_language"),
}
MISLEADING_PER_FAMILY = (1, 3)
INCIDENT_WINDOW = (dt.date(2026, 2, 1), dt.date(2026, 4, 30))
INTERVIEW_DELAY_DAYS = (2, 7)
HEX_DIGITS = "0123456789abcdef"  # hidden family IDs: H plus 10 hex characters (S1 2)
HIDDEN_ID_HEX = 10
MAX_DEV_FAMILY_NUMBER = 999  # dev family IDs are F01..F999 (S1 2)
WEEKEND = (5, 6)  # date.weekday() of Saturday and Sunday
_WORDS_PER_BLOCK = 256
_U64 = 1 << 64

Split = Literal["dev", "hidden"]


class DrawStream:
    """Uniform integer draws from SHAKE-256(label, seed, block) in counter mode, unbiased by rejection."""

    def __init__(self, seed: int, label: str) -> None:
        if seed < 0:
            msg = "seed must be a non-negative integer"
            raise ValueError(msg)
        self._prefix = f"arena.scenario.seed|{label}|{seed}|".encode()
        self._block = 0
        self._words: list[int] = []

    def _word(self) -> int:
        if not self._words:
            digest = hashlib.shake_256(self._prefix + str(self._block).encode()).digest(8 * _WORDS_PER_BLOCK)
            self._words = list(reversed(struct.unpack(f">{_WORDS_PER_BLOCK}Q", digest)))
            self._block += 1
        return self._words.pop()

    def below(self, n: int) -> int:
        """A uniform integer in [0, n)."""
        if n <= 0:
            msg = "below() needs a positive bound"
            raise ValueError(msg)
        limit = _U64 - _U64 % n
        while True:
            word = self._word()
            if word < limit:
                return word % n

    def shuffle(self, items: list[T]) -> None:
        """Fisher-Yates, in place."""
        for i in range(len(items) - 1, 0, -1):
            j = self.below(i + 1)
            items[i], items[j] = items[j], items[i]

    def sample(self, population: Sequence[T], k: int) -> list[T]:
        """k distinct elements, in draw order (a partial Fisher-Yates)."""
        pool = list(population)
        if not 0 <= k <= len(pool):
            msg = f"cannot sample {k} from {len(pool)}"
            raise ValueError(msg)
        for i in range(k):
            j = i + self.below(len(pool) - i)
            pool[i], pool[j] = pool[j], pool[i]
        return pool[:k]

    def choice(self, seq: Sequence[T]) -> T:
        if not seq:
            msg = "choice() from an empty sequence"
            raise ValueError(msg)
        return seq[self.below(len(seq))]


# ---------------------------------------------------------------- factorial (S1 7.5)


def phi(a: int, b: int, n: int) -> float:
    """Phi coefficient of two binary indicators over n families, given as bit masks (0 when either is constant)."""
    n1, m1, n11 = a.bit_count(), b.bit_count(), (a & b).bit_count()
    denominator = n1 * (n - n1) * m1 * (n - m1)
    return (n * n11 - n1 * m1) / math.sqrt(denominator) if denominator else 0.0


def active_axes(second_language_allowed: bool) -> tuple[str, ...]:
    return tuple(a for a in STYLE_AXES if second_language_allowed or a != "language")


def max_abs_phi(axis_masks: Sequence[int], level_masks: Sequence[int], n: int) -> float:
    """Largest |phi| between any two axes and between any axis and any difficulty indicator."""
    pairs = [(a, b) for i, a in enumerate(axis_masks) for b in axis_masks[i + 1 :]]
    pairs += [(a, lvl) for a in axis_masks for lvl in level_masks]
    return max((abs(phi(a, b, n)) for a, b in pairs), default=0.0)


@dataclass(frozen=True, slots=True)
class FactorialPlan:
    seed: int
    n: int
    draws: int
    second_language_allowed: bool
    styles: tuple[dict[str, str], ...]
    levels: tuple[int, ...]
    max_phi: float


def _level_counts(n: int, stream: DrawStream) -> list[int]:
    counts = [n // len(LEVELS)] * len(LEVELS)
    for index in stream.sample(range(len(LEVELS)), n % len(LEVELS)):
        counts[index] += 1
    return counts


def _draw_assignment(n: int, axes: tuple[str, ...], stream: DrawStream) -> tuple[float, list[int], list[int]]:
    """One balanced assignment: (largest |phi|, one first-level bit mask per axis, level per family)."""
    masks = []
    for _axis in axes:
        first_level = n // 2 + (stream.below(2) if n % 2 else 0)
        masks.append(sum(1 << i for i in stream.sample(range(n), first_level)))
    levels = [lvl for lvl, count in zip(LEVELS, _level_counts(n, stream), strict=True) for _ in range(count)]
    stream.shuffle(levels)
    level_masks = [sum(1 << i for i, lvl in enumerate(levels) if lvl == wanted) for wanted in LEVELS]
    return max_abs_phi(masks, level_masks, n), masks, levels


def plan_factorial(n: int, seed: int, *, second_language_allowed: bool, draws: int = DRAWS) -> FactorialPlan:
    """Draw `draws` balanced style and difficulty assignments; keep the one with the smallest max |phi|."""
    if n < 1 or draws < 1:
        msg = "n and draws must be positive"
        raise ValueError(msg)
    axes = active_axes(second_language_allowed)
    stream = DrawStream(seed, "factorial")
    best = _draw_assignment(n, axes, stream)
    for _ in range(draws - 1):
        candidate = _draw_assignment(n, axes, stream)
        if candidate[0] < best[0]:
            best = candidate
    score, masks, levels = best
    styles = tuple(
        {
            axis: first if axis not in axes or masks[axes.index(axis)] >> i & 1 else second
            for axis, (first, second) in STYLE_AXES.items()
        }
        for i in range(n)
    )
    return FactorialPlan(seed, n, draws, second_language_allowed, styles, tuple(levels), score)


@dataclass(frozen=True, slots=True)
class BalanceReport:
    """Per-axis level counts, per-level family counts and the largest |phi| of a style and level assignment."""

    n: int
    axis_counts: dict[str, dict[str, int]]
    level_counts: dict[int, int]
    max_phi: float

    def problems(self, *, second_language_allowed: bool, phi_max: float = PHI_MAX) -> list[str]:
        """AC-S1-16: every style level in floor(n/2)..ceil(n/2) families, every level in floor(n/3)..ceil(n/3)."""
        out: list[str] = []
        half, third = (self.n // 2, -(-self.n // 2)), (self.n // 3, -(-self.n // 3))
        for axis in active_axes(second_language_allowed):
            for value, count in self.axis_counts[axis].items():
                if not half[0] <= count <= half[1]:
                    out.append(f"style {axis}={value} on {count} of {self.n} families")
        if not second_language_allowed and self.axis_counts["language"].get("second_language", 0):
            out.append("language=second_language used although OD-9 does not allow it")
        for level, count in self.level_counts.items():
            if not third[0] <= count <= third[1]:
                out.append(f"difficulty level {level} on {count} of {self.n} families")
        if self.max_phi > phi_max:
            out.append(f"largest |phi| {self.max_phi:.3f} > {phi_max}")
        return out


def balance_report(styles: Sequence[Mapping[str, str]], levels: Sequence[int]) -> BalanceReport:
    """Counts and largest |phi| for styles and levels, over all five axes (constant axes contribute phi 0)."""
    n = len(styles)
    axis_masks = [sum(1 << i for i, s in enumerate(styles) if s[axis] == STYLE_AXES[axis][0]) for axis in STYLE_AXES]
    level_masks = [sum(1 << i for i, lvl in enumerate(levels) if lvl == wanted) for wanted in LEVELS]
    axis_counts = {
        axis: {lvl: sum(1 for s in styles if s[axis] == lvl) for lvl in STYLE_AXES[axis]} for axis in STYLE_AXES
    }
    level_counts = {lvl: sum(1 for x in levels if x == lvl) for lvl in LEVELS}
    return BalanceReport(n, axis_counts, level_counts, max_abs_phi(axis_masks, level_masks, n))


# ---------------------------------------------------------------- the split's sampler record (S1 10.5)

SAMPLER_RECORD_KEYS = ("seed", "n", "assignment", "max_phi")


def _assignment_entry(family: Mapping[str, Any]) -> dict[str, Any]:
    """What the record says about one family: exactly what S4 compares with its archived file (SG1-29)."""
    return {
        "family_id": family["family_id"],
        "violation_type": family["taxonomy"]["violation_type"],
        "misleading_types": list(family["taxonomy"]["misleading_types"]),
        "level": family["difficulty"]["level"],
        "style": dict(family["style"]),
    }


def _assignment_phi(assignment: Sequence[Mapping[str, Any]]) -> float:
    return balance_report([dict(e["style"]) for e in assignment], [int(e["level"]) for e in assignment]).max_phi


def split_sampler_record(seed: int, families: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """`{seed, n, assignment, max_phi}` for a sealed split (S1 10.5), built from the accepted family files, so
    a replaced seed's family is recorded as it was accepted; `max_phi` is recomputed from the assignment."""
    assignment = [_assignment_entry(f) for f in sorted(families, key=lambda f: str(f["family_id"]))]
    return {"seed": seed, "n": len(assignment), "assignment": assignment, "max_phi": _assignment_phi(assignment)}


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _record_shape_problems(record: Mapping[str, Any]) -> list[str]:
    problems: list[str] = []
    if sorted(record) != sorted(SAMPLER_RECORD_KEYS):
        problems.append(f"keys {sorted(record)} are not {sorted(SAMPLER_RECORD_KEYS)}")
    seed = record.get("seed")
    if not (isinstance(seed, int) and not isinstance(seed, bool) and seed >= 0):
        problems.append("seed is not a non-negative integer")
    if not _is_int(record.get("n")):
        problems.append("n is not an integer")
    max_phi = record.get("max_phi")
    if isinstance(max_phi, bool) or not isinstance(max_phi, int | float) or not 0 <= max_phi <= PHI_MAX:
        problems.append(f"max_phi {max_phi!r} is not a number in [0, {PHI_MAX}]")
    assignment = record.get("assignment")
    if not isinstance(assignment, list) or not all(isinstance(e, Mapping) for e in assignment):
        problems.append("assignment is not a list of objects")
    return problems


def sampler_record_problems(record: object, families: Sequence[Mapping[str, Any]]) -> list[str]:
    """Why `record` cannot seal `families`, the accepted files of the split: the checks S4's
    `sealed.sampler_matches` makes at the seal (SG1-29, SG1-33), plus the one the authoring session's
    validator makes before it calls the seal: `max_phi` equals the largest phi recomputed from the
    assignment (S1 7.5, 10.5)."""
    if not isinstance(record, Mapping):
        return ["the sampler record is not an object"]
    problems = _record_shape_problems(record)
    if problems:
        return problems
    assignment: list[Mapping[str, Any]] = list(record["assignment"])
    if record["n"] != len(families) or len(assignment) != len(families):
        problems.append(f"n {record['n']} and {len(assignment)} entries for {len(families)} families")
    ids = [str(e.get("family_id")) for e in assignment]
    if len(set(ids)) != len(ids):
        problems.append("an assignment entry repeats a family")
    by_id = {str(f["family_id"]): _assignment_entry(f) for f in families}
    for entry in assignment:
        if by_id.get(str(entry.get("family_id"))) != dict(entry):
            problems.append(f"entry {entry.get('family_id')!r} differs from the archived family")
    if not problems and _assignment_phi(assignment) != record["max_phi"]:
        problems.append(f"max_phi {record['max_phi']} is not the assignment's largest phi")
    return problems


# ---------------------------------------------------------------- seed specs (S1 8.1)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class PortraitEntry(_Model):
    """One portrait of the art pool: its ID and the neutral one-line description that goes into the seed."""

    persona_id: str
    description: str


class SamplerPools(_Model):
    """Lists with no case content (S1 4.1, 8.1); `facilities` is this split's own list (L4)."""

    portraits: tuple[PortraitEntry, ...]
    voices: tuple[str, ...]
    facilities: tuple[str, ...]
    occupations: tuple[str, ...]


class ExistingFamily(_Model):
    """What the sampler must avoid repeating from families that already exist (any split)."""

    family_id: str
    split: str
    violation_type: str
    first_misleading_type: str
    persona_name: str
    persona_id: str
    facility: str

    @classmethod
    def from_family(cls, family: Mapping[str, Any]) -> ExistingFamily:
        public = family["variants"]["truthful"]["public_packet"]
        return cls(
            family_id=str(family["family_id"]),
            split=str(family["split"]),
            violation_type=str(family["taxonomy"]["violation_type"]),
            first_misleading_type=str(family["taxonomy"]["misleading_types"][0]),
            persona_name=str(public["interview_context"]["subject"]["name"]),
            persona_id=str(public["presentation"]["persona_id"]),
            facility=str(public["interview_context"]["facility"]),
        )


class KnobTarget(_Model):
    min: int
    max: int


class SeedPresentation(_Model):
    persona_id: str
    persona_description: str
    voice_id: str


class SamplerRecord(_Model):
    """Where a spec came from: the plan's seed and size, its slot `index`, and `replacement` (0 for the
    plan's own draw, k for the k-th replacement of a discarded seed in that slot, S1 8.5 step 4)."""

    seed: int
    n: int
    index: int
    draws: int
    second_language_allowed: bool
    max_phi: float
    replacement: int = 0


class SeedSpec(_Model):
    """Everything code decides before a family is authored (S1 8.1); rendered as the brief's SEED block."""

    seed_spec_version: Literal["seed_spec.v1"]
    family_id: str
    split: Split
    domain: str
    agency: str
    violation_type: str
    misleading_types: tuple[str, ...]
    difficulty_level: int
    knob_targets: dict[str, KnobTarget]
    style: dict[str, str]
    presentation: SeedPresentation
    facility: str
    occupation: str
    incident_date: str
    interview_date: str
    used_names: tuple[str, ...]
    sampler: SamplerRecord

    def as_json(self) -> dict[str, Any]:
        data: dict[str, Any] = self.model_dump(mode="json")
        return data

    def sha256(self) -> str:
        """`provenance.seed_spec_sha256` of the family authored from this spec."""
        return canonical_sha256(self.as_json())


class SeedPlan(_Model):
    seed: int
    n: int
    split: Split
    draws: int
    second_language_allowed: bool
    max_phi: float
    specs: tuple[SeedSpec, ...]


def _family_ids(n: int, split: Split, existing: Sequence[ExistingFamily], stream: DrawStream) -> list[str]:
    """Dev: the next `Fnn` numbers after every existing dev ID; hidden: `H` plus 10 random hex, unique."""
    if split == "dev":
        numbers = [int(f.family_id[1:]) for f in existing if f.family_id.startswith("F")]
        start = max(numbers, default=0) + 1
        if start + n - 1 > MAX_DEV_FAMILY_NUMBER:
            msg = f"development family IDs end at F{MAX_DEV_FAMILY_NUMBER}"
            raise ValueError(msg)
        return [f"F{number:02d}" for number in range(start, start + n)]
    taken = {f.family_id for f in existing}
    hidden_ids: list[str] = []
    while len(hidden_ids) < n:
        candidate = "H" + "".join(HEX_DIGITS[stream.below(len(HEX_DIGITS))] for _ in range(HIDDEN_ID_HEX))
        if candidate not in taken and candidate not in hidden_ids:
            hidden_ids.append(candidate)
    return hidden_ids


def _violation_types(n: int, catalog: tuple[str, ...], stream: DrawStream) -> list[str]:
    """floor(n/12) or ceil(n/12) families per type, so no type exceeds ceil(n/12) and coverage is maximal."""
    counts = dict.fromkeys(catalog, n // len(catalog))
    for vtype in stream.sample(catalog, n % len(catalog)):
        counts[vtype] += 1
    types = [vtype for vtype in catalog for _ in range(counts[vtype])]
    stream.shuffle(types)
    return types


def _weekdays(start: dt.date, end: dt.date) -> list[dt.date]:
    days = (end - start).days + 1
    return [d for d in (start + dt.timedelta(days=i) for i in range(days)) if d.weekday() not in WEEKEND]


def max_hidden_split() -> int:
    """The largest hidden split V5 can pass: at most 2 families per catalog violation type (S1 8.1, 9.5)."""
    return 2 * len(schema_enum("case-family.schema.json", "violationType"))


def _check_pool_contents(pools: SamplerPools, split: Split, existing: Sequence[ExistingFamily]) -> None:
    """What every draw needs from the pools, for a plan and for a replacement alike: non-empty lists, and no
    facility the other split already uses (L4), checked against the families that exist now."""
    other_facilities = {identity_key(f.facility) for f in existing if f.split != split}
    clash = sorted(f for f in pools.facilities if identity_key(f) in other_facilities)
    if clash:
        msg = f"facilities {clash} are already used by the other split (L4)"
        raise ValueError(msg)
    if not pools.voices or not pools.facilities or not pools.occupations:
        msg = "voices, facilities and occupations must be non-empty"
        raise ValueError(msg)


def _check_pools(pools: SamplerPools, split: Split, existing: Sequence[ExistingFamily], n: int) -> None:
    if split == "hidden" and any(f.split == "hidden" for f in existing):
        msg = (
            "the hidden split is sampled once, as a whole, so its quotas hold over the split (S1 7.5); "
            "a discarded hidden seed is replaced in its slot with replacement_spec (S1 8.5 step 4)"
        )
        raise ValueError(msg)
    if split == "hidden" and n > max_hidden_split():
        msg = (
            f"a hidden split of {n} needs more than 2 families of some violation type (the catalog has "
            f"{max_hidden_split() // 2}): V5 coverage_types could never pass (S1 9.5)"
        )
        raise ValueError(msg)
    _check_pool_contents(pools, split, existing)
    free = [p for p in pools.portraits if p.persona_id not in {f.persona_id for f in existing}]
    if len(free) < n:
        msg = f"the portrait pool has {len(free)} unused portraits for {n} families"
        raise ValueError(msg)


class SamplerConfig(_Model):
    """The sampler's inputs besides the pools: n, the split, the recorded seed and the OD-9 answer."""

    n: int
    split: Split
    seed: int
    second_language_allowed: bool
    draws: int = DRAWS


@dataclass
class _Draw:
    """Mutable state shared across one plan's families (signatures and portraits already taken)."""

    families: DrawStream
    ids: DrawStream
    signatures: set[tuple[str, str]]
    free_portraits: list[PortraitEntry]


def _misleading_types(vtype: str, catalog: tuple[str, ...], draw: _Draw) -> tuple[str, ...]:
    """One to three misleading types; the first makes the (violation, first misleading) signature unique."""
    firsts = [m for m in catalog if (vtype, m) not in draw.signatures]
    if not firsts:
        msg = f"no unused (violation, first misleading) signature left for {vtype}"
        raise ValueError(msg)
    first = draw.families.choice(firsts)
    draw.signatures.add((vtype, first))
    lo, hi = MISLEADING_PER_FAMILY
    count = lo + draw.families.below(hi - lo + 1)
    return (first, *draw.families.sample([m for m in catalog if m != first], count - 1))


@dataclass(frozen=True)
class _Slot:
    """What the plan fixes for one family: its ID and its share of the split's quotas."""

    family_id: str
    split: Split
    violation_type: str
    difficulty_level: int
    style: dict[str, str]
    used_names: tuple[str, ...]


def _draw_spec(slot: _Slot, record: SamplerRecord, pools: SamplerPools, draw: _Draw) -> SeedSpec:
    # Draw order is part of the recorded plan: misleading types, portrait, voice, facility, occupation,
    # incident date, interview delay.
    misleading = _misleading_types(slot.violation_type, schema_enum("case-family.schema.json", "misleadingType"), draw)
    portrait = draw.free_portraits.pop(draw.families.below(len(draw.free_portraits)))
    voice = draw.families.choice(pools.voices)
    facility = draw.families.choice(pools.facilities)
    occupation = draw.families.choice(pools.occupations)
    incident = draw.families.choice(_weekdays(*INCIDENT_WINDOW))
    delay_lo, delay_hi = INTERVIEW_DELAY_DAYS
    interview = incident + dt.timedelta(days=delay_lo + draw.families.below(delay_hi - delay_lo + 1))
    level = slot.difficulty_level
    return SeedSpec(
        seed_spec_version=SEED_SPEC_VERSION,
        family_id=slot.family_id,
        split=slot.split,
        domain=DOMAIN,
        agency=AGENCY,
        violation_type=slot.violation_type,
        misleading_types=misleading,
        difficulty_level=level,
        knob_targets={k: KnobTarget(min=lo, max=hi) for k, (lo, hi) in LEVEL_BANDS[level].ranges().items()},
        style=dict(slot.style),
        presentation=SeedPresentation(
            persona_id=portrait.persona_id, persona_description=portrait.description, voice_id=voice
        ),
        facility=facility,
        occupation=occupation,
        incident_date=incident.isoformat(),
        interview_date=interview.isoformat(),
        used_names=slot.used_names,
        sampler=record,
    )


def sample_seed_plan(config: SamplerConfig, pools: SamplerPools, existing: Iterable[ExistingFamily] = ()) -> SeedPlan:
    """Seed specs for `config.n` new families of `config.split`, all drawn from `config.seed` (S1 7.5, 8.1)."""
    n, split, seed = config.n, config.split, config.seed
    known = list(existing)
    _check_pools(pools, split, known, n)
    factorial = plan_factorial(n, seed, second_language_allowed=config.second_language_allowed, draws=config.draws)
    if split == "hidden" and set(factorial.levels) != set(LEVELS):
        msg = (
            f"a hidden split of {n} cannot cover every difficulty level {list(LEVELS)}, which V5 "
            "coverage_levels requires (S1 9.5)"
        )
        raise ValueError(msg)
    if split == "hidden":
        # AC-S1-16 holds over the hidden split: a plan that misses it (too few families for the axes, or too
        # few draws) is refused here, not discovered in the authoring report.
        problems = balance_report(factorial.styles, factorial.levels).problems(
            second_language_allowed=config.second_language_allowed
        )
        if problems:
            msg = f"the hidden plan fails AC-S1-16: {problems}"
            raise ValueError(msg)
    draw = _Draw(
        families=DrawStream(seed, "families"),
        ids=DrawStream(seed, "ids"),
        signatures={(f.violation_type, f.first_misleading_type) for f in known if f.split == split},
        free_portraits=[p for p in pools.portraits if p.persona_id not in {f.persona_id for f in known}],
    )
    family_ids = _family_ids(n, split, known, draw.ids)
    vtypes = _violation_types(n, schema_enum("case-family.schema.json", "violationType"), draw.families)
    used_names = tuple(sorted({f.persona_name for f in known}))
    specs: list[SeedSpec] = []
    for index in range(n):
        slot = _Slot(
            family_id=family_ids[index],
            split=split,
            violation_type=vtypes[index],
            difficulty_level=factorial.levels[index],
            style=dict(factorial.styles[index]),
            used_names=used_names,
        )
        record = SamplerRecord(
            seed=seed,
            n=n,
            index=index,
            draws=config.draws,
            second_language_allowed=config.second_language_allowed,
            max_phi=factorial.max_phi,
        )
        specs.append(_draw_spec(slot, record, pools, draw))
    return SeedPlan(
        seed=seed,
        n=n,
        split=split,
        draws=config.draws,
        second_language_allowed=config.second_language_allowed,
        max_phi=factorial.max_phi,
        specs=tuple(specs),
    )


def replacement_spec(
    plan: SeedPlan,
    index: int,
    issued: Sequence[SeedSpec],
    pools: SamplerPools,
    existing: Iterable[ExistingFamily],
) -> SeedSpec:
    """The next seed for slot `index` of `plan` under the same quotas (S1 8.5 step 4).

    `issued` is every replacement already issued for this plan, for any slot, in the order issued: all of
    them stay reserved (family IDs, signatures, portraits) whether accepted, pending or discarded,
    so two slots replaced before either is accepted never get the same family ID. `existing` is every family
    that exists now (required, as for the plan); the names already used stay excluded, the plan's recorded
    ones and any added since.

    The replacement keeps the slot's violation type, difficulty level and style, so the split's balance
    (S1 7.5) and type coverage are exactly the plan's; everything else is drawn fresh from the plan's seed,
    on a stream named by the slot and the attempt."""
    if not 0 <= index < len(plan.specs):
        msg = f"slot {index} is not in the plan"
        raise ValueError(msg)
    for spec in issued:
        if spec.sampler.seed != plan.seed or not 0 <= spec.sampler.index < len(plan.specs):
            msg = f"issued spec {spec.family_id} was not drawn from this plan"
            raise ValueError(msg)
    for slot_index in {spec.sampler.index for spec in issued}:
        numbers = [spec.sampler.replacement for spec in issued if spec.sampler.index == slot_index]
        if numbers != list(range(1, len(numbers) + 1)):
            msg = f"issued replacements of slot {slot_index} must be numbered 1, 2, ... in order, got {numbers}"
            raise ValueError(msg)
    known = list(existing)
    _check_pool_contents(pools, plan.split, known)
    drawn = [*plan.specs, *issued]
    attempt = 1 + sum(1 for spec in issued if spec.sampler.index == index)
    label = f"replacement|{index}|{attempt}"
    draw = _Draw(
        families=DrawStream(plan.seed, f"{label}|families"),
        ids=DrawStream(plan.seed, f"{label}|ids"),
        signatures={(f.violation_type, f.first_misleading_type) for f in known if f.split == plan.split}
        | {(d.violation_type, d.misleading_types[0]) for d in drawn},
        free_portraits=[
            p
            for p in pools.portraits
            if p.persona_id not in {f.persona_id for f in known} | {d.presentation.persona_id for d in drawn}
        ],
    )
    if not draw.free_portraits:
        msg = "the portrait pool has no unused portrait for a replacement"
        raise ValueError(msg)
    taken_ids = [
        *known,
        *(
            ExistingFamily(
                family_id=d.family_id,
                split=d.split,
                violation_type=d.violation_type,
                first_misleading_type=d.misleading_types[0],
                persona_name="",
                persona_id=d.presentation.persona_id,
                facility=d.facility,
            )
            for d in drawn
        ),
    ]
    original = plan.specs[index]
    slot = _Slot(
        family_id=_family_ids(1, plan.split, taken_ids, draw.ids)[0],
        split=plan.split,
        violation_type=original.violation_type,
        difficulty_level=original.difficulty_level,
        style=dict(original.style),
        used_names=tuple(sorted(set(original.used_names) | {f.persona_name for f in known})),
    )
    return _draw_spec(slot, original.sampler.model_copy(update={"replacement": attempt}), pools, draw)


def check_against_seed(family: Mapping[str, Any], spec: SeedSpec) -> list[Issue]:
    """The code-owned fields of an authored family equal its seed spec (S1 8.3: the agent never chooses
    the agency, the style or the presentation), and the persona name is not already used.

    The seed's occupation is the subject's position, and its incident date is the day of the violation:
    every timed `violation` fact falls on it, and there is at least one (a family has no other structured
    incident date)."""
    public = family["variants"]["truthful"]["public_packet"]
    context = public["interview_context"]
    violation_days = sorted(
        {str(f["time"])[:10] for f in family["event_graph"]["facts"] if "violation" in f["tags"] and f.get("time")}
    )
    actual = {
        "family_id": family["family_id"],
        "split": family["split"],
        "domain": family["domain"],
        "violation_type": family["taxonomy"]["violation_type"],
        "misleading_types": list(family["taxonomy"]["misleading_types"]),
        "difficulty_level": family["difficulty"]["level"],
        "style": dict(family["style"]),
        "persona_id": public["presentation"]["persona_id"],
        "voice_id": public["presentation"]["voice_id"],
        "agency": context["agency"],
        "facility": context["facility"],
        "interview_date": context["interview_date"],
        "incident_date": violation_days,
        "occupation": context["subject"]["position"],
    }
    wanted = {
        "family_id": spec.family_id,
        "split": spec.split,
        "domain": spec.domain,
        "violation_type": spec.violation_type,
        "misleading_types": list(spec.misleading_types),
        "difficulty_level": spec.difficulty_level,
        "style": spec.style,
        "persona_id": spec.presentation.persona_id,
        "voice_id": spec.presentation.voice_id,
        "agency": spec.agency,
        "facility": spec.facility,
        "interview_date": spec.interview_date,
        "incident_date": [spec.incident_date],
        "occupation": spec.occupation,
    }
    family_id = str(family.get("family_id"))
    issues = [
        Issue(f"SEED.{key}", f"{key} is {actual[key]!r}, the seed spec says {wanted[key]!r}", family_id)
        for key in wanted
        if actual[key] != wanted[key]
    ]
    # Knob targets bind as well (S1 8.3): every target the seed names is met by the family's computed knobs,
    # and the seed names exactly the knobs its level's band constrains.
    knobs = family["difficulty"]["knobs"]
    wanted_knobs = set(LEVEL_BANDS[spec.difficulty_level].ranges()) if spec.difficulty_level in LEVEL_BANDS else set()
    if set(spec.knob_targets) != wanted_knobs:
        message = f"seed knob targets {sorted(spec.knob_targets)} are not the level's {sorted(wanted_knobs)}"
        issues.append(Issue("SEED.knob_targets", message, family_id))
    for knob, target in sorted(spec.knob_targets.items()):
        value = knobs.get(knob)
        if not isinstance(value, int) or not target.min <= value <= target.max:
            message = f"{knob} is {value!r}, the seed targets {target.min}..{target.max}"
            issues.append(Issue("SEED.knob_targets", message, family_id))
    name = str(context["subject"]["name"])
    if identity_key(name) in {identity_key(n) for n in spec.used_names}:
        issues.append(Issue("SEED.used_name", f"persona name {name!r} is already used by another family", family_id))
    return issues
