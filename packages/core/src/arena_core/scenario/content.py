"""Record content: `content_text()` and the V1d byte budget (S1 6.1, 9.1).

`content_text(content)` is the one text rendering of a record's content: the body, then the table's column
line and one line per row, cells joined by " | ". Cells and column names carry no "|" and no line break
(public-packet schema v1.2) and every row has one cell per column (V2), so every cell survives and every
row is one line. Every consumer carries the content object or this rendering; none reads `body` alone.

The byte budget is measured on canonical JSON (S1 8.4) in wire bytes (D-019: `ensure_ascii`, every non-ASCII
character as its `\\uXXXX` escape, as a request body carries it; never fewer than its UTF-8 bytes). Each limit is at
most half the smallest store or event it feeds (S4 evidence event and SSE delta 16 KiB, artifact 32 KiB, packets
64 KiB public and private, 128 KiB evaluator), so jsonb overhead and envelope fields always fit.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from typing import Any

MAX_RECORD_CONTENT = 4096  # one record's content, initial document or releasable record
MAX_RELEASABLE_CONTENT = 12288  # all releasable records of one variant, contents summed
MAX_PACKET_BYTES: dict[str, int] = {
    "public_packet": 12288,
    "private_packet": 16384,
    "evaluator_packet": 49152,
}
MAX_FAMILY_FILE = 196608


def content_text(content: Mapping[str, Any]) -> str:
    """The body, then the column line and one line per table row (S1 6.1)."""
    lines = [str(content["body"])]
    table = content.get("table")
    if table:
        lines.append(" | ".join(table["columns"]))
        lines.extend(" | ".join(row) for row in table["rows"])
    return "\n".join(lines)


def size(obj: object) -> int:
    """Canonical JSON size in wire bytes (D-019): the canonical form with every non-ASCII character escaped. A lone
    surrogate (which V1.storage refuses) is measured, not raised on, so one bad character never hides the other V1
    findings."""
    return len(json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False))


def budget_overruns(family: Mapping[str, Any]) -> Iterator[tuple[str, str]]:
    """(V1d rule, message) for every object over its limit: each record's content, the releasable contents
    of a variant summed, each packet and the family file."""
    if size(family) > MAX_FAMILY_FILE:
        yield "V1d.family_file", f"family file {size(family)} bytes > {MAX_FAMILY_FILE}"
    for variant in ("truthful", "deceptive"):
        packets = family["variants"][variant]
        for name, limit in MAX_PACKET_BYTES.items():
            if size(packets[name]) > limit:
                yield "V1d.packet", f"{variant} {name} {size(packets[name])} bytes > {limit}"
        artifacts = packets["evaluator_packet"]["evidence_artifacts"]
        for a in artifacts:
            if size(a["content"]) > MAX_RECORD_CONTENT:
                yield (
                    "V1d.record",
                    f"{variant} {a['artifact_id']} content {size(a['content'])} bytes > {MAX_RECORD_CONTENT}",
                )
        total = sum(size(a["content"]) for a in artifacts if a["release"]["type"] != "initial")
        if total > MAX_RELEASABLE_CONTENT:
            yield "V1d.releasable", f"{variant} releasable record contents {total} bytes > {MAX_RELEASABLE_CONTENT}"
