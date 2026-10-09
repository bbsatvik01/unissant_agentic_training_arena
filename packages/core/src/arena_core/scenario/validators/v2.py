"""V2 fact-graph and packet consistency (S1 9.2; M1-M6 of S1 3).

Rows of S1 9.2 and their rule IDs (each prefixed `V2.`):

- Facts: `fact_ids_unique`, `edge_endpoint`, `edge_variants`, `time_order`, `cycle`, `edge_relation`.
- Packet agreement: `case_id`, `labels`, `packet_header`, `canonical_facts`, `event_edges`, `public_documents`,
  `public_records`, `timeline_source`, `matter`, `persona` (also M1: one persona in both variants),
  `display_name`.
- Records: `artifact_ids_unique`, `max_releases`, `support_fact`, `support_level`, `skeleton` (M3),
  `table_row` (every table row has one cell per column, S1 6.1).
- Ledger: `private_refs`, `ledger_unknown_overlap`, `relevant_actions`, `private_class`, `violation_core`,
  `hold_gate`, `precondition_records`, `gate_unreachable`, `uncertainty` (each approximate fact has exactly
  one range or unsure entry and no entry names another fact, S1 7.3), `forbidden_assertion`,
  `style` (M6), `entry_ids_unique`.
- Evaluator: `correct_finding`, `contradiction_type` (both roles, S1 4.3), `contradiction_refs`, `decisive_refs`,
  `corroboration_refs`, `rubric_refs`, `material_decisive` (F4, v2.8: every fact a decisive-support item names
  is `material: true` in the event graph).
- Knobs: `knobs_matched` (M5), `knobs_stored`, `knobs_band`.

Rules the schema already guarantees after V1 are not repeated: predicate values at most 10
(`completedExchanges`), a HOLD fact carrying a `gate_id` and no other class carrying one (`ledgerFact`),
truthful ledgers holding only FREE and PRIVATE facts, and record IDs `doc-0[1-4]` / `rec-0[1-6]`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from arena_core.scenario.constants import MAX_RELEASES
from arena_core.scenario.difficulty import LEVEL_BANDS, compute_knobs, variant_knobs
from arena_core.scenario.source import EFM_LEVEL
from arena_core.scenario.validators._common import (
    VARIANTS,
    Family,
    Issue,
    Reporter,
    Variant,
    family_id_of,
    packets,
    variant_fact_ids,
)

_TIMED_RELATIONS = ("precedes", "causes")


def _seconds(time: str) -> str:
    """Facility-local `YYYY-MM-DDTHH:MM[:SS]` normalized to seconds so string order is time order."""
    return time if len(time) == len("YYYY-MM-DDTHH:MM:SS") else f"{time}:00"


def _check_facts(family: Family, report: Reporter) -> None:
    facts = family["event_graph"]["facts"]
    ids = [str(f["id"]) for f in facts]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        report.add("V2.fact_ids_unique", f"duplicate fact ids {duplicates}")
    by_id = {str(f["id"]): f for f in facts}
    for edge in family["event_graph"]["edges"]:
        _check_edge(edge, by_id, report)
    _check_acyclic(family["event_graph"]["edges"], report)


def _check_edge(edge: Mapping[str, Any], by_id: Mapping[str, Mapping[str, Any]], report: Reporter) -> None:
    src, dst, relation = str(edge["from"]), str(edge["to"]), str(edge["relation"])
    missing = [end for end in (src, dst) if end not in by_id]
    if missing:
        report.add("V2.edge_endpoint", f"edge {src} {relation} {dst} references unknown fact(s) {missing}")
        return
    a, b = by_id[src], by_id[dst]
    if not set(a["variants"]) & set(b["variants"]):
        report.add("V2.edge_variants", f"edge {src} {relation} {dst} joins facts with no variant in common")
    if relation in _TIMED_RELATIONS and "time" in a and "time" in b and _seconds(a["time"]) > _seconds(b["time"]):
        report.add("V2.time_order", f"edge {src} {relation} {dst} runs backwards in time ({a['time']} > {b['time']})")
    tags_a, tags_b = set(a["tags"]), set(b["tags"])
    rule_broken = (
        (relation == "explains" and not ("innocent_explanation" in tags_a and "misleading" in tags_b))
        or (relation == "motivates" and not ("motive" in tags_a and "violation" in tags_b))
        or (relation == "enables" and not ({"opportunity", "means"} & tags_a and "violation" in tags_b))
    )
    if rule_broken:
        report.add("V2.edge_relation", f"edge {src} {relation} {dst} breaks the relation-tag rule of S1 5")


def _check_acyclic(edges: Sequence[Mapping[str, Any]], report: Reporter) -> None:
    succ: dict[str, list[str]] = {}
    for e in edges:
        if e["relation"] in _TIMED_RELATIONS:
            succ.setdefault(str(e["from"]), []).append(str(e["to"]))
    state: dict[str, int] = {}  # 1 on the current path, 2 done
    for root in sorted(succ):
        if root in state:
            continue
        stack: list[tuple[str, int]] = [(root, 0)]
        state[root] = 1
        while stack:
            node, index = stack[-1]
            children = succ.get(node, [])
            if index == len(children):
                state[node] = 2
                stack.pop()
                continue
            stack[-1] = (node, index + 1)
            child = children[index]
            if state.get(child) == 1:
                report.add("V2.cycle", f"precedes/causes edges form a cycle through {child}")
                return
            if child not in state:
                state[child] = 1
                stack.append((child, 0))


def _filtered_graph(family: Family, variant: Variant) -> tuple[list[dict[str, Any]], list[Any]]:
    facts = [f for f in family["event_graph"]["facts"] if variant in f["variants"]]
    ids = {str(f["id"]) for f in facts}
    expected_facts = [{k: v for k, v in f.items() if k != "variants"} for f in facts]
    expected_edges = [e for e in family["event_graph"]["edges"] if e["from"] in ids and e["to"] in ids]
    return expected_facts, expected_edges


def _check_packet_agreement(family: Family, report: Reporter) -> None:
    case_ids = {variant: str(family["variants"][variant]["case_id"]) for variant in VARIANTS}
    if case_ids["truthful"] == case_ids["deceptive"]:
        report.add("V2.case_id", "both variants share one case_id")
    personas = [packets(family, variant)[1]["persona"] for variant in VARIANTS]
    if personas[0] != personas[1]:
        report.add("V2.persona", "private personas differ between the variants (M1: same persona)")
    for variant in VARIANTS:
        public, private, evaluator = packets(family, variant)
        if {str(p["case_id"]) for p in (public, private, evaluator)} != {case_ids[variant]}:
            report.add("V2.case_id", "a packet's case_id differs from the variant's case_id", variant)
        if (evaluator["family_id"], evaluator["variant"], evaluator["role"], private["role"]) != (
            family["family_id"],
            variant,
            variant,
            variant,
        ):
            report.add("V2.labels", "evaluator family_id/variant/role or private role does not match", variant)
        header = (public["domain"], public["title"], public["difficulty_level"])
        if header != (family["domain"], family["title"], family["difficulty"]["level"]):
            report.add("V2.packet_header", "public domain, title or difficulty_level differs from the family", variant)
        expected_facts, expected_edges = _filtered_graph(family, variant)
        if list(evaluator["canonical_facts"]) != expected_facts:
            report.add("V2.canonical_facts", "canonical_facts differ from the event graph filtered by variant", variant)
        if list(evaluator["event_edges"]) != expected_edges:
            report.add("V2.event_edges", "event_edges differ from the event graph filtered by variant", variant)
        _check_public_records(public, evaluator, report, variant)
        if private["matter"] != public["investigation_objective"]:
            report.add("V2.matter", "matter differs from the public investigation objective", variant)
        context = public["interview_context"]
        persona = private["persona"]
        # One biography: every field the private persona shares with the public subject must agree, so the
        # subject never plays a different position, unit or tenure from the one the investigator reads.
        subject = context["subject"]
        shared = sorted(k for k in _PERSONA_SHARED if k in subject or k in persona)
        differing = [k for k in shared if subject.get(k) != persona.get(k)]
        if persona["organization"] != context["agency"]:
            differing.append("organization")
        if differing:
            report.add("V2.persona", f"persona {differing} differ from the public interview context", variant)
        if public["presentation"]["display_name"] != context["subject"]["name"]:
            report.add("V2.display_name", "presentation.display_name differs from the subject name", variant)


# S1 4.3: deceptive contradictions are real (statement or evidence against evidence); truthful ones are only
# apparent, with an innocent resolution.
_CONTRADICTION_TYPES: dict[str, tuple[str, ...]] = {
    "deceptive": ("statement_vs_evidence", "evidence_vs_evidence"),
    "truthful": ("apparent",),
}
_PERSONA_SHARED = ("name", "position", "unit", "tenure_years")


def _check_public_records(
    public: Mapping[str, Any], evaluator: Mapping[str, Any], report: Reporter, variant: Variant
) -> None:
    artifacts = evaluator["evidence_artifacts"]
    initial = [
        {"doc_id": a["artifact_id"], "kind": a["kind"], "title": a["title"], "content": a["content"]}
        for a in artifacts
        if a["release"]["type"] == "initial"
    ]
    if list(public["initial_documents"]) != initial:
        report.add(
            "V2.public_documents", "public initial_documents differ from the evaluator's initial records", variant
        )
    requestable = [
        {
            "record_id": a["artifact_id"],
            "kind": a["kind"],
            "title": a["title"],
            "description": a.get("description"),
            "requestable_after_exchanges": a["release"]["after_exchanges"],
        }
        for a in artifacts
        if a["release"]["type"] == "on_request"
    ]
    listed = [{k: v for k, v in r.items() if k != "date"} for r in public["requestable_records"]]
    if listed != requestable:
        report.add(
            "V2.public_records", "public requestable_records differ from the evaluator's on-request records", variant
        )
    doc_ids = {d["doc_id"] for d in public["initial_documents"]}
    for entry in public["known_timeline"]:
        if entry["source"] not in doc_ids:
            report.add("V2.timeline_source", f"timeline source {entry['source']} is not an initial document", variant)


def _skeleton(evaluator: Mapping[str, Any]) -> list[tuple[Any, ...]]:
    return [
        (
            a["artifact_id"],
            a["kind"],
            a["title"],
            a["release"]["type"],
            a["release"].get("after_exchanges"),
            a.get("description"),
        )
        for a in evaluator["evidence_artifacts"]
    ]


def _check_records(family: Family, report: Reporter) -> None:
    skeletons = []
    for variant in VARIANTS:
        _public, _private, evaluator = packets(family, variant)
        in_variant = set(variant_fact_ids(family, variant))
        artifacts = evaluator["evidence_artifacts"]
        ids = [str(a["artifact_id"]) for a in artifacts]
        if len(ids) != len(set(ids)):
            report.add(
                "V2.artifact_ids_unique",
                f"duplicate artifact ids {sorted({i for i in ids if ids.count(i) > 1})}",
                variant,
            )
        releasable = sum(1 for a in artifacts if a["release"]["type"] != "initial")
        if releasable > MAX_RELEASES:
            report.add("V2.max_releases", f"{releasable} releasable records > MAX_RELEASES {MAX_RELEASES}", variant)
        for a in artifacts:
            table = a["content"].get("table")
            for index, row in enumerate(table["rows"] if table else [], start=1):
                if len(row) != len(table["columns"]):
                    message = (
                        f"{a['artifact_id']} table row {index} has {len(row)} cells for {len(table['columns'])} columns"
                    )
                    report.add("V2.table_row", message, variant)
            for s in a["supports"]:
                if s["fact_id"] not in in_variant:
                    report.add(
                        "V2.support_fact", f"{a['artifact_id']} supports {s['fact_id']}, not in the variant", variant
                    )
                if EFM_LEVEL[(s["source_strength"], s["precision"])] != s["level"]:
                    report.add(
                        "V2.support_level",
                        f"{a['artifact_id']} level for {s['fact_id']} != strength x precision",
                        variant,
                    )
        skeletons.append(_skeleton(evaluator))
    if skeletons[0] != skeletons[1]:
        report.add("V2.skeleton", "record skeletons differ (ids, kinds, titles, predicates or descriptions; M3)")


def _check_entry_ids(
    private: Mapping[str, Any], evaluator: Mapping[str, Any], report: Reporter, variant: Variant
) -> None:
    lists = {
        "ledger facts": [k["id"] for k in private["facts"]],
        "uncertainty": [u["id"] for u in private["uncertainty"]],
        "gates": [g["id"] for g in private["gates"]],
        "forbidden assertions": [x["id"] for x in private["forbidden_assertions"]],
        "contradictions": [c["id"] for c in evaluator["material_contradictions"]],
        "decisive support": [r["id"] for r in evaluator["resolution_criteria"]["decisive_support"]],
        "key questions": [q["id"] for q in evaluator["rubric"]["key_questions"]],
        "alternatives": [a["id"] for a in evaluator["rubric"]["alternative_explanations"]],
        "turn-label guide": [g["id"] for g in evaluator["turn_label_guide"]],
    }
    for name, ids in lists.items():
        if len(ids) != len(set(ids)):
            report.add(
                "V2.entry_ids_unique", f"duplicate {name} ids {sorted({i for i in ids if ids.count(i) > 1})}", variant
            )


def _check_gates(
    private: Mapping[str, Any],
    evaluator: Mapping[str, Any],
    ledger: Mapping[str, Any],
    report: Reporter,
    variant: Variant,
) -> None:
    gates = {str(g["id"]): g for g in private["gates"]}
    held_by: dict[str, set[str]] = {}
    for fid, k in ledger.items():
        if k["class"] == "HOLD":
            held_by.setdefault(str(k["gate_id"]), set()).add(fid)
    for gid in sorted(set(held_by) - set(gates)):
        report.add("V2.hold_gate", f"HOLD facts {sorted(held_by[gid])} name gate {gid}, which does not exist", variant)
    support_rows = [
        (a["artifact_id"], s["fact_id"], s["level"]) for a in evaluator["evidence_artifacts"] for s in a["supports"]
    ]
    for gid, gate in gates.items():
        # One relation, read both ways: a gate opens exactly the HOLD facts that name it (S1 9.2 Ledger row).
        holding = held_by.get(gid, set())
        if set(gate["opens"]) != holding:
            message = f"gate {gid} opens {sorted(gate['opens'])} but the HOLD facts naming it are {sorted(holding)}"
            report.add("V2.hold_gate", message, variant)
        level = gate["min_evidence_level"]
        derived = sorted({aid for (aid, f, lvl) in support_rows if f in gate["opens"] and lvl >= level})
        if sorted(gate["precondition_records"]) != derived:
            report.add(
                "V2.precondition_records",
                f"gate {gid} precondition_records {list(gate['precondition_records'])} != derived {derived}",
                variant,
            )
        if not derived:
            report.add(
                "V2.gate_unreachable", f"gate {gid} can never open: no record supports it at level >= {level}", variant
            )


def _check_ledger_refs(
    private: Mapping[str, Any], in_variant: set[str], report: Reporter, variant: Variant
) -> dict[str, Any]:
    """Ledger, unknown and relevant-action references; returns the ledger by fact id."""
    ledger = {str(k["id"]): k for k in private["facts"]}
    unknown = {str(u["fact_id"]) for u in private["unknown_facts"]}
    relevant = [str(f) for f in private["relevant_action_ids"]]
    outside = sorted((set(ledger) | unknown | set(relevant)) - in_variant)
    if outside:
        report.add("V2.private_refs", f"ledger, unknown or relevant facts not in the variant: {outside}", variant)
    if set(ledger) & unknown:
        overlap = sorted(set(ledger) & unknown)
        report.add("V2.ledger_unknown_overlap", f"facts both in the ledger and unknown: {overlap}", variant)
    if not set(relevant) <= set(ledger):
        missing = sorted(set(relevant) - set(ledger))
        report.add("V2.relevant_actions", f"relevant actions not in the ledger: {missing}", variant)
    return ledger


def _check_ledger_classes(
    ledger: Mapping[str, Any], graph: Mapping[str, Any], in_variant: set[str], report: Reporter, variant: Variant
) -> None:
    private_ids = {fid for fid, k in ledger.items() if k["class"] == "PRIVATE"}
    privacy_tagged = {fid for fid in in_variant if "privacy" in graph[fid]["tags"]}
    if private_ids != privacy_tagged:
        message = f"PRIVATE facts {sorted(private_ids)} != privacy-tagged facts {sorted(privacy_tagged)}"
        report.add("V2.private_class", message, variant)
    for fid in sorted(in_variant):
        if "violation" in graph[fid]["tags"] and ledger.get(fid, {}).get("class") != "CORE":
            report.add("V2.violation_core", f"violation fact {fid} is not a CORE ledger fact", variant)


def _check_uncertainty(
    private: Mapping[str, Any], ledger: Mapping[str, Any], report: Reporter, variant: Variant
) -> None:
    approximate = sorted(fid for fid, k in ledger.items() if k["certainty"] == "approximate")
    hedged = sorted(str(u["fact_id"]) for u in private["uncertainty"])
    if approximate != hedged:
        message = f"approximate facts {approximate} need exactly one range/unsure entry each, got {hedged}"
        report.add("V2.uncertainty", message, variant)


def _check_ledger(family: Family, report: Reporter) -> None:
    graph = {str(f["id"]): f for f in family["event_graph"]["facts"]}
    for variant in VARIANTS:
        _public, private, evaluator = packets(family, variant)
        in_variant = set(variant_fact_ids(family, variant))
        _check_entry_ids(private, evaluator, report, variant)
        ledger = _check_ledger_refs(private, in_variant, report, variant)
        _check_ledger_classes(ledger, graph, in_variant, report, variant)
        _check_gates(private, evaluator, ledger, report, variant)
        _check_uncertainty(private, ledger, report, variant)
        for x in private["forbidden_assertions"]:
            if x["contradicts"] not in in_variant:
                message = f"forbidden assertion {x['id']} contradicts {x['contradicts']}, not in the variant"
                report.add("V2.forbidden_assertion", message, variant)
        if private["style"] != family["style"]:
            report.add("V2.style", "private style differs from the family style (M6)", variant)


def _check_evaluator(family: Family, report: Reporter) -> None:
    # F4 (S1 5, v2.8): a fact a resolution rests on is material in the graph, so in every variant carrying it.
    material = {str(f["id"]): bool(f["material"]) for f in family["event_graph"]["facts"]}
    for variant in VARIANTS:
        _public, private, evaluator = packets(family, variant)
        in_variant = set(variant_fact_ids(family, variant))
        artifact_ids = {str(a["artifact_id"]) for a in evaluator["evidence_artifacts"]}
        assertion_ids = {str(x["id"]) for x in private["forbidden_assertions"]}
        resolution = evaluator["resolution_criteria"]
        if resolution["correct_finding"] != evaluator["role"]:
            report.add("V2.correct_finding", "correct_finding does not equal the variant's role", variant)
        for c in evaluator["material_contradictions"]:
            if c["type"] not in _CONTRADICTION_TYPES[variant]:
                allowed = " or ".join(_CONTRADICTION_TYPES[variant])
                message = f"{variant} contradiction {c['id']} is {c['type']}, must be {allowed} (S1 4.3)"
                report.add("V2.contradiction_type", message, variant)
            facts = set(c["fact_ids"]) | set(c["resolved_by"]["fact_ids"])
            arts = set(c["artifact_ids"]) | set(c["resolved_by"]["artifact_ids"])
            if not (
                facts <= in_variant
                and arts <= artifact_ids
                and set(c.get("forbidden_assertion_ids", [])) <= assertion_ids
            ):
                report.add("V2.contradiction_refs", f"contradiction {c['id']} has dangling references", variant)
        for item in resolution["decisive_support"]:
            if not (set(item["artifact_ids"]) <= artifact_ids and set(item["fact_ids"]) <= in_variant):
                report.add("V2.decisive_refs", f"decisive item {item['id']} has dangling references", variant)
            not_material = sorted(f for f in item["fact_ids"] if f in material and not material[f])
            if not_material:
                message = f"decisive item {item['id']} names facts {not_material} that are not material (F4)"
                report.add("V2.material_decisive", message, variant)
        if not set(resolution["corroboration_to_name"]) <= artifact_ids:
            report.add("V2.corroboration_refs", "corroboration_to_name names unknown records", variant)
        rubric = evaluator["rubric"]
        targets = {f for q in rubric["key_questions"] for f in q["target_fact_ids"]}
        if not (targets <= in_variant and set(rubric["evidence_to_request"]) <= artifact_ids):
            report.add(
                "V2.rubric_refs", "rubric key questions or evidence_to_request have dangling references", variant
            )


def _check_knobs(family: Family, report: Reporter) -> None:
    per_variant = {
        variant: variant_knobs(packets(family, variant)[2], packets(family, variant)[1]) for variant in VARIANTS
    }
    if per_variant["truthful"] != per_variant["deceptive"]:
        report.add("V2.knobs_matched", f"variants not matched on (K, E, U): {per_variant} (M5)")
    computed = compute_knobs(family)
    stored = dict(family["difficulty"]["knobs"])
    if stored != computed.as_dict():
        report.add("V2.knobs_stored", f"stored knobs {stored} != computed {computed.as_dict()}")
    level = int(family["difficulty"]["level"])
    outside = LEVEL_BANDS[level].violations(computed)
    if outside:
        report.add("V2.knobs_band", f"computed knobs outside the level {level} band: {outside}")


def check_consistency(family: Family) -> list[Issue]:
    """V2 over one schema-valid family."""
    report = Reporter(family_id_of(family))
    _check_facts(family, report)
    _check_packet_agreement(family, report)
    _check_records(family, report)
    _check_ledger(family, report)
    _check_evaluator(family, report)
    _check_knobs(family, report)
    return report.issues
