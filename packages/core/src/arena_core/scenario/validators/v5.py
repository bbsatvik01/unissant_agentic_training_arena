"""V5 diversity across families (S1 9.5; leakage rule L4 of S1 10.2; AC-S1-18, AC-S1-35).

A lineage is one family ID with its revisions (S1 8.6); its active family is its highest revision.

- `V5.family_id`: no (family ID, revision) appears twice.
- `V5.case_id`: case IDs are unique across all families and revisions (a revision draws new ones).
- `V5.names`: a persona name belongs to one lineage.
- `V5.lineage`: every revision of a family keeps its predecessor's persona name and facility (S1 8.6).
- `V5.signature`: within a split, no two active families share (violation type, first misleading type).
- `V5.lexical`: word 3-gram Jaccard over all fact statements is at most `JACCARD_MAX` for every pair of active
  families of different lineages within a split, and for every hidden family against every development
  family, retired revisions included (their text is in the repository).
- `V5.facility`: no facility is used by both a dev family (any revision) and a hidden family.
- `V5.type_quota`: a hidden split has at most `HIDDEN_PER_TYPE` families per violation type, so a split of
  n families covers at least ceil(n/2) types; a split larger than twice the catalog therefore always fails.
- `V5.coverage_levels`: a hidden split covers every difficulty level (a split of one or two families
  cannot, and fails).

Text is compared as the runtime renders it: statements through `sanitize_untrusted_text`, names and
facilities through `guardscan.identity_key` (also case-folded, whitespace collapsed), so a Unicode
disguise cannot make a copy look new.

Inputs are schema-valid family files (V1). For a hidden split this runs inside the isolated authoring
session, against the development files, and only `issue_counts` of the result leaves it (S1 L7).
"""

from __future__ import annotations

import itertools
import re
from collections import Counter
from collections.abc import Iterator, Sequence

from arena_core.agents.fence import sanitize_untrusted_text
from arena_core.scenario.difficulty import LEVELS
from arena_core.scenario.guardscan import identity_key
from arena_core.scenario.validators._common import Family, Issue, Reporter

JACCARD_MAX = 0.20  # initial value, tuned in the dev pilot on development data only (S1 9.5)
HIDDEN_PER_TYPE = 2  # S1 8.1, 9.5
SHINGLE_WORDS = 3
_WORD = re.compile(r"[a-z0-9]+")


def shingles(family: Family, n: int = SHINGLE_WORDS) -> set[tuple[str, ...]]:
    """Word n-grams over all fact statements joined in event-graph order (S1 9.5; reference `shingles`),
    read as the runtime renders them (`sanitize_untrusted_text`), so a Unicode disguise changes nothing."""
    text = " ".join(sanitize_untrusted_text(str(f["statement"])) for f in family["event_graph"]["facts"])
    words = _WORD.findall(text.lower())
    return {tuple(words[i : i + n]) for i in range(len(words) - n + 1)}


def jaccard(a: set[tuple[str, ...]], b: set[tuple[str, ...]]) -> float:
    union = a | b
    return len(a & b) / len(union) if union else 0.0


def _name(family: Family) -> str:
    return identity_key(str(family["variants"]["truthful"]["public_packet"]["interview_context"]["subject"]["name"]))


def _facility(family: Family) -> str:
    return identity_key(str(family["variants"]["truthful"]["public_packet"]["interview_context"]["facility"]))


def _active(families: Sequence[Family]) -> list[Family]:
    """The highest revision of each lineage, in family-ID order."""
    latest: dict[str, Family] = {}
    for f in families:
        fid = str(f["family_id"])
        if fid not in latest or int(f["revision"]) > int(latest[fid]["revision"]):
            latest[fid] = f
    return [latest[fid] for fid in sorted(latest)]


def _check_unique(families: Sequence[Family], report: Reporter) -> None:
    identities = Counter((str(f["family_id"]), int(f["revision"])) for f in families)
    for (fid, revision), count in sorted(identities.items()):
        if count > 1:
            report.add("V5.family_id", f"family {fid} revision {revision} appears {count} times")
    owners: dict[str, list[str]] = {}
    for f in families:
        for variant in ("truthful", "deceptive"):
            owners.setdefault(str(f["variants"][variant]["case_id"]), []).append(f"{f['family_id']} r{f['revision']}")
    for case_id, users in sorted(owners.items()):
        if len(users) > 1:
            report.add("V5.case_id", f"case_id {case_id} is used by {users}")
    lineages: dict[str, set[str]] = {}
    for f in families:
        lineages.setdefault(_name(f), set()).add(str(f["family_id"]))
    for name, fids in sorted(lineages.items()):
        if len(fids) > 1:
            report.add("V5.names", f"persona name {name!r} is used by families {sorted(fids)}")
    lineage_identity: dict[str, set[tuple[str, str]]] = {}
    for f in families:
        lineage_identity.setdefault(str(f["family_id"]), set()).add((_name(f), _facility(f)))
    for fid, seen in sorted(lineage_identity.items()):
        if len(seen) > 1:
            report.add("V5.lineage", f"revisions of {fid} differ in persona name or facility: {sorted(seen)}")


def _check_signatures(split: str, members: Sequence[Family], report: Reporter) -> None:
    seen: dict[tuple[str, str], str] = {}
    for f in members:
        key = (str(f["taxonomy"]["violation_type"]), str(f["taxonomy"]["misleading_types"][0]))
        if key in seen:
            report.add("V5.signature", f"{split}: signature {key} shared by {seen[key]} and {f['family_id']}")
        seen[key] = str(f["family_id"])


def _lexical_pairs(families: Sequence[Family], active: Sequence[Family]) -> Iterator[tuple[Family, Family]]:
    """Active families of different lineages within a split, and every hidden family against every dev
    family of any revision."""
    for a, b in itertools.combinations(active, 2):
        if a["split"] == b["split"]:
            yield a, b
    dev = [f for f in families if f["split"] == "dev"]
    for hidden in (f for f in active if f["split"] == "hidden"):
        for d in dev:
            yield d, hidden


def _check_lexical(families: Sequence[Family], active: Sequence[Family], report: Reporter) -> None:
    for a, b in _lexical_pairs(families, active):
        score = jaccard(shingles(a), shingles(b))
        if score > JACCARD_MAX:
            pair = f"({a['family_id']} r{a['revision']}, {b['family_id']} r{b['revision']})"
            report.add("V5.lexical", f"word 3-gram Jaccard{pair} = {score:.3f} > {JACCARD_MAX}")


def _check_coverage(hidden: Sequence[Family], report: Reporter) -> None:
    for vtype, count in sorted(Counter(str(f["taxonomy"]["violation_type"]) for f in hidden).items()):
        if count > HIDDEN_PER_TYPE:
            report.add("V5.type_quota", f"violation type {vtype} is used by {count} hidden families (at most 2)")
    missing = sorted(set(LEVELS) - {int(f["difficulty"]["level"]) for f in hidden})
    if missing:
        report.add("V5.coverage_levels", f"hidden split misses difficulty levels {missing}")


def check_diversity(families: Sequence[Family]) -> list[Issue]:
    """V5 over every family given (dev and hidden together)."""
    report = Reporter(None)
    _check_unique(families, report)
    active = _active(families)
    by_split: dict[str, list[Family]] = {}
    for f in active:
        by_split.setdefault(str(f["split"]), []).append(f)
    for split, members in sorted(by_split.items()):
        _check_signatures(split, members, report)
    _check_lexical(families, active, report)
    dev_facilities = {_facility(f) for f in families if f["split"] == "dev"}
    for facility in sorted(dev_facilities & {_facility(f) for f in by_split.get("hidden", [])}):
        report.add("V5.facility", f"facility {facility!r} is used by both dev and hidden families")
    if by_split.get("hidden"):
        _check_coverage(by_split["hidden"], report)
    return report.issues
