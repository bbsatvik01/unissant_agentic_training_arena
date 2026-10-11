"""Record content and storage (S1 6.1, 9.1): `content_text()`, the V1d byte budget and V1.storage."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from arena_core.scenario import content, storage
from arena_core.scenario.validators import validate_family

Family = dict[str, Any]
SQL = (Path(__file__).resolve().parents[4] / "docs" / "spec" / "sql" / "0002_cases.sql").read_text(encoding="utf-8")
FOUR_BYTE = chr(0x1D11E)  # one 4-byte UTF-8 character


def sql_cap(table: str, column: str) -> int:
    """The `octet_length(column::text) <= N` check of one table in 0002_cases.sql."""
    body = re.search(rf"create table {re.escape(table)} \((.*?)\n\);", SQL, re.DOTALL)
    assert body, table
    found = re.search(rf"octet_length\({column}::text\) <= (\d+)", body.group(1))
    assert found, (table, column)
    return int(found.group(1))


def test_each_limit_is_at_most_half_the_store_it_feeds() -> None:
    """S1 9.1: every V1d limit is at most half the smallest store or event it feeds."""
    assert sql_cap("sealed.evidence_artifacts", "content") >= content.MAX_RECORD_CONTENT * 2
    assert content.MAX_PACKET_BYTES["public_packet"] * 2 <= sql_cap("arena.public_packets", "packet")
    assert content.MAX_PACKET_BYTES["public_packet"] * 2 <= sql_cap("sealed.hidden_public_packets", "packet")
    assert content.MAX_PACKET_BYTES["private_packet"] * 2 <= sql_cap("subject.private_packets", "packet")
    assert content.MAX_PACKET_BYTES["evaluator_packet"] * 2 <= sql_cap("sealed.evaluator_packets", "packet")
    assert (content.MAX_RECORD_CONTENT, content.MAX_RELEASABLE_CONTENT, content.MAX_FAMILY_FILE) == (
        4096,
        12288,
        196608,
    )
    assert content.MAX_PACKET_BYTES == {"public_packet": 12288, "private_packet": 16384, "evaluator_packet": 49152}


def test_content_text_renders_every_row_on_its_own_line() -> None:
    """S1 6.1: the body, the column line, then one line per row, cells joined by ' | '."""
    record = {
        "body": "Radio log.",
        "table": {"columns": ["Time", "Room"], "rows": [["14:01", "B-12"], ["14:05", "B-10"]]},
    }
    assert content.content_text(record) == "Radio log.\nTime | Room\n14:01 | B-12\n14:05 | B-10"
    assert content.content_text({"body": "No table."}) == "No table."


def test_f01_radio_log_rows_reach_content_text(seed: Callable[[str], Family]) -> None:
    """AC-S1-30: F01 rec-02's dispatch room is in the table, so content_text carries it."""
    for variant, room in (("truthful", "B-12"), ("deceptive", "B-10")):
        evaluator = seed("F01")["variants"][variant]["evaluator_packet"]
        rec02 = next(a for a in evaluator["evidence_artifacts"] if a["artifact_id"] == "rec-02")
        lines = content.content_text(rec02["content"]).splitlines()
        assert room not in rec02["content"]["body"]
        assert lines[0] == rec02["content"]["body"]
        assert lines[1] == "Time | From | To | Message"
        assert lines[2] == f"14:01 | I. Marrow | J. Pell | Humidity alarm in the B wing, {room}. Can you take it?"


def _set_rec04(family: Family, body: str) -> None:
    for variant in ("truthful", "deceptive"):
        for a in family["variants"][variant]["evaluator_packet"]["evidence_artifacts"]:
            if a["artifact_id"] == "rec-04":
                a["content"] = {"body": body}


def test_a_record_at_the_limit_passes_and_one_more_character_fails(seed: Callable[[str], Family]) -> None:
    """AC-S1-29: a record content of exactly 4,096 canonical wire bytes passes V1d (D-019: a character outside the BMP
    is its 12-byte surrogate-pair escape); one more character fails."""
    overhead = content.size({"body": ""})
    body = FOUR_BYTE * ((content.MAX_RECORD_CONTENT - overhead) // 12)
    body += "x" * (content.MAX_RECORD_CONTENT - overhead - content.size(body) + 2)
    at_limit = seed("F01")
    _set_rec04(at_limit, body)
    assert content.size({"body": body}) == content.MAX_RECORD_CONTENT
    assert not [i for i in validate_family(at_limit) if i.rule.startswith("V1d")]
    over = seed("F01")
    _set_rec04(over, body + "x")
    assert [i.rule for i in validate_family(over) if i.rule.startswith("V1d")] == ["V1d.record", "V1d.record"]


def test_initial_documents_do_not_count_toward_the_releasable_budget(seed: Callable[[str], Family]) -> None:
    """S1 9.1: the 12,288-byte sum covers releasable records only; initial documents have their own limits."""
    family = seed("F01")
    for variant in ("truthful", "deceptive"):
        packets = family["variants"][variant]
        for doc in packets["public_packet"]["initial_documents"]:
            doc["content"] = {"body": FOUR_BYTE * 1000}
        for a in packets["evaluator_packet"]["evidence_artifacts"]:
            if a["release"]["type"] == "initial":
                a["content"] = {"body": FOUR_BYTE * 1000}
    rules = {rule for rule, _message in content.budget_overruns(family)}
    assert "V1d.packet" in rules  # three 4,000-byte documents fill the public packet
    assert "V1d.releasable" not in rules


def test_the_dev_families_are_within_the_budget(dev_families: list[Family]) -> None:
    for family in dev_families:
        assert list(content.budget_overruns(family)) == []
        assert storage.unstorable_text(family) == []


def test_size_measures_a_lone_surrogate_instead_of_raising() -> None:
    assert content.size(chr(0xD800)) == len('"\\ud800"')  # measured as its wire escape (D-019)


@pytest.mark.parametrize(
    ("value", "problem"),
    [
        ({"body": "a" + chr(0) + "b"}, "NUL character at /body"),
        ({"rows": [["ok", chr(0xDC00)]]}, "lone surrogate at /rows/0/1"),
        ({"k" + chr(0): "v"}, "NUL character at /k" + chr(0)),
        (chr(0), "NUL character at /"),
    ],
)
def test_unstorable_text_names_the_path(value: object, problem: str) -> None:
    assert storage.unstorable_text(value) == [problem]
