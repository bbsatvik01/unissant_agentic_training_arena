"""Assembler (S1 8.4): byte-identical development families, determinism (AC-S1-26), drawn identifiers and
every derived field."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from arena_core.scenario import assemble as asm
from arena_core.scenario.source import (
    SourceError,
    canonical_artifact_id,
    canonical_fact_id,
    canonical_label_id,
    parse_source,
    parse_source_text,
)
from arena_core.scenario.validators import validate_family

REPO_ROOT = Path(__file__).resolve().parents[4]
SEED_DIR = REPO_ROOT / "cases" / "dev"
SPEC_SEED_DIR = REPO_ROOT / "docs" / "spec" / "seed-families"
SEED_IDS = ("F01", "F02", "F03")
DEV_IDS = (*SEED_IDS, "F04", "F05", "F06", "F07", "F08", "F09")

Source = dict[str, Any]
SECOND_REVISION = 2


def build(data: Source) -> dict[str, Any]:
    return asm.assemble(parse_source(data))


@pytest.mark.parametrize("family_id", DEV_IDS)
def test_each_dev_source_assembles_byte_identically_to_the_committed_family(
    family_id: str, source_text: Callable[[str], str]
) -> None:
    built = asm.dump_family(asm.assemble(parse_source_text(source_text(family_id))))
    assert built == (SEED_DIR / f"{family_id}.json").read_text(encoding="utf-8")


@pytest.mark.parametrize("family_id", SEED_IDS)
def test_the_hand_authored_seeds_are_the_spec_seed_files(family_id: str) -> None:
    """S1 11: F01-F03 in cases/dev are the spec's seed files byte for byte."""
    assert (SEED_DIR / f"{family_id}.json").read_bytes() == (SPEC_SEED_DIR / f"{family_id}.json").read_bytes()


def test_every_committed_source_is_canonical_json(source_text: Callable[[str], str]) -> None:
    for family_id in DEV_IDS:
        text = source_text(family_id)
        assert text == json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"


# ---------------------------------------------------------------- drawn identifiers (S1 8.3, 8.6; L3)


def _without_identifiers(data: Source) -> Source:
    for v in data["variants"].values():
        del v["case_id"], v["canaries"]
    return data


def test_a_source_without_drawn_identifiers_is_not_assembled(source_dict: Callable[[str], Source]) -> None:
    data = _without_identifiers(source_dict("F01"))
    with pytest.raises(SourceError) as caught:
        build(data)
    assert caught.value.problems == [
        f"variants.{v}: case_id and canaries are drawn by draw_identifiers before assembly"
        for v in ("truthful", "deceptive")
    ]


def test_identifiers_are_drawn_once_recorded_and_then_reproduced(source_dict: Callable[[str], Source]) -> None:
    bare = _without_identifiers(source_dict("F02"))
    drawn = asm.draw_identifiers(bare)
    assert "case_id" not in bare["variants"]["truthful"]  # the input is not changed
    for v in ("truthful", "deceptive"):
        variant = drawn["variants"][v]
        assert re.fullmatch(r"C-[0-9A-HJKMNP-TV-Z]{8}", variant["case_id"])
        assert all(re.fullmatch(r"CANARY-[0-9a-f]{16}", c) for c in variant["canaries"].values())
    assert asm.draw_identifiers(drawn) == drawn  # recorded values are kept
    family = build(drawn)
    assert asm.dump_family(build(copy.deepcopy(drawn))) == asm.dump_family(family)
    for v in ("truthful", "deceptive"):
        packets = family["variants"][v]
        assert packets["case_id"] == drawn["variants"][v]["case_id"]
        assert packets["private_packet"]["canary"] == drawn["variants"][v]["canaries"]["private"]
        assert packets["evaluator_packet"]["canary"] == drawn["variants"][v]["canaries"]["evaluator"]
    assert validate_family(family) == []


def test_identifiers_come_from_the_csprng_not_from_the_family(source_dict: Callable[[str], Source]) -> None:
    """Two draws for the same source differ: nothing recorded (family ID, seed, hash) determines them."""
    bare = _without_identifiers(source_dict("F02"))
    first, second = asm.draw_identifiers(bare), asm.draw_identifiers(bare)
    for v in ("truthful", "deceptive"):
        assert first["variants"][v]["case_id"] != second["variants"][v]["case_id"]
        assert first["variants"][v]["canaries"] != second["variants"][v]["canaries"]
    tokens = [first["variants"][v]["canaries"][p] for v in ("truthful", "deceptive") for p in ("private", "evaluator")]
    assert len(set(tokens)) == len(tokens)


def test_null_identifiers_count_as_missing(source_dict: Callable[[str], Source]) -> None:
    """A source may write `null` for code-owned identifiers (the model allows it): they are drawn too."""
    data = source_dict("F02")
    for v in data["variants"].values():
        v["case_id"], v["canaries"] = None, None
    drawn = asm.draw_identifiers(data)
    assert all(drawn["variants"][v]["case_id"] and drawn["variants"][v]["canaries"] for v in ("truthful", "deceptive"))
    assert validate_family(build(drawn)) == []
    serialized = json.loads(parse_source(drawn).model_dump_json(by_alias=True))
    assert asm.draw_identifiers(serialized)["variants"] == serialized["variants"]


def test_a_taken_case_id_is_never_drawn(source_dict: Callable[[str], Source], monkeypatch: pytest.MonkeyPatch) -> None:
    draws = iter(["C-AAAAAAAA", "C-AAAAAAAA", "C-BBBBBBBB", "C-CCCCCCCC"])
    monkeypatch.setattr(asm, "draw_case_id", lambda: next(draws))
    drawn = asm.draw_identifiers(_without_identifiers(source_dict("F02")), taken={"C-BBBBBBBB"})
    assert [drawn["variants"][v]["case_id"] for v in ("truthful", "deceptive")] == ["C-AAAAAAAA", "C-CCCCCCCC"]


def test_a_new_revision_draws_new_identifiers(source_dict: Callable[[str], Source]) -> None:
    """S1 8.6 step 1: revision + 1 and new case IDs (and canaries); nothing else changes."""
    data = source_dict("F01")
    revised = asm.new_revision(data)
    assert revised["family"]["revision"] == data["family"]["revision"] + 1
    for v in ("truthful", "deceptive"):
        old, new = data["variants"][v], revised["variants"][v]
        assert new["case_id"] not in {data["variants"][w]["case_id"] for w in ("truthful", "deceptive")}
        assert set(new["canaries"].values()).isdisjoint(old["canaries"].values())
        assert {k: x for k, x in new.items() if k not in {"case_id", "canaries"}} == {
            k: x for k, x in old.items() if k not in {"case_id", "canaries"}
        }
    family = build(revised)
    assert family["revision"] == SECOND_REVISION
    assert validate_family(family) == []


def test_assembly_is_deterministic_across_runs_and_key_orders(source_dict: Callable[[str], Source]) -> None:
    """AC-S1-26: the same source gives byte-identical family files, whatever its key order."""
    data = source_dict("F03")
    reversed_keys = json.loads(json.dumps(data), object_pairs_hook=lambda pairs: dict(reversed(pairs)))
    first, second, third = (asm.dump_family(build(d)) for d in (data, copy.deepcopy(data), reversed_keys))
    assert first == second == third


def _fact(ref: str) -> str:
    return ref if ":" in ref else f"f:{ref[1:]}"


def _prefixed(ref: str, prefix: str) -> str:
    return ref if ":" in ref else f"{prefix}:{ref[1:]}"


def _arts(refs: list[str]) -> list[str]:
    return [canonical_artifact_id(a) for a in refs]


def _canonicalize_evaluator_fields(v: dict[str, Any]) -> None:
    for c in v["contradictions"]:
        c["id"] = _prefixed(c["id"], "c")
        c["fact_ids"] = [_fact(f) for f in c["fact_ids"]]
        c["artifact_ids"] = _arts(c["artifact_ids"])
        if "forbidden_assertion_ids" in c:
            c["forbidden_assertion_ids"] = [_prefixed(x, "x") for x in c["forbidden_assertion_ids"]]
        c["resolved_by"] = {
            "fact_ids": [_fact(f) for f in c["resolved_by"]["fact_ids"]],
            "artifact_ids": _arts(c["resolved_by"]["artifact_ids"]),
        }
    res = v["resolution"]
    for item in res["decisive_support"]:
        item.update(
            id=_prefixed(item["id"], "r"),
            fact_ids=[_fact(f) for f in item["fact_ids"]],
            artifact_ids=_arts(item["artifact_ids"]),
        )
    res["corroboration_to_name"] = _arts(res["corroboration_to_name"])
    rubric = v["rubric"]
    for q in rubric["key_questions"]:
        q.update(id=_prefixed(q["id"], "q"), target_fact_ids=[_fact(f) for f in q["target_fact_ids"]])
    rubric["evidence_to_request"] = _arts(rubric["evidence_to_request"])
    for alt in rubric["alternative_explanations"]:
        alt["id"] = _prefixed(alt["id"], "a")
    v["label_guide"] = [[canonical_label_id(row[0]), *row[1:]] for row in v["label_guide"]]


def _canonicalize_variant(v: dict[str, Any]) -> None:
    for key in ("relevant_actions", "known", "unknown"):
        v[key] = [[_fact(row[0]), *row[1:]] for row in v[key]]
    for g in v["guarded"]:
        g["fact_id"] = _fact(g["fact_id"])
    v["uncertainty"] = [[_prefixed(row[0], "u"), _fact(row[1]), *row[2:]] for row in v["uncertainty"]]
    v["forbidden"] = [[_prefixed(row[0], "x"), row[1], _fact(row[2])] for row in v["forbidden"]]
    if "concealed" in v:
        v["concealed"] = [_fact(f) for f in v["concealed"]]
    _canonicalize_evaluator_fields(v)


def _canonicalize_ids(data: Source) -> None:
    """Rewrite every short-form ID in a kit source into its canonical form."""
    for f in data["facts"]:
        f["id"] = _fact(f["id"])
    for e in data["edges"]:
        e["from"], e["to"] = _fact(e["from"]), _fact(e["to"])
    for a in data["artifacts"]:
        a["id"] = canonical_artifact_id(a["id"])
        a["supports"] = {k: [[_fact(r[0]), *r[1:]] for r in rows] for k, rows in a["supports"].items()}
    data["public"]["known_timeline"] = [
        [t, e, canonical_artifact_id(d)] for t, e, d in data["public"]["known_timeline"]
    ]
    for v in data["variants"].values():
        _canonicalize_variant(v)


@pytest.mark.parametrize("family_id", ["F01", "F02", "F03"])
def test_canonical_ids_in_the_source_assemble_to_the_same_family(
    family_id: str, source_dict: Callable[[str], Source]
) -> None:
    short, canonical = source_dict(family_id), source_dict(family_id)
    _canonicalize_ids(canonical)
    assert canonical != short
    assert asm.dump_family(build(canonical)) == asm.dump_family(build(short))


def test_world_text_that_reads_as_a_source_id_is_refused_with_every_path(source_dict: Callable[[str], Source]) -> None:
    data = source_dict("F01")
    work_orders = next(a for a in data["artifacts"] if a["id"] == "R1")
    work_orders["content"]["truthful"]["body"] = "2 work orders, both logged from Rack R2."
    data["variants"]["deceptive"]["known"][0][2] = "We were short near stair S1 that shift."
    with pytest.raises(SourceError) as caught:
        build(data)
    found = sorted(problem.split(" reads as")[0] for problem in caught.value.problems)
    assert found == ["artifacts[R1].content.truthful.body: ['R2']", "variants.deceptive.known[f01]: ['S1']"]


def test_evaluator_commentary_rewrites_short_ids(source_dict: Callable[[str], Source]) -> None:
    data = source_dict("F01")
    data["variants"]["truthful"]["synopsis"] += " See R4 and fact f29."
    synopsis = build(data)["variants"]["truthful"]["evaluator_packet"]["synopsis"]
    assert synopsis.endswith("See rec-04 and fact f:29.")


@pytest.mark.parametrize(
    "authored",
    [
        "You read Appendix I of the access procedure during the Phase I inspection.",
        'You heard Mara say, "I was alone when I entered."',
        "Mara told you, 'I opened the door myself.'",
        "You\u2019re sure Mara\u2019s badge was hers to sign for.",
    ],
)
def test_ledger_and_unknown_text_are_copied_verbatim(authored: str, source_dict: Callable[[str], Source]) -> None:
    """S1 8.3: the source's second-person text is the ledger text; no pronoun is rewritten, so a quotation's
    speaker and a Roman numeral survive."""
    data = source_dict("F01")
    variant = data["variants"]["deceptive"]
    variant["known"][0][2] = authored
    variant["unknown"][0][1] = authored
    private = build(data)["variants"]["deceptive"]["private_packet"]
    known_id, unknown_id = canonical_fact_id(variant["known"][0][0]), canonical_fact_id(variant["unknown"][0][0])
    assert next(k["text"] for k in private["facts"] if k["id"] == known_id) == authored
    assert next(u["subject_view"] for u in private["unknown_facts"] if u["fact_id"] == unknown_id) == authored


def test_the_committed_sources_carry_second_person_ledger_text(source_dict: Callable[[str], Source]) -> None:
    """The dev sources were converted once from the kit's first person; no ledger row speaks as "I" now."""
    first_person = re.compile(r"\b(?:I|me|my|mine|myself)\b")
    for family_id in DEV_IDS:
        for variant in source_dict(family_id)["variants"].values():
            texts = [row[2] for row in variant["known"]] + [row[1] for row in variant["unknown"]]
            assert not [t for t in texts if first_person.search(t)], family_id


def test_derived_fields_of_f01(seed: Callable[[str], dict[str, Any]]) -> None:
    family = seed("F01")
    truthful, deceptive = family["variants"]["truthful"], family["variants"]["deceptive"]
    public_t, public_d = truthful["public_packet"], deceptive["public_packet"]
    assert {k: v for k, v in public_t.items() if k != "case_id"} == {
        k: v for k, v in public_d.items() if k != "case_id"
    }
    assert public_t["presentation"]["display_name"] == public_t["interview_context"]["subject"]["name"] == "Jordan Pell"
    assert public_t["ground_rules"] == list(asm.GROUND_RULES)
    assert public_t["limits"] == {"max_exchanges": 12, "max_releases": 6}
    assert truthful["private_packet"]["objective"] == asm.OBJECTIVE_TRUTHFUL
    assert deceptive["private_packet"]["objective"].startswith("Keep this from being established: that you entered")
    assert deceptive["private_packet"]["permitted_behaviors"] == ["omission", "deflection", "minimization"]
    assert truthful["private_packet"]["permitted_behaviors"] == []
    gates = [
        (g["id"], g["opens"], g["min_evidence_level"], g["precondition_records"])
        for g in deceptive["private_packet"]["gates"]
    ]
    assert gates == [  # S1 11 table: g:01 f:44 level 3, g:02 f:49 level 4
        ("g:01", ["f:44"], 3, ["rec-01", "rec-02", "rec-03"]),
        ("g:02", ["f:49"], 4, ["rec-04"]),
    ]
    assert truthful["private_packet"]["canary"] == "CANARY-69953abf10335789"  # recorded in the F01 source
    assert truthful["evaluator_packet"]["canary"].startswith("CANARY-")


def test_gate_preconditions_follow_the_support_levels(source_dict: Callable[[str], Source]) -> None:
    data = source_dict("F01")
    data["variants"]["deceptive"]["guarded"][0]["gate"]["min_level"] = 4  # no record supports f44 at level 4
    del data["family"]["difficulty"]["knobs"]  # the gate level changes G; the assembler computes the knobs
    family = build(data)
    assert family["variants"]["deceptive"]["private_packet"]["gates"][0]["precondition_records"] == []


def test_dump_family_is_indented_utf8_with_a_trailing_newline() -> None:
    assert asm.dump_family({"a": "é", "b": [1]}) == '{\n  "a": "é",\n  "b": [\n    1\n  ]\n}\n'


def test_an_assembled_seed_passes_every_validator(source_dict: Callable[[str], Source]) -> None:
    assert validate_family(build(source_dict("F02"))) == []
