"""The finding the database test commits (supabase/tests/002a_finding_contract.sql, FN-02) is exactly the shared
contract's stored investigator finding, so the database accepts what the contract produces (S2 4.8, S5 5.4)."""

from __future__ import annotations

from arena_core.contracts.findings import InvestigatorFinding
from arena_core.ids import canonical_json

from .conftest import REPO_ROOT


def test_the_database_test_commits_the_contracts_stored_finding() -> None:
    body = InvestigatorFinding.model_validate(
        {
            "label": "insufficient_evidence",
            "likelihood": "roughly_even_chance",
            "confidence": "low",
            "basis_flag_refs": [],
            "cited_turns": [],
            "cited_records": ["rec-02"],
            "corroboration_needed": ["the work order"],
            "rationale": "The reason for entry is not yet established.",
        }
    )
    stored = canonical_json(body.stored().model_dump(mode="json"))
    assert '"alternative_explanations":null' in stored
    sql = (REPO_ROOT / "supabase" / "tests" / "002a_finding_contract.sql").read_text(encoding="utf-8")
    assert f"'{stored}'::jsonb" in sql
