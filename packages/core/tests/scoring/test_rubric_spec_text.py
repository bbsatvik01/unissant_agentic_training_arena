"""rubric.v1's own text must never drift from spec S3 2.3-2.7 (the 22 checks 1a-5e and the five dimensions'
anchors). This module parses the S3 markdown tables directly out of `docs/spec/S3-scoring-rubrics-metrics.md`
and asserts `arena_core.scoring.rubric`'s canonical dicts match every cell verbatim, so an edit on either side
without the other fails here -- the gap this guards against is `services/referee`'s former development
placeholder ("placeholder text of 3a"), which drifted from the spec by construction because nothing checked it
against anything."""

from __future__ import annotations

import re

from arena_core.agents.templates import REPO_ROOT
from arena_core.scoring import rubric

SPEC = (REPO_ROOT / "docs/spec/S3-scoring-rubrics-metrics.md").read_text(encoding="utf-8")
# Section 2 only (EVL-7 investigator rubric); section 3 (EVL-8) uses an unrelated table shape.
SECTION_2 = SPEC.split("\n## 2. EVL-7 investigator rubric\n", 1)[1].split("\n## 3. ", 1)[0]

DIMENSION_HEADING = re.compile(r"^### 2\.\d Dimension \d: (?P<name>.+)$", re.M)
CHECK_TABLE_HEADER = "| Check | Applicable | Passes when | Determined by |\n| --- | --- | --- | --- |\n"
ANCHOR_TABLE_HEADER = "| Score | Anchor |\n| --- | --- |\n"
CHECK_ROW = re.compile(r"^\| (?P<id>[1-5][a-e]) (?P<name>.+?) \| (?P<applic>.+?) \| (?P<passes>.+?) \| (?P<by>.+?) \|$")
ANCHOR_ROW = re.compile(r"^\| (?P<score>[0-4]) \| (?P<text>.+?) \|$")
DIMENSION_COUNT = 5
TOTAL_CHECKS = 22


def _table_rows(body: str, header: str) -> list[str]:
    """Every `| ... |` row of the one table in `body` that starts with `header`, stopping at the first blank
    line (markdown tables are contiguous line blocks)."""
    start = body.index(header) + len(header)
    rest = body[start:]
    end = rest.index("\n\n") if "\n\n" in rest else len(rest)
    return [line for line in rest[:end].splitlines() if line.strip()]


def _dimension_bodies() -> list[tuple[str, str, str]]:
    """(dim_id, name, text up to the next dimension heading or end of section) for D1..D5, in spec order."""
    headings = list(DIMENSION_HEADING.finditer(SECTION_2))
    found = len(headings)
    assert found == DIMENSION_COUNT, f"expected {DIMENSION_COUNT} dimension headings in S3 2, found {found}"
    out = []
    for i, m in enumerate(headings):
        dim_id = f"D{i + 1}"
        end = headings[i + 1].start() if i + 1 < len(headings) else len(SECTION_2)
        out.append((dim_id, m.group("name"), SECTION_2[m.end() : end]))
    return out


def test_rubric_v1_text_matches_the_s3_table_verbatim() -> None:
    """S3 2.3-2.7's "Check | Applicable | Passes when | Determined by" tables, parsed cell by cell, equal
    `CHECK_NAME`, `CHECK_APPLICABILITY` (None for "Always"), `CHECK_PASSES_WHEN` and `CHECK_DETERMINED_BY`."""
    names, applic, passes, by = {}, {}, {}, {}
    for dim_id, dim_name, body in _dimension_bodies():
        assert rubric.DIMENSION_NAMES[dim_id] == dim_name
        rows = _table_rows(body, CHECK_TABLE_HEADER)
        assert rows, f"{dim_id}: no check table rows found"
        for line in rows:
            m = CHECK_ROW.match(line)
            assert m, f"{dim_id}: unparseable check row: {line}"
            cid = m["id"]
            assert cid[0] == dim_id[1], f"{cid} parsed under {dim_id}"
            names[cid] = m["name"]
            applic[cid] = None if m["applic"] == "Always" else m["applic"]
            passes[cid] = m["passes"]
            by[cid] = m["by"]
    all_ids = {c for cs in rubric.CHECKS.values() for c in cs}
    assert set(names) == all_ids, f"parsed {sorted(names)} vs. registry {sorted(all_ids)}"
    assert names == rubric.CHECK_NAME
    assert applic == rubric.CHECK_APPLICABILITY
    assert passes == rubric.CHECK_PASSES_WHEN
    assert by == rubric.CHECK_DETERMINED_BY


def test_rubric_v1_anchors_match_the_s3_table_verbatim() -> None:
    """S3 2.3-2.7's "Score | Anchor" tables, reordered ascending (index 0 = score 0), equal `DIMENSION_ANCHORS`."""
    for dim_id, _name, body in _dimension_bodies():
        rows = _table_rows(body, ANCHOR_TABLE_HEADER)
        assert rows, f"{dim_id}: no anchor table rows found"
        by_score: dict[int, str] = {}
        for line in rows:
            m = ANCHOR_ROW.match(line)
            assert m, f"{dim_id}: unparseable anchor row: {line}"
            by_score[int(m["score"])] = m["text"]
        assert set(by_score) == {0, 1, 2, 3, 4}, f"{dim_id}: scores {sorted(by_score)}"
        assert tuple(by_score[i] for i in range(5)) == rubric.DIMENSION_ANCHORS[dim_id]


def test_the_registry_covers_every_parsed_check_once() -> None:
    assert sum(len(ids) for ids in rubric.CHECKS.values()) == TOTAL_CHECKS
    for dim_id, ids in rubric.CHECKS.items():
        assert all(cid[0] == dim_id[1] for cid in ids)
    assert {cid for ids in rubric.CHECKS.values() for cid in ids} == set(rubric.CHECK_NAME)
