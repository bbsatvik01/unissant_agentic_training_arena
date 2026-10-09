"""Seed sampler and style/difficulty factorial (S1 7.5, 8.1; AC-S1-16)."""

from __future__ import annotations

import datetime as dt
import json
import math
import re
from collections import Counter
from collections.abc import Callable, Sequence
from typing import Any

import pytest

from arena_core.scenario import brief as br
from arena_core.scenario import seed as sd
from arena_core.scenario.difficulty import LEVEL_BANDS
from arena_core.scenario.schema import schema_enum

Family = dict[str, Any]
SEED = 20261021
N_HIDDEN = 15  # S1 10.1 baseline hidden split
SMALL_HIDDEN = 9  # the smallest hidden split (above 1) whose factorial can meet AC-S1-16 with 4 axes
SMALL_DRAWS = 500
HIDDEN_ID = re.compile(r"^H[0-9a-f]{10}$")
UNIFORM_DRAWS = 6000
UNIFORM_SIDES = 6
UNIFORM_TOLERANCE = 0.1
SAMPLE_K = 7
SEED_NAMES = ("Avery Lindqvist", "Jordan Pell", "Mara Quell")
SEED_PORTRAITS = {"persona-01", "persona-02", "persona-03"}
VIOLATION_TYPES = schema_enum("case-family.schema.json", "violationType")
MISLEADING_TYPES = schema_enum("case-family.schema.json", "misleadingType")


def pools(
    *, portraits: int = 40, facilities: tuple[str, ...] = ("Marlow Depot", "Tessaly Hall", "Orrin Point Annex")
) -> sd.SamplerPools:
    return sd.SamplerPools(
        portraits=tuple(
            sd.PortraitEntry(persona_id=f"persona-{i:02d}", description=f"Neutral portrait {i}")
            for i in range(1, portraits + 1)
        ),
        voices=("Charon", "Kore", "Puck", "Aoede", "Fenrir"),
        facilities=facilities,
        occupations=("Records Clerk", "Facilities Technician", "Network Operator"),
    )


def existing(seeds: list[Family]) -> list[sd.ExistingFamily]:
    return [sd.ExistingFamily.from_family(f) for f in seeds]


def plan_for(
    seeds: list[Family], *, n: int = N_HIDDEN, split: sd.Split = "hidden", seed: int = SEED, draws: int = sd.DRAWS
) -> sd.SeedPlan:
    config = sd.SamplerConfig(n=n, split=split, seed=seed, second_language_allowed=False, draws=draws)
    facilities = (
        ("Corliss Records Center",) if split == "dev" else ("Marlow Depot", "Tessaly Hall", "Orrin Point Annex")
    )
    return sd.sample_seed_plan(config, pools(facilities=facilities), existing(seeds))


# ---------------------------------------------------------------- DrawStream


def test_draw_streams_are_reproducible_and_separated_by_seed_and_label() -> None:
    def draws(seed: int, label: str) -> list[int]:
        stream = sd.DrawStream(seed, label)
        return [stream.below(1000) for _ in range(300)]

    assert draws(7, "a") == draws(7, "a")
    assert draws(7, "a") != draws(8, "a")
    assert draws(7, "a") != draws(7, "b")


def test_below_stays_in_range_and_is_close_to_uniform() -> None:
    stream = sd.DrawStream(SEED, "uniform")
    counts = Counter(stream.below(UNIFORM_SIDES) for _ in range(UNIFORM_DRAWS))
    assert set(counts) == set(range(UNIFORM_SIDES))
    expected = UNIFORM_DRAWS / UNIFORM_SIDES
    assert all(abs(c - expected) / expected < UNIFORM_TOLERANCE for c in counts.values())
    assert sd.DrawStream(SEED, "one").below(1) == 0


def test_below_rejects_the_biased_tail() -> None:
    """With n = 2**63 + 1 about half of all 64-bit words fall in the rejected tail."""
    stream = sd.DrawStream(SEED, "tail")
    bound = 2**63 + 1
    assert all(0 <= stream.below(bound) < bound for _ in range(50))


def test_sample_shuffle_and_choice() -> None:
    stream = sd.DrawStream(SEED, "helpers")
    picked = stream.sample(range(20), SAMPLE_K)
    assert len(set(picked)) == len(picked) == SAMPLE_K
    items = list(range(30))
    stream.shuffle(items)
    assert sorted(items) == list(range(30))
    assert items != list(range(30))
    assert stream.choice(["only"]) == "only"


@pytest.mark.parametrize(
    "call",
    [
        lambda: sd.DrawStream(-1, "x"),
        lambda: sd.DrawStream(1, "x").below(0),
        lambda: sd.DrawStream(1, "x").sample([1, 2], 3),
        lambda: sd.DrawStream(1, "x").choice([]),
    ],
)
def test_draw_stream_refuses_bad_arguments(call: Callable[[], object]) -> None:
    with pytest.raises(ValueError, match=r"seed|bound|sample|empty"):
        call()


# ---------------------------------------------------------------- phi and the factorial


def test_phi_known_values() -> None:
    assert sd.phi(0b0011, 0b0011, 4) == pytest.approx(1.0)
    assert sd.phi(0b0011, 0b1100, 4) == pytest.approx(-1.0)
    assert sd.phi(0b0011, 0b0101, 4) == pytest.approx(0.0)
    assert sd.phi(0b1111, 0b0101, 4) == 0.0  # a constant indicator has no association


@pytest.mark.parametrize("n", [15, 17])
@pytest.mark.parametrize("second_language_allowed", [True, False])
def test_the_factorial_meets_ac_s1_16(n: int, second_language_allowed: bool) -> None:
    plan = sd.plan_factorial(n, SEED, second_language_allowed=second_language_allowed)
    report = sd.balance_report(plan.styles, plan.levels)
    assert report.problems(second_language_allowed=second_language_allowed) == []
    assert report.max_phi == pytest.approx(plan.max_phi)
    assert plan.max_phi <= sd.PHI_MAX
    third = n // len(LEVEL_BANDS)
    assert sorted(report.level_counts.values()) == sorted(third + (i < n % len(LEVEL_BANDS)) for i in range(3))
    if second_language_allowed:
        assert sorted(report.axis_counts["language"].values()) == [n // 2, n - n // 2]
    else:
        assert {s["language"] for s in plan.styles} == {"native"}


def test_the_factorial_is_deterministic_and_seed_dependent() -> None:
    first = sd.plan_factorial(N_HIDDEN, SEED, second_language_allowed=True)
    assert sd.plan_factorial(N_HIDDEN, SEED, second_language_allowed=True) == first
    assert sd.plan_factorial(N_HIDDEN, SEED + 1, second_language_allowed=True) != first


def test_the_factorial_keeps_the_minimum_over_its_draws() -> None:
    """The first draw is a candidate of every longer run with the same seed, so more draws never do worse."""
    one = sd.plan_factorial(N_HIDDEN, SEED, second_language_allowed=True, draws=1)
    many = sd.plan_factorial(N_HIDDEN, SEED, second_language_allowed=True, draws=500)
    assert many.max_phi < one.max_phi
    assert sd.balance_report(one.styles, one.levels).max_phi == pytest.approx(one.max_phi)


@pytest.mark.parametrize(("n", "draws"), [(0, 10), (5, 0)])
def test_the_factorial_needs_positive_n_and_draws(n: int, draws: int) -> None:
    with pytest.raises(ValueError, match="positive"):
        sd.plan_factorial(n, SEED, second_language_allowed=True, draws=draws)


def test_balance_report_names_each_imbalance() -> None:
    style = {
        "verbosity": "terse",
        "fluency": "fluent",
        "affect": "calm",
        "register": "formal",
        "language": "second_language",
    }
    problems = sd.balance_report([style, style, style], [1, 1, 1]).problems(second_language_allowed=False)
    assert "style verbosity=terse on 3 of 3 families" in problems
    assert "language=second_language used although OD-9 does not allow it" in problems
    assert "difficulty level 1 on 3 of 3 families" in problems
    correlated = sd.BalanceReport(4, {a: {} for a in sd.STYLE_AXES}, {1: 1, 2: 2, 3: 1}, 0.9)
    assert correlated.problems(second_language_allowed=False) == ["largest |phi| 0.900 > 0.4"]


# ---------------------------------------------------------------- seed specs


def test_a_hidden_plan_meets_the_sampler_rules(seeds: list[Family]) -> None:
    plan = plan_for(seeds)
    specs = plan.specs
    assert len(specs) == plan.n == N_HIDDEN
    assert [s.sampler.index for s in specs] == list(range(N_HIDDEN))
    ids = [s.family_id for s in specs]
    assert all(HIDDEN_ID.match(i) for i in ids)
    assert len(set(ids)) == N_HIDDEN
    types = Counter(s.violation_type for s in specs)
    assert set(types) == set(VIOLATION_TYPES)  # coverage: all types for n = 15
    assert max(types.values()) <= math.ceil(N_HIDDEN / len(VIOLATION_TYPES))
    signatures = [(s.violation_type, s.misleading_types[0]) for s in specs]
    assert len(set(signatures)) == len(signatures)
    lo, hi = sd.MISLEADING_PER_FAMILY
    assert all(lo <= len(s.misleading_types) <= hi for s in specs)
    assert all(len(set(s.misleading_types)) == len(s.misleading_types) for s in specs)
    portraits = [s.presentation.persona_id for s in specs]
    assert len(set(portraits)) == N_HIDDEN
    assert not set(portraits) & SEED_PORTRAITS


def test_hidden_specs_carry_targets_dates_and_the_record(seeds: list[Family]) -> None:
    plan = plan_for(seeds)
    start, end = sd.INCIDENT_WINDOW
    delay_lo, delay_hi = sd.INTERVIEW_DELAY_DAYS
    for spec in plan.specs:
        assert {k: (t.min, t.max) for k, t in spec.knob_targets.items()} == LEVEL_BANDS[spec.difficulty_level].ranges()
        assert spec.style["language"] == "native"
        incident, interview = dt.date.fromisoformat(spec.incident_date), dt.date.fromisoformat(spec.interview_date)
        assert incident.weekday() not in sd.WEEKEND
        assert start <= incident <= end
        assert delay_lo <= (interview - incident).days <= delay_hi
        assert (spec.agency, spec.domain, spec.split) == (sd.AGENCY, "facility_access", "hidden")
        assert spec.used_names == SEED_NAMES
        assert spec.facility in pools().facilities
        assert spec.presentation.voice_id in pools().voices
        assert spec.presentation.persona_description.startswith("Neutral portrait")
        assert (spec.sampler.seed, spec.sampler.max_phi) == (SEED, plan.max_phi)
    report = sd.balance_report([s.style for s in plan.specs], [s.difficulty_level for s in plan.specs])
    assert report.problems(second_language_allowed=False) == []


def test_the_plan_is_reproducible_from_its_seed(seeds: list[Family]) -> None:
    first = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    again = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    assert first == again
    assert [s.sha256() for s in first.specs] == [s.sha256() for s in again.specs]
    assert plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS, seed=SEED + 1) != first


def test_a_dev_plan_continues_the_family_numbers(seeds: list[Family]) -> None:
    plan = plan_for(seeds, n=3, split="dev", draws=20)
    assert [s.family_id for s in plan.specs] == ["F04", "F05", "F06"]
    signatures = {(s.violation_type, s.misleading_types[0]) for s in plan.specs}
    seed_signatures = {(f["taxonomy"]["violation_type"], f["taxonomy"]["misleading_types"][0]) for f in seeds}
    assert not signatures & seed_signatures


@pytest.mark.parametrize(
    ("build", "message"),
    [
        pytest.param(
            lambda e: sd.sample_seed_plan(
                sd.SamplerConfig(n=2, split="hidden", seed=SEED, second_language_allowed=False, draws=5),
                pools(facilities=("Halvern Street Annex",)),
                e,
            ),
            "already used by the other split",
            id="hidden facility already used by dev",
        ),
        pytest.param(
            lambda e: sd.sample_seed_plan(
                sd.SamplerConfig(n=2, split="hidden", seed=SEED, second_language_allowed=False, draws=5),
                pools(facilities=("HALVERN  street " + chr(0x200B) + "Annex",)),
                e,
            ),
            "already used by the other split",
            id="hidden facility already used by dev, disguised",
        ),
        pytest.param(
            lambda e: sd.sample_seed_plan(
                sd.SamplerConfig(n=3, split="hidden", seed=SEED, second_language_allowed=False, draws=5),
                pools(portraits=4),
                e,
            ),
            "unused portraits",
            id="portrait pool too small",
        ),
        pytest.param(
            lambda e: sd.sample_seed_plan(
                sd.SamplerConfig(n=2, split="hidden", seed=SEED, second_language_allowed=False, draws=5),
                pools().model_copy(update={"voices": ()}),
                e,
            ),
            "must be non-empty",
            id="empty voice list",
        ),
    ],
)
def test_the_sampler_refuses_unusable_pools(
    build: Callable[[list[sd.ExistingFamily]], object], message: str, seeds: list[Family]
) -> None:
    with pytest.raises(ValueError, match=message):
        build(existing(seeds))


def test_dev_family_ids_end_at_f999(seeds: list[Family]) -> None:
    last = sd.ExistingFamily.from_family(seeds[0]).model_copy(update={"family_id": "F998"})
    config = sd.SamplerConfig(n=3, split="dev", seed=SEED, second_language_allowed=False, draws=5)
    with pytest.raises(ValueError, match="end at F999"):
        sd.sample_seed_plan(config, pools(facilities=("Corliss Records Center",)), [last])


def test_the_sampler_refuses_when_a_violation_type_has_no_signature_left() -> None:
    taken = [
        sd.ExistingFamily(
            family_id=f"F{i + 1:02d}",
            split="dev",
            violation_type=vtype,
            first_misleading_type=misleading,
            persona_name=f"Taken {i}",
            persona_id=f"persona-9{i % 10}",
            facility="Marlow Depot",
        )
        for i, (vtype, misleading) in enumerate((v, m) for v in VIOLATION_TYPES for m in MISLEADING_TYPES)
    ]
    config = sd.SamplerConfig(n=1, split="dev", seed=SEED, second_language_allowed=False, draws=5)
    with pytest.raises(ValueError, match="no unused"):
        sd.sample_seed_plan(config, pools(), taken)


# ---------------------------------------------------------------- the authored family against its seed


def spec_from(family: Family, *, used_names: tuple[str, ...] = ()) -> sd.SeedSpec:
    """The seed spec a family's code-owned fields correspond to."""
    public = family["variants"]["truthful"]["public_packet"]
    return sd.SeedSpec(
        seed_spec_version="seed_spec.v1",
        family_id=family["family_id"],
        split=family["split"],
        domain=family["domain"],
        agency=public["interview_context"]["agency"],
        violation_type=family["taxonomy"]["violation_type"],
        misleading_types=tuple(family["taxonomy"]["misleading_types"]),
        difficulty_level=family["difficulty"]["level"],
        knob_targets={
            k: sd.KnobTarget(min=lo, max=hi)
            for k, (lo, hi) in LEVEL_BANDS[family["difficulty"]["level"]].ranges().items()
        },
        style=dict(family["style"]),
        presentation=sd.SeedPresentation(
            persona_id=public["presentation"]["persona_id"],
            persona_description="Neutral portrait",
            voice_id=public["presentation"]["voice_id"],
        ),
        facility=public["interview_context"]["facility"],
        occupation=public["interview_context"]["subject"]["position"],
        incident_date="2026-03-12",
        interview_date=public["interview_context"]["interview_date"],
        used_names=used_names,
        sampler=sd.SamplerRecord(seed=SEED, n=1, index=0, draws=1, second_language_allowed=False, max_phi=0.0),
    )


def test_a_family_built_from_its_seed_conforms(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    assert sd.check_against_seed(family, spec_from(family)) == []


def test_every_code_owned_field_is_checked_against_the_seed(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    spec = spec_from(family, used_names=("Jordan Pell",)).model_copy(
        update={
            "agency": "Another Agency",
            "style": {**family["style"], "affect": "calm"},
            "facility": "Marlow Depot",
            "misleading_types": ("clock_skew",),
        }
    )
    rules = {i.rule for i in sd.check_against_seed(family, spec)}
    assert rules == {
        "SEED.agency",
        "SEED.style",
        "SEED.facility",
        "SEED.misleading_types",
        "SEED.used_name",
    }


def _occupant(family_id: str) -> sd.ExistingFamily:
    """A family that already holds an ID; IDs are unique across both splits, so a dev record will do (a hidden
    plan is only ever drawn with no hidden family in existence)."""
    return sd.ExistingFamily(
        family_id=family_id,
        split="dev",
        violation_type="key_misuse",
        first_misleading_type="clock_skew",
        persona_name="Someone Else",
        persona_id="persona-40",
        facility="Occupied Hall",
    )


def test_a_drawn_hidden_family_id_already_in_use_is_skipped(seeds: list[Family]) -> None:
    first = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS).specs[0]
    config = sd.SamplerConfig(
        n=SMALL_HIDDEN, split="hidden", seed=SEED, second_language_allowed=False, draws=SMALL_DRAWS
    )
    again = sd.sample_seed_plan(config, pools(), [*existing(seeds), _occupant(first.family_id)]).specs[0]
    assert HIDDEN_ID.match(again.family_id)
    assert again.family_id != first.family_id


def test_a_seed_spec_holds_no_case_id(seeds: list[Family]) -> None:
    """Case IDs are drawn by the assembler from a CSPRNG (S1 8.3, L3): nothing in the recorded seed spec, which
    a sampler seed reproduces, names or determines them."""
    spec = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS).specs[0]
    assert not re.search(r"C-[0-9A-HJKMNP-TV-Z]{8}", json.dumps(spec.as_json()))
    assert "case_ids" not in sd.SeedSpec.model_fields


# ---------------------------------------------------------------- whole-split quotas and replacements (S1 7.5, 8.5)


def _quotas(specs: Sequence[sd.SeedSpec]) -> tuple[Counter[str], Counter[int], Counter[tuple[str, str]]]:
    return (
        Counter(s.violation_type for s in specs),
        Counter(s.difficulty_level for s in specs),
        Counter((axis, level) for s in specs for axis, level in s.style.items()),
    )


def test_a_hidden_plan_is_never_drawn_on_top_of_hidden_families(seeds: list[Family]) -> None:
    """Sixteen hidden families plus one more would be 17, which V5 can never pass; and an incremental batch
    would be balanced on its own, not over the split. The hidden split is drawn once (S1 7.5)."""
    plan = plan_for(seeds, n=16, draws=20)
    as_existing = [
        _occupant(s.family_id).model_copy(update={"split": "hidden", "facility": s.facility}) for s in plan.specs
    ]
    config = sd.SamplerConfig(n=1, split="hidden", seed=SEED + 1, second_language_allowed=False, draws=5)
    with pytest.raises(ValueError, match="sampled once, as a whole"):
        sd.sample_seed_plan(config, pools(), [*existing(seeds), *as_existing])


def test_a_replacement_keeps_the_slot_quotas_and_takes_nothing_already_drawn(seeds: list[Family]) -> None:
    """S1 8.5 step 4: a discarded seed is replaced under the same quotas, so the split's balance holds."""
    plan = plan_for(seeds, draws=200)
    counts = Counter(s.violation_type for s in plan.specs)
    index = next(i for i, s in enumerate(plan.specs) if counts[s.violation_type] == 1)  # a singleton type
    original = plan.specs[index]
    first = sd.replacement_spec(plan, index, [], pools(), existing(seeds))
    second = sd.replacement_spec(plan, index, [first], pools(), existing(seeds))
    assert sd.replacement_spec(plan, index, [], pools(), existing(seeds)) == first  # seeded, reproducible
    for k, spec in enumerate((first, second), start=1):
        assert spec.sampler == original.sampler.model_copy(update={"replacement": k})
        assert (spec.violation_type, spec.difficulty_level, spec.style) == (
            original.violation_type,
            original.difficulty_level,
            original.style,
        )
        split = [*plan.specs[:index], spec, *plan.specs[index + 1 :]]
        assert _quotas(split) == _quotas(plan.specs)
    drawn = [*plan.specs, first]
    assert second.family_id not in {s.family_id for s in drawn}
    assert second.presentation.persona_id not in {s.presentation.persona_id for s in drawn} | SEED_PORTRAITS
    assert (second.violation_type, second.misleading_types[0]) not in {
        (s.violation_type, s.misleading_types[0]) for s in drawn
    }
    assert HIDDEN_ID.match(second.family_id)
    example = next(f for f in seeds if f["taxonomy"]["violation_type"] != second.violation_type)
    authored = br.Authoring(
        spec=second,
        brief=br.render_authoring_brief(second, example, "Rules."),
        generator_model="model",
        created="2026-10-21",
    )
    assert "Replacement 2 for a discarded seed" in authored.provenance()["notes"]


def test_a_dev_replacement_takes_the_next_family_number(seeds: list[Family]) -> None:
    plan = plan_for(seeds, n=2, split="dev", draws=20)
    dev_pools = pools(facilities=("Corliss Records Center",))
    replacement = sd.replacement_spec(plan, 0, [], dev_pools, existing(seeds))
    assert [s.family_id for s in plan.specs] == ["F04", "F05"]
    assert replacement.family_id == "F06"


@pytest.mark.parametrize("split", ["dev", "hidden"])
def test_slots_replaced_before_either_is_accepted_never_share_anything(split: sd.Split, seeds: list[Family]) -> None:
    """Every issued replacement stays reserved, pending or not: no shared family ID, signature or portrait
    between two slots replaced in parallel."""
    plan = (
        plan_for(seeds, n=2, split=split, draws=20)
        if split == "dev"
        else plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    )
    slot_pools = pools(facilities=("Corliss Records Center",)) if split == "dev" else pools()
    first = sd.replacement_spec(plan, 0, [], slot_pools, existing(seeds))
    second = sd.replacement_spec(plan, 1, [first], slot_pools, existing(seeds))
    third = sd.replacement_spec(plan, 0, [first, second], slot_pools, existing(seeds))
    if split == "dev":
        assert [first.family_id, second.family_id, third.family_id] == ["F06", "F07", "F08"]
    assert (first.sampler.replacement, second.sampler.replacement, third.sampler.replacement) == (1, 1, 2)
    specs = [*plan.specs, first, second, third]
    assert len({s.family_id for s in specs}) == len(specs)
    assert len({s.presentation.persona_id for s in specs}) == len(specs)
    assert len({(s.violation_type, s.misleading_types[0]) for s in specs}) == len(specs)


def test_a_replacement_checks_what_was_issued(seeds: list[Family]) -> None:
    plan = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    with pytest.raises(ValueError, match="not in the plan"):
        sd.replacement_spec(plan, len(plan.specs), [], pools(), [])
    first = sd.replacement_spec(plan, 1, [], pools(), [])
    foreign = first.model_copy(update={"sampler": first.sampler.model_copy(update={"seed": SEED + 1})})
    with pytest.raises(ValueError, match="not drawn from this plan"):
        sd.replacement_spec(plan, 1, [foreign], pools(), [])
    with pytest.raises(ValueError, match="numbered 1, 2"):
        sd.replacement_spec(plan, 1, [first, first], pools(), [])
    with pytest.raises(ValueError, match="numbered 1, 2"):
        sd.replacement_spec(plan, 1, [plan.specs[2]], pools(), [])
    with pytest.raises(ValueError, match="no unused portrait"):
        sd.replacement_spec(plan, 1, [], pools(portraits=3), existing(seeds))


def test_a_used_name_is_caught_however_it_is_written(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    disguised = "JORDAN " + chr(0xFF30) + "ELL"  # fullwidth P
    assert [i.rule for i in sd.check_against_seed(family, spec_from(family, used_names=(disguised,)))] == [
        "SEED.used_name"
    ]


def test_a_replacement_keeps_the_recorded_used_names_and_adds_new_ones(seeds: list[Family]) -> None:
    plan = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    original = plan.specs[0]
    assert original.used_names == SEED_NAMES
    assert sd.replacement_spec(plan, 0, [], pools(), []).used_names == SEED_NAMES
    newcomer = _occupant("F09").model_copy(update={"persona_name": "Ada Newcomer"})
    assert sd.replacement_spec(plan, 0, [], pools(), [newcomer]).used_names == tuple(
        sorted({*SEED_NAMES, "Ada Newcomer"})
    )


def test_a_replacement_checks_the_pools_against_the_families_that_exist_now(seeds: list[Family]) -> None:
    """L4: a dev family added after the plan took a facility; a hidden replacement may not draw it."""
    plan = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    newdev = _occupant("F04").model_copy(update={"facility": "Marlow Depot"})
    with pytest.raises(ValueError, match="already used by the other split"):
        sd.replacement_spec(plan, 0, [], pools(), [*existing(seeds), newdev])
    with pytest.raises(ValueError, match="must be non-empty"):
        sd.replacement_spec(plan, 0, [], pools().model_copy(update={"voices": ()}), existing(seeds))


def test_a_hidden_plan_that_fails_ac_s1_16_is_refused(seeds: list[Family]) -> None:
    """Six families over five balanced axes cannot keep every phi at or below 0.40: no plan is returned."""
    config = sd.SamplerConfig(n=6, split="hidden", seed=0, second_language_allowed=True)
    with pytest.raises(ValueError, match="AC-S1-16"):
        sd.sample_seed_plan(config, pools(), existing(seeds))


@pytest.mark.parametrize("n", [1, 2])
def test_a_hidden_plan_must_cover_every_difficulty_level(n: int, seeds: list[Family]) -> None:
    """V5 coverage_levels can never pass for fewer than three hidden families: refused at sampling time."""
    config = sd.SamplerConfig(n=n, split="hidden", seed=0, second_language_allowed=False, draws=50)
    with pytest.raises(ValueError, match="every difficulty level"):
        sd.sample_seed_plan(config, pools(), existing(seeds))


def test_the_family_knobs_must_meet_the_seed_targets(seed: Callable[[str], Family]) -> None:
    """S1 8.3: a target narrower than the level's band (here M = 2 inside level 2's band) binds too."""
    family = seed("F01")
    spec = spec_from(family)
    actual = family["difficulty"]["knobs"]["misleading_count"]
    narrow = {**spec.knob_targets, "misleading_count": sd.KnobTarget(min=actual + 1, max=actual + 1)}
    issues = sd.check_against_seed(family, spec.model_copy(update={"knob_targets": narrow}))
    assert [i.rule for i in issues] == ["SEED.knob_targets"]
    assert "misleading_count" in issues[0].message
    missing = {k: v for k, v in spec.knob_targets.items() if k != "gate_level"}
    issues = sd.check_against_seed(family, spec.model_copy(update={"knob_targets": missing}))
    assert [i.rule for i in issues] == ["SEED.knob_targets"]


# ---------------------------------------------------------------- the split's sampler record (S1 10.5)


def _accepted(plan: sd.SeedPlan) -> list[Family]:
    """The fields of each accepted hidden family file that the sampler record states (S4 sampler_matches)."""
    return [
        {
            "family_id": s.family_id,
            "taxonomy": {"violation_type": s.violation_type, "misleading_types": list(s.misleading_types)},
            "difficulty": {"level": s.difficulty_level},
            "style": dict(s.style),
        }
        for s in plan.specs
    ]


def test_the_sampler_record_matches_the_plan_and_its_families(seeds: list[Family]) -> None:
    """S1 10.5: {seed, n, assignment, max_phi}; max_phi recomputed from the files equals the plan's draw."""
    plan = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    families = _accepted(plan)
    record = sd.split_sampler_record(plan.seed, list(reversed(families)))
    assert sorted(record) == ["assignment", "max_phi", "n", "seed"]
    assert (record["seed"], record["n"], record["max_phi"]) == (plan.seed, SMALL_HIDDEN, plan.max_phi)
    assert [e["family_id"] for e in record["assignment"]] == sorted(s.family_id for s in plan.specs)
    first = min(families, key=lambda f: f["family_id"])
    assert record["assignment"][0] == {
        "family_id": first["family_id"],
        "violation_type": first["taxonomy"]["violation_type"],
        "misleading_types": first["taxonomy"]["misleading_types"],
        "level": first["difficulty"]["level"],
        "style": first["style"],
    }
    assert sd.sampler_record_problems(record, families, second_language_allowed=False) == []
    assert sd.sampler_record_problems(json.loads(json.dumps(record)), families, second_language_allowed=False) == []


def _edited(record: dict[str, Any], **changes: object) -> dict[str, Any]:
    out: dict[str, Any] = json.loads(json.dumps(record))
    out.update(changes)
    return out


@pytest.mark.parametrize(
    ("edit", "problem"),
    [
        (lambda r: _edited(r, n=r["n"] + 1), "n "),
        (lambda r: _edited(r, assignment=r["assignment"][:-1]), "entries for"),
        (lambda r: _edited(r, assignment=[*r["assignment"][:-1], r["assignment"][0]]), "repeats a family"),
        (
            lambda r: _edited(
                r,
                assignment=[{**r["assignment"][0], "level": r["assignment"][0]["level"] % 3 + 1}, *r["assignment"][1:]],
            ),
            "differs from the archived family",
        ),
        (lambda r: _edited(r, max_phi=r["max_phi"] / 2), "is not the assignment's largest phi"),
        (
            lambda r: _edited(r, assignment=[{**e, "level": e["level"] == 1 or e["level"]} for e in r["assignment"]]),
            "differs from the archived family",  # JSON true is not 1 (S4 compares jsonb)
        ),
        (lambda r: _edited(r, max_phi=0.41), "is not a number in [0, 0.4]"),
        (lambda r: _edited(r, max_phi=True), "is not a number"),
        (lambda r: _edited(r, seed=-1), "seed is not a non-negative integer"),
        (lambda r: _edited(r, seed=1.5), "seed is not a non-negative integer"),
        (lambda r: _edited(r, seed=True), "seed is not a non-negative integer"),
        (lambda r: _edited(r, n="9"), "n is not an integer"),
        (lambda r: _edited(r, assignment={}), "assignment is not a list of objects"),
        (lambda r: _edited(r, extra=1), "keys"),
        (lambda r: [r], "not an object"),
    ],
)
def test_a_sampler_record_that_does_not_match_is_refused(
    edit: Callable[[dict[str, Any]], object], problem: str, seeds: list[Family]
) -> None:
    """The checks of S4 `sealed.sampler_matches` (SG1-29, SG1-33) and the phi recomputation (S1 10.5)."""
    plan = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    families = _accepted(plan)
    record = edit(sd.split_sampler_record(plan.seed, families))
    problems = sd.sampler_record_problems(record, families, second_language_allowed=False)
    assert any(problem in p for p in problems), problems


def test_a_record_for_other_families_is_refused(seeds: list[Family]) -> None:
    plan = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    families = _accepted(plan)
    record = sd.split_sampler_record(plan.seed, families)
    renamed = [{**f, "family_id": "Hffffffffff"} if i == 0 else f for i, f in enumerate(families)]
    assert any(
        "differs from the archived family" in p
        for p in sd.sampler_record_problems(record, renamed, second_language_allowed=False)
    )


def test_an_unbalanced_split_is_refused_even_with_a_low_phi(seeds: list[Family]) -> None:
    """S1 7.5 before the seal: constant axes give phi 0, so the balance quotas are checked as well."""
    plan = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    families = _accepted(plan)
    same_style = dict(families[0]["style"])
    for f in families:
        f["style"] = dict(same_style)
    levels = [1, 1, 2, 2, 2, 2, 2, 3, 3]  # 2/5/2 instead of 3/3/3
    for f, level in zip(families, levels, strict=True):
        f["difficulty"]["level"] = level
    record = sd.split_sampler_record(plan.seed, families)
    assert record["max_phi"] == 0.0
    problems = sd.sampler_record_problems(record, families, second_language_allowed=False)
    assert any(p.startswith("style verbosity=") for p in problems), problems
    assert any(p.startswith("difficulty level 2 on 5 of 9") for p in problems), problems


def test_second_language_is_refused_unless_the_owner_allows_it(seeds: list[Family]) -> None:
    plan = plan_for(seeds, n=SMALL_HIDDEN, draws=SMALL_DRAWS)
    families = _accepted(plan)
    for f in families:
        f["style"]["language"] = "second_language"  # constant, so phi stays as drawn
    record = sd.split_sampler_record(plan.seed, families)
    refused = sd.sampler_record_problems(record, families, second_language_allowed=False)
    assert any("second_language used" in p for p in refused), refused
    unbalanced = sd.sampler_record_problems(record, families, second_language_allowed=True)
    assert any(p.startswith("style language=") for p in unbalanced), unbalanced
