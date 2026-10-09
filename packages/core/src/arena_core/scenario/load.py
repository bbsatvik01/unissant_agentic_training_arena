"""Loader: a case-family file -> the bundle S4 `sealed.ingest_case_family(p_bundle)` accepts (S1 4.4, 10.5).

Bundle shape (`docs/spec/sql/0002_cases.sql`):

    {family_code, domain, split, supersedes (revisions only), source, attestation,
     variants: [{variant_code, role, style, difficulty, public_packet, private_packet, evaluator_packet,
                 artifacts: [{record_id, kind, doc_kind, title, content, requestable, scheduled_turn,
                              request_after_turn}]}]}

Mapping (S1 4.4): `family_code` is the family ID, plus `.rN` for revision N >= 2 (S1 8.6), and `supersedes`
names the active predecessor (`Fnn` for r2, `Fnn.r(N-1)` after that); `variant_code` is the variant's opaque
`case_id`, never a role word (L3; S4 checks the shape, C-25); `role` comes from the evaluator packet;
`style` and `difficulty` are the family's; the three packets go in verbatim; `artifacts` are the releasable
`rec-NN` records only (initial documents stay in the public packet), with `kind` `clarification` /
`context_change` kept and every other S1 kind mapped to `record`, `doc_kind` the S1 kind (C-24),
`requestable` true for on-request records, `scheduled_turn` the predicate value of a scheduled record and
`request_after_turn` that of an on-request record (the other one null).

`source` is the family file as canonical JSON text (S1 8.4) and `attestation` its authoring attestation
(S1 10.5): `{family_id, revision, family_sha256, validator_version, checks_passed, codex}`, where
`family_sha256` is the sha256 of `source` and `codex` the passed Codex review (`CodexReview`, given by the
authoring loop; this package runs no model). The review names the family hash it was run on, and a review of
any other file is refused (S1 8.5 step 3). S4 checks the two against each other and the variants.

Variants are ordered by `variant_code`, so the insertion order of the public-tier `arena.case_variants`
rows cannot reveal which variant is truthful (L3). The loader refuses a family with any validator issue
(V1-V4 on the family, V5 over the family and its comparison corpus), because the attestation states that every
check passed and S4 stores packets immutably. The loader runs under `arena_referee`; the database call
itself lives with the S4 wrappers (WP-03).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from arena_core.ids import canonical_json, read_json_text, sha256_hex
from arena_core.scenario.source import VARIANTS
from arena_core.scenario.validators import Issue, issue_counts, validate_families

INGEST_FUNCTION = "sealed.ingest_case_family"
VALIDATOR_VERSION = "arena_core.scenario S1 v2.7"
# S1 10.5: the deterministic checks an attestation names; S4 refuses an attestation that lacks one.
CHECKS_PASSED: tuple[str, ...] = ("V1", "V1b", "V1c", "V1d", "V2", "V3a", "V4a", "V4b", "V4c", "V5")
MAX_CODEX_ROUNDS = 5  # S1 8.5 step 4
FIRST_REVISION_CODE = 2  # S1 8.6: revision 1 is `Fnn`, revision N >= 2 is `Fnn.rN`


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class IngestArtifact(_Model):
    record_id: str
    kind: Literal["record", "clarification", "context_change"]
    doc_kind: str
    title: str
    content: dict[str, Any]
    requestable: bool
    scheduled_turn: int | None
    request_after_turn: int | None


class IngestVariant(_Model):
    variant_code: str
    role: Literal["truthful", "deceptive"]
    style: dict[str, str]
    difficulty: int
    public_packet: dict[str, Any]
    private_packet: dict[str, Any]
    evaluator_packet: dict[str, Any]
    artifacts: tuple[IngestArtifact, ...]


class CodexResults(_Model):
    """The attestation's `codex` object (S1 10.5): every result a pass."""

    rounds: int = Field(ge=1, le=MAX_CODEX_ROUNDS)
    review: Literal["pass"]
    cx2_truthful: Literal["pass"]
    cx2_deceptive: Literal["pass"]
    cx3: Literal["pass"]


class CodexReview(CodexResults):
    """A passed Codex review together with the family-file hash it was run on (S1 8.5 step 3: the validators
    and the review pass on the same hash). The loader refuses it for any other family file."""

    family_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    def results(self) -> CodexResults:
        return CodexResults.model_validate(self.model_dump(exclude={"family_sha256"}))


class Attestation(_Model):
    family_id: str
    revision: int
    family_sha256: str
    validator_version: str
    checks_passed: tuple[str, ...]
    codex: CodexResults


class IngestBundle(_Model):
    family_code: str
    domain: str
    split: Literal["dev", "hidden"]
    supersedes: str | None
    source: str
    attestation: Attestation
    variants: tuple[IngestVariant, ...]

    def as_json(self) -> dict[str, Any]:
        """The bundle as JSON; `supersedes` is present only on a revision (S4 refuses it on revision 1)."""
        data: dict[str, Any] = self.model_dump(mode="json")
        if data["supersedes"] is None:
            del data["supersedes"]
        return data

    def to_json(self) -> str:
        """Canonical JSON text, the `p_bundle` argument of `sealed.ingest_case_family`."""
        return canonical_json(self.as_json())


class FamilyLoadError(ValueError):
    """The family has validator issues; nothing is ingested.

    The message holds rule codes and counts only, so a hidden family's text never reaches a log or span
    through it (S1 L6, L7); callers inside the isolated authoring session read `issues` for the details.
    """

    def __init__(self, issues: list[Issue]) -> None:
        self.issues = issues
        super().__init__(f"{len(issues)} validator issue(s): {canonical_json(issue_counts(issues))}")


def read_family_file(path: Path) -> dict[str, Any]:
    """A family file through the strict reader: one JSON object, no duplicate keys, no NaN or Infinity."""
    family = read_json_text(path.read_text(encoding="utf-8"))
    if not isinstance(family, dict):
        msg = f"{path.name}: a family file holds one JSON object"
        raise TypeError(msg)
    return family


def _artifact(artifact: Mapping[str, Any]) -> IngestArtifact:
    release = artifact["release"]
    kind = str(artifact["kind"])
    return IngestArtifact(
        record_id=str(artifact["artifact_id"]),
        kind="clarification" if kind == "clarification" else "context_change" if kind == "context_change" else "record",
        doc_kind=kind,
        title=str(artifact["title"]),
        content=dict(artifact["content"]),
        requestable=release["type"] == "on_request",
        scheduled_turn=int(release["after_exchanges"]) if release["type"] == "scheduled" else None,
        request_after_turn=int(release["after_exchanges"]) if release["type"] == "on_request" else None,
    )


def family_code(family: Mapping[str, Any]) -> str:
    """S4's family code: the family ID, plus `.rN` for revision N >= 2 (S1 8.6)."""
    revision = int(family["revision"])
    return str(family["family_id"]) + (f".r{revision}" if revision >= FIRST_REVISION_CODE else "")


def supersedes(family: Mapping[str, Any]) -> str | None:
    """The family code of the active predecessor of a revision (S1 4.4), None for revision 1."""
    revision = int(family["revision"])
    if revision < FIRST_REVISION_CODE:
        return None
    return family_code({"family_id": family["family_id"], "revision": revision - 1})


def family_source_text(family: Mapping[str, Any]) -> str:
    """The archived form of a family file: canonical JSON text (S1 8.4, 10.5)."""
    return canonical_json(family)


def attestation(family: Mapping[str, Any], codex: CodexReview) -> Attestation:
    """The authoring attestation of a family whose checks all passed (S1 10.5): codes and hashes only."""
    return Attestation(
        family_id=str(family["family_id"]),
        revision=int(family["revision"]),
        family_sha256=sha256_hex(family_source_text(family)),
        validator_version=VALIDATOR_VERSION,
        checks_passed=CHECKS_PASSED,
        codex=codex.results(),
    )


def corpus_issues(family: Mapping[str, Any], corpus: Sequence[Mapping[str, Any]]) -> list[Issue]:
    """What the comparison corpus lacks for V5 to mean anything for this family (S1 9.5, 8.6, 10.3).

    V5 compares a family with others, so an attestation that V5 passed needs the families it must be compared
    with: every earlier revision of its lineage (a revision draws new case IDs, keeps its persona and
    facility), and the development baseline, at least one development family of another lineage (names,
    signatures, facilities and text are compared with it; for a hidden family that is the hidden-dev check
    of L4). A hidden family's split peers are the caller's to add: V5's quota and level coverage need them."""
    fid, revision = str(family["family_id"]), int(family["revision"])
    present = {int(f["revision"]) for f in corpus if str(f["family_id"]) == fid}
    issues: list[Issue] = []
    missing = sorted(set(range(1, revision)) - present)
    if missing:
        issues.append(Issue("CORPUS.predecessor", f"revisions {missing} of {fid} are not in the corpus", fid))
    if not any(f["split"] == "dev" and str(f["family_id"]) != fid for f in corpus):
        issues.append(Issue("CORPUS.dev_baseline", "the corpus holds no development family of another lineage", fid))
    return issues


def ingest_bundle(family: Mapping[str, Any], codex: CodexReview, corpus: Sequence[Mapping[str, Any]]) -> IngestBundle:
    """The S4 ingest bundle of one valid family; FamilyLoadError lists the issues of an invalid one.

    `corpus` is what V5 compares the family with: the development split (every revision, the family's own
    predecessors included) and, for a hidden family, the rest of its split. A corpus without the family's
    earlier revisions or without a development baseline is refused (`corpus_issues`), so the attestation's
    `checks_passed` is true when it is written. A copy of the family itself in the corpus (a development
    directory holds it) is compared once.
    """
    others = [f for f in corpus if canonical_json(f) != canonical_json(family)]
    issues = corpus_issues(family, others) or validate_families([*others, family])
    if not issues and codex.family_sha256 != sha256_hex(family_source_text(family)):
        message = "the Codex review was run on a different family file (S1 8.5 step 3: same hash)"
        issues = [Issue("CODEX.family_sha256", message, str(family.get("family_id")))]
    if issues:
        raise FamilyLoadError(issues)
    variants = []
    for variant in VARIANTS:
        v = family["variants"][variant]
        evaluator = v["evaluator_packet"]
        variants.append(
            IngestVariant(
                variant_code=str(v["case_id"]),
                role=evaluator["role"],
                style=dict(family["style"]),
                difficulty=int(family["difficulty"]["level"]),
                public_packet=dict(v["public_packet"]),
                private_packet=dict(v["private_packet"]),
                evaluator_packet=dict(evaluator),
                artifacts=tuple(
                    _artifact(a)
                    for a in sorted(evaluator["evidence_artifacts"], key=lambda a: str(a["artifact_id"]))
                    if str(a["artifact_id"]).startswith("rec-")
                ),
            )
        )
    return IngestBundle(
        family_code=family_code(family),
        domain=str(family["domain"]),
        split=family["split"],
        supersedes=supersedes(family),
        source=family_source_text(family),
        attestation=attestation(family, codex),
        variants=tuple(sorted(variants, key=lambda v: v.variant_code)),
    )
