"""The database test of the candidate hash (supabase/tests/002b_candidate_hash.sql) asserts the values Python
computes, so the stored `arena.candidates.sha256` is S2 3.2's manifest hash on both sides."""

from __future__ import annotations

import json
import re

from arena_core.agents.manifests import INITIAL, manifest_sha256, official_manifests
from arena_core.agents.templates import REPO_ROOT
from arena_core.ids import canonical_json

SQL = (REPO_ROOT / "supabase" / "tests" / "002b_candidate_hash.sql").read_text(encoding="utf-8")


def _literals() -> list[str]:
    """Every SQL string literal outside comment lines."""
    code = "\n".join(line for line in SQL.split("\n") if not line.lstrip().startswith("--"))
    return [m.replace("''", "'") for m in re.findall(r"'((?:[^']|'')*)'", code)]


def test_the_canonical_json_fixture_matches_python() -> None:
    literals = _literals()
    fixture = next(s for s in literals if s.startswith('{"b"'))
    value = json.loads(fixture)
    assert canonical_json(value) in literals
    assert manifest_sha256(value) in literals
    assert chr(0x2028) in fixture
    assert "\\u0001" in fixture


def test_the_a1_manifest_and_its_hash_are_the_official_1_0_0_ones() -> None:
    """The fixture is the official A1 as release 1.0.0 builds it (the row registered on the hosted project); the
    1.1.0 manifest differs only in prompt files, version and lineage, which the same hash rule covers."""
    a1 = official_manifests(release=INITIAL)["A1"]
    literals = _literals()
    assert canonical_json(a1.model_dump(mode="json", exclude={"frozen_at"})) in literals
    assert a1.sha256 == manifest_sha256(a1)
    assert a1.sha256 in literals
