"""Small shared rules: turn identifiers (S2 1, C-16), the S1 table rule on the wire, review label reasons."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from arena_core.contracts.common import turn_id, turn_no
from arena_core.contracts.events import Content
from arena_core.contracts.review import LabelVerdict


def test_turn_ids_and_numbers_round_trip() -> None:
    assert [turn_id(n) for n in (1, 7, 12)] == ["t01", "t07", "t12"]
    assert [turn_no(turn_id(n)) for n in range(1, 13)] == list(range(1, 13))


def test_every_table_row_has_one_cell_per_column() -> None:
    Content.model_validate({"body": "Log.", "table": {"columns": ["a", "b"], "rows": [["1", "2"]]}})
    Content.model_validate({"body": "Log."})
    with pytest.raises(ValidationError, match="one cell per column"):
        Content.model_validate({"body": "Log.", "table": {"columns": ["a", "b"], "rows": [["1"]]}})


def test_a_rater_label_carries_exactly_its_reason() -> None:
    checks = {
        "no_contradiction": True,
        "no_invention": True,
        "uncertainty_respected": True,
        "disclosure_policy_respected": True,
        "in_character": True,
        "platform_attack": False,
    }
    LabelVerdict.model_validate(
        {"turn_id": "t02", "label": "evasion", "eva_subtype": "stall", "pfq_reason": None, **checks}
    )
    with pytest.raises(ValidationError, match="eva_subtype"):
        LabelVerdict.model_validate(
            {"turn_id": "t02", "label": "evasion", "eva_subtype": None, "pfq_reason": None, **checks}
        )
