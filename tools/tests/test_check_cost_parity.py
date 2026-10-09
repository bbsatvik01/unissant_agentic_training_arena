"""check_cost_parity.py (WP-01 stub): cost_model.py --plan-json must run and print parseable JSON.
The full ceiling-parity gate (S5 3.6, 4.9) lands in WP-05."""

from pathlib import Path

import pytest

from tools import check_cost_parity as cp
from tools.tests.conftest import REPO_ROOT


def test_parses_a_real_plan_object() -> None:
    parsed = cp.parse_plan_json('{"global": {"parent": null, "ceiling_usd": 74.0}}')
    assert parsed == {"global": {"parent": None, "ceiling_usd": 74.0}}


@pytest.mark.gateproof
def test_non_json_output_fails() -> None:
    with pytest.raises(cp.CostParityError, match="did not print valid JSON"):
        cp.parse_plan_json("not json at all")


@pytest.mark.gateproof
def test_empty_object_fails() -> None:
    with pytest.raises(cp.CostParityError, match="non-empty JSON object"):
        cp.parse_plan_json("{}")


@pytest.mark.gateproof
def test_a_json_array_is_not_a_plan_object() -> None:
    with pytest.raises(cp.CostParityError, match="non-empty JSON object"):
        cp.parse_plan_json("[1, 2, 3]")


@pytest.mark.gateproof
def test_missing_cost_model_fails(tmp_path: Path) -> None:
    with pytest.raises(cp.CostParityError, match="is missing"):
        cp.run_plan_json(tmp_path)


@pytest.mark.gateproof
def test_a_cost_model_that_exits_nonzero_fails(tmp_path: Path) -> None:
    broken = tmp_path / cp.COST_MODEL_PATH
    broken.parent.mkdir(parents=True)
    broken.write_text("import sys\nsys.exit(1)\n")
    with pytest.raises(cp.CostParityError, match="exited 1"):
        cp.run_plan_json(tmp_path)


@pytest.mark.gateproof
def test_a_cost_model_that_prints_garbage_fails(tmp_path: Path) -> None:
    broken = tmp_path / cp.COST_MODEL_PATH
    broken.parent.mkdir(parents=True)
    broken.write_text("print('not json')\n")
    assert cp.main(["--root", str(tmp_path)]) == 1


def test_the_real_cost_model_passes() -> None:
    assert cp.main(["--root", str(REPO_ROOT)]) == 0


def test_the_real_cost_model_plan_json_round_trips() -> None:
    parsed = cp.parse_plan_json(cp.run_plan_json(REPO_ROOT))
    assert "global" in parsed
