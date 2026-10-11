"""V4 role leak (S1 9.4; leakage rules L1-L3 of S1 10.2).

- V4a: `L1` public packets identical except `case_id`; `L2` initial and scheduled record contents identical.
- V4b: `role_word`, `ledger_id`, `other_case_id`, `real_agency` over public-tier text: the public packet plus
  every record's title, description and content (records become public on release).
- V4c: `G3`, `G4`, `G5` (S2 guard rules) over the public packet (ground rules excluded: platform text never
  rendered to the subject), persona, matter, ledger text, uncertainty text, gate conditions, unknown-fact views,
  forbidden-assertion text and every record's title, description and content.

Every lexical scan here reads each text as authored and as the runtime renders it (`guardscan.scan_forms`).

A role guesser that sees only the public packet is at exactly 50% per family once V4a passes, so the
direction's model-based public-packet check is not run; cues a lexical scan misses are Codex CX-4.
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Mapping
from typing import Any

from arena_core.ids import canonical_json
from arena_core.scenario.content import content_text
from arena_core.scenario.guardscan import guard_hits, scan_forms
from arena_core.scenario.validators._common import VARIANTS, Family, Issue, Reporter, family_id_of, packets, strings
from arena_core.scenario.validators.v1 import real_agency

ROLE_WORDS = re.compile(
    r"\b(?:deceptive|deception|truthful|guilty|innocent|perpetrator|culprit|liar|lying|lied"
    r"|role label|scoring key|evaluator)\b",
    re.IGNORECASE,
)
LEDGER_ID = re.compile(r"\b[fugxcrqal]:[0-9]{2,3}\b")


def _record_text(evaluator: Mapping[str, Any]) -> Iterator[str]:
    """Each record's title, description and content: every content string, and the one rendering every
    consumer reads (`content_text`, S1 6.1), so a phrase split across the body and the table is still seen."""
    for a in evaluator["evidence_artifacts"]:
        yield str(a["title"])
        if "description" in a:
            yield str(a["description"])
        yield from strings(a["content"])
        yield content_text(a["content"])


def public_tier_text(public: Mapping[str, Any], evaluator: Mapping[str, Any]) -> list[str]:
    """Every string an investigator or assistant can see, now or after a release."""
    return [*strings(public), *_record_text(evaluator)]


def subject_renderable_text(
    public: Mapping[str, Any], private: Mapping[str, Any], evaluator: Mapping[str, Any]
) -> list[str]:
    """The strings S2's authoring obligation covers (S2 6.2): public, persona, ledger and record text."""
    out = [*strings({k: v for k, v in public.items() if k != "ground_rules"}), *strings(private["persona"])]
    out.append(str(private["matter"]))
    out.extend(str(k["text"]) for k in private["facts"])
    for u in private["uncertainty"]:
        out.append(str(u["text"]))
        if "range_text" in u:
            out.append(str(u["range_text"]))
    out.extend(str(g["condition"]) for g in private["gates"])
    out.extend(str(u["subject_view"]) for u in private["unknown_facts"])
    out.extend(str(x["text"]) for x in private["forbidden_assertions"])
    out.extend(_record_text(evaluator))
    return out


def _first_match(pattern: re.Pattern[str], forms: tuple[str, ...]) -> str | None:
    """The first match of `pattern` in any scan form of one text (`guardscan.scan_forms`)."""
    return next((m.group(0) for m in (pattern.search(form) for form in forms) if m is not None), None)


def check_invariance(family: Family) -> list[Issue]:
    """V4a: L1 and L2."""
    report = Reporter(family_id_of(family))
    # Compared as canonical JSON, not with Python's `==`, for which 4 == 4.0 == True: the packets must be the
    # same bytes (S1 L1), or a serialization difference becomes a role signal in free material.
    stripped = [{k: v for k, v in packets(family, variant)[0].items() if k != "case_id"} for variant in VARIANTS]
    if canonical_json(stripped[0]) != canonical_json(stripped[1]):
        keys = sorted(set(stripped[0]) | set(stripped[1]))
        differing = [k for k in keys if canonical_json(stripped[0].get(k)) != canonical_json(stripped[1].get(k))]
        report.add("V4a.L1", f"public packets differ beyond case_id in {differing}")
    free = [
        [
            (a["artifact_id"], a["content"])
            for a in packets(family, variant)[2]["evidence_artifacts"]
            if a["release"]["type"] != "on_request"
        ]
        for variant in VARIANTS
    ]
    if canonical_json(free[0]) != canonical_json(free[1]):
        report.add("V4a.L2", "initial or scheduled record contents differ between the variants")
    return report.issues


def check_lexical(family: Family) -> list[Issue]:
    """V4b over public-tier text, per variant."""
    report = Reporter(family_id_of(family))
    case_ids = {variant: str(family["variants"][variant]["case_id"]) for variant in VARIANTS}
    for variant in VARIANTS:
        public, _private, evaluator = packets(family, variant)
        other = case_ids["deceptive" if variant == "truthful" else "truthful"]
        for text in public_tier_text(public, evaluator):
            forms = scan_forms(text)
            found = _first_match(ROLE_WORDS, forms)
            if found is not None:
                report.add(
                    "V4b.role_word",
                    f"role or verdict word {found!r} in public-tier text {forms[-1][:120]!r}",
                    variant,
                )
            found = _first_match(LEDGER_ID, forms)
            if found is not None:
                report.add("V4b.ledger_id", f"ledger or evaluator id {found!r} in public-tier text", variant)
            if other != case_ids[variant] and any(other in form for form in forms):
                report.add("V4b.other_case_id", "the other variant's case_id appears in public-tier text", variant)
            name = real_agency(text)
            if name is not None:
                report.add("V4b.real_agency", f"real agency or sponsor name {name!r} in public-tier text", variant)
    return report.issues


def check_guard_vocabulary(family: Family) -> list[Issue]:
    """V4c: no S2 G3-G5 match in public or subject-renderable text, per variant."""
    report = Reporter(family_id_of(family))
    for variant in VARIANTS:
        public, private, evaluator = packets(family, variant)
        for text in subject_renderable_text(public, private, evaluator):
            for hit in guard_hits(text):
                report.add(f"V4c.{hit.rule}", f"guard rule {hit.rule} matches {hit.match!r} in {text[:120]!r}", variant)
    return report.issues
