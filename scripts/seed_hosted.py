"""`make seed-hosted` (S1 10.5, S2 3.1, S4 2.3): idempotent one-shot seeding of the owner's hosted Supabase
project. No model call, no connection but the one DSN named below, run once by the operator.

    ARENA_OWNER_DSN=... uv run --locked python -m scripts.seed_hosted --email <allowlisted email>

Three idempotent steps, each safe to re-run after a partial failure (every S4 function it calls already
refuses to double-write, so a retry after a crash just re-confirms what committed):

1. Ingests the nine development case families (`cases/dev/F01.json` .. `F09.json`) through the real
   `sealed.ingest_case_family` (S1 4.4, 10.5) -- never the pgTAP test fixture (`tests.seed_family`,
   `scripts/dev.sh`). Each family's Codex review comes from its real per-family CX report
   (`cases/dev/reports/<ID>.cx.json`, documented in `cases/dev/README.md`), reduced to the attestation's
   `codex` object by `arena_core.scenario.load.codex_review_from_report` -- the fix for the mismatch WP-13
   found (`scenario bundle`'s `--codex` input must be a `CodexReview`, which the full report is not).
2. Registers the official roster (A1-A3, S1-S3; `arena_core.agents.manifests.official_manifests`, rebuilt
   from the live prompt files so a stale committed hash is never trusted) through `arena.register_candidate`
   (S2 3.1, 3.2).
3. Allowlists one investigator: an `auth.users` row at `user_id_for(email)` (S4 2.3, S5 10.3), the operator
   action S4 section 2 names ("Users are allowlisted rows in `auth.users`, created by the operator"). This
   never touches `ARENA_USERS_FILE`; the operator adds the same email there separately (outside this
   database), with the same mapping, for `arena-api`'s dev-identity middleware to accept it.

Prints one JSON object of counts and ids to stdout and nothing else on success; a DSN or a password is never
read from argv, never printed and never logged (`ARENA_OWNER_DSN` is read from the environment only).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import psycopg

from arena_core.agents.manifests import CandidateManifest, RosterRefusedError, check_roster, official_manifests
from arena_core.db import calls
from arena_core.db.pool import Connector, dsn_connector
from arena_core.identity import user_id_for
from arena_core.ids import read_json_text
from arena_core.scenario.load import (
    DevSplit,
    FamilyLoadError,
    IngestBundle,
    codex_review_from_report,
    ingest_bundle,
)

ROOT = Path(__file__).resolve().parents[1]
DEV_DIR = ROOT / "cases" / "dev"
REPORTS_DIR = DEV_DIR / "reports"
DSN_VAR = "ARENA_OWNER_DSN"
# S2 5.3, 6.5: the official in-process roster; the order it is reported in (never the order it is written in).
CANDIDATE_IDS: tuple[str, ...] = ("A1", "A2", "A3", "S1", "S2", "S3")


class SeedError(RuntimeError):
    """A dev family, the official roster, or the dev user did not seed cleanly; nothing partial is reported."""


def _read_report(path: Path) -> dict[str, Any]:
    """A per-family CX report file: one JSON object, no duplicate keys (`arena_core.ids.read_json_text`)."""
    try:
        raw = read_json_text(path.read_text(encoding="utf-8"))
    except OSError as exc:
        msg = f"{path}: cannot read: {exc}"
        raise SeedError(msg) from exc
    if not isinstance(raw, dict):
        msg = f"{path}: a CX report holds one JSON object"
        raise SeedError(msg)
    return raw


def dev_bundles(dev_dir: Path = DEV_DIR, reports_dir: Path = REPORTS_DIR) -> list[IngestBundle]:
    """The S4 ingest bundle of every committed development family, in `DevSplit`'s order (F01..F09).

    Each family's attestation is reduced from its real per-family CX report (S1 9.7, 10.5); a family whose
    report does not record a clean pass, or whose bundle fails V1-V5, stops the whole run (`SeedError`) rather
    than seeding eight of nine and silently skipping the rest."""
    dev = DevSplit.from_dir(dev_dir)
    bundles: list[IngestBundle] = []
    for family in dev.families:
        family_id = str(family["family_id"])
        report = _read_report(reports_dir / f"{family_id}.cx.json")
        try:
            review = codex_review_from_report(report)
            bundles.append(ingest_bundle(family, review, dev))
        except (FamilyLoadError, ValueError) as exc:
            msg = f"{family_id}: {exc}"
            raise SeedError(msg) from exc
    return bundles


def candidate_manifests(root: Path = ROOT) -> dict[str, CandidateManifest]:
    """The official roster (A1-A3, S1-S3), rebuilt from the live prompt files, not read back from
    `prompts/manifests/*.json` (so a stale committed hash is never trusted). `check_roster` is the same
    roster-freeze check S2 3.3 runs (defense in depth: a bad manifest is refused here, long before a freeze)."""
    manifests = official_manifests(root)
    missing = [c for c in CANDIDATE_IDS if c not in manifests]
    if missing:
        msg = f"the official roster is missing {missing}"
        raise SeedError(msg)
    try:
        check_roster(list(manifests.values()))
    except RosterRefusedError as exc:
        msg = f"the official roster fails its own freeze check: {exc}"
        raise SeedError(msg) from exc
    return manifests


async def seed(
    connect: Connector,
    *,
    email: str,
    bundles: Sequence[IngestBundle],
    manifests: Mapping[str, CandidateManifest],
) -> dict[str, Any]:
    """Ingest every bundle, register every candidate, then allowlist one user, all on one connection (owner
    credential). Each step is independently idempotent (S4's own functions, `arena_core.db.calls`), so running
    this twice, or resuming after a crash partway through, repeats no write and reports the same ids."""
    families: dict[str, str] = {}
    candidates: dict[str, str] = {}
    lowered = email.strip().lower()
    user_id = user_id_for(lowered)
    async with connect() as conn:
        for bundle in bundles:
            family_uuid = await calls.ingest_case_family(conn, bundle.as_json())
            families[bundle.family_code] = str(family_uuid)
        for candidate_id in CANDIDATE_IDS:
            manifest = manifests[candidate_id]
            payload = manifest.model_dump(mode="json", exclude={"frozen_at"})
            candidate_uuid = await calls.register_candidate(
                conn, kind=manifest.kind, name=manifest.candidate_id, version=manifest.version, manifest=payload
            )
            candidates[candidate_id] = str(candidate_uuid)
        await calls.allowlist_user(conn, user_id=user_id, email=lowered)
    return {"families": families, "candidates": candidates, "user": {"email": lowered, "user_id": str(user_id)}}


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scripts.seed_hosted", description=__doc__)
    parser.add_argument("--email", required=True, help="the one investigator email to allowlist (auth.users, S4 2.3)")
    args = parser.parse_args(argv)
    resolved = os.environ if env is None else env
    dsn = resolved.get(DSN_VAR, "")
    if not dsn:
        sys.stderr.write(f"seed_hosted: {DSN_VAR} is not set\n")
        return 1
    try:
        bundles = dev_bundles()
        manifests = candidate_manifests()
    except (OSError, ValueError, SeedError) as exc:
        sys.stderr.write(f"seed_hosted: {type(exc).__name__}: {exc}\n")
        return 1
    try:
        result = asyncio.run(seed(dsn_connector(dsn), email=args.email, bundles=bundles, manifests=manifests))
    except (psycopg.Error, SeedError, calls.GuardProtocolError) as exc:
        sys.stderr.write(f"seed_hosted: FAIL: {type(exc).__name__}: {exc}\n")
        return 1
    sys.stdout.write(json.dumps(result, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
