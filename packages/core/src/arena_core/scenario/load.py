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

A caller may hand either shape: the attestation's own `CodexReview`, or the authoring loop's full per-family
CX report (`cases/dev/reports/<ID>.cx.json`, `is_legacy_codex_report`); `codex_review_from_report` reduces
the latter to the former, refusing one that does not record a clean pass (`LegacyCodexReportError`).

Variants are ordered by `variant_code`, so the insertion order of the public-tier `arena.case_variants`
rows cannot reveal which variant is truthful (L3). The loader refuses a family with any validator issue
(V1-V4 on the family, V5 over the whole dev split and, for a hidden family, the whole hidden split named by
its sampler record), because the attestation states that every
check passed and S4 stores packets immutably. The loader runs under `arena_referee`; the database call
itself lives with the S4 wrappers (WP-03).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TypeGuard

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from arena_core.ids import canonical_json, read_json_text, sha256_hex
from arena_core.scenario.source import VARIANTS
from arena_core.scenario.validators import Issue, issue_counts, validate_families
from arena_core.scenario.validators.v1 import check_schema

INGEST_FUNCTION = "sealed.ingest_case_family"
VALIDATOR_VERSION = "arena_core.scenario S1 v2.8"
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


LEGACY_REPORT_CHECKS: tuple[str, ...] = ("cx1", "cx4", "cx2_truthful", "cx2_deceptive", "cx3")
# S1 9.7: the three solve sheets with a nested basis (cx1 and cx4 are the review session, one verdict, no sheet).
LEGACY_SOLVE_KEYS: tuple[str, ...] = ("cx2_truthful", "cx2_deceptive", "cx3")


class LegacyCodexReportError(ValueError):
    """The authoring loop's full per-family CX report (`cases/dev/reports/<ID>.cx.json`, documented in
    `cases/dev/README.md`) does not record a clean pass on every check, or carries a review finding. The
    review is re-run on the family (S1 8.5 step 3); nothing here coerces a failed check to pass."""


def is_legacy_codex_report(raw: object) -> TypeGuard[dict[str, Any]]:
    """Whether `raw` is the authoring loop's full per-family CX report (S1 9.7) rather than the attestation's
    reduced `codex` object (S1 10.5, `CodexReview`). Both are the loop's own JSON: the report keeps every
    solve sheet and basis for audit (`cases/dev/README.md`), with one boolean per check plus `solves`, where
    the attestation holds five fields with `pass` literals. `solves` and `cx1` together are only ever on the
    report (`CodexReview` forbids both as extra fields), so the two shapes never overlap."""
    return isinstance(raw, dict) and "solves" in raw and "cx1" in raw


VALID_FINDINGS: frozenset[str] = frozenset({"truthful", "deceptive", "insufficient_evidence"})

# S1 9.7's own pass rule for each solve session, fixed by which session it is: CX-2 per variant compares
# against that variant's own correct finding (the truthful-variant session against `truthful`, the
# deceptive-variant session against `deceptive`); CX-3 (truthful variant, free evidence only) compares
# against `deceptive` or `insufficient_evidence` -- `truthful` is never a valid CX-3 finding. This is never
# something a sheet gets to claim for itself: a report that moves `finding` and its own `expected` field
# together, so the two still agree with each other, must still be refused below.
EXPECTED_FINDINGS: dict[str, frozenset[str]] = {
    "cx2_truthful": frozenset({"truthful"}),
    "cx2_deceptive": frozenset({"deceptive"}),
    "cx3": frozenset({"deceptive", "insufficient_evidence"}),
}


def _sheet_problems(key: str, sheet: Mapping[str, Any]) -> list[str]:
    """Whether one solve sheet (S1 9.7's CX-2 or CX-3 output shape: `finding`, `cited_records`, `cited_answers`,
    `basis`, `expected`, `pass`) is a real, filled-in sheet, not a bare `{"pass": true}` standing in for one,
    and that its own `finding` is the literal S1 9.7's fixed rule requires for this solve session
    (`EXPECTED_FINDINGS[key]`) -- never resolved by trusting `pass` alone, and never by trusting the sheet's
    own `expected` field, which is checked against that same fixed rule rather than used as the authority (so
    a report that moves `finding` and `expected` together is still refused). This is the sheet's internal
    self-consistency plus S1 9.7's fixed pass rule, the only things checkable without a model call; it is not
    a re-run of CX-2/CX-3's full semantic comparison against the family -- citation completeness against the
    family's own decisive-support items and their required account evidence runs in the authoring session
    itself (S1 9.7's own "code compares", outside this package, which reads no family data and runs no
    model), so a hand-edited report with a well-typed but fabricated or incomplete citation is not caught
    here."""
    problems = []
    if sheet.get("pass") is not True:
        problems.append(f"solves.{key}.pass is {sheet.get('pass')!r}, not true")
    finding = sheet.get("finding")
    if not isinstance(finding, str) or finding not in VALID_FINDINGS:
        problems.append(f"solves.{key}.finding is {finding!r}, not one of {sorted(VALID_FINDINGS)}")
    required = EXPECTED_FINDINGS[key]
    if isinstance(finding, str) and finding in VALID_FINDINGS and finding not in required:
        problems.append(f"solves.{key}.finding {finding!r} is not one of {sorted(required)} (S1 9.7, this session)")
    expected = sheet.get("expected")
    expected_values = {part.strip() for part in expected.split(" or ")} if isinstance(expected, str) else set()
    if expected_values != required:
        problems.append(f"solves.{key}.expected {expected!r} does not name exactly {sorted(required)} (S1 9.7)")
    cited_records = sheet.get("cited_records")
    if not isinstance(cited_records, list) or not all(isinstance(r, str) for r in cited_records):
        problems.append(f"solves.{key}.cited_records is not a list of strings: {cited_records!r}")
    elif key != "cx3" and not cited_records:
        # S1 9.7: CX-2's own pass rule needs the cited records to cover a decisive-support item, so an empty
        # list can never be real; CX-3's pass rule is `finding` alone (no citation requirement at all), so an
        # honest "insufficient_evidence" sheet may legitimately cite nothing.
        problems.append(f"solves.{key}.cited_records is empty (S1 9.7's CX-2 pass rule needs one cited)")
    cited_answers = sheet.get("cited_answers")
    if not isinstance(cited_answers, list) or not all(isinstance(a, str) for a in cited_answers):
        problems.append(f"solves.{key}.cited_answers is not a list of strings: {cited_answers!r}")
    basis = sheet.get("basis")
    if not isinstance(basis, str) or not basis.strip():
        problems.append(f"solves.{key}.basis is not a non-empty string: {basis!r}")
    return problems


def _solve_mismatches(report: Mapping[str, Any]) -> list[str]:
    """Where `report["solves"]` (S1 9.7's per-sheet basis, kept for audit) disagrees with the top-level flag
    `codex_review_from_report` would otherwise trust alone, or is not a real, filled-in sheet in the first
    place: a report edited (or corrupted) so one says pass and the other does not, or that stands in a bare
    `{"pass": true}` for a sheet, is refused, never resolved in the passing field's favor."""
    solves = report.get("solves")
    if not isinstance(solves, Mapping):
        return [f"solves is not an object: {solves!r}"]
    problems = []
    for key in LEGACY_SOLVE_KEYS:
        sheet = solves.get(key)
        if not isinstance(sheet, Mapping):
            problems.append(f"solves.{key} is not an object: {sheet!r}")
        else:
            problems.extend(_sheet_problems(key, sheet))
    return problems


def codex_review_from_report(report: Mapping[str, Any]) -> CodexReview:
    """The attestation's `codex` object (S1 10.5), reduced from the authoring loop's full per-family CX
    report (S1 9.7: one review session for CX-1 and CX-4, one solve session each for CX-2 truthful, CX-2
    deceptive and CX-3). Refuses (never coerces) a report whose `pass` summary disagrees with its checks or
    with its own nested solve sheets, that does not record every check as a real pass, or that carries a
    review finding — exactly what `ingest_bundle` would refuse from a passed-looking review that was not, so
    a stale or hand-edited report is never ingested.

    The report predates per-round tracking (S1 8.5 step 4: a seed is discarded after 5 failed rounds), so a
    report with no `rounds` field is recorded as round 1; `CodexReview` only bounds the field to 1-5, and S4
    does not check it against authoring history, so this never understates or overstates what S4 attests.
    """
    failed = [check for check in LEGACY_REPORT_CHECKS if report.get(check) is not True]
    findings = report.get("findings")
    overall = report.get("pass")
    solve_problems = _solve_mismatches(report)
    if failed or findings or overall is not True or solve_problems:
        family = report.get("family", "?")
        message = (
            f"{family}: the CX report does not record a clean pass "
            f"(failed={failed}, findings={findings!r}, pass={overall!r}, solves={solve_problems})"
        )
        raise LegacyCodexReportError(message)
    if "family_sha256" not in report:
        message = "the CX report has no family_sha256"
        raise LegacyCodexReportError(message)
    rounds = report.get("rounds", 1)
    if not isinstance(rounds, int):
        message = f"rounds is not an integer: {rounds!r}"
        raise LegacyCodexReportError(message)
    try:
        return CodexReview.model_validate(
            {
                "rounds": rounds,
                "review": "pass",
                "cx2_truthful": "pass",
                "cx2_deceptive": "pass",
                "cx3": "pass",
                "family_sha256": str(report["family_sha256"]),
            }
        )
    except ValidationError as exc:
        message = f"malformed CX report: {exc}"
        raise LegacyCodexReportError(message) from exc


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


@dataclass(frozen=True)
class DevSplit:
    """The development split as committed: every `F*.json` of one directory (`cases/dev`), each revision of a
    family in its own file. It is read whole, never assembled from a hand-picked list, so V5 sees every
    development family and every earlier revision."""

    families: tuple[dict[str, Any], ...]

    @classmethod
    def from_dir(cls, directory: Path) -> DevSplit:
        paths = sorted(directory.glob("F*.json"))
        if not paths:
            msg = f"{directory}: no development family file (F*.json)"
            raise FileNotFoundError(msg)
        return cls(tuple(read_family_file(path) for path in paths))


def corpus_issues(
    family: Mapping[str, Any],
    dev: Sequence[Mapping[str, Any]],
    hidden_split: Sequence[Mapping[str, Any]],
    sampler_record: Mapping[str, Any] | None,
) -> list[Issue]:
    """What the comparison corpus lacks for V5 to mean anything for this family (S1 8.6, 9.5, 10.3).

    V5 compares a family with others, so an attestation that V5 passed needs all of them: the development
    split (`DevSplit`, read whole) with the complete revision history of every lineage (the family's own
    earlier revisions included) and at least one
    development family of another lineage; for a hidden family, also the whole hidden split, which must be
    exactly the families the split's sampler record names (the inventory S4's seal checks, 10.3). Inputs are
    schema-valid (checked before this)."""
    fid, revision = str(family["family_id"]), int(family["revision"])
    histories: dict[str, set[int]] = {}
    for f in dev:
        histories.setdefault(str(f["family_id"]), set()).add(int(f["revision"]))
    if family["split"] == "dev":
        histories.setdefault(fid, set()).add(revision)
    issues: list[Issue] = []
    for lineage, present in sorted(histories.items()):
        # Every lineage's history is complete: a retired revision's text and case IDs stay comparable (9.5).
        missing = sorted(set(range(1, max(present) + 1)) - present)
        if missing:
            message = f"revisions {missing} of {lineage} are not in the dev split"
            issues.append(Issue("CORPUS.predecessor", message, fid))
    if not any(str(f["family_id"]) != fid for f in dev):
        issues.append(Issue("CORPUS.dev_baseline", "the dev split holds no family of another lineage", fid))
    if family["split"] == "hidden":
        given = sorted({fid} | {str(f["family_id"]) for f in hidden_split})
        assignment = (sampler_record or {}).get("assignment")
        entries = assignment if isinstance(assignment, list) else []
        named = sorted(str(e.get("family_id")) if isinstance(e, Mapping) else "" for e in entries)
        if sampler_record is None or given != named:
            issues.append(Issue("CORPUS.hidden_split", "the hidden families are not the split's sampler record", fid))
    elif hidden_split:
        issues.append(Issue("CORPUS.hidden_split", "a development family is compared with the dev split only", fid))
    return issues


def ingest_bundle(
    family: Mapping[str, Any],
    codex: CodexReview,
    dev: DevSplit,
    hidden_split: Sequence[Mapping[str, Any]] = (),
    sampler_record: Mapping[str, Any] | None = None,
) -> IngestBundle:
    """The S4 ingest bundle of one valid family; FamilyLoadError lists the issues of an invalid one.

    V5 compares the family with the whole development split (`dev`, its own earlier revisions included) and,
    for a hidden family, with the rest of the hidden split named by `sampler_record`; an incomplete corpus is
    refused (`corpus_issues`), so the attestation's `checks_passed` is true when it is written. Every input
    is schema-checked first. The family's own file in the dev split is compared once.
    """
    others = [f for f in (*dev.families, *hidden_split) if canonical_json(f) != canonical_json(family)]
    issues = [issue for f in (family, *others) for issue in check_schema(f)]
    if not issues:
        dev_others = [f for f in dev.families if canonical_json(f) != canonical_json(family)]
        issues = corpus_issues(family, dev_others, hidden_split, sampler_record)
    if not issues:
        issues = validate_families([*others, family])
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
