"""Loader (S1 4.4, 10.5): the bundle `sealed.ingest_case_family` accepts, checked against the S4 SQL itself."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from arena_core.ids import canonical_json, canonical_sha256
from arena_core.scenario import load
from arena_core.scenario.load import CodexReview, FamilyLoadError, IngestBundle, ingest_bundle
from arena_core.scenario.schema import schema_enum

Family = dict[str, Any]
SQL = (Path(__file__).resolve().parents[4] / "docs" / "spec" / "sql" / "0002_cases.sql").read_text(encoding="utf-8")
MAX_ARTIFACTS = 6  # AR006
MAX_TURN = 12  # scheduled_turn / request_after_turn between 0 and 12
MAX_TITLE = 200
MAX_SOURCE_BYTES = 524288  # sealed.family_ingests.source
CODEX_RESULTS = {"rounds": 1, "review": "pass", "cx2_truthful": "pass", "cx2_deceptive": "pass", "cx3": "pass"}


DEV_DIR = Path(__file__).resolve().parents[4] / "cases" / "dev"
DEV = [load.read_family_file(path) for path in sorted(DEV_DIR.glob("F*.json"))]  # the comparison corpus


def corpus_for(family_id: str) -> list[Family]:
    """The development corpus without the family's committed file (for an edited copy of it)."""
    return [f for f in DEV if f["family_id"] != family_id]


def revised(family: Family, revision: int) -> Family:
    """`family` as revision `revision`, with new case IDs (S1 8.6 step 1)."""
    out: Family = json.loads(json.dumps(family))
    out["revision"] = revision
    for n, variant in enumerate(("truthful", "deceptive")):
        case_id = f"C-RRRRRR{revision}{n}"
        out["variants"][variant]["case_id"] = case_id
        for packet in ("public_packet", "private_packet", "evaluator_packet"):
            out["variants"][variant][packet]["case_id"] = case_id
    return out


def review_of(family: Family) -> CodexReview:
    """A passed Codex review of exactly this family file (its canonical-JSON sha256)."""
    return CodexReview.model_validate({**CODEX_RESULTS, "family_sha256": canonical_sha256(family)})


def sql_pattern(column: str) -> re.Pattern[str]:
    """The `column ~ '<regex>'` check of 0002_cases.sql, so the test follows the SQL if it changes."""
    found = re.search(rf"{column} ~ '([^']+)'", SQL)
    assert found, column
    return re.compile(found.group(1))


def sql_enum(column: str) -> set[str]:
    found = re.search(rf"{column}\s+text\s+(?:not null\s+)?check \({column} in \(([^)]*)\)\)", SQL, re.DOTALL)
    assert found, column
    return set(re.findall(r"'([a-z_]+)'", found.group(1)))


def sql_required_checks() -> list[str]:
    found = re.search(r"checks_passed' @> '(\[[^']*\])'", SQL)
    assert found
    checks: list[str] = json.loads(found.group(1))
    return checks


def test_the_sql_contract_parses() -> None:
    assert sql_enum("kind") == {"record", "clarification", "context_change"}
    assert sql_enum("doc_kind") == set(schema_enum("public-packet.schema.json", "artifactKind"))
    assert list(load.CHECKS_PASSED) == sql_required_checks()  # S1 10.5: every check S4 requires


def _check_artifact(a: dict[str, Any], original: dict[str, Any]) -> None:
    assert sql_pattern("record_id").match(a["record_id"])
    assert a["kind"] in sql_enum("kind")
    assert a["doc_kind"] == original["kind"]
    assert a["doc_kind"] in sql_enum("doc_kind")
    assert 1 <= len(a["title"]) <= MAX_TITLE
    assert a["content"] == original["content"]
    # evidence_one_predicate and evidence_request_shape: exactly one predicate column, the right one.
    release = original["release"]
    assert (a["scheduled_turn"] is None) != (a["request_after_turn"] is None)
    if release["type"] == "scheduled":
        expected = (False, release["after_exchanges"], None)
    else:
        expected = (True, None, release["after_exchanges"])
    assert (a["requestable"], a["scheduled_turn"], a["request_after_turn"]) == expected
    for turn in (a["scheduled_turn"], a["request_after_turn"]):
        assert turn is None or 0 <= turn <= MAX_TURN


@pytest.mark.parametrize("family_id", ["F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09"])
def test_each_dev_bundle_meets_the_s4_ingest_contract(family_id: str, seed: Callable[[str], Family]) -> None:
    family = seed(family_id)
    bundle = ingest_bundle(family, review_of(family), DEV).as_json()
    assert sql_pattern("family_code").match(bundle["family_code"])
    assert bundle["family_code"] == family_id
    assert "supersedes" not in bundle  # revision 1 names none (SG1-22)
    assert bundle["split"] in sql_enum("split")
    assert {v["role"] for v in bundle["variants"]} == {"truthful", "deceptive"}  # AR007
    for variant in bundle["variants"]:
        source = family["variants"][variant["role"]]
        assert sql_pattern("variant_code").match(variant["variant_code"])  # C-25: never a role word
        assert variant["variant_code"] == source["case_id"] == variant["public_packet"]["case_id"]
        assert variant["style"] == family["style"]
        assert variant["difficulty"] == family["difficulty"]["level"]
        for packet in ("public_packet", "private_packet", "evaluator_packet"):
            assert variant[packet] == source[packet]
        assert variant["role"] == source["evaluator_packet"]["role"]
        artifacts = variant["artifacts"]
        assert len(artifacts) <= MAX_ARTIFACTS  # AR006
        originals = {a["artifact_id"]: a for a in source["evaluator_packet"]["evidence_artifacts"]}
        assert [a["record_id"] for a in artifacts] == sorted(k for k in originals if k.startswith("rec-"))
        for a in artifacts:
            _check_artifact(a, originals[a["record_id"]])


def test_the_archive_is_the_family_file_and_its_attestation(seed: Callable[[str], Family]) -> None:
    """S1 10.5 and S4's SG1-19 checks: the source parses back to the family, the attestation hashes it."""
    family = seed("F01")
    bundle = ingest_bundle(family, review_of(family), DEV).as_json()
    assert bundle["source"] == canonical_json(family)
    assert json.loads(bundle["source"]) == family
    assert len(bundle["source"].encode("utf-8")) <= MAX_SOURCE_BYTES
    assert bundle["attestation"] == {
        "family_id": "F01",
        "revision": 1,
        "family_sha256": hashlib.sha256(bundle["source"].encode("utf-8")).hexdigest(),
        "validator_version": load.VALIDATOR_VERSION,
        "checks_passed": sql_required_checks(),
        "codex": CODEX_RESULTS,
    }


@pytest.mark.parametrize(("revision", "code", "supersedes"), [(2, "F01.r2", "F01"), (3, "F01.r3", "F01.r2")])
def test_a_revision_has_its_own_code_and_names_its_predecessor(
    revision: int, code: str, supersedes: str, seed: Callable[[str], Family]
) -> None:
    """S1 8.6 and 4.4: family code `Fnn.rN`; `supersedes` is `Fnn` for r2 and `Fnn.r(N-1)` after that."""
    family = revised(seed("F01"), revision)
    corpus = [*DEV, *(revised(seed("F01"), r) for r in range(2, revision))]
    bundle = ingest_bundle(family, review_of(family), corpus).as_json()
    found = (bundle["family_code"], bundle["supersedes"], bundle["attestation"]["revision"])
    assert found == (code, supersedes, revision)
    assert sql_pattern("family_code").match(code)


@pytest.mark.parametrize(
    "codex",
    [
        {"rounds": 0, "review": "pass", "cx2_truthful": "pass", "cx2_deceptive": "pass", "cx3": "pass"},
        {"rounds": 6, "review": "pass", "cx2_truthful": "pass", "cx2_deceptive": "pass", "cx3": "pass"},
        {"rounds": 1, "review": "fail", "cx2_truthful": "pass", "cx2_deceptive": "pass", "cx3": "pass"},
        {"rounds": 1, "review": "pass", "cx2_truthful": "pass", "cx2_deceptive": "pass"},
    ],
)
def test_only_a_passed_codex_review_can_be_attested(codex: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        CodexReview.model_validate({**codex, "family_sha256": "0" * 64})


def test_a_review_of_another_family_file_is_refused(seed: Callable[[str], Family]) -> None:
    """S1 8.5 step 3: the validators and the Codex review pass on the same family-file hash."""
    reviewed = seed("F01")
    review = review_of(reviewed)
    edited = seed("F01")
    edited["variants"]["deceptive"]["evaluator_packet"]["synopsis"] += " Edited after the review."
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(edited, review, corpus_for("F01"))
    assert [i.rule for i in caught.value.issues] == ["CODEX.family_sha256"]
    assert ingest_bundle(reviewed, review, DEV).attestation.family_sha256 == review.family_sha256


def test_scheduled_clarifications_and_context_changes_keep_their_kind(seed: Callable[[str], Family]) -> None:
    """AC-S1-10 fixtures: F02 rec-05 is a context change after 3 exchanges, F03 rec-05 a clarification after 4."""
    for family_id, kind, after in (("F02", "context_change", 3), ("F03", "clarification", 4)):
        bundle = ingest_bundle(seed(family_id), review_of(seed(family_id)), DEV)
        for variant in bundle.variants:
            rec05 = next(a for a in variant.artifacts if a.record_id == "rec-05")
            assert (rec05.kind, rec05.doc_kind, rec05.requestable) == (kind, kind, False)
            assert (rec05.scheduled_turn, rec05.request_after_turn) == (after, None)
    f01 = ingest_bundle(seed("F01"), review_of(seed("F01")), DEV).variants[0]
    assert {a.kind for a in f01.artifacts} == {"record"}


def test_variant_order_follows_the_opaque_code_not_the_role(seed: Callable[[str], Family]) -> None:
    """The public-tier insertion order of arena.case_variants must not reveal the truthful variant (L3)."""
    orders = {}
    for family_id in ("F01", "F02", "F03"):
        variants = ingest_bundle(seed(family_id), review_of(seed(family_id)), DEV).variants
        assert [v.variant_code for v in variants] == sorted(v.variant_code for v in variants)
        orders[family_id] = [v.role for v in variants]
    assert orders["F01"] == ["truthful", "deceptive"]
    assert orders["F02"] == ["deceptive", "truthful"]


def test_bundle_json_is_canonical_and_stable(seed: Callable[[str], Family]) -> None:
    bundle = ingest_bundle(seed("F03"), review_of(seed("F03")), DEV)
    text = bundle.to_json()
    assert text == ingest_bundle(seed("F03"), review_of(seed("F03")), DEV).to_json()
    assert json.loads(text) == bundle.as_json()
    assert text.startswith('{"attestation":{"checks_passed":["V1",')
    assert IngestBundle.model_validate_json(canonical_json({**json.loads(text), "supersedes": None})) == bundle


def test_an_invalid_family_is_never_loaded(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    family["variants"]["deceptive"]["public_packet"]["presentation"]["voice_id"] = "Fenrir"
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), corpus_for("F01"))
    assert [i.rule for i in caught.value.issues] == ["V4a.L1"]
    assert str(caught.value) == '1 validator issue(s): {"V4a.L1":1}'  # codes and counts only (S1 L7)
    assert "presentation" in caught.value.issues[0].message


def test_v5_runs_over_the_family_and_its_corpus(seed: Callable[[str], Family]) -> None:
    """The attestation says V5 passed, so V5 runs here: a corpus family that shares the persona refuses it."""
    family = seed("F02")
    assert ingest_bundle(family, review_of(family), [seed("F01"), seed("F03")]).family_code == "F02"
    clash = seed("F01")
    clash["variants"]["truthful"]["public_packet"]["interview_context"]["subject"]["name"] = "Mara Quell"
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), [clash])
    assert "V5.names" in {i.rule for i in caught.value.issues}


def test_a_revision_needs_its_predecessors_in_the_corpus(seed: Callable[[str], Family]) -> None:
    """Without r1 the reuse of r1's case IDs could not be seen; the load is refused, not attested."""
    family = revised(seed("F01"), 3)
    without_f01 = [f for f in DEV if f["family_id"] != "F01"]
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), without_f01)
    assert [(i.rule, i.message) for i in caught.value.issues] == [
        ("CORPUS.predecessor", "revisions [1, 2] of F01 are not in the corpus")
    ]


def test_a_revision_that_keeps_its_predecessors_case_ids_is_refused(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    family["revision"] = 2
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), DEV)
    assert {i.rule for i in caught.value.issues} == {"V5.case_id"}


@pytest.mark.parametrize("split", ["dev", "hidden"])
def test_a_family_without_a_dev_baseline_is_refused(split: str, seed: Callable[[str], Family]) -> None:
    """A hidden copy of F01 compared with nothing would be attested; the dev baseline is required."""
    family = seed("F01")
    if split == "hidden":
        family.update(family_id="Hc00000000a", split="hidden")
        family["provenance"].update(
            method="generator",
            generator_model="m",
            prompt_sha256="0" * 64,
            seed_spec_sha256="0" * 64,
            few_shot_family_ids=["F02"],
        )
        for variant in ("truthful", "deceptive"):
            family["variants"][variant]["evaluator_packet"]["family_id"] = "Hc00000000a"
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), [])
    assert [i.rule for i in caught.value.issues] == ["CORPUS.dev_baseline"]
    if split == "hidden":
        with pytest.raises(FamilyLoadError) as caught:
            ingest_bundle(family, review_of(family), DEV)
        assert {"V5.names", "V5.lexical", "V5.facility"} <= {i.rule for i in caught.value.issues}


def test_a_revisions_own_predecessor_is_not_a_dev_baseline(seed: Callable[[str], Family]) -> None:
    """Only another lineage gives V5 something to compare names, signatures and text with."""
    family = revised(seed("F01"), 2)
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), [seed("F01")])
    assert [i.rule for i in caught.value.issues] == ["CORPUS.dev_baseline"]
