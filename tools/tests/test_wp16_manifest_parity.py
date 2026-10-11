"""`tools.wp16_manifest_parity` (AC-S3-4.2, WP-16): the usage error, a matching rebuild, and a mismatch,
without a database -- `012_reveal_manifest.sql` is the real cross-process proof (its own report, not
pytest's coverage)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.wp16_manifest_parity import main

USAGE_ERROR = 2
MISMATCH_EXIT = 1
# The sha256 build_manifest/manifest_hash (arena_core.scoring.inclusion) give this exact fixture, pinned by
# a scratch run; a deliberately wrong hash below proves the mismatch path.
MATCHING_HASH = "ce27168eb3bf0bd8d76addce30951d82c41d701e7f8bafaf63f21f325d56b573"


def write_fixture(path: Path, *, manifest_sha256: str) -> None:
    path.write_text(
        json.dumps(
            {
                "tournament_id": "7c1e0f52-3a4b-4c5d-8e6f-0a1b2c3d4e5f",
                "manifest_version": 1,
                "roster_hash": "1" * 64,
                "corpus_seal_hash": None,
                "hidden_seal_hash": None,
                "manifest_sha256": manifest_sha256,
                "rows": [
                    {
                        "planned_trial_id": "a0000001-0000-4000-8000-000000000001",
                        "track": "interactive",
                        "assistant_id": "a1111111-1111-4111-8111-111111111111",
                        "subject_id": "51111111-1111-4111-8111-111111111111",
                        "family_id": "F01",
                        "variant_id": "F01-T",
                        "role": "truthful",
                        "repeat": 1,
                        "block_id": "B1",
                        "exec_state": "completed",
                        "adjudication_id": "ad000001-0000-4000-8000-000000000001",
                        "verdict": "valid",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )


def test_wrong_argument_count_is_a_usage_error() -> None:
    assert main(["prog"]) == USAGE_ERROR
    assert main(["prog", "a", "b"]) == USAGE_ERROR


def test_a_matching_hash_prints_match_and_exits_zero(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    fixture = tmp_path / "manifest.json"
    write_fixture(fixture, manifest_sha256=MATCHING_HASH)
    assert main(["prog", str(fixture)]) == 0
    assert capsys.readouterr().out == "MATCH\n"


def test_a_mismatched_hash_prints_a_diagnostic_and_exits_one(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    fixture = tmp_path / "manifest.json"
    write_fixture(fixture, manifest_sha256="0" * 65)
    assert main(["prog", str(fixture)]) == MISMATCH_EXIT
    assert capsys.readouterr().out.startswith("MISMATCH: python=")
