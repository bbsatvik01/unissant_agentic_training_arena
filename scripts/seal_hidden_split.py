"""The S1 10.3 sealing sequence's database half: ingest each accepted hidden family (with its attestation)
into the sealed archive, `seal_hidden_split`, verify the archive. docs/runbooks/hidden-seal.md is the full
operator runbook this script is one step of.

    ARENA_REFEREE_DSN=... uv run --locked python -m scripts.seal_hidden_split \
      --bundle cases/hidden/bundles/H1.json --bundle cases/hidden/bundles/H2.json ... \
      --sampler-record cases/hidden/sampler_record.json

Each `--bundle` file is the S4 ingest bundle `python -m arena_core.scenario bundle <family.json> --codex
<codex.json> --dev-dir cases/dev --hidden <family.json>... --sampler-record <record.json> --out <bundle.json>`
already built and validated (V1-V5, Codex review) for one family -- this script never re-validates a
family's content, the same division of labor `scripts/seed_hosted.py` already has with the dev split's own
loader. `--sampler-record` is the same file the bundle command's own `--sampler-record` named: this script
is what actually commits it, with `sealed.seal_hidden_split`, once every family it names has been ingested.

Refuses to leave `cases/hidden/` and the authoring session's transcripts in place after a successful seal is
not this script's job (S1 10.3 step 4 is a judgment call the operator makes after reading this script's
report and confirming the archive independently, never automated): this script only ingests, seals and
verifies, and prints the seal hash, family count and per-family ids for that record.

Three idempotent steps (safe to re-run after a partial failure, the same way scripts/seed_hosted.py is):
ingest is idempotent per `family_code`; `seal_hidden_split` raises AR001 on a second seal (this script then
only verifies and reports, never treating an already-sealed split as a failure); `verify_hidden_seal` is a
read.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg

from arena_core.db import calls
from arena_core.db.pool import Connector, dsn_connector
from arena_core.ids import read_json_text

log = logging.getLogger("scripts.seal_hidden_split")
DSN_VAR = "ARENA_REFEREE_DSN"
# The S4 ingest bundle's own top-level keys (arena_core.scenario.load.IngestBundle, docs/spec/sql/0002_cases.sql):
# `sealed.ingest_case_family` is the real validator of everything below this shape, so a bundle file is read
# back as a plain dict (never re-parsed into IngestBundle's own strict pydantic model, which requires real
# Python tuples a JSON array round-trip never gives back) and only checked for these keys before it reaches
# the database.
BUNDLE_KEYS = frozenset({"family_code", "domain", "split", "source", "attestation", "variants"})


class SealError(RuntimeError):
    """A bundle file, the sampler record, or the database refused to seal cleanly."""


@dataclass(frozen=True)
class SealReport:
    seal_sha256: str
    already_sealed: bool
    verified: bool
    family_codes: tuple[str, ...]


def _read_bundle(path: Path) -> dict[str, Any]:
    try:
        raw = read_json_text(path.read_text(encoding="utf-8"))
    except OSError as exc:
        msg = f"{path}: cannot read: {exc}"
        raise SealError(msg) from exc
    if not isinstance(raw, dict) or not raw.keys() >= BUNDLE_KEYS:
        msg = f"{path}: not an ingest bundle (missing one of {sorted(BUNDLE_KEYS)})"
        raise SealError(msg)
    return raw


def read_bundles(paths: Sequence[Path]) -> list[dict[str, Any]]:
    """Every `--bundle` file, in the order given (S1 10.3 step 2: ingest order does not matter to the seal,
    which hashes the sealed set, not an order)."""
    return [_read_bundle(p) for p in paths]


def read_sampler_record(path: Path) -> dict[str, Any]:
    try:
        raw = read_json_text(path.read_text(encoding="utf-8"))
    except OSError as exc:
        msg = f"{path}: cannot read: {exc}"
        raise SealError(msg) from exc
    if not isinstance(raw, dict):
        msg = f"{path}: the sampler record is one JSON object"
        raise SealError(msg)
    return raw


async def seal(
    connect: Connector, bundles: Sequence[Mapping[str, Any]], sampler_record: Mapping[str, Any]
) -> SealReport:
    """Ingest every bundle, then seal_hidden_split, then verify_hidden_seal, all on one connection (the
    operator's own `arena_referee` credential, S1 10.5). `already_sealed=True` when the split was sealed
    by an earlier, interrupted run of this same script (AR001 on the second `seal_hidden_split` call is
    expected then, never a failure to report): the caller already has everything it needs (the archive and
    the seal) from before, this run only re-confirms it still verifies."""
    async with connect() as conn:
        for bundle in bundles:
            await calls.ingest_case_family(conn, bundle)
        already_sealed = False
        try:
            seal_sha256 = await calls.seal_hidden_split(conn, sampler_record)
        except psycopg.Error as exc:
            if exc.sqlstate != "AR001":
                raise
            already_sealed = True
            cur = await conn.execute("select seal_sha256 from sealed.hidden_split_seals")
            row = await cur.fetchone()
            if row is None:
                msg = "seal_hidden_split: AR001 but no sealed.hidden_split_seals row"
                raise SealError(msg) from exc
            seal_sha256 = str(row[0])
            log.info("seal_hidden_split: already sealed (%s), reusing seal %s", exc, seal_sha256)
        verified = await calls.verify_hidden_seal(conn)
    return SealReport(
        seal_sha256=seal_sha256,
        already_sealed=already_sealed,
        verified=verified,
        family_codes=tuple(str(b["family_code"]) for b in bundles),
    )


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scripts.seal_hidden_split", description=__doc__)
    parser.add_argument("--bundle", type=Path, action="append", required=True, dest="bundles")
    parser.add_argument("--sampler-record", type=Path, required=True)
    args = parser.parse_args(argv)
    resolved = os.environ if env is None else env
    dsn = resolved.get(DSN_VAR, "")
    if not dsn:
        sys.stderr.write(f"seal_hidden_split: {DSN_VAR} is not set\n")
        return 1
    try:
        bundles = read_bundles(args.bundles)
        sampler_record = read_sampler_record(args.sampler_record)
    except SealError as exc:
        sys.stderr.write(f"seal_hidden_split: {exc}\n")
        return 1
    try:
        report = asyncio.run(seal(dsn_connector(dsn), bundles, sampler_record))
    except (psycopg.Error, SealError, calls.GuardProtocolError) as exc:
        detail = (
            str(exc)
            if isinstance(exc, SealError)
            else "connection or guard error (detail withheld: it can echo ARENA_REFEREE_DSN)"
        )
        sys.stderr.write(f"seal_hidden_split: FAIL: {type(exc).__name__}: {detail}\n")
        return 1
    if not report.verified:
        sys.stderr.write(f"seal_hidden_split: FAIL: sealed but verify_hidden_seal() is false: {report}\n")
        return 1
    sys.stdout.write(
        json.dumps(
            {
                "seal_sha256": report.seal_sha256,
                "already_sealed": report.already_sealed,
                "verified": report.verified,
                "family_codes": sorted(report.family_codes),
                "n_families": len(report.family_codes),
            },
            sort_keys=True,
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
