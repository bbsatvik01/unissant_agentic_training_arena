"""`FamilySource`: the typed source model (S1 8.3) reads the kit's JSON form strictly."""

from __future__ import annotations

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from arena_core.ids import StrictJSONError
from arena_core.scenario import source as src

Source = dict[str, Any]


@pytest.mark.parametrize("family_id", ["F01", "F02", "F03"])
def test_the_seed_sources_load(family_id: str, source_text: Callable[[str], str]) -> None:
    loaded = src.parse_source_text(source_text(family_id))
    assert loaded.family.family_id == family_id
    assert loaded.variants.truthful.concealment_target is None
    assert loaded.variants.deceptive.concealment_target


def test_load_source_reads_a_file(tmp_path: Path, source_text: Callable[[str], str]) -> None:
    path = tmp_path / "F01.source.json"
    path.write_text(source_text("F01"), encoding="utf-8")
    assert src.load_source(path) == src.parse_source_text(source_text("F01"))


def test_python_tuples_and_json_lists_load_the_same(source_dict: Callable[[str], Source]) -> None:
    """The kit's Python sources use tuples (known_timeline, ledger rows, releases); JSON has lists."""
    as_json = source_dict("F01")
    as_python = copy.deepcopy(as_json)
    as_python["public"]["known_timeline"] = [tuple(row) for row in as_python["public"]["known_timeline"]]
    for artifact in as_python["artifacts"]:
        artifact["release"] = tuple(artifact["release"])
    as_python["variants"]["truthful"]["known"] = [tuple(row) for row in as_python["variants"]["truthful"]["known"]]
    assert src.parse_source(as_python) == src.parse_source(as_json)


def test_key_order_does_not_matter(source_dict: Callable[[str], Source]) -> None:
    data = source_dict("F02")
    reversed_keys = json.loads(json.dumps(data), object_pairs_hook=lambda pairs: dict(reversed(pairs)))
    assert src.parse_source(reversed_keys) == src.parse_source(data)


def test_duplicate_keys_and_nan_are_refused(source_text: Callable[[str], str]) -> None:
    text = source_text("F01")
    with pytest.raises(StrictJSONError):
        src.parse_source_text(text.replace('{"artifacts":', '{"facts":[],"artifacts":', 1))
    with pytest.raises(StrictJSONError):
        src.parse_source_text(text.replace('"tenure_years":4', '"tenure_years":NaN', 1))


def _break(mutate: Callable[[Source], None], source_dict: Callable[[str], Source], family_id: str = "F01") -> str:
    data = source_dict(family_id)
    mutate(data)
    with pytest.raises(ValidationError) as caught:
        src.parse_source(data)
    return str(caught.value)


def _artifact(data: Source, artifact_id: str) -> dict[str, Any]:
    found: dict[str, Any] = next(a for a in data["artifacts"] if a["id"] == artifact_id)
    return found


@pytest.mark.parametrize(
    ("name", "mutate", "message"),
    [
        ("unknown key", lambda d: d["family"].__setitem__("colour", "red"), "Extra inputs are not permitted"),
        ("malformed fact id", lambda d: d["facts"][0].__setitem__("id", "fact1"), "String should match pattern"),
        ("malformed record id", lambda d: _artifact(d, "R1").__setitem__("id", "R7"), "String should match pattern"),
        ("string where a number belongs", lambda d: d["persona"].__setitem__("tenure_years", "4"), "valid integer"),
        ("number where a bool belongs", lambda d: d["facts"][0].__setitem__("material", 1), "valid boolean"),
        ("release without its count", lambda d: _artifact(d, "R1").__setitem__("release", ["on_request"]), "release"),
        ("unknown release type", lambda d: _artifact(d, "R1").__setitem__("release", ["later", 2]), "release"),
        (
            "unknown source strength",
            lambda d: _artifact(d, "D3")["supports"]["shared"][0].__setitem__(1, "solid"),
            "weak",
        ),
        (
            "shared plus per-variant content",
            lambda d: _artifact(d, "D1")["content"].__setitem__("truthful", {"body": "x"}),
            "content",
        ),
        ("only one variant's content", lambda d: _artifact(d, "R1")["content"].pop("deceptive"), "content"),
        (
            "on-request record without description",
            lambda d: _artifact(d, "R1").pop("description"),
            "needs a description",
        ),
        (
            "date on an initial record",
            lambda d: _artifact(d, "D1").__setitem__("date", "2026-03-12"),
            "only an on_request record",
        ),
        (
            "privacy fact with a gate",
            lambda d: d["variants"]["deceptive"]["guarded"][0].__setitem__("reason", "privacy"),
            "cannot have a gate",
        ),
        (
            "unknown guard reason",
            lambda d: d["variants"]["deceptive"]["guarded"][1].__setitem__("reason", "motive"),
            "reason",
        ),
        (
            "fact guarded twice",
            lambda d: d["variants"]["deceptive"]["guarded"].append({"fact_id": "f45", "reason": "concealment_support"}),
            "guarded more than once",
        ),
        (
            "guarded fact the subject does not know",
            lambda d: d["variants"]["deceptive"]["guarded"].append({"fact_id": "f51", "reason": "concealment_support"}),
            "must be in the ledger",
        ),
        (
            "concealed list disagrees",
            lambda d: d["variants"]["deceptive"].__setitem__("concealed", ["f46"]),
            "concealed must list exactly",
        ),
        (
            "truthful concealment target",
            lambda d: d["variants"]["truthful"].__setitem__("concealment_target", "x"),
            "truthful variant has no",
        ),
        (
            "deceptive without concealment target",
            lambda d: d["variants"]["deceptive"].pop("concealment_target"),
            "needs a concealment_target",
        ),
        (
            "two spellings of one record id",
            lambda d: _artifact(d, "R4").__setitem__("id", "R5"),
            "record ids ['rec-05'] are defined twice",
        ),
        (
            "two spellings of one fact id",
            lambda d: d["facts"][1].__setitem__("id", "f:01"),
            "fact ids ['f:01'] are defined twice",
        ),
        (
            "fact in an unknown variant",
            lambda d: d["facts"][0].__setitem__("variants", ["truthful", "neutral"]),
            "variants",
        ),
    ],
)
def test_malformed_sources_fail_at_load(
    name: str, mutate: Callable[[Source], None], message: str, source_dict: Callable[[str], Source]
) -> None:
    assert message in _break(mutate, source_dict), name


def test_canonical_id_helpers() -> None:
    assert src.canonical_fact_id("f07") == src.canonical_fact_id("f:07") == "f:07"
    assert [src.canonical_artifact_id(a) for a in ("D1", "D4", "R1", "R6", "S1", "S2", "doc-02", "rec-03")] == [
        "doc-01",
        "doc-04",
        "rec-01",
        "rec-06",
        "rec-05",
        "rec-06",
        "doc-02",
        "rec-03",
    ]
    assert src.canonical_prefixed_id("u02", "u") == src.canonical_prefixed_id("u:02", "u") == "u:02"
    assert src.canonical_label_id("g03") == src.canonical_label_id("l:03") == "l:03"


def test_prose_rewrite_matches_the_reference_kit() -> None:
    text = "Credit requesting R1-R3 and S1; HOLD fact f44 within u01, see g02, r01, q01, a01, c01, x01, D2, S2."
    assert src.rewrite_prose_ids(text) == (
        "Credit requesting rec-01-rec-03 and rec-05; HOLD fact f:44 within u:01, see l:02, r:01, q:01, a:01, c:01, "
        "x:01, doc-02, rec-06."
    )
    assert src.prose_id_tokens("Rack R2 next to stair S1") == ["R2", "S1"]
    assert src.prose_id_tokens("Room B-12 at 14:07, badge 30418, card A-2291") == []
