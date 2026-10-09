"""Authoring-brief renderer (S1 8.2): dev-only examples (L5, AC-S1-20), blocks and the brief hash."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest

from arena_core.ids import sha256_hex
from arena_core.scenario import brief as br
from arena_core.scenario import seed as sd
from arena_core.scenario.source import prose_id_tokens

Family = dict[str, Any]
RULES = "Author one synthetic case family. Fictional organizations, people and places only."
# sha256 of the S1 reference kit's `brief()` output on each committed seed (scratch s1v23/brief.py, run on
# cases/dev/F01-F03 as of the v2.5 seed fixes).
REFERENCE_BRIEF_SHA256 = {
    "F01": "2f7cc2a9ce9525aa8383e3e5246ea9f6fc2f4df9ec752bf62470594f9c877734",
    "F02": "b5d0dd306cfecfd8d2d2fd21d53595d848dea80bb8f59755af48bb0a3483d93d",
    "F03": "eca05761564b2204c3f39d15543c87a17dd0fc7d15d52b081e72f5e60bcaa6d6",
}
REFERENCE_BRIEF_TOKENS = (2312, 3100)  # characters / 4 of those briefs (S1 8.2 measured 2,324-2,989 on v2.3)


def hidden_spec(seeds: list[Family], index: int = 0) -> sd.SeedSpec:
    # 9: the smallest hidden split above 1 whose style factorial can meet AC-S1-16 (the sampler refuses less).
    config = sd.SamplerConfig(n=9, split="hidden", seed=7, second_language_allowed=False, draws=500)
    pools = sd.SamplerPools(
        portraits=tuple(
            sd.PortraitEntry(persona_id=f"persona-{i:02d}", description=f"Portrait {i}") for i in range(4, 13)
        ),
        voices=("Kore",),
        facilities=("Marlow Depot",),
        occupations=("Records Clerk",),
    )
    return sd.sample_seed_plan(config, pools, [sd.ExistingFamily.from_family(f) for f in seeds]).specs[index]


@pytest.mark.parametrize("family_id", ["F01", "F02", "F03"])
def test_design_brief_matches_the_reference_renderer(family_id: str, seed: Callable[[str], Family]) -> None:
    text = br.design_brief(seed(family_id))
    assert sha256_hex(text) == REFERENCE_BRIEF_SHA256[family_id]
    assert REFERENCE_BRIEF_TOKENS[0] <= len(text) // 4 <= REFERENCE_BRIEF_TOKENS[1]


def test_design_brief_refuses_a_hidden_family(seed: Callable[[str], Family]) -> None:
    """AC-S1-20 with a hidden-split fixture."""
    family = seed("F02")
    family["split"] = "hidden"
    family["family_id"] = "H0123456789"
    with pytest.raises(br.ExampleSplitError, match="only dev families are examples"):
        br.design_brief(family)


def test_design_brief_shows_per_variant_records_and_ledgers(seed: Callable[[str], Family]) -> None:
    text = br.design_brief(seed("F01"))
    assert text.startswith("CASE DESIGN BRIEF F01: Records vault entry during a busy shift")
    assert "rec-01 work_order (on_request after 2): Facilities work orders assigned to J. Pell, 12 March 2026" in text
    assert "\n  T: 2 work orders." in text
    assert "\n  D: 2 work orders." in text
    assert "LEDGER D: " in text
    assert "GATE g:01 level 3 opens ['f:44']" in text


def test_the_authoring_brief_has_four_blocks_and_hashes_its_text(seeds: list[Family]) -> None:
    spec = hidden_spec(seeds)
    example = next(f for f in seeds if f["taxonomy"]["violation_type"] != spec.violation_type)
    brief = br.render_authoring_brief(spec, example, RULES)
    blocks = brief.text.split("\n\n")
    assert blocks[0] == br.BRIEF_VERSION
    assert blocks[1] == "RULES\n" + RULES
    assert blocks[2].startswith("DOMAIN\nFacility-access evidence vocabulary: ")
    assert brief.text.count(f"EXAMPLE\n{br.EXAMPLE_HEADER}\nCASE DESIGN BRIEF {example['family_id']}") == 1
    assert json.loads(brief.text.split("\n\nSEED\n", 1)[1]) == spec.as_json()
    assert brief.sha256 == sha256_hex(brief.text)
    assert (brief.example_family_id, brief.seed_spec_sha256) == (example["family_id"], spec.sha256())


def test_the_brief_hash_covers_rules_example_and_seed(seeds: list[Family]) -> None:
    spec = hidden_spec(seeds)
    examples = [f for f in seeds if f["taxonomy"]["violation_type"] != spec.violation_type]
    base = br.render_authoring_brief(spec, examples[0], RULES).sha256
    assert br.render_authoring_brief(spec, examples[0], RULES + " Extra rule.").sha256 != base
    assert br.render_authoring_brief(spec, examples[1], RULES).sha256 != base
    assert br.render_authoring_brief(hidden_spec(seeds, 1), examples[0], RULES).sha256 != base
    assert br.render_authoring_brief(spec, examples[0], RULES).sha256 == base


def test_the_example_must_differ_in_violation_type_and_rules_must_be_given(seeds: list[Family]) -> None:
    spec = hidden_spec(seeds)
    same = dict(seeds[0], taxonomy={**seeds[0]["taxonomy"], "violation_type": spec.violation_type})
    with pytest.raises(ValueError, match="shares the seed's violation type"):
        br.render_authoring_brief(spec, same, RULES)
    with pytest.raises(ValueError, match="RULES block is empty"):
        br.render_authoring_brief(spec, seeds[0], "   ")


def test_choose_example_draws_a_dev_family_of_another_violation_type(seeds: list[Family]) -> None:
    spec = hidden_spec(seeds)
    hidden_copy = dict(seeds[0], split="hidden")
    chosen = br.choose_example(spec, [hidden_copy, *seeds])
    assert chosen["split"] == "dev"
    assert chosen["taxonomy"]["violation_type"] != spec.violation_type
    assert br.choose_example(spec, list(reversed(seeds)))["family_id"] == chosen["family_id"]
    with pytest.raises(ValueError, match="no development family"):
        br.choose_example(spec, [hidden_copy])


def test_the_authoring_provenance_records_the_brief_and_the_seed(seeds: list[Family]) -> None:
    spec = hidden_spec(seeds)
    example = next(f for f in seeds if f["taxonomy"]["violation_type"] != spec.violation_type)
    brief = br.render_authoring_brief(spec, example, RULES)
    authoring = br.Authoring(spec=spec, brief=brief, generator_model="claude-opus-5-5", created="2026-10-21")
    provenance = authoring.provenance()
    assert (provenance["method"], provenance["generator_model"], provenance["created"]) == (
        "generator",
        "claude-opus-5-5",
        "2026-10-21",
    )
    assert (provenance["prompt_sha256"], provenance["seed_spec_sha256"]) == (brief.sha256, spec.sha256())
    assert provenance["few_shot_family_ids"] == [example["family_id"]]
    assert f"sampler seed {spec.sampler.seed}, family 1 of 9" in provenance["notes"]
    assert prose_id_tokens(provenance["notes"]) == []  # notes are world text: no token the kit would rewrite
