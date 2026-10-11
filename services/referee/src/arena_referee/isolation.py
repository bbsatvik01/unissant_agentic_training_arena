"""Isolation-gate runner IO (S3 9; IG-1..IG-6; WP-16): the referee reads its own sealed hidden families to
build the scan corpus and never sends their content anywhere else (L6, L7) -- a caller supplies IG-1, IG-2
and IG-3's own report evidence (the suites they prove are run by the gates this process sits inside, S5 11.1)
and IG-6's canary-hit counts (observed at the trust-center or trace-export layer, not built here); everything
else (IG-4's corpus scan, IG-5's commitment and chain verification) is computed from the database and the
referee's own filesystem.
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
    ig4_evidence,
    ig5_evidence,
    ig6_evidence,
    report_evidence,
)
from arena_core.scenario.corpus import Corpus, build_corpus, dev_reference_grams
from arena_core.scoring.ranking import IsolationResult
from arena_referee import db

# The development prompt and fixture surfaces S1 10.4/AC-S1-21 name: template and few-shot text a rostered
# manifest can reach. Bounded and simple (D-016): three directories, not a repo-wide walk.
DEFAULT_SCAN_ROOTS = (Path("prompts"), Path("cases/dev"), Path("packages/core/src/arena_core/fixtures"))
_SCAN_SUFFIXES = (".md", ".json", ".txt")


async def fetch_hidden_corpora(connect: Connector) -> list[Corpus]:
    """One `Corpus` per sealed hidden family (`sealed.family_ingests.source`, read as `arena_referee` --
    the one role allowed to), never a file from the deleted `cases/hidden/` (L6). The development reference
    (10.4's subtraction) is shared across all of them, fixed at the seal commit."""
    async with connect() as conn:
        cur = await conn.execute(
            "select f.split, fi.source from sealed.family_ingests fi join arena.case_families f on f.id = fi.family_id"
        )
        rows = await cur.fetchall()
    hidden = [json.loads(source) for split, source in rows if split == "hidden"]
    dev = [json.loads(source) for split, source in rows if split == "dev"]
    reference = dev_reference_grams(dev)
    return [build_corpus(family, reference) for family in hidden]


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


async def verify_corpus_seal(connect: Connector, tournament_id: str) -> bool:
    """Vacuously true for a tournament with no `replay_corpus` track (S4 `check_reveal_preconditions`'s own
    rule): a seal is required only when the tournament has a corpus to seal."""
    async with connect() as conn:
        cur = await conn.execute(
            "select not exists (select 1 from arena.planned_trials"
            "                    where tournament_id = %s and track = 'replay_corpus')"
            "       or exists (select 1 from ledger.corpus_seals s, ledger.corpus_digest(%s) d"
            "                   where s.tournament_id = %s and s.corpus_sha256 = d.corpus_sha256)",
            (tournament_id, tournament_id, tournament_id),
        )
        row = await cur.fetchone()
    return bool(row and row[0])


async def fetch_commitment_results(connect: Connector, tournament_id: str) -> dict[str, bool]:
    """Every finalized trial of the tournament, `ledger.verify_commitment` (BKO-9, SG3-42)."""
    async with connect() as conn:
        cur = await conn.execute(
            "select t.id::text, ledger.verify_commitment(t.id)"
            " from arena.trials t where t.tournament_id = %s and t.status = 'finalized'",
            (tournament_id,),
        )
        rows = await cur.fetchall()
    return {trial_id: bool(ok) for trial_id, ok in rows}


def read_scan_files(roots: Sequence[Path] = DEFAULT_SCAN_ROOTS) -> dict[str, str]:
    """Every text file under `roots` with a scannable suffix (prompts, dev fixtures, few-shot files, AC-S1-
    21); a missing root (a scan environment without the full tree checked out) contributes nothing rather
    than failing the whole gate."""
    files: dict[str, str] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.is_file() and path.suffix in _SCAN_SUFFIXES:
                files[str(path)] = path.read_text(encoding="utf-8", errors="replace")
    return files


@dataclass(frozen=True, kw_only=True)
class IsolationGateRequest:
    """One isolation-gate run's inputs (S3 9): `ig1`/`ig2`/`ig3` are `(passed, report_text)` from the
    caller's own already-run pgTAP, route-test and assistant-context suites (`report_evidence` hashes
    each); `hits_by_candidate` is IG-6's observed canary-hit count per candidate."""

    tournament_id: str
    git_sha: str
    ig1: tuple[bool, str]
    ig2: tuple[bool, str]
    ig3: tuple[bool, str]
    hits_by_candidate: Mapping[str, int]
    scan_roots: Sequence[Path] = DEFAULT_SCAN_ROOTS


async def run_isolation_gate(connect: Connector, request: IsolationGateRequest) -> IsolationResult:
    """Runs every IG item and writes one `arena.isolation_checks` row each (S3 9), returning the combined
    `IsolationResult` `rank()` consumes."""
    corpora = await fetch_hidden_corpora(connect)
    files = read_scan_files(request.scan_roots)
    scan = combined_corpus_scan_evidence(corpora, files)
    seal_ok = await verify_hidden_seal(connect)
    chain_ok = await verify_chain(connect)
    corpus_seal_ok = await verify_corpus_seal(connect, request.tournament_id)
    commitments = await fetch_commitment_results(connect, request.tournament_id)
    canary = ig6_evidence(request.hits_by_candidate)
    ig1, ig2, ig3, git_sha = request.ig1, request.ig2, request.ig3, request.git_sha

    evidence = IsolationEvidence(
        items={
            "IG-1": report_evidence(passed=ig1[0], report_text=ig1[1]),
            "IG-2": report_evidence(passed=ig2[0], report_text=ig2[1]),
            "IG-3": report_evidence(passed=ig3[0], report_text=ig3[1]),
            "IG-4": ig4_evidence(seal_verifies=seal_ok, scan=scan),
            "IG-5": ig5_evidence(chain_verifies=chain_ok, corpus_seal_verifies=corpus_seal_ok, commitments=commitments),
            "IG-6": (canary.passed, canary.evidence_hash),
        },
        canary_culprit=canary.culprit,
    )
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
    return evidence.result()
