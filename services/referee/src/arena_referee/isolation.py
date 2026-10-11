"""Isolation-gate runner IO (S3 9; IG-1..IG-6; WP-16): the referee reads its own sealed hidden families to
build the scan corpus and never sends their content anywhere else (L6, L7).

Every check here is system-wide, matching `arena.isolation_checks`'s own schema (no `tournament_id`
column) and S3 9's preamble ("isolation_pass is true... for the tournament's code version... and migration
version"): the gate is a property of the running deployment, shared by whichever tournament asks, never one
tournament's own state. A check scoped to a single tournament (an earlier draft of this module took one)
would let a stale or unrelated tournament's passing result authorize a different tournament's reveal, and a
single hidden split is sealed once for every hidden tournament anyway (S1 10.3) -- there is nothing to scope.

A caller supplies only IG-1, IG-2 and IG-3's own report evidence (the suites they prove are run by the gates
this process sits inside, S5 11.1); IG-4 (hidden-text scan), IG-5 (commitment/chain verification) and IG-6
(canary audit, scanning every candidate's own coach cards and findings) are computed here, live, every call.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from arena_core.db.pool import Connector
from arena_core.referee.isolation import (
    IsolationEvidence,
    combined_corpus_scan_evidence,
    count_canary_hits,
    ig4_evidence,
    ig5_evidence,
    ig6_evidence,
    report_evidence,
)
from arena_core.scenario.corpus import Corpus, build_corpus, dev_reference_grams, family_canaries
from arena_core.scoring.ranking import DEV_IG_ITEMS, IsolationResult, isolation_result
from arena_referee import db

# The development prompt and fixture surfaces S1 10.4/AC-S1-21 name: template and few-shot text a rostered
# manifest can reach. Bounded and simple (D-016): three directories, not a repo-wide walk.
DEFAULT_SCAN_ROOTS = (Path("prompts"), Path("cases/dev"), Path("packages/core/src/arena_core/fixtures"))
_SCAN_SUFFIXES = (".md", ".json", ".txt", ".py")  # fixtures/injection.py, style.py: few-shot text in code too


@dataclass(frozen=True)
class HiddenCorpora:
    corpora: list[Corpus]
    canaries: frozenset[str]  # every sealed hidden family's own canaries (IG-6's scan target)


async def fetch_hidden_corpora(connect: Connector) -> HiddenCorpora:
    """One `Corpus` per sealed hidden family (`sealed.family_ingests.source`, read as `arena_referee` --
    the one role allowed to), never a file from the deleted `cases/hidden/` (L6), plus every one's canaries
    (one query, so IG-6 never re-reads the sealed archive separately). The development reference (10.4's
    subtraction) is fixed at the hidden split's own seal commit: only dev families ingested at or before
    that seal count, so a dev family added afterward can never retroactively subtract text from the scan
    (S1 10.4's "fixed at the seal commit", literally)."""
    async with connect() as conn:
        cur = await conn.execute(
            "select f.split, fi.source, fi.created_at <= coalesce("
            "         (select h.created_at from sealed.hidden_split_seals h), 'infinity'::timestamptz)"
            " from sealed.family_ingests fi join arena.case_families f on f.id = fi.family_id"
        )
        rows = await cur.fetchall()
    hidden = [json.loads(source) for split, source, _before_seal in rows if split == "hidden"]
    dev_at_seal = [json.loads(source) for split, source, before_seal in rows if split == "dev" and before_seal]
    reference = dev_reference_grams(dev_at_seal)
    canaries: set[str] = set()
    for family in hidden:
        canaries |= family_canaries(family)
    return HiddenCorpora([build_corpus(family, reference) for family in hidden], frozenset(canaries))


async def verify_hidden_seal(connect: Connector) -> bool:
    async with connect() as conn:
        cur = await conn.execute("select sealed.verify_hidden_seal()")
        row = await cur.fetchone()
    return bool(row and row[0])


async def verify_chain(connect: Connector) -> bool:
    async with connect() as conn:
        cur = await conn.execute("select ledger.verify_chain()")
        row = await cur.fetchone()
    return row is None or row[0] is None


async def verify_all_corpus_seals(connect: Connector) -> bool:
    """Every sealed replay corpus (across every tournament that has one) verifies against its own digest
    (S4 `ledger.corpus_digest`); vacuously true when none exists yet."""
    async with connect() as conn:
        cur = await conn.execute(
            "select not exists ("
            "  select 1 from ledger.corpus_seals s"
            "   where s.corpus_sha256 is distinct from"
            "         (select d.corpus_sha256 from ledger.corpus_digest(s.tournament_id) d)"
            ")"
        )
        row = await cur.fetchone()
    return bool(row and row[0])


async def fetch_commitment_results(connect: Connector) -> dict[str, bool]:
    """Every finalized trial, system-wide, `ledger.verify_commitment` (BKO-9, SG3-42, IG-5's own wording:
    "every finalized trial", not one tournament's)."""
    async with connect() as conn:
        cur = await conn.execute(
            "select t.id::text, ledger.verify_commitment(t.id) from arena.trials t where t.status = 'finalized'"
        )
        rows = await cur.fetchall()
    return {trial_id: bool(ok) for trial_id, ok in rows}


_COACH_EVENT_KINDS = ("coach_card", "coach_deep")  # coach_unavailable carries no assistant-authored text


async def fetch_assistant_output_texts(connect: Connector) -> dict[str, list[str]]:
    """IG-6's own scan surface (S3 9, "assistant outputs"): every candidate's own coach-card AND coach-deep
    events (both are persisted assistant-authored payloads, `arena.trial_events.kind`; a canary surfacing
    only in a deep response must fail the audit too, not just a card) plus committed findings, as text,
    system-wide. Phoenix spans and logs are a separate surface this does not reach (WP-07's observability
    pipeline); disclosed, not silently skipped."""
    texts: dict[str, list[str]] = {}
    async with connect() as conn:
        cur = await conn.execute(
            "select t.assistant_candidate_id::text, e.payload::text"
            "  from arena.trial_events e join arena.trials t on t.id = e.trial_id"
            " where e.kind = any(%s) and t.assistant_candidate_id is not null",
            (list(_COACH_EVENT_KINDS),),
        )
        for candidate_id, payload_text in await cur.fetchall():
            texts.setdefault(candidate_id, []).append(payload_text)
    async with connect() as conn:
        cur = await conn.execute(
            "select t.assistant_candidate_id::text, f.finding::text"
            "  from arena.final_findings f join arena.trials t on t.id = f.trial_id"
            " where t.assistant_candidate_id is not null"
        )
        for candidate_id, finding_text in await cur.fetchall():
            texts.setdefault(candidate_id, []).append(finding_text)
    return texts


def read_scan_files(roots: Sequence[Path] = DEFAULT_SCAN_ROOTS) -> dict[str, str]:
    """Every text file under `roots` with a scannable suffix (prompts, dev fixtures, few-shot files, AC-S1-
    21). A missing root fails closed: a scan of nothing would silently pass IG-4 (the empty report has no
    hits), the exact gate-softening a checked-out-but-unreachable prompt tree must not cause."""
    missing = [root for root in roots if not root.is_dir()]
    if missing:
        msg = f"isolation-gate scan root(s) missing (would scan nothing and pass vacuously): {missing}"
        raise FileNotFoundError(msg)
    files: dict[str, str] = {}
    for root in roots:
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix in _SCAN_SUFFIXES:
                files[str(path)] = path.read_text(encoding="utf-8", errors="replace")
    return files


@dataclass(frozen=True, kw_only=True)
class IsolationGateRequest:
    """One isolation-gate run's inputs (S3 9): `ig1`/`ig2`/`ig3` are `(passed, report_text)` from the
    caller's own already-run pgTAP, route-test and assistant-context suites (`report_evidence` hashes
    each). IG-4, IG-5 and IG-6 need nothing from the caller -- they are computed live."""

    git_sha: str
    ig1: tuple[bool, str]
    ig2: tuple[bool, str]
    ig3: tuple[bool, str]
    scan_roots: Sequence[Path] = DEFAULT_SCAN_ROOTS


_IG123 = ("IG-1", "IG-2", "IG-3")


async def _ig5(connect: Connector) -> tuple[bool, str]:
    chain_ok = await verify_chain(connect)
    corpus_seal_ok = await verify_all_corpus_seals(connect)
    commitments = await fetch_commitment_results(connect)
    return ig5_evidence(chain_verifies=chain_ok, corpus_seal_verifies=corpus_seal_ok, commitments=commitments)


async def _record(connect: Connector, evidence: IsolationEvidence, git_sha: str) -> None:
    # Known gap (not fixed this round, Codex finding #2): each item below commits in its own transaction
    # (`db.record_isolation_check`), not all atomically. If a write fails partway through, the NEXT read of
    # `arena.isolation_checks` ("latest row per check_name") would fold this run's successful writes together
    # with an EARLIER run's result for whichever item never got rewritten. A write failure does propagate to
    # the caller (`routes.reveal._run` never swallows it), so the gap is in what a LATER read sees.
    for item, (passed, evidence_hash) in evidence.items.items():
        await db.record_isolation_check(
            connect,
            db.IsolationCheckRow(
                check_name=db.CHECK_NAMES[item],
                passed=passed,
                evidence_hash=evidence_hash,
                commit_sha=git_sha,
                candidate_id=evidence.canary_culprit if item == "IG-6" else None,
            ),
        )


async def _recompute_and_record(
    connect: Connector, *, ig123: Mapping[str, tuple[bool, str]], git_sha: str, scan_roots: Sequence[Path]
) -> IsolationResult:
    """Shared by `run_isolation_gate` (IG-1/2/3 freshly hashed from the caller's own report text) and
    `fetch_fresh_isolation_result` (IG-1/2/3 reused from the latest already-recorded result for this
    git_sha -- they are code-version-scoped, never tournament-data-scoped, so nothing about them needs
    recomputing): IG-4, IG-5 and IG-6 are ALWAYS recomputed here, live, against current data, and every
    item (all six) is written as a fresh `arena.isolation_checks` row."""
    hidden = await fetch_hidden_corpora(connect)
    files = read_scan_files(scan_roots)
    scan = combined_corpus_scan_evidence(hidden.corpora, files)
    seal_ok = await verify_hidden_seal(connect)
    output_texts = await fetch_assistant_output_texts(connect)
    canary = ig6_evidence(count_canary_hits(hidden.canaries, output_texts))

    evidence = IsolationEvidence(
        items={
            "IG-1": ig123["IG-1"],
            "IG-2": ig123["IG-2"],
            "IG-3": ig123["IG-3"],
            "IG-4": ig4_evidence(seal_verifies=seal_ok, scan=scan),
            "IG-5": await _ig5(connect),
            "IG-6": (canary.passed, canary.evidence_hash),
        },
        canary_culprit=canary.culprit,
    )
    await _record(connect, evidence, git_sha)
    return evidence.result()


async def fetch_family_canaries(connect: Connector) -> frozenset[str]:
    """Every ingested family's canaries, dev and hidden (a dev tournament's own private packets carry the dev
    families' canaries; a hidden canary in any output is a leak too)."""
    async with connect() as conn:
        cur = await conn.execute("select fi.source from sealed.family_ingests fi")
        rows = await cur.fetchall()
    canaries: set[str] = set()
    for (source,) in rows:
        canaries |= family_canaries(json.loads(source))
    return frozenset(canaries)


async def fetch_fresh_dev_isolation_result(connect: Connector, git_sha: str) -> IsolationResult:
    """A dev tournament's reveal gate (`DEV_IG_ITEMS`): IG-5 and IG-6 recomputed live over current data and
    recorded, exactly as the hidden gate does; it never reads the hidden seal or a hidden corpus (IG-4) and
    needs no suite reports (IG-1..3), since a dev open records none (S1 L9 gates the hidden split)."""
    output_texts = await fetch_assistant_output_texts(connect)
    canary = ig6_evidence(count_canary_hits(await fetch_family_canaries(connect), output_texts))
    evidence = IsolationEvidence(
        items={"IG-5": await _ig5(connect), "IG-6": (canary.passed, canary.evidence_hash)},
        canary_culprit=canary.culprit,
    )
    await _record(connect, evidence, git_sha)
    return isolation_result(evidence.items, DEV_IG_ITEMS)


async def run_isolation_gate(connect: Connector, request: IsolationGateRequest) -> IsolationResult:
    """Runs every IG item and writes one `arena.isolation_checks` row each (S3 9), returning the combined
    `IsolationResult` `rank()` consumes."""
    ig123 = {
        "IG-1": report_evidence(passed=request.ig1[0], report_text=request.ig1[1]),
        "IG-2": report_evidence(passed=request.ig2[0], report_text=request.ig2[1]),
        "IG-3": report_evidence(passed=request.ig3[0], report_text=request.ig3[1]),
    }
    return await _recompute_and_record(connect, ig123=ig123, git_sha=request.git_sha, scan_roots=request.scan_roots)


async def fetch_fresh_isolation_result(connect: Connector, git_sha: str) -> IsolationResult:
    """Reveal and its corrections need the isolation gate's CURRENT truth, never whatever a prior `/open`
    call happened to cache (S3 9, FX-I02; Codex finding #1): a tournament with no assistant outputs yet
    passes IG-6 trivially at open time, and reusing that stale pass at reveal -- after the tournament
    actually ran -- would let a canary that leaked DURING execution slip through undetected unless an
    operator remembered to rerun the gate by hand. IG-1/2/3 reuse the latest already-recorded result for
    this git_sha (code-version-scoped, not tournament-data-scoped); IG-4, IG-5 and IG-6 are recomputed
    fresh and rewritten every call, exactly as `run_isolation_gate` does, never read back stale."""
    stale = await db.fetch_isolation_result(connect, git_sha)
    missing = [item for item in _IG123 if item not in stale.items]
    if missing:
        msg = f"isolation gate has never recorded {missing} for commit {git_sha}; run it once first"
        raise RuntimeError(msg)
    ig123 = {item: stale.items[item] for item in _IG123}
    return await _recompute_and_record(connect, ig123=ig123, git_sha=git_sha, scan_roots=DEFAULT_SCAN_ROOTS)


async def open_hidden_tournament(
    connect: Connector, tournament_id: str, request: IsolationGateRequest
) -> IsolationResult:
    """S1 L9, S3 9: the hidden-text scan and the rest of the isolation gate run before a hidden tournament
    leaves `frozen` -- never a standalone check an operator could skip. Runs the gate fresh, and calls
    `arena.open_tournament` only if it passes; a failing gate raises and the tournament stays frozen."""
    result = await run_isolation_gate(connect, request)
    if not result.passed:
        msg = f"isolation gate failed ({result.evidence_hash}); tournament {tournament_id} was not opened"
        raise RuntimeError(msg)
    await db.open_tournament(connect, tournament_id)
    return result
