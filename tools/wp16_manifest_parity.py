"""AC-S3-4.2 (SQL and Python parity, WP-16): rebuilds S3 4.4's canonical manifest text in Python from the
raw rows `012_reveal_manifest.sql` exports (the same facts `ledger.build_manifest` reads, read back out as
one JSON document) and compares the result byte for byte against the SQL-sealed hash.

Run with the project's own interpreter (`uv run --locked python tools/wp16_manifest_parity.py <file>`): it
imports `arena_core.scoring.inclusion`, a real package dependency, not a stdlib-only script like
`tools/pgtap_ban.py`. Prints ``MATCH`` on success (the only input `012_reveal_manifest.sql`'s `is()` accepts)
or a diagnostic line and exits 1.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from arena_core.scoring.inclusion import Exec, ManifestHeader, PlannedRow, build_manifest, manifest_hash

_EXPECTED_ARGC = 2


def main(argv: list[str]) -> int:
    if len(argv) != _EXPECTED_ARGC:
        sys.stderr.write("usage: wp16_manifest_parity.py <exported-json-file>\n")
        return 2
    data = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    header = ManifestHeader(
        tournament_id=data["tournament_id"],
        manifest_version=data["manifest_version"],
        parent_manifest_hash=data.get("parent_manifest_hash"),
        roster_hash=data["roster_hash"],
        corpus_seal_hash=data.get("corpus_seal_hash"),
        hidden_seal_hash=data.get("hidden_seal_hash"),
    )
    rows = [
        PlannedRow(
            planned_trial_id=r["planned_trial_id"],
            track=r["track"],
            assistant_id=r.get("assistant_id"),
            subject_id=r.get("subject_id"),
            family_id=r["family_id"],
            variant_id=r["variant_id"],
            role=r["role"],
            repeat=r["repeat"],
            block_id=r.get("block_id"),
            exec_state=Exec(r["exec_state"]),
            adjudication_id=r.get("adjudication_id"),
            verdict=r.get("verdict"),
        )
        for r in data["rows"]
    ]
    text = build_manifest(header, rows, roster_size=len(rows))
    python_hash = manifest_hash(text)
    sql_hash = data["manifest_sha256"]
    if python_hash == sql_hash:
        sys.stdout.write("MATCH\n")
        return 0
    sys.stdout.write(f"MISMATCH: python={python_hash} sql={sql_hash}\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
