"""V5 diversity (S1 9.5, L4, AC-S1-18, AC-S1-35): one seeded defect per rule, plus the measured dev values."""

from __future__ import annotations

import itertools
import math
import re
from pathlib import Path
from typing import Any

import pytest

from arena_core.scenario import seed as sd
from arena_core.scenario import validators
from arena_core.scenario.schema import schema_enum
from arena_core.scenario.validators import validate_split
from arena_core.scenario.validators.v5 import JACCARD_MAX, jaccard, shingles

Family = dict[str, Any]
SEED_JACCARD_CEILING = 0.05  # S1 9.5 measured the seeds at 0.001-0.003; F04-F09 reach 0.028 (cases/dev)


def family(family_id: str, split: str = "dev", **fields: str | int | list[str]) -> Family:
    """The fields V5 reads; unless given, statements, name, facility and case IDs are unique to the family.

    `fields` may set violation, first_misleading, name, facility, level, revision and statements.
    """
    revision = fields.get("revision", 1)
    statements = fields.get("statements")
    if not isinstance(statements, list):
        statements = [f"{family_id}a{i} {family_id}b{i} {family_id}c{i} {family_id}d{i}" for i in range(12)]
    context = {
        "subject": {"name": fields.get("name", f"Person {family_id}")},
        "facility": fields.get("facility", f"Site {family_id}"),
    }
    return {
        "family_id": family_id,
        "revision": revision,
        "split": split,
        "taxonomy": {
            "violation_type": fields.get("violation", "badge_sharing"),
            "misleading_types": [fields.get("first_misleading", "late_paperwork")],
        },
        "difficulty": {"level": fields.get("level", 2)},
        "event_graph": {"facts": [{"statement": s} for s in statements]},
        "variants": {
            "truthful": {"case_id": f"T-{family_id}-{revision}", "public_packet": {"interview_context": context}},
            "deceptive": {"case_id": f"D-{family_id}-{revision}"},
        },
    }


def rules(families: list[Family]) -> set[str]:
    return {i.rule for i in validate_split(families)}


def balanced_hidden(n: int) -> list[Family]:
    """n hidden families over four violation types, every level, distinct signatures."""
    types = ("badge_sharing", "key_misuse", "tailgating_assist", "sealed_material_access")
    misleading = ("clock_skew", "camera_outage", "privacy_reason", "late_paperwork")
    return [
        family(
            f"H{i:010x}",
            split="hidden",
            violation=types[i % len(types)],
            first_misleading=misleading[i // len(types) % len(misleading)],
            level=1 + i % 3,
        )
        for i in range(n)
    ]


def test_a_clean_dev_and_hidden_split_has_no_issue() -> None:
    assert validate_split([family("F01"), family("F02", violation="key_misuse"), *balanced_hidden(6)]) == []


def test_a_family_id_twice_within_or_across_splits() -> None:
    assert "V5.family_id" in rules([family("F01"), family("F01", violation="key_misuse")])
    assert "V5.family_id" in rules([family("F07"), family("F07", split="hidden")])


def test_revisions_of_one_lineage_are_one_family() -> None:
    """S1 8.6, 9.5: a revision keeps its predecessor's persona, statements and signature; only the active
    revision is compared, and only its case IDs must be new."""
    lineage = [family("F01"), family("F01", revision=2), family("F01", revision=3)]
    assert rules([*lineage, family("F02", violation="key_misuse")]) == set()
    reused = family("F01", revision=2)
    reused["variants"]["deceptive"]["case_id"] = "D-F01-1"
    assert rules([family("F01"), reused]) == {"V5.case_id"}


def test_only_the_active_revision_is_compared(  # S1 8.6: a retired revision leaves the comparisons
) -> None:
    retired = family("F01", first_misleading="clock_skew")
    active = family("F01", revision=2, first_misleading="camera_outage")
    other = family("F02", first_misleading="clock_skew")  # the retired revision's signature
    assert rules([retired, active, other]) == set()
    assert rules([active, retired, other]) == set()
    assert "V5.signature" in rules([retired, active, family("F03", first_misleading="camera_outage")])


def test_a_case_id_is_unique_across_families() -> None:
    other = family("F02", violation="key_misuse")
    other["variants"]["truthful"]["case_id"] = "D-F01-1"
    assert rules([family("F01"), other]) == {"V5.case_id"}


def test_a_signature_shared_within_a_split_but_not_across_splits() -> None:
    assert "V5.signature" in rules([family("F01"), family("F02")])
    assert "V5.signature" not in rules([family("F01"), family("Habcdef0123", split="hidden")])


def test_a_persona_name_reused_in_any_split() -> None:
    reused = [family("F01", name="Jordan Pell"), family("Habcdef0123", split="hidden", name="Jordan Pell")]
    assert "V5.names" in rules(reused)


def test_lexical_overlap_within_a_split_and_across_splits() -> None:
    shared = [f"Shared statement number {i} about the vault door alarm." for i in range(12)]
    within = [family("F01", statements=shared), family("F02", violation="key_misuse", statements=shared)]
    assert "V5.lexical" in rules(within)
    across = [family("F01", statements=shared), family("Habcdef0123", split="hidden", statements=shared)]
    assert "V5.lexical" in rules(across)


def test_jaccard_and_the_threshold() -> None:
    a: set[tuple[str, ...]] = {("a", "b", "c"), ("d", "e", "f"), ("g", "h", "i"), ("j", "k", "l"), ("m", "n", "o")}
    b: set[tuple[str, ...]] = {("a", "b", "c"), ("p", "q", "r"), ("s", "t", "u"), ("v", "w", "x"), ("y", "z", "0")}
    assert jaccard(a, b) == pytest.approx(1 / 9)
    assert jaccard(set(), set()) == 0.0
    assert math.isclose(JACCARD_MAX, 0.20)


def test_a_facility_used_by_both_splits() -> None:
    hidden = balanced_hidden(3)
    hidden[0]["variants"]["truthful"]["public_packet"]["interview_context"]["facility"] = "Halvern Street Annex"
    assert "V5.facility" in rules([family("F01", facility="Halvern Street Annex"), *hidden])


def test_hidden_violation_type_quota() -> None:
    misleading = ("clock_skew", "camera_outage", "privacy_reason")
    same_type = [
        family(f"H{i:010x}", split="hidden", level=1 + i, first_misleading=m) for i, m in enumerate(misleading)
    ]
    assert "V5.type_quota" in rules(same_type)  # three hidden families of one type; at most 2
    assert "V5.type_quota" not in rules(same_type[:2] + balanced_hidden(3)[1:2])


def test_hidden_coverage_of_difficulty_levels() -> None:
    hidden = balanced_hidden(3)
    for f in hidden:
        f["difficulty"]["level"] = 2
    assert "V5.coverage_levels" in rules(hidden)
    assert "V5.coverage_levels" not in rules(balanced_hidden(3))


def test_coverage_is_not_required_of_the_dev_split() -> None:
    assert rules([family("F01"), family("F02", violation="key_misuse")]) == set()


def test_the_dev_families_are_lexically_distinct(dev_families: list[Family]) -> None:
    for a, b in itertools.combinations(dev_families, 2):
        assert jaccard(shingles(a), shingles(b)) < SEED_JACCARD_CEILING


def test_every_v5_rule_has_a_seeded_defect() -> None:
    source = (Path(validators.__file__).parent / "v5.py").read_text(encoding="utf-8")
    emitted = set(re.findall(r'"(V5\.[a-z_]+)"', source))
    tested = {
        "V5.family_id",
        "V5.case_id",
        "V5.signature",
        "V5.lexical",
        "V5.names",
        "V5.facility",
        "V5.type_quota",
        "V5.coverage_levels",
    }
    assert emitted == tested


def _pools() -> sd.SamplerPools:
    return sd.SamplerPools(
        portraits=tuple(sd.PortraitEntry(persona_id=f"persona-{i:02d}", description="Neutral") for i in range(10, 40)),
        voices=("Kore",),
        facilities=("Marlow Depot", "Tessaly Hall"),
        occupations=("Records Clerk",),
    )


@pytest.mark.parametrize("n", [15, 17])
def test_sampled_hidden_plans_pass_v5(n: int, seeds: list[Family]) -> None:
    """S1 10.1 / OD-8, AC-S1-36: both planned hidden sizes draw a plan that can pass V5."""
    config = sd.SamplerConfig(n=n, split="hidden", seed=11, second_language_allowed=False, draws=200)
    plan = sd.sample_seed_plan(config, _pools(), [sd.ExistingFamily.from_family(f) for f in seeds])
    hidden = [
        family(
            s.family_id,
            "hidden",
            violation=s.violation_type,
            first_misleading=s.misleading_types[0],
            facility=s.facility,
            level=s.difficulty_level,
        )
        for s in plan.specs
    ]
    assert validate_split([*seeds, *hidden]) == []


LARGEST_FEASIBLE_HIDDEN_SPLIT = 24  # 2 x the 12 violation types of schema v1.2 (S1 8.1)


def test_the_sampler_refuses_a_hidden_plan_v5_could_never_pass(seeds: list[Family]) -> None:
    """25 hidden families need a third family of some type: fail closed before anything is drawn."""
    assert sd.max_hidden_split() == LARGEST_FEASIBLE_HIDDEN_SPLIT
    config = sd.SamplerConfig(n=25, split="hidden", seed=11, second_language_allowed=False, draws=200)
    with pytest.raises(ValueError, match="needs more than 2 families of some violation type"):
        sd.sample_seed_plan(config, _pools(), [sd.ExistingFamily.from_family(f) for f in seeds])


def test_v5_fails_closed_beyond_what_the_catalog_can_cover() -> None:
    """S1 9.5: at most 2 hidden families per type, so 24 over the 12-type catalog pass and 25 always fail."""
    catalog = schema_enum("case-family.schema.json", "violationType")
    misleading = schema_enum("case-family.schema.json", "misleadingType")

    def split(n: int) -> list[Family]:
        return [
            family(
                f"H{i:010x}",
                "hidden",
                violation=catalog[i % len(catalog)],
                first_misleading=misleading[i // len(catalog)],
                level=1 + i % 3,
            )
            for i in range(n)
        ]

    assert rules(split(LARGEST_FEASIBLE_HIDDEN_SPLIT)) == set()
    assert rules(split(LARGEST_FEASIBLE_HIDDEN_SPLIT + 1)) == {"V5.type_quota"}


FULLWIDTH = str.maketrans({chr(c): chr(c + 0xFEE0) for c in range(0x21, 0x7F)})
ZERO_WIDTH = chr(0x200B)


@pytest.mark.parametrize("disguise", ["fullwidth", "zero_width"])
def test_a_unicode_disguised_copy_is_still_the_same_family(disguise: str) -> None:
    """Split isolation (L4) compares text as the runtime renders it: a fullwidth or zero-width-split copy of
    a dev family's statements, name and facility is the same family to every model that reads it."""

    def hide(text: str) -> str:
        if disguise == "fullwidth":
            return text.translate(FULLWIDTH)
        return ZERO_WIDTH.join(text)

    dev = family("F01", name="Jordan Pell", facility="Halvern Street Annex")
    statements = [str(f["statement"]) for f in dev["event_graph"]["facts"]]
    copy = family(
        "H0000000001",
        "hidden",
        name=hide("Jordan Pell"),
        facility=hide("Halvern Street Annex"),
        statements=[hide(s) for s in statements],
        violation="key_misuse",
    )
    assert {"V5.lexical", "V5.names", "V5.facility"} <= rules([dev, copy])


def test_names_and_facilities_compare_without_case_or_spacing_tricks() -> None:
    dev = family("F01", name="Jordan Pell", facility="Halvern Street Annex")
    copy = family("H0000000001", "hidden", name="JORDAN  PELL", facility="halvern street annex")
    assert {"V5.names", "V5.facility"} <= rules([dev, copy])
