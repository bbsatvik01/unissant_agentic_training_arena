"""Isolation-gate evidence assembly (S3 9; IG-1..IG-6), the pure half of WP-16's runner.

WP-15's `arena_core.scoring.ranking` already owns the pure gate: `isolation_result` (combines per-item
(passed, evidence_hash) pairs into one `IsolationResult`, hashed) and `canary_audit` (IG-6's zero-hits rule,
FX-I02). This module adds the two checks whose evidence WP-16 computes from scratch -- the hidden-text scan
(IG-4, S1 10.4) and the canary audit's own scan (IG-6) -- plus a uniform report-hash helper for the three
checks that are themselves other work packages' test suites (IG-1 pgTAP, IG-2 route tests, IG-3 the
assistant-context type test): the caller already ran that suite and knows whether it passed, so this module
only has to hash its report text into the same evidence shape. IG-5 (commitment verification) is SQL-side
evidence the referee's DB layer reads directly (`ledger.verify_chain`, `ledger.verify_commitment`,
`sealed.verify_hidden_seal`); `ig5_evidence` folds its booleans into that same shape.
"""

from __future__ import annotations

import hashlib
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass

from arena_core.scenario.corpus import Corpus, scan_files
from arena_core.scoring.ranking import IG_ITEMS, IsolationResult, canary_audit, isolation_result

__all__ = [
    "IG_ITEMS",
    "CorpusScanEvidence",
    "IsolationEvidence",
    "combined_corpus_scan_evidence",
    "corpus_scan_evidence",
    "count_canary_hits",
    "ig4_evidence",
    "ig4_report",
    "ig5_evidence",
    "ig6_evidence",
    "report_evidence",
]


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def report_evidence(*, passed: bool, report_text: str) -> tuple[bool, str]:
    """IG-1, IG-2, IG-3 (S3 9's "pgTAP report hash", "Route-test report hash", "Test report hash"): the
    caller already ran that suite; this only gives it the same (passed, hash) shape as every other item."""
    return passed, _hash(report_text)


@dataclass(frozen=True)
class CorpusScanEvidence:
    """IG-4's scan half (S1 10.4, S2 3.4, L9): zero hits over every named file passes. `hit_paths` are the
    hidden family field paths that matched, never the matched text (L7)."""

    passed: bool
    report_text: str
    hit_paths: tuple[str, ...]


def corpus_scan_evidence(corpus: Corpus, files: Mapping[str, str]) -> CorpusScanEvidence:
    """Scan every named file (development prompts, templates, fixtures a rostered manifest names, AC-S1-21)
    against one hidden family's `corpus`; the report lists each scanned path and its hit count only."""
    return combined_corpus_scan_evidence((corpus,), files)


def combined_corpus_scan_evidence(corpora: Sequence[Corpus], files: Mapping[str, str]) -> CorpusScanEvidence:
    """IG-4 at the roster level: the whole hidden split's hits (every sealed family's own corpus, L9), not
    just one family's -- a scan that stopped at the first corpus would miss a second family's persona name
    or canary, since each `Corpus` carries only its own family's identifiers."""
    per_corpus = [scan_files(c, files) for c in corpora]
    hit_paths = tuple(sorted({p for results in per_corpus for r in results for h in r.hits for p in h.source_paths}))
    counts: dict[str, int] = {}
    for results in per_corpus:
        for r in results:
            counts[r.path] = counts.get(r.path, 0) + r.hit_count
    lines = [f"{path}|{counts[path]}" for path in sorted(counts)]
    return CorpusScanEvidence(passed=not hit_paths, report_text="\n".join(lines), hit_paths=hit_paths)


def ig4_evidence(*, seal_verifies: bool, scan: CorpusScanEvidence) -> tuple[bool, str]:
    """IG-4 (S1 10.3, 10.4): the hidden-split seal verifies and the scan finds nothing. S3 9's own pass
    evidence for this row is "scan report, INCLUDING THE FIELD PATH OF ANY HIT" -- `scan.hit_paths` (the
    hidden family field paths that matched, never the matched text itself, L7) is folded into the hashed
    report here so an operator diagnosing a failure can tell which hidden field leaked, and two different
    leaks with the same hit COUNT but different source fields never hash identically."""
    return seal_verifies and scan.passed, _hash(ig4_report(seal_verifies=seal_verifies, scan=scan))


def ig4_report(*, seal_verifies: bool, scan: CorpusScanEvidence) -> str:
    """The exact text IG-4's evidence hash covers (S1 10.4): seal status, each scanned path with its hit count,
    and the hidden field paths that matched -- never the matched text (L7). Stored next to the hash so an
    operator can read which path and field leaked and re-derive the hash."""
    hit_path_lines = "\n".join(scan.hit_paths)
    return f"seal_verifies={seal_verifies}\n{scan.report_text}\n{hit_path_lines}"


def ig5_evidence(
    *, chain_verifies: bool, corpus_seal_verifies: bool, commitments: Mapping[str, bool]
) -> tuple[bool, str]:
    """IG-5 (BKO-9): the ledger chain verifies, the replay-corpus seal verifies (vacuously true with no
    replay track) and every finalized trial's commitment verifies."""
    passed = chain_verifies and corpus_seal_verifies and all(commitments.values())
    lines = [f"chain|{int(chain_verifies)}", f"corpus_seal|{int(corpus_seal_verifies)}"]
    lines += [f"{t}|{int(ok)}" for t, ok in sorted(commitments.items())]
    return passed, _hash("\n".join(lines))


@dataclass(frozen=True)
class CanaryResult:
    """IG-6 (S3 9, FX-I02): zero hits passes; a hit attributed to one candidate fails the gate for all, and
    that candidate's id is the only IG item ever written with a `candidate_id` attached."""

    passed: bool
    evidence_hash: str
    culprit: str | None


def count_canary_hits(canaries: Collection[str], texts_by_candidate: Mapping[str, Sequence[str]]) -> dict[str, int]:
    """IG-6's own scan (S3 9): how many times any of the sealed families' canaries appear, literally, in
    each candidate's own assistant outputs. The caller supplies the texts (coach cards, findings -- never
    this module's job to query a database); this only counts, so a candidate with no canary anywhere in
    its texts is zero, never a trusted external input."""
    return {
        candidate: sum(1 for text in texts for canary in canaries if canary in text)
        for candidate, texts in texts_by_candidate.items()
    }


def ig6_evidence(hits_by_candidate: Mapping[str, int]) -> CanaryResult:
    """A hit count is an observed occurrence and can never be negative; a negative value could otherwise
    cancel a real positive hit in `canary_audit`'s sum-based check (`sum(...) == 0`), passing a gate that
    should fail. Rejecting it here, before that check runs, keeps `canary_audit` itself the one place the
    pass rule lives (S3 9) while never trusting malformed input to decide the gate."""
    bad = {c: n for c, n in hits_by_candidate.items() if n < 0}
    if bad:
        msg = f"canary hit counts cannot be negative: {sorted(bad)}"
        raise ValueError(msg)
    passed = canary_audit(hits_by_candidate)
    culprit = next((c for c, n in sorted(hits_by_candidate.items()) if n > 0), None)
    lines = [f"{c}|{n}" for c, n in sorted(hits_by_candidate.items())]
    return CanaryResult(passed=passed, evidence_hash=_hash("\n".join(lines)), culprit=culprit)


@dataclass(frozen=True)
class IsolationEvidence:
    """One (passed, evidence_hash) per IG item (`IG_ITEMS`), plus IG-6's candidate attribution, if any."""

    items: Mapping[str, tuple[bool, str]]
    canary_culprit: str | None = None

    def result(self) -> IsolationResult:
        return isolation_result(self.items)
