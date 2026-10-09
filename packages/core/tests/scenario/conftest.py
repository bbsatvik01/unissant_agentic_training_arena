"""Shared fixtures for the scenario-engine tests: the committed development families and their sources.

Families are read from `cases/dev/` (F01-F09; F01-F03 are also the spec's seed files, whose hashes S1 11
publishes) and their sources from `cases/dev/sources/`.
"""

from __future__ import annotations

import copy
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from arena_core.scenario.load import read_family_file

REPO_ROOT = Path(__file__).resolve().parents[4]
SPEC_SEED_DIR = REPO_ROOT / "docs" / "spec" / "seed-families"
SPEC_SCHEMA_DIR = REPO_ROOT / "docs" / "spec" / "schemas"
SEED_DIR = REPO_ROOT / "cases" / "dev"
SOURCE_DIR = SEED_DIR / "sources"
SEED_IDS = ("F01", "F02", "F03")
DEV_IDS = ("F01", "F02", "F03", "F04", "F05", "F06", "F07", "F08", "F09")


def read_family(family_id: str) -> dict[str, Any]:
    return read_family_file(SEED_DIR / f"{family_id}.json")


_SEEDS = {fid: read_family(fid) for fid in DEV_IDS}


@pytest.fixture
def seed() -> Callable[[str], dict[str, Any]]:
    """A fresh deep copy of a committed development family, safe to mutate."""

    def _copy(family_id: str) -> dict[str, Any]:
        return copy.deepcopy(_SEEDS[family_id])

    return _copy


@pytest.fixture
def seeds() -> list[dict[str, Any]]:
    return [copy.deepcopy(_SEEDS[fid]) for fid in SEED_IDS]


@pytest.fixture
def dev_families() -> list[dict[str, Any]]:
    return [copy.deepcopy(_SEEDS[fid]) for fid in DEV_IDS]


@pytest.fixture
def source_text() -> Callable[[str], str]:
    def _read(family_id: str) -> str:
        return (SOURCE_DIR / f"{family_id}.source.json").read_text(encoding="utf-8")

    return _read


@pytest.fixture
def source_dict() -> Callable[[str], dict[str, Any]]:
    def _read(family_id: str) -> dict[str, Any]:
        return read_family_file(SOURCE_DIR / f"{family_id}.source.json")

    return _read
