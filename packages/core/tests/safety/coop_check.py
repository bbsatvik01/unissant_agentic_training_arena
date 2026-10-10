"""FX-COOP (S2 11.1): the two checks code makes; everything else is the recorded independent review.

S2 11.1 (D-016, keep it simple): FX-COOP is three authored test transcripts, not product code. Code checks only that
every cited ledger ID exists in the variant and every cited quote is verbatim from a record released in the interview;
everything else (consistency with the case, numbers, polarity, responsiveness, subject visibility) is decided by the
recorded independent review (fixtures/transcript_review.json), and a test fails if any pair lacks a current passing
review bound to the text and case hashes. No natural-language parsing here.

Each sentence of an answer carries `{"kind": "fact" | "perception", "ledger": [ids], "records": [{"record_id",
"quote"}]}`; the sentence split only aligns answers with their support entries.
"""

from __future__ import annotations

import re
from typing import Any

from arena_core.contracts.citations import quote_ok

SENTENCE_END = re.compile(r"(?<=[.?!])(?: |$)")
Problem = tuple[int, str, str]


def sentences(answer: str) -> list[str]:
    return [s for s in SENTENCE_END.split(answer) if s]


def ledger_problems(cited: list[str], ledger: dict[str, str]) -> list[str]:
    """Every cited ledger ID exists in the variant's ledger."""
    return [f"cites an unknown ledger entry: {i}" for i in cited if i not in ledger]


def quote_problems(records: list[dict[str, str]], record_texts: dict[str, str], released: set[str]) -> list[str]:
    """Every cited quote is verbatim (`quote_ok`) from a record released in the interview."""
    problems = []
    for record in records:
        if record["record_id"] not in released:
            problems.append(f"record not released in this interview: {record['record_id']}")
        elif not quote_ok(record["quote"], record_texts[record["record_id"]]):
            problems.append(f"quote not in the record: {record['record_id']}")
    return problems


def coop_problems(t: dict[str, Any], ledger: dict[str, str], record_texts: dict[str, str]) -> list[Problem]:
    """Every problem the code checks in one FX-COOP transcript: (turn, sentence, problem)."""
    released = set(t["exchanges"][-1]["released_before"])  # records reach the coach during the interview
    out: list[Problem] = []
    for e in t["exchanges"]:
        parts = sentences(e["answer"])
        if len(parts) != len(e["support"]):
            out.append((e["turn"], "", "one support entry per sentence"))
            continue
        for sentence, support in zip(parts, e["support"], strict=True):
            found = ledger_problems(support["ledger"], ledger)
            found += quote_problems(support["records"], record_texts, released)
            out.extend((e["turn"], sentence, p) for p in found)
    return out
