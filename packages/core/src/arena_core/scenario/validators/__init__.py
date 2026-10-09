"""S1 deterministic validators (S1 9.1-9.5): pure functions of family files.

`validate_family` runs V1 first; the later validators read the shapes the schema guarantees, so they run
only on a family that passed V1 (a V1 failure is reported alone). `validate_families` adds V5 across all
schema-valid families given. `issue_counts` reduces any result to codes and counts, the only form hidden
families' results may leave the isolated authoring session in (S1 L7, AC-S1-24).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from arena_core.agents.budget import over_limit
from arena_core.scenario.difficulty import compute_knobs
from arena_core.scenario.validators._common import Family, Issue
from arena_core.scenario.validators.v1 import check_real_agencies, check_relay, check_schema, check_storage
from arena_core.scenario.validators.v2 import check_consistency
from arena_core.scenario.validators.v3 import check_solvability
from arena_core.scenario.validators.v4 import check_guard_vocabulary, check_invariance, check_lexical
from arena_core.scenario.validators.v5 import check_diversity

__all__ = [
    "Family",
    "Issue",
    "compute_knobs",
    "issue_counts",
    "validate_families",
    "validate_family",
    "validate_split",
]


def validate_family(family: object) -> list[Issue]:
    """V1 (schema, storage), V1b, V1c, V2, V3a, V4a, V4b, V4c on one family file (parsed JSON)."""
    schema_issues = check_schema(family)
    if schema_issues or not isinstance(family, Mapping):
        return schema_issues
    valid: Mapping[str, Any] = family
    return [
        *check_storage(valid),
        *check_real_agencies(valid),
        *check_relay(valid),
        *check_consistency(valid),
        *check_solvability(valid),
        *check_invariance(valid),
        *check_lexical(valid),
        *check_guard_vocabulary(valid),
        *check_context(valid),
    ]


def check_context(family: Family) -> list[Issue]:
    """V1d.context (S2 2, O-10; D-014): every call kind, rendered with S2's prompt builders at the input caps,
    fits its input limit with the repair allowance (`arena_core.agents.budget`). A family that does not fit goes
    back to its author."""
    fid = str(family.get("family_id"))
    try:
        problems = over_limit(family)
    except ValueError as exc:
        return [Issue("V1d.context", f"the family cannot be rendered by the S2 builders ({type(exc).__name__})", fid)]
    return [Issue("V1d.context", p, fid, p.split(" ", 1)[0]) for p in problems]


def validate_split(families: Sequence[Family]) -> list[Issue]:
    """V5 across schema-valid families (dev and hidden together)."""
    return check_diversity(families)


def validate_families(families: Sequence[object]) -> list[Issue]:
    """Every per-family validator on each family, then V5 across the ones that passed V1."""
    issues: list[Issue] = []
    schema_valid: list[Family] = []
    for family in families:
        found = validate_family(family)
        issues.extend(found)
        if isinstance(family, Mapping) and not any(i.rule == "V1.schema" for i in found):
            schema_valid.append(family)
    issues.extend(validate_split(schema_valid))
    return issues


def issue_counts(issues: Iterable[Issue]) -> dict[str, int]:
    """Rule ID -> count, sorted by rule: no family ID, text or message (S1 L7)."""
    return dict(sorted(Counter(i.rule for i in issues).items()))
