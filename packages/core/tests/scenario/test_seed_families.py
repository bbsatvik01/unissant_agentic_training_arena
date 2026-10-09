"""S1 acceptance on the repository's development families (AC-S1-01..03, 05..07, 09, 12..15, 17, 25, 28).

The development split is `cases/dev/F01..F09.json` (F01-F03 are also the spec's seed files,
`docs/spec/seed-families/`, S1 11); CI reruns V1-V5 on every development family (S1 8.5).
"""

from __future__ import annotations

import json
import re
from collections import Counter
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from arena_core.ids import StrictJSONError, canonical_sha256
from arena_core.scenario.assemble import assemble_file
from arena_core.scenario.load import read_family_file
from arena_core.scenario.validators import Issue, compute_knobs, issue_counts, validate_families, validate_family
from arena_core.scenario.validators.v1 import check_schema

REPO_ROOT = Path(__file__).resolve().parents[4]
SEED_DIR = REPO_ROOT / "docs" / "spec" / "seed-families"
CASES_DEV = REPO_ROOT / "cases" / "dev"
S1_SPEC = REPO_ROOT / "docs" / "spec" / "S1-scenario-engine.md"
SEED_IDS = ("F01", "F02", "F03")
DEV_IDS = (*SEED_IDS, "F04", "F05", "F06", "F07", "F08", "F09")
Family = dict[str, Any]


def repository_families(*dirs: Path) -> dict[str, tuple[Path, Family]]:
    """Every committed development family by ID, read strictly; a family in both places must be the same."""
    found: dict[str, tuple[Path, Family]] = {}
    for path in [p for d in (dirs or (SEED_DIR, CASES_DEV)) for p in sorted(d.glob("F*.json"))]:
        family = read_family_file(path)
        fid = str(family["family_id"])
        if fid in found:
            assert canonical_sha256(found[fid][1]) == canonical_sha256(family), f"{fid} differs between copies"
            continue
        found[fid] = (path, family)
    return found


def test_the_repository_reader_refuses_a_duplicate_key(tmp_path: Path) -> None:
    """A family file with a duplicate key must fail the gate, not hash or validate as one of its readings."""
    text = (SEED_DIR / "F01.json").read_text(encoding="utf-8")
    (tmp_path / "F01.json").write_text(text.replace('"split": "dev",', '"split": "dev",\n  "split": "hidden",', 1))
    with pytest.raises(StrictJSONError, match="duplicate object key 'split'"):
        repository_families(tmp_path)


def test_the_repository_holds_the_nine_development_families() -> None:
    assert sorted(repository_families()) == list(DEV_IDS)


def test_every_development_family_passes_v1_to_v5_together() -> None:
    """AC-S1-01 (V1 over every dev family), AC-S1-02 (V2), AC-S1-03 (V3a) and V4, V5 across the split."""
    families = [family for _path, family in repository_families().values()]
    assert all(f["split"] == "dev" for f in families)
    issues = validate_families(families)
    assert issues == [], [str(i) for i in issues]


def test_every_committed_source_rebuilds_its_family() -> None:
    """A family's source and its committed file never drift (S1 8.4: same source, same family)."""
    families = repository_families()
    rebuilt = set()
    for path in sorted((CASES_DEV / "sources").glob("*.source.json")):
        family = assemble_file(path)  # with the authoring context beside it, when one is committed
        committed = families[str(family["family_id"])][1]
        assert canonical_sha256(family) == canonical_sha256(committed), path
        rebuilt.add(family["family_id"])
    assert sorted(rebuilt) == list(DEV_IDS)


@pytest.mark.parametrize("family_id", SEED_IDS)
def test_seed_repository_hash_matches_s1_section_11(family_id: str) -> None:
    published = dict(re.findall(r"(F0[1-3]) `([0-9a-f]{64})`", S1_SPEC.read_text(encoding="utf-8")))
    assert canonical_sha256(read_family_file(SEED_DIR / f"{family_id}.json")) == published[family_id]


# S1 11, first table: level and knobs K, E, M, U, G.
KNOBS = {"F01": (2, (3, 1, 3, 2, 3)), "F02": (1, (2, 1, 2, 1, 2)), "F03": (3, (5, 2, 2, 2, 4))}
# S1 11, second table: case IDs (truthful, deceptive), fact counts (T, D), deceptive ledger classes.
CASES = {
    "F01": (("C-7Q2MXK4D", "C-H3N8RW5B"), (22, 24), {"FREE": 13, "HOLD": 2, "CORE": 3}),
    "F02": (("C-K9TB2ZQF", "C-4XVM7HPA"), (19, 22), {"FREE": 10, "PRIVATE": 1, "HOLD": 2, "CORE": 3}),
    "F03": (("C-R6DJ3NWC", "C-PA8E5TKY"), (17, 18), {"FREE": 11, "PRIVATE": 1, "HOLD": 3, "CORE": 3}),
}
GATES = {
    "F01": [("g:01", ["f:44"], 3), ("g:02", ["f:49"], 4)],
    "F02": [("g:01", ["f:40"], 2), ("g:02", ["f:46"], 3)],
    "F03": [("g:01", ["f:43"], 4), ("g:02", ["f:44"], 4), ("g:03", ["f:40"], 4)],
}


@pytest.mark.parametrize("family_id", SEED_IDS)
def test_seed_matches_the_s1_section_11_tables(family_id: str, seed: Callable[[str], Family]) -> None:
    """AC-S1-14: computed knobs equal stored knobs and S1 11; the case table holds."""
    family = seed(family_id)
    level, knobs = KNOBS[family_id]
    assert family["difficulty"]["level"] == level
    assert tuple(compute_knobs(family).as_dict().values()) == knobs == tuple(family["difficulty"]["knobs"].values())
    case_ids, fact_counts, classes = CASES[family_id]
    assert (family["variants"]["truthful"]["case_id"], family["variants"]["deceptive"]["case_id"]) == case_ids
    counts = tuple(len(family["variants"][v]["evaluator_packet"]["canonical_facts"]) for v in ("truthful", "deceptive"))
    assert counts == fact_counts
    ledger = family["variants"]["deceptive"]["private_packet"]["facts"]
    assert Counter(k["class"] for k in ledger) == classes
    gates = family["variants"]["deceptive"]["private_packet"]["gates"]
    assert [(g["id"], g["opens"], g["min_evidence_level"]) for g in gates] == GATES[family_id]


@pytest.mark.parametrize("family_id", DEV_IDS)
def test_seed_structural_acceptance(family_id: str, seed: Callable[[str], Family]) -> None:
    """AC-S1-05, 06, 07, 09, 12, 15, 28 checked directly on the file, independent of the validator code."""
    family = seed(family_id)
    variants = family["variants"]
    publics = [variants[v]["public_packet"] for v in ("truthful", "deceptive")]
    # AC-S1-12 and AC-S1-28: public packets equal except case_id; one presentation; display name; no style key.
    assert {k: v for k, v in publics[0].items() if k != "case_id"} == {
        k: v for k, v in publics[1].items() if k != "case_id"
    }
    assert set(publics[0]["presentation"]) == {"persona_id", "display_name", "voice_id"}
    assert publics[0]["presentation"]["display_name"] == publics[0]["interview_context"]["subject"]["name"]
    style_like = {"style", "demeanor", "baseline_demeanor", "verbosity", "fluency", "affect", "register", "language"}
    assert not style_like & set(_keys(publics[0]))
    for variant in ("truthful", "deceptive"):
        private, evaluator = variants[variant]["private_packet"], variants[variant]["evaluator_packet"]
        # AC-S1-15: one style per family.
        assert private["style"] == family["style"]
        # AC-S1-05: ledger facts are canonical facts; approximate facts have exactly one range/unsure entry.
        canonical = {f["id"] for f in evaluator["canonical_facts"]}
        assert {k["id"] for k in private["facts"]} <= canonical
        approximate = sorted(k["id"] for k in private["facts"] if k["certainty"] == "approximate")
        assert approximate == sorted(u["fact_id"] for u in private["uncertainty"])
        # AC-S1-07: resolution equals the role; decisive item, corroboration, unsupported grounds, label guide.
        criteria = evaluator["resolution_criteria"]
        assert criteria["correct_finding"] == evaluator["role"] == variant
        assert criteria["decisive_support"]
        assert criteria["corroboration_to_name"]
        assert len(criteria["unsupported_grounds"]) >= MIN_GUIDE_ENTRIES
        assert len(evaluator["turn_label_guide"]) >= MIN_GUIDE_ENTRIES
        # AC-S1-09: predicates at most 10, at most 6 releasable records.
        releasable = [a for a in evaluator["evidence_artifacts"] if a["release"]["type"] != "initial"]
        assert len(releasable) <= MAX_RELEASES
        assert all(a["release"]["after_exchanges"] <= MAX_PREDICATE for a in releasable)
    # AC-S1-05 and AC-S1-06 on the deceptive variant: the violation is CORE; preconditions non-empty.
    deceptive = variants["deceptive"]
    violation = [f["id"] for f in deceptive["evaluator_packet"]["canonical_facts"] if "violation" in f["tags"]]
    assert [k["class"] for k in deceptive["private_packet"]["facts"] if k["id"] in violation] == ["CORE"]
    assert all(g["precondition_records"] for g in deceptive["private_packet"]["gates"])


MIN_GUIDE_ENTRIES = 2  # AC-S1-07: at least two label-guide entries; schema: at least two unsupported grounds
MAX_RELEASES = 6
MAX_PREDICATE = 10


def _keys(obj: object) -> list[str]:
    if isinstance(obj, dict):
        return [k for key, value in obj.items() for k in (str(key), *_keys(value))]
    if isinstance(obj, list):
        return [k for value in obj for k in _keys(value)]
    return []


def test_f01_carries_the_slide_8_exchange_path(seed: Callable[[str], Family]) -> None:
    """AC-S1-25 (EX-1 to EX-3; S1 11.1): "It was a busy shift" is `evasion` in both variants (labels follow
    content, never role), and a truthful Pell who gives the purpose is `responsive`."""
    family = seed("F01")
    for variant in ("truthful", "deceptive"):
        evaluator = family["variants"][variant]["evaluator_packet"]
        q01 = next(q for q in evaluator["rubric"]["key_questions"] if q["id"] == "q:01")
        assert q01["neutral_example"] == "What task required entry?"  # EX-2's follow-up, verbatim
        busy = [g for g in evaluator["turn_label_guide"] if "'It was a busy shift'" in g["situation"]]
        assert [g["label"] for g in busy] == ["evasion"]
        kinds = {a["artifact_id"]: a["kind"] for a in evaluator["evidence_artifacts"]}
        named = {kinds[a] for a in evaluator["resolution_criteria"]["corroboration_to_name"]}
        assert {"work_order", "dispatch_log"} <= named


def test_validate_family_reports_a_non_object_at_the_root() -> None:
    issues = validate_family(["not", "a", "family"])
    assert [i.rule for i in issues] == ["V1.schema"]
    assert issues[0].path == ""
    assert issues[0].message.startswith("<root>:")


def test_schema_errors_stop_the_later_validators(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    family["variants"]["truthful"]["public_packet"].pop("ground_rules")
    issues = validate_family(family)
    assert issues == check_schema(family)
    assert {i.rule for i in issues} == {"V1.schema"}


def test_v5_runs_only_over_schema_valid_families(seeds: list[Family]) -> None:
    broken = json.loads(json.dumps(seeds[0]))
    broken["schema_version"] = "0.9"
    issues = validate_families([broken, seeds[0], seeds[1]])
    assert {i.rule for i in issues} == {"V1.schema"}  # no V5.family_id for F01 appearing twice


def test_issue_counts_hold_codes_and_counts_only(seed: Callable[[str], Family]) -> None:
    family = seed("F01")
    family["variants"]["deceptive"]["private_packet"]["style"]["affect"] = "calm"
    family["variants"]["truthful"]["evaluator_packet"]["resolution_criteria"]["correct_finding"] = "deceptive"
    counts = issue_counts(validate_family(family))
    assert counts == {"V2.correct_finding": 1, "V2.style": 1}
    assert list(counts) == sorted(counts)


def test_issue_text_names_the_rule_family_and_variant() -> None:
    issue = Issue("V2.style", "private style differs", "F01", "deceptive")
    assert issue.validator == "V2"
    assert str(issue) == "V2.style [F01/deceptive] private style differs"
    assert str(Issue("V5.names", "persona name reused")) == "V5.names persona name reused"


def test_schema_issues_of_a_family_without_a_string_id_carry_no_id() -> None:
    issues = check_schema({"family_id": 5})
    assert issues
    assert all(i.family_id is None for i in issues)
