"""Validity proposal, inclusion and the sealed manifest (S3 4.2-4.4): AC-S3-4.1, 4.2 (Python half), FX-V01 to
FX-V03, FX-A04 to FX-A08, FX-M01 to FX-M03."""

from __future__ import annotations

import itertools
import json
from pathlib import Path
from typing import Any

import pytest

from arena_core.scoring.inclusion import (
    AsstInc,
    Exec,
    ManifestError,
    ManifestHeader,
    PlannedRow,
    RevealBlockedError,
    SubjInc,
    block_invalid,
    build_manifest,
    inclusion,
    manifest_hash,
    material_fact_ids,
    propose_validity,
)

from .builders import judgment, report

REPO = Path(__file__).resolve().parents[4]

# ---------------------------------------------------------------- AC-S3-4.1: the inclusion table, every combination

EXCLUDED = (AsstInc.EXCLUDED, SubjInc.EXCLUDED)


# The S3 4.3 table row by row: (state, verdict, block_invalid) -> expected, "blocked" when reveal is blocked.
FIXED = {
    Exec.INFRA_FAILED: (*EXCLUDED, "infra_failed"),
    Exec.BUDGET_SKIPPED: (*EXCLUDED, "budget_skipped"),
    Exec.BUDGET_TRUNCATED: (*EXCLUDED, "budget_truncated"),
    Exec.SUBJECT_QUARANTINED: (AsstInc.EXCLUDED, SubjInc.AGAINST_SUBJECT, "subject_quarantined"),
}
REVIEWED = {
    (Exec.COMPLETED, "valid"): (AsstInc.INCLUDED, SubjInc.COUNTED, "included"),
    (Exec.ASSISTANT_FAILED, "valid"): (
        AsstInc.INCLUDED_AS_INSUFFICIENT,
        SubjInc.COUNTED,
        "assistant_failed_as_insufficient",
    ),
    (Exec.COMPLETED, "subject_invalid"): (AsstInc.EXCLUDED, SubjInc.AGAINST_SUBJECT, "subject_invalid"),
    (Exec.ASSISTANT_FAILED, "subject_invalid"): (AsstInc.EXCLUDED, SubjInc.AGAINST_SUBJECT, "subject_invalid"),
}


def table(state: Exec, verdict: str | None, block: bool) -> tuple[AsstInc, SubjInc, str] | str:
    if state is Exec.SOURCE_UNAVAILABLE:
        return (*EXCLUDED, "source_unavailable")
    if block:
        return (*EXCLUDED, "block_invalid_infra")
    if state in FIXED:
        return FIXED[state]
    return REVIEWED.get((state, verdict or ""), "blocked")


@pytest.mark.parametrize(
    ("state", "verdict", "block"), list(itertools.product(Exec, (None, "valid", "subject_invalid"), (False, True)))
)
def test_ac_s3_4_1_every_state_verdict_and_block_combination(state: Exec, verdict: str | None, block: bool) -> None:
    expected = table(state, verdict, block)
    if expected == "blocked":
        with pytest.raises(RevealBlockedError):
            inclusion(state, verdict, block)
    else:
        assert inclusion(state, verdict, block) == expected


def test_an_unknown_verdict_is_refused() -> None:
    with pytest.raises(ValueError, match="unknown validity verdict"):
        inclusion(Exec.COMPLETED, "maybe", block_invalid=False)


def test_fx_a04_assistant_failed_with_valid_is_included_as_insufficient() -> None:
    assert inclusion(Exec.ASSISTANT_FAILED, "valid", block_invalid=False)[0] is AsstInc.INCLUDED_AS_INSUFFICIENT


def test_fx_a05_failure_plus_invalid_subject_is_excluded_for_the_assistant_and_against_the_subject() -> None:
    assert inclusion(Exec.ASSISTANT_FAILED, "subject_invalid", block_invalid=False)[:2] == (
        AsstInc.EXCLUDED,
        SubjInc.AGAINST_SUBJECT,
    )


def test_fx_a07_one_infra_failure_invalidates_an_18_trial_block() -> None:
    assert block_invalid([Exec.INFRA_FAILED] + [Exec.COMPLETED] * 17)
    assert not block_invalid([Exec.COMPLETED] * 18)
    assert not block_invalid([Exec.INFRA_FAILED] + [Exec.COMPLETED] * 20)  # 1/21 is under 5%


# ---------------------------------------------------------------- FX-V01 to FX-V03 (AC-S3-4.5 propose_validity)


def f01_truthful_packet() -> dict[str, Any]:
    family = json.loads((REPO / "docs/spec/seed-families/F01.json").read_text(encoding="utf-8"))
    packet = family["variants"]["truthful"]["evaluator_packet"]
    assert isinstance(packet, dict)
    return packet


def test_material_fact_ids_is_the_projection_of_the_canonical_facts() -> None:
    packet = f01_truthful_packet()
    material = material_fact_ids(packet)
    assert material == {f["id"] for f in packet["canonical_facts"] if f["material"]}
    assert {"f:24"} <= material
    assert not {"f:09", "f:10"} & material


@pytest.mark.parametrize(
    ("turn", "expected", "deciding"),
    [
        # FX-V01: asks for non-material f:09, volunteers a falsehood against material f:24
        (
            judgment(1, requested_fact_ids=["f:09"], no_invention=False, violated_fact_ids=["f:24"]),
            "subject_invalid",
            ["t01"],
        ),
        # FX-V02: the same question; the falsehood is against non-material f:10
        (judgment(1, requested_fact_ids=["f:09"], no_contradiction=False, violated_fact_ids=["f:10"]), "valid", []),
        # FX-V03: a platform attack, no F1 failure
        (judgment(1, platform_attack=True), "subject_invalid", ["t01"]),
        # F6 out of character
        (judgment(1, in_character=False), "subject_invalid", ["t01"]),
        # F2-F4 failures lower fidelity but never invalidate
        (judgment(1, disclosure_policy_respected=False, uncertainty_respected=False), "valid", []),
    ],
)
def test_fx_v01_to_v03_propose_validity(turn: dict[str, object], expected: str, deciding: list[str]) -> None:
    material = material_fact_ids(f01_truthful_packet())
    assert propose_validity(report([turn]), material) == (expected, deciding)


# ---------------------------------------------------------------- the manifest (FX-M01 to FX-M03; AC-S3-4.2)

T = "7c1e0f52-3a4b-4c5d-8e6f-0a1b2c3d4e5f"
A1, S1 = "a1111111-1111-4111-8111-111111111111", "51111111-1111-4111-8111-111111111111"
ROSTER, CORPUS, HIDDEN = "1" * 64, "2" * 64, "3" * 64
ADJ = [
    "ad000001-0000-4000-8000-000000000001",
    "ad000002-0000-4000-8000-000000000002",
    "ad000003-0000-4000-8000-000000000003",
]


def fx_m01_rows() -> list[PlannedRow]:
    """Six planned trials, deliberately out of byte order: two interactive trials of one block, a quarantined
    interactive trial, a replay corpus transcript, a replay trial carrying its source's adjudication, and a
    replay trial whose source is unavailable (C-35)."""
    return [
        PlannedRow(
            "f0000006-0000-4000-8000-000000000006",
            "replay",
            A1,
            None,
            "F01",
            "F01-T",
            "truthful",
            1,
            None,
            Exec.SOURCE_UNAVAILABLE,
            None,
            None,
        ),
        PlannedRow(
            "b0000002-0000-4000-8000-000000000002",
            "interactive",
            A1,
            S1,
            "F01",
            "F01-D",
            "deceptive",
            1,
            "B1",
            Exec.ASSISTANT_FAILED,
            ADJ[1],
            "valid",
        ),
        PlannedRow(
            "a0000001-0000-4000-8000-000000000001",
            "interactive",
            A1,
            S1,
            "F01",
            "F01-T",
            "truthful",
            1,
            "B1",
            Exec.COMPLETED,
            ADJ[0],
            "valid",
        ),
        PlannedRow(
            "c0000003-0000-4000-8000-000000000003",
            "interactive",
            A1,
            S1,
            "F02",
            "F02-T",
            "truthful",
            1,
            "B2",
            Exec.SUBJECT_QUARANTINED,
            None,
            None,
        ),
        PlannedRow(
            "d0000004-0000-4000-8000-000000000004",
            "replay_corpus",
            None,
            S1,
            "F01",
            "F01-D",
            "deceptive",
            1,
            None,
            Exec.COMPLETED,
            ADJ[2],
            "subject_invalid",
        ),
        PlannedRow(
            "e0000005-0000-4000-8000-000000000005",
            "replay",
            A1,
            None,
            "F01",
            "F01-D",
            "deceptive",
            1,
            None,
            Exec.COMPLETED,
            ADJ[2],
            "subject_invalid",
        ),
    ]


HEADER = ManifestHeader(T, 1, None, ROSTER, CORPUS, HIDDEN)
FX_M01_TEXT = (
    f"arena-inclusion-manifest|v1|{T}|1||{ROSTER}|{CORPUS}|{HIDDEN}\n"
    f"a0000001-0000-4000-8000-000000000001|interactive|{A1}|{S1}|F01|F01-T|truthful|1|completed|{ADJ[0]}|valid"
    "|included|counted|included\n"
    f"b0000002-0000-4000-8000-000000000002|interactive|{A1}|{S1}|F01|F01-D|deceptive|1|assistant_failed|{ADJ[1]}"
    "|valid|included_as_insufficient|counted|assistant_failed_as_insufficient\n"
    f"c0000003-0000-4000-8000-000000000003|interactive|{A1}|{S1}|F02|F02-T|truthful|1|subject_quarantined|||excluded"
    "|against_subject|subject_quarantined\n"
    f"d0000004-0000-4000-8000-000000000004|replay_corpus||{S1}|F01|F01-D|deceptive|1|completed|{ADJ[2]}"
    "|subject_invalid||against_subject|subject_invalid\n"
    f"e0000005-0000-4000-8000-000000000005|replay|{A1}||F01|F01-D|deceptive|1|completed|{ADJ[2]}|subject_invalid"
    "|excluded||subject_invalid\n"
    f"f0000006-0000-4000-8000-000000000006|replay|{A1}||F01|F01-T|truthful|1|source_unavailable||"
    "|excluded||source_unavailable\n"
)
FX_M01_SHA256 = "af3fb480c4e1b2f52908563c3d7e4e7b1041990a9ed68d8bf7b3621b6a880644"


def test_fx_m01_the_canonical_text_byte_for_byte() -> None:
    text = build_manifest(HEADER, fx_m01_rows(), roster_size=6)
    assert text == FX_M01_TEXT
    assert manifest_hash(text) == FX_M01_SHA256


@pytest.mark.parametrize("field", ["verdict", "exec_state", "role", "repeat", "adjudication_id"])
def test_fx_m02_changing_one_field_in_one_row_changes_the_hash(field: str) -> None:
    rows = fx_m01_rows()
    changed = {
        "verdict": "subject_invalid",
        "exec_state": Exec.BUDGET_TRUNCATED,
        "role": "deceptive",
        "repeat": 2,
        "adjudication_id": ADJ[2],
    }[field]
    rows[2] = PlannedRow(**{**rows[2].__dict__, field: changed})
    assert manifest_hash(build_manifest(HEADER, rows, 6)) != FX_M01_SHA256


def test_ac_s3_4_2_one_infra_failure_excludes_every_line_of_its_block() -> None:
    rows = [r for r in fx_m01_rows() if r.block_id != "B1"]
    block = [
        PlannedRow(
            f"9{i:07d}-0000-4000-8000-000000000000",
            "interactive",
            A1,
            S1,
            "F03",
            "F03-T",
            "truthful",
            1,
            "B9",
            Exec.INFRA_FAILED if i == 0 else Exec.COMPLETED,
            None if i == 0 else ADJ[0],
            None if i == 0 else "valid",
        )
        for i in range(18)
    ]
    text = build_manifest(HEADER, rows + block, roster_size=len(rows) + 18)
    lines = [ln for ln in text.splitlines() if "|B9|" in ln or "|F03|" in ln]
    assert [ln.split("|")[0] for ln in lines] == sorted(r.planned_trial_id for r in block)
    assert all(ln.endswith("|excluded|excluded|block_invalid_infra") for ln in lines)


def test_fx_m03_a_correction_is_version_2_with_the_parent_hash_and_v1_is_unchanged() -> None:
    v1 = build_manifest(HEADER, fx_m01_rows(), 6)
    rows = fx_m01_rows()
    rows[2] = PlannedRow(**{**rows[2].__dict__, "verdict": "subject_invalid"})  # adjudicated after reveal
    v2 = build_manifest(ManifestHeader(T, 2, manifest_hash(v1), ROSTER, CORPUS, HIDDEN), rows, 6)
    assert v2.splitlines()[0] == f"arena-inclusion-manifest|v1|{T}|2|{manifest_hash(v1)}|{ROSTER}|{CORPUS}|{HIDDEN}"
    assert manifest_hash(v2) != manifest_hash(v1)
    assert build_manifest(HEADER, fx_m01_rows(), 6) == v1 == FX_M01_TEXT


def test_fx_a06_a08_budget_and_source_unavailable_rows_are_listed() -> None:
    rows = fx_m01_rows()
    rows[3] = PlannedRow(**{**rows[3].__dict__, "exec_state": Exec.BUDGET_SKIPPED})
    text = build_manifest(HEADER, rows, 6)
    assert "|budget_skipped|||excluded|excluded|budget_skipped\n" in text
    assert len(text.splitlines()) == len(rows) + 1


def test_a_row_count_other_than_the_roster_blocks_the_manifest() -> None:
    with pytest.raises(ManifestError, match="frozen roster"):
        build_manifest(HEADER, fx_m01_rows(), roster_size=7)


def test_a_separator_inside_a_field_is_refused() -> None:
    rows = fx_m01_rows()
    rows[0] = PlannedRow(**{**rows[0].__dict__, "family_id": "F|01"})
    with pytest.raises(ManifestError, match="separator"):
        build_manifest(HEADER, rows, 6)


def test_a_reviewed_row_without_a_verdict_blocks_the_manifest() -> None:
    rows = fx_m01_rows()
    rows[2] = PlannedRow(**{**rows[2].__dict__, "verdict": None})
    with pytest.raises(RevealBlockedError):
        build_manifest(HEADER, rows, 6)
