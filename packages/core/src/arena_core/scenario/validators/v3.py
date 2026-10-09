"""V3a structural solvability (S1 9.3; AR-Bench triple constraint, arXiv 2506.08295 via X9 Q2).

Rule IDs (each prefixed `V3a.`):

- Deceptive: `violation_count` (exactly one violation fact); `triple` (exactly one motive with a `motivates`
  edge into it, one opportunity and one means with `enables` edges); `violation_core`.
- Truthful: `truthful_violation` (no violation fact); `misleading_explained` (exactly one `explains` edge into
  each misleading fact); `explanation_reachable` (that explanation is in the subject's ledger or supported by
  a record at level 2 or more, so the corroboration path exists, EX-3).
- Both: `decisive_available` (some decisive-support item whose records all exist, so all of them can be
  released by exchange 10); `account_path` (every item with `requires_subject_account` names at least one
  ledger fact that a rubric key question targets: those are the item's account facts, so the account it
  needs can be asked for, and CX-2 can check that all of it was given).

The deceptive "at least one gate, every gate openable by exchange 10" rule is held by the private-packet
schema (`gates.minItems` 1 for the deceptive role) plus V2 `gate_unreachable`, since every predicate value
is at most 10 (schema). The semantic solves (formerly V3b, V3c) are Codex checks CX-2 and CX-3 (S1 9.7).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from arena_core.scenario.validators._common import VARIANTS, Family, Issue, Reporter, family_id_of, packets

_EXPLANATION_MIN_LEVEL = 2
_TRIPLE = (("motive", "motivates"), ("opportunity", "enables"), ("means", "enables"))


def _check_deceptive(evaluator: Mapping[str, Any], private: Mapping[str, Any], report: Reporter) -> None:
    facts = {str(f["id"]): f for f in evaluator["canonical_facts"]}
    violations = sorted(fid for fid, f in facts.items() if "violation" in f["tags"])
    if len(violations) != 1:
        report.add(
            "V3a.violation_count",
            f"the deceptive variant needs exactly one violation fact, found {violations}",
            "deceptive",
        )
        return
    vid = violations[0]
    for tag, relation in _TRIPLE:
        # Exactly one fact carries the tag (a second, disconnected one would be a second motive, opportunity
        # or means), and that fact has exactly one `relation` edge into the violation.
        tagged = sorted(fid for fid, f in facts.items() if tag in f["tags"])
        if len(tagged) != 1:
            report.add("V3a.triple", f"need exactly one {tag} fact, found {tagged}", "deceptive")
            continue
        edges = [
            e
            for e in evaluator["event_edges"]
            if e["from"] == tagged[0] and e["to"] == vid and e["relation"] == relation
        ]
        if len(edges) != 1:
            message = f"need exactly one {tag} -{relation}-> {vid} edge from {tagged[0]}, found {len(edges)}"
            report.add("V3a.triple", message, "deceptive")
    core = [k for k in private["facts"] if k["id"] == vid]
    if not core or core[0]["class"] != "CORE":
        report.add(
            "V3a.violation_core", f"the violation {vid} must be a CORE fact in the deceptive ledger", "deceptive"
        )


def _check_truthful(evaluator: Mapping[str, Any], private: Mapping[str, Any], report: Reporter) -> None:
    facts = {str(f["id"]): f for f in evaluator["canonical_facts"]}
    if any("violation" in f["tags"] for f in facts.values()):
        report.add("V3a.truthful_violation", "the truthful variant contains a violation fact", "truthful")
    known = {str(k["id"]) for k in private["facts"]}
    best_support: dict[str, int] = {}
    for a in evaluator["evidence_artifacts"]:
        for s in a["supports"]:
            best_support[s["fact_id"]] = max(best_support.get(s["fact_id"], 0), int(s["level"]))
    for fid in sorted(fid for fid, f in facts.items() if "misleading" in f["tags"]):
        explains = [e for e in evaluator["event_edges"] if e["to"] == fid and e["relation"] == "explains"]
        if len(explains) != 1:
            report.add(
                "V3a.misleading_explained",
                f"misleading fact {fid} needs exactly one explanation, found {len(explains)}",
                "truthful",
            )
            continue
        explanation = str(explains[0]["from"])
        if explanation not in known and best_support.get(explanation, 0) < _EXPLANATION_MIN_LEVEL:
            report.add(
                "V3a.explanation_reachable",
                f"explanation {explanation} of {fid} is neither known to the subject nor supported at level >= 2",
                "truthful",
            )


def check_solvability(family: Family) -> list[Issue]:
    """V3a over one schema-valid family."""
    report = Reporter(family_id_of(family))
    _public, private_d, evaluator_d = packets(family, "deceptive")
    _check_deceptive(evaluator_d, private_d, report)
    _public, private_t, evaluator_t = packets(family, "truthful")
    _check_truthful(evaluator_t, private_t, report)
    for variant in VARIANTS:
        _public, private, evaluator = packets(family, variant)
        artifact_ids = {str(a["artifact_id"]) for a in evaluator["evidence_artifacts"]}
        items = evaluator["resolution_criteria"]["decisive_support"]
        if not any(set(item["artifact_ids"]) <= artifact_ids for item in items):
            report.add(
                "V3a.decisive_available", "no decisive-support item can be fully released by exchange 10", variant
            )
        ledger = {str(k["id"]) for k in private["facts"]}
        asked = {str(f) for q in evaluator["rubric"]["key_questions"] for f in q["target_fact_ids"]}
        for item in items:
            if item["requires_subject_account"] and not set(item["fact_ids"]) & ledger & asked:
                message = (
                    f"decisive item {item['id']} requires the subject's account, but none of its facts is a "
                    "ledger fact that a key question targets"
                )
                report.add("V3a.account_path", message, variant)
    return report.issues
