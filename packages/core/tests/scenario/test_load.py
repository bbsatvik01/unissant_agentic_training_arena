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
from arena_core.scenario.load import (
    CodexReview,
    FamilyLoadError,
    IngestBundle,
    LegacyCodexReportError,
    codex_review_from_report,
    ingest_bundle,
    is_legacy_codex_report,
)
from arena_core.scenario.schema import schema_enum

Family = dict[str, Any]
SQL = (Path(__file__).resolve().parents[4] / "docs" / "spec" / "sql" / "0002_cases.sql").read_text(encoding="utf-8")
MAX_ARTIFACTS = 6  # AR006
MAX_TURN = 12  # scheduled_turn / request_after_turn between 0 and 12
MAX_TITLE = 200
MAX_SOURCE_BYTES = 524288  # sealed.family_ingests.source
CODEX_RESULTS = {"rounds": 1, "review": "pass", "cx2_truthful": "pass", "cx2_deceptive": "pass", "cx3": "pass"}


DEV_DIR = Path(__file__).resolve().parents[4] / "cases" / "dev"
DEV = load.DevSplit.from_dir(DEV_DIR)  # the comparison corpus: the committed dev split, read whole


def corpus_for(family_id: str) -> load.DevSplit:
    """The development corpus without the family's committed file (for an edited copy of it)."""
    return load.DevSplit(tuple(f for f in DEV.families if f["family_id"] != family_id))


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
        "validator_version": "arena_core.scenario S1 v2.8",  # the S1 version whose V1-V5 ran (F4 is v2.8)
        "checks_passed": sql_required_checks(),
        "codex": CODEX_RESULTS,
    }


@pytest.mark.parametrize(("revision", "code", "supersedes"), [(2, "F01.r2", "F01"), (3, "F01.r3", "F01.r2")])
def test_a_revision_has_its_own_code_and_names_its_predecessor(
    revision: int, code: str, supersedes: str, seed: Callable[[str], Family]
) -> None:
    """S1 8.6 and 4.4: family code `Fnn.rN`; `supersedes` is `Fnn` for r2 and `Fnn.r(N-1)` after that."""
    family = revised(seed("F01"), revision)
    corpus = load.DevSplit((*DEV.families, *(revised(seed("F01"), r) for r in range(2, revision))))
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


REPORTS_DIR = DEV_DIR / "reports"


def legacy_report(family_id: str, **changes: object) -> dict[str, Any]:
    """A copy of the real per-family CX report (`cases/dev/reports/<ID>.cx.json`), optionally mutated."""
    report: dict[str, Any] = json.loads((REPORTS_DIR / f"{family_id}.cx.json").read_text(encoding="utf-8"))
    report.update(changes)
    return report


@pytest.mark.parametrize("family_id", ["F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09"])
def test_codex_review_from_report_reduces_the_real_dev_reports(family_id: str, seed: Callable[[str], Family]) -> None:
    """S1 9.7/10.5: the committed per-family CX report reduces to the attestation's codex object and is
    bound to the committed family file's own hash (never a stale one)."""
    report = legacy_report(family_id)
    assert is_legacy_codex_report(report)
    review = codex_review_from_report(report)
    assert review == CodexReview.model_validate({**CODEX_RESULTS, "family_sha256": report["family_sha256"]})
    assert review.family_sha256 == canonical_sha256(seed(family_id))  # the report is not stale


def test_a_direct_codex_review_is_not_mistaken_for_a_report() -> None:
    assert is_legacy_codex_report({**CODEX_RESULTS, "family_sha256": "0" * 64}) is False


@pytest.mark.parametrize("check", ["cx1", "cx4", "cx2_truthful", "cx2_deceptive", "cx3"])
def test_codex_review_from_report_refuses_a_failed_check(check: str) -> None:
    report = legacy_report("F01", **{check: False})
    with pytest.raises(LegacyCodexReportError):
        codex_review_from_report(report)


def test_codex_review_from_report_refuses_a_review_finding() -> None:
    report = legacy_report("F01", findings=[{"code": "CX-1", "refs": ["f:01"], "note": "x"}])
    with pytest.raises(LegacyCodexReportError):
        codex_review_from_report(report)


def test_codex_review_from_report_refuses_a_pass_summary_that_disagrees_with_its_checks() -> None:
    """Defense in depth: a hand-edited or stale report whose top-level `pass` no longer matches its own
    per-check fields is refused rather than trusted on either field alone."""
    report = legacy_report("F01", cx3=False)  # the per-check field already makes this fail
    report["pass"] = True  # still asserted true, but disagrees with cx3
    with pytest.raises(LegacyCodexReportError):
        codex_review_from_report(report)


def test_codex_review_from_report_refuses_a_missing_hash() -> None:
    report = legacy_report("F01")
    del report["family_sha256"]
    with pytest.raises(LegacyCodexReportError):
        codex_review_from_report(report)


def test_codex_review_from_report_refuses_a_non_integer_rounds() -> None:
    report = legacy_report("F01", rounds="one")
    with pytest.raises(LegacyCodexReportError, match="rounds"):
        codex_review_from_report(report)


def test_codex_review_from_report_refuses_a_malformed_hash() -> None:
    """A `family_sha256` that is not 64 hex characters fails `CodexReview`'s own pattern; the wrapper reports
    it as a report problem (`LegacyCodexReportError`), never a bare `pydantic.ValidationError`."""
    report = legacy_report("F01", family_sha256="not-a-hash")
    with pytest.raises(LegacyCodexReportError, match="malformed CX report"):
        codex_review_from_report(report)


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
    assert ingest_bundle(family, review_of(family), load.DevSplit((seed("F01"), seed("F03")))).family_code == "F02"
    clash = seed("F01")
    clash["variants"]["truthful"]["public_packet"]["interview_context"]["subject"]["name"] = "Mara Quell"
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), load.DevSplit((clash,)))
    assert "V5.names" in {i.rule for i in caught.value.issues}


def test_a_revision_needs_its_predecessors_in_the_corpus(seed: Callable[[str], Family]) -> None:
    """Without r1 the reuse of r1's case IDs could not be seen; the load is refused, not attested."""
    family = revised(seed("F01"), 3)
    without_f01 = corpus_for("F01")
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), without_f01)
    assert [(i.rule, i.message) for i in caught.value.issues] == [
        ("CORPUS.predecessor", "revisions [1, 2] of F01 are not in the dev split")
    ]


def test_a_revision_that_keeps_its_predecessors_case_ids_is_refused(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    family["revision"] = 2
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), DEV)
    assert {i.rule for i in caught.value.issues} == {"V5.case_id"}


def as_hidden(family: Family, family_id: str) -> Family:
    hidden: Family = json.loads(json.dumps(family))
    hidden.update(family_id=family_id, split="hidden")
    hidden["provenance"].update(
        method="generator",
        generator_model="m",
        prompt_sha256="0" * 64,
        seed_spec_sha256="0" * 64,
        few_shot_family_ids=["F02"],
    )
    for variant in ("truthful", "deceptive"):
        hidden["variants"][variant]["evaluator_packet"]["family_id"] = family_id
    return hidden


def test_a_family_without_a_dev_baseline_is_refused(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), load.DevSplit(()))
    assert [i.rule for i in caught.value.issues] == ["CORPUS.dev_baseline"]


def test_a_hidden_family_needs_its_whole_split_and_the_whole_dev_split(seed: Callable[[str], Family]) -> None:
    """A hidden copy of F01 is attested only against the whole dev split, which refuses it (L4), and only
    with the hidden families its sampler record names."""
    family = as_hidden(seed("F01"), "Hc00000000a")
    review = review_of(family)
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review, DEV)
    assert [i.rule for i in caught.value.issues] == ["CORPUS.hidden_split"]
    other = {"assignment": [{"family_id": "Hc00000000a"}, {"family_id": "Hc00000000b"}]}
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review, DEV, (), other)  # the record names a family that is not given
    assert [i.rule for i in caught.value.issues] == ["CORPUS.hidden_split"]
    record = {"assignment": [{"family_id": "Hc00000000a"}]}
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review, DEV, (), record)
    assert {"V5.names", "V5.lexical", "V5.facility"} <= {i.rule for i in caught.value.issues}


def test_a_dev_family_takes_no_hidden_split(seed: Callable[[str], Family]) -> None:
    family = seed("F02")
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), DEV, [as_hidden(seed("F03"), "Hc00000000b")])
    assert [i.rule for i in caught.value.issues] == ["CORPUS.hidden_split"]


@pytest.mark.parametrize(
    ("edit", "where"),
    [
        (lambda f: f.pop("revision"), "family"),
        (lambda f: f.update(revision=10**9), "family"),
        (lambda f: f.clear(), "corpus"),
    ],
)
def test_every_input_is_schema_checked_before_the_corpus_is_read(
    edit: Callable[[Family], object], where: str, seed: Callable[[str], Family]
) -> None:
    family, extra = seed("F02"), seed("F03")
    edit(family if where == "family" else extra)
    corpus = load.DevSplit((*corpus_for("F03").families, extra))
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), corpus)
    assert {i.rule for i in caught.value.issues} == {"V1.schema"}


def test_the_dev_split_is_read_whole_from_its_directory(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load.DevSplit.from_dir(tmp_path)
    assert sorted(f["family_id"] for f in DEV.families) == [f"F0{i}" for i in range(1, 10)]


def test_a_revisions_own_predecessor_is_not_a_dev_baseline(seed: Callable[[str], Family]) -> None:
    """Only another lineage gives V5 something to compare names, signatures and text with."""
    family = revised(seed("F01"), 2)
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), load.DevSplit((seed("F01"),)))
    assert [i.rule for i in caught.value.issues] == ["CORPUS.dev_baseline"]


@pytest.mark.parametrize("split", ["dev", "hidden"])
def test_every_lineage_in_the_dev_split_has_its_whole_history(split: str, seed: Callable[[str], Family]) -> None:
    """A dev split holding F01 r2 without r1 hides r1's text and case IDs from V5, for any family ingested."""
    without_r1 = load.DevSplit((*corpus_for("F01").families, revised(seed("F01"), 2)))
    family = seed("F02") if split == "dev" else as_hidden(seed("F02"), "Hc00000000a")
    record = None if split == "dev" else {"assignment": [{"family_id": "Hc00000000a"}]}
    dev = load.DevSplit(tuple(f for f in without_r1.families if f["family_id"] != "F02"))
    with pytest.raises(FamilyLoadError) as caught:
        ingest_bundle(family, review_of(family), dev, (), record)
    assert [(i.rule, i.message) for i in caught.value.issues] == [
        ("CORPUS.predecessor", "revisions [1] of F01 are not in the dev split")
    ]
