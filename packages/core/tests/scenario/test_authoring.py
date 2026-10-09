"""AI-authored families (D-014, S1 8.1-8.3): seed spec -> brief -> seeded assembly -> validators -> S4 bundle.

The code-owned fields of an AI-authored family (family ID, split, domain, taxonomy, difficulty level,
style, provenance, agency, presentation, knobs) come from its seed spec and brief; the agent's source may
leave them out, and a source that disagrees with the seed is refused. Case IDs and canaries are drawn by
`draw_identifiers` (a CSPRNG), never taken from the seed.
"""

from __future__ import annotations

import datetime as dt
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from arena_core.ids import canonical_sha256
from arena_core.scenario import brief as br
from arena_core.scenario import seed as sd
from arena_core.scenario.assemble import assemble, assemble_file, draw_identifiers, dump_family
from arena_core.scenario.cli import main
from arena_core.scenario.load import CodexReview, DevSplit, FamilyLoadError, ingest_bundle
from arena_core.scenario.source import SourceError, parse_source
from arena_core.scenario.validators import validate_families, validate_family

Family = dict[str, Any]
RULES = "Author one synthetic case family. Fictional organizations, people and places only."
CODE_OWNED_FAMILY_KEYS = ("family_id", "split", "domain", "taxonomy", "difficulty", "style", "provenance")
F02_LEVEL = 1
F02_INCIDENT = "2026-03-10"  # the date of F02's violation fact f41
SEED_DIR = Path(__file__).resolve().parents[4] / "cases" / "dev"


def review_of(family: Family) -> CodexReview:
    return CodexReview(
        rounds=1,
        review="pass",
        cx2_truthful="pass",
        cx2_deceptive="pass",
        cx3="pass",
        family_sha256=canonical_sha256(family),
    )


def _pools() -> sd.SamplerPools:
    return sd.SamplerPools(
        portraits=tuple(sd.PortraitEntry(persona_id=f"persona-{i:02d}", description="Neutral") for i in range(10, 30)),
        voices=("Kore", "Puck"),
        facilities=("Marlow Depot", "Tessaly Hall"),
        occupations=("Records Clerk",),
    )


def hidden_spec(seeds: list[Family], *, level: int = F02_LEVEL) -> sd.SeedSpec:
    """A sampled hidden seed spec of the given level; F02 is left out of the existing families (its persona
    name stays free for the re-authored copy)."""
    config = sd.SamplerConfig(n=6, split="hidden", seed=23, second_language_allowed=False, draws=100)
    existing = [sd.ExistingFamily.from_family(f) for f in seeds if f["family_id"] != "F02"]
    plan = sd.sample_seed_plan(config, _pools(), existing)
    return next(s for s in plan.specs if s.difficulty_level == level)


def authoring_for(spec: sd.SeedSpec, seeds: list[Family]) -> br.Authoring:
    example = br.choose_example(spec, seeds)
    brief = br.render_authoring_brief(spec, example, RULES)
    return br.Authoring(spec=spec, brief=brief, generator_model="claude-opus-5-5", created="2026-10-21")


def shift_fact_dates(data: Family, old: str, new: str) -> None:
    """Move every timed fact by the days between `old` and `new`, keeping times of day and order."""
    delta = dt.date.fromisoformat(new) - dt.date.fromisoformat(old)
    for fact in data["facts"]:
        if "time" in fact:
            day, clock = fact["time"].split("T")
            fact["time"] = f"{(dt.date.fromisoformat(day) + delta).isoformat()}T{clock}"


def agent_source(source_dict: Callable[[str], Family], spec: sd.SeedSpec) -> Family:
    """F02's source as an agent would write it from this seed: no code-owned field, the seed's facility,
    interview date and occupation in the interview context, and the incident on the seed's date."""
    data = source_dict("F02")
    shift_fact_dates(data, F02_INCIDENT, spec.incident_date)
    data["public"]["interview_context"]["subject"]["position"] = spec.occupation
    data["persona"]["position"] = spec.occupation
    for key in CODE_OWNED_FAMILY_KEYS:
        data["family"].pop(key)
    context = data["public"]["interview_context"]
    context.pop("agency")
    context.update(facility=spec.facility, interview_date=spec.interview_date)
    data["persona"].pop("organization")
    data["public"].pop("presentation")
    for variant in ("truthful", "deceptive"):
        data["variants"][variant].pop("case_id")
        data["variants"][variant].pop("canaries")
    return data


def seeded_family(source_dict: Callable[[str], Family], spec: sd.SeedSpec, authoring: br.Authoring) -> Family:
    """The agent's source with its identifiers drawn (as the CLI does before assembly), assembled."""
    return assemble(parse_source(draw_identifiers(agent_source(source_dict, spec))), authoring)


def test_a_sampled_seed_becomes_a_valid_hidden_family_and_bundle(
    seeds: list[Family], source_dict: Callable[[str], Family], tmp_path: Path
) -> None:
    spec = hidden_spec(seeds)
    authoring = authoring_for(spec, seeds)
    family = seeded_family(source_dict, spec, authoring)
    assert validate_family(family) == []
    assert sd.check_against_seed(family, spec) == []
    assert (family["family_id"], family["split"], family["difficulty"]["level"]) == (
        spec.family_id,
        "hidden",
        F02_LEVEL,
    )
    assert family["taxonomy"] == {
        "violation_type": spec.violation_type,
        "misleading_types": list(spec.misleading_types),
    }
    assert family["style"] == spec.style
    public = family["variants"]["truthful"]["public_packet"]
    assert (public["interview_context"]["agency"], public["presentation"]["persona_id"]) == (
        sd.AGENCY,
        spec.presentation.persona_id,
    )
    assert family["variants"]["deceptive"]["private_packet"]["persona"]["organization"] == sd.AGENCY
    assert "case_ids" not in spec.as_json()  # never a seed draw (S1 8.3, L3)
    provenance = family["provenance"]
    assert provenance == authoring.provenance()
    assert (provenance["prompt_sha256"], provenance["seed_spec_sha256"]) == (authoring.brief.sha256, spec.sha256())
    # V5 runs against the whole dev split and the whole hidden split its sampler record names (S1 9.5,
    # 10.3). This family re-authors dev F02, so the committed dev split refuses it (L4). Against a dev split
    # without F01-F03 (a directory of F04-F09) it needs its split: alone it cannot cover every level.
    split = [as_hidden(seeds[0], "Hc00000000a", "C-HHHHHHA"), as_hidden(seeds[2], "Hc00000000b", "C-HHHHHHB")]
    record = {"assignment": [{"family_id": f["family_id"]} for f in (family, *split)]}
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), DevSplit.from_dir(SEED_DIR), split, record)
    assert {"V5.names", "V5.lexical"} <= {i.rule for i in caught.value.issues}
    later_dev = tmp_path / "dev"
    later_dev.mkdir()
    for path in sorted(SEED_DIR.glob("F0[4-9].json")):
        (later_dev / path.name).write_bytes(path.read_bytes())
    alone = {"assignment": [{"family_id": family["family_id"]}]}
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), DevSplit.from_dir(later_dev), (), alone)
    assert [i.rule for i in caught.value.issues] == ["V5.coverage_levels"]
    bundle = ingest_bundle(family, review_of(family), DevSplit.from_dir(later_dev), split, record)
    assert (bundle.family_code, bundle.split) == (spec.family_id, "hidden")


def as_hidden(dev: Family, family_id: str, case_id_prefix: str) -> Family:
    """A development family relabeled as a hidden one (schema-valid), to complete a hidden split."""
    hidden: Family = json.loads(json.dumps(dev))
    hidden.update(family_id=family_id, split="hidden")
    hidden["provenance"].update(
        method="generator",
        generator_model="m",
        prompt_sha256="0" * 64,
        seed_spec_sha256="0" * 64,
        few_shot_family_ids=["F02"],
    )
    for n, variant in enumerate(("truthful", "deceptive")):
        case_id = case_id_prefix + str(n)
        hidden["variants"][variant]["case_id"] = case_id
        for packet in ("public_packet", "private_packet", "evaluator_packet"):
            hidden["variants"][variant][packet]["case_id"] = case_id
        hidden["variants"][variant]["evaluator_packet"]["family_id"] = family_id
        hidden["variants"][variant]["public_packet"]["interview_context"]["facility"] = f"Hidden Site {family_id}"
    return hidden


def test_a_hidden_copy_of_a_dev_family_fails_l4(seeds: list[Family], source_dict: Callable[[str], Family]) -> None:
    """AC-S1-18: the re-authored F02 shares its persona and text with dev F02, so V5 refuses the pair."""
    spec = hidden_spec(seeds)
    family = seeded_family(source_dict, spec, authoring_for(spec, seeds))
    rules = {i.rule for i in validate_families([*seeds, family])}
    assert {"V5.names", "V5.lexical"} <= rules
    assert {r for r in rules if not r.startswith("V5.")} == set()


def test_seeded_assembly_is_deterministic(seeds: list[Family], source_dict: Callable[[str], Family]) -> None:
    spec = hidden_spec(seeds)
    drawn = parse_source(draw_identifiers(agent_source(source_dict, spec)))
    first = dump_family(assemble(drawn, authoring_for(spec, seeds)))
    second = dump_family(assemble(drawn, authoring_for(spec, seeds)))
    assert first == second


def test_code_owned_values_the_source_repeats_must_equal_the_seed(
    seeds: list[Family], source_dict: Callable[[str], Family]
) -> None:
    spec = hidden_spec(seeds)
    authoring = authoring_for(spec, seeds)
    agreeing = draw_identifiers(agent_source(source_dict, spec))
    agreeing["public"]["interview_context"]["agency"] = spec.agency
    assert (
        assemble(parse_source(agreeing), authoring)["variants"]["truthful"]["public_packet"]["interview_context"][
            "agency"
        ]
        == spec.agency
    )
    conflicting = draw_identifiers(agent_source(source_dict, spec))
    conflicting["public"]["interview_context"]["agency"] = "Another Agency"
    conflicting["family"]["style"] = {**spec.style, "affect": "anxious" if spec.style["affect"] == "calm" else "calm"}
    conflicting["public"]["presentation"] = {"persona_id": "persona-99", "voice_id": "Puck"}
    conflicting["family"]["family_id"] = "H0000000000"
    conflicting["family"]["provenance"] = {"method": "hand", "created": "2026-10-21", "notes": "Hand written."}
    with pytest.raises(SourceError) as caught:
        assemble(parse_source(conflicting), authoring)
    refused = {problem.split(" is code-owned")[0] for problem in caught.value.problems}
    assert refused == {
        "public.interview_context.agency",
        "family.style",
        "public.presentation.persona_id",
        "family.family_id",
        "family.provenance",
    }


def test_the_family_must_conform_to_its_seed(seeds: list[Family], source_dict: Callable[[str], Family]) -> None:
    spec = hidden_spec(seeds)
    data = draw_identifiers(agent_source(source_dict, spec))
    data["public"]["interview_context"]["facility"] = "Halvern Street Annex"
    data["public"]["interview_context"]["interview_date"] = "2026-01-05"
    data["public"]["interview_context"]["subject"]["position"] = "Facilities Technician II"
    data["persona"]["position"] = "Facilities Technician II"
    shift_fact_dates(data, F02_INCIDENT, "2026-04-30")  # the incident moved off the seed's date
    with pytest.raises(SourceError) as caught:
        assemble(parse_source(data), authoring_for(spec, seeds))
    assert sorted(p.split(":")[0] for p in caught.value.problems) == [
        "SEED.facility",
        "SEED.incident_date",
        "SEED.interview_date",
        "SEED.occupation",
    ]
    used = spec.model_copy(update={"used_names": ("Mara Quell",)})
    with pytest.raises(SourceError, match=r"SEED\.used_name"):
        seeded_family(source_dict, used, authoring_for(used, seeds))


def test_wrong_source_knobs_are_refused_and_missing_ones_computed(source_dict: Callable[[str], Family]) -> None:
    data = source_dict("F01")
    data["family"]["difficulty"]["knobs"]["gate_level"] = 4
    with pytest.raises(SourceError, match=r"family.difficulty.knobs .* != computed"):
        assemble(parse_source(data))
    data["family"]["difficulty"].pop("knobs")
    assert dump_family(assemble(parse_source(data))) == (SEED_DIR / "F01.json").read_text(encoding="utf-8")


def test_a_hand_source_must_carry_every_code_owned_field(source_dict: Callable[[str], Family]) -> None:
    data = source_dict("F03")
    data["variants"]["truthful"].pop("case_id")
    data["public"].pop("presentation")
    with pytest.raises(SourceError) as caught:
        assemble(parse_source(data))
    assert sorted(p.split(" is required")[0] for p in caught.value.problems) == [
        "public.presentation.persona_id",
        "public.presentation.voice_id",
        "variants.truthful: case_id and canaries are drawn by draw_identifiers before assembly",
    ]


def test_the_authoring_context_checks_its_brief(seeds: list[Family]) -> None:
    spec = hidden_spec(seeds)
    authoring = authoring_for(spec, seeds)
    with pytest.raises(ValidationError, match="not the sha256 of its text"):
        br.AuthoringBrief(**{**authoring.brief.model_dump(), "text": authoring.brief.text + "edited"})
    other = hidden_spec(seeds, level=2)
    with pytest.raises(ValidationError, match="different seed spec"):
        br.Authoring(spec=other, brief=authoring.brief, generator_model="m", created="2026-10-21")
    with pytest.raises(ValidationError, match="created"):
        br.Authoring(spec=spec, brief=authoring.brief, generator_model="m", created="21 October")
    # The example ID is the one the EXAMPLE block shows; re-labelling it would falsify few_shot_family_ids.
    with pytest.raises(ValidationError, match="EXAMPLE block"):
        br.AuthoringBrief(**{**authoring.brief.model_dump(), "example_family_id": "F99"})
    # A stale brief whose metadata was re-pointed at another seed: its text still holds the old SEED block.
    stale = authoring.brief.model_copy(update={"seed_spec_sha256": other.sha256()})
    with pytest.raises(ValidationError, match="SEED block"):
        br.Authoring(spec=other, brief=stale, generator_model="m", created="2026-10-21")


def test_the_cli_assembles_from_an_authoring_file(
    tmp_path: Path, seeds: list[Family], source_dict: Callable[[str], Family], capsys: pytest.CaptureFixture[str]
) -> None:
    spec = hidden_spec(seeds)
    authoring = authoring_for(spec, seeds)
    source_path = tmp_path / "source.json"
    source_path.write_text(json.dumps(agent_source(source_dict, spec)), encoding="utf-8")
    authoring_path = tmp_path / "authoring.json"
    authoring_path.write_text(authoring.model_dump_json(), encoding="utf-8")
    family_path = tmp_path / "family.json"
    assert main(["assemble", str(source_path), "--authoring", str(authoring_path), "--out", str(family_path)]) == 0
    family = json.loads(family_path.read_text(encoding="utf-8"))
    assert family["family_id"] == spec.family_id
    assert family["provenance"]["prompt_sha256"] == authoring.brief.sha256
    recorded = json.loads(source_path.read_text(encoding="utf-8"))  # the drawn identifiers, written back
    assert family["variants"]["truthful"]["case_id"] == recorded["variants"]["truthful"]["case_id"]
    bad = tmp_path / "bad-authoring.json"
    bad.write_text("{}", encoding="utf-8")
    assert main(["assemble", str(source_path), "--authoring", str(bad)]) == 1
    captured = capsys.readouterr()
    assert (captured.out, "bad-authoring.json" in captured.err) == ("", True)


def test_a_committed_ai_authored_source_rebuilds_with_the_authoring_beside_it(
    tmp_path: Path, seeds: list[Family], source_dict: Callable[[str], Family]
) -> None:
    """The repository rebuild path (`assemble_file`) for a generated development family: the source alone
    cannot be assembled, the source with its `.authoring.json` gives the committed family byte for byte."""
    config = sd.SamplerConfig(n=1, split="dev", seed=5, second_language_allowed=False, draws=50)
    existing = [sd.ExistingFamily.from_family(f) for f in seeds if f["family_id"] != "F02"]
    spec = sd.sample_seed_plan(config, _pools(), existing).specs[0]
    authoring = authoring_for(spec, seeds)
    source_path = tmp_path / f"{spec.family_id}.source.json"
    source = draw_identifiers(agent_source(source_dict, spec))
    source_path.write_text(json.dumps(source), encoding="utf-8")
    with pytest.raises(SourceError, match="required when a family is assembled without a seed spec"):
        assemble_file(source_path)
    authoring_path = tmp_path / f"{spec.family_id}.authoring.json"
    authoring_path.write_text(authoring.model_dump_json(), encoding="utf-8")
    committed = dump_family(assemble(parse_source(source), authoring))
    family = assemble_file(source_path)
    identity = (family["family_id"], family["split"], family["provenance"]["method"])
    assert identity == (spec.family_id, "dev", "generator")
    assert dump_family(family) == committed
    assert br.authoring_beside(source_path) == authoring
    with pytest.raises(ValueError, match="source file is named"):
        br.authoring_beside(tmp_path / f"{spec.family_id}.json")
