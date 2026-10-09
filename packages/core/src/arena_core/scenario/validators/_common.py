"""Shared types and accessors for the S1 validators.

Every validator after V1 reads a family that already passed the case-family schema (V1), so the shapes
the schema guarantees (required keys, enums, ID patterns, list bounds) are relied on, not re-checked.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from arena_core.scenario.source import VARIANTS, Variant

Family = Mapping[str, Any]
__all__ = ["VARIANTS", "Family", "Issue", "Variant"]


@dataclass(frozen=True, slots=True)
class Issue:
    """One validator finding. `rule` is stable (`V2.time_order`); its prefix names the validator."""

    rule: str
    message: str
    family_id: str | None = None
    variant: str | None = None
    path: str | None = None

    @property
    def validator(self) -> str:
        return self.rule.split(".", 1)[0]

    def __str__(self) -> str:
        where = "/".join(p for p in (self.family_id, self.variant) if p)
        return f"{self.rule} [{where}] {self.message}" if where else f"{self.rule} {self.message}"


class Reporter:
    """Builds issues for one family (and optionally one variant)."""

    def __init__(self, family_id: str | None) -> None:
        self.family_id = family_id
        self.issues: list[Issue] = []

    def add(self, rule: str, message: str, variant: str | None = None, path: str | None = None) -> None:
        self.issues.append(Issue(rule, message, self.family_id, variant, path))


def family_id_of(family: object) -> str | None:
    if isinstance(family, Mapping):
        value = family.get("family_id")
        if isinstance(value, str):
            return value
    return None


def packets(family: Family, variant: Variant) -> tuple[Mapping[str, Any], Mapping[str, Any], Mapping[str, Any]]:
    """(public, private, evaluator) packets of one variant."""
    v = family["variants"][variant]
    return v["public_packet"], v["private_packet"], v["evaluator_packet"]


def variant_fact_ids(family: Family, variant: Variant) -> list[str]:
    return [str(f["id"]) for f in family["event_graph"]["facts"] if variant in f["variants"]]


def strings(obj: object) -> Iterator[str]:
    """Every string value in a JSON value, depth first (keys are schema-fixed and not included)."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, Mapping):
        for value in obj.values():
            yield from strings(value)
    elif isinstance(obj, Sequence):
        for value in obj:
            yield from strings(value)
