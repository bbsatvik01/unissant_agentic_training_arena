"""Shared paths for the contract tests: the repository's `contracts/` directory and its fixtures."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[4]
CONTRACTS_DIR = REPO_ROOT / "contracts"
FIXTURES_DIR = CONTRACTS_DIR / "fixtures"


def load_fixture(name: str) -> dict[str, Any]:
    parsed = json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))
    assert isinstance(parsed, dict)
    return parsed
