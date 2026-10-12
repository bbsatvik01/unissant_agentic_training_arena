"""`make export-run TRIAL=<id>` (D-021): write a trial's recording, `recordings/<trial>.json`.

Runs as `arena-api` would (the `arena_public` credential, the dev identity as the actor) and reads the trial
through the same projection and visibility rules as the API's `GET /api/trials/{id}/recording`, so a recording
is exactly what the session's owner saw, with server timestamps, plus the published debrief when there is one.
A tournament trial (no training session, no debrief) exports the same way through `load_tournament_trial`
(D-021: "every tournament trial must be exportable"; `arena_tournament`, WP-17) -- `arena.trial_visible`
already restricts which ones an `arena_public` caller may read (a dev-split trial, or a hidden one after
reveal) regardless of the acting identity, so the same dev identity that exports a training trial can export
a tournament one too. `scripts/dev.sh export-run <trial>` builds the environment from `.env.local` and
`.env.local.public`.
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
from uuid import UUID

from arena_core.config import ArenaRole, boot
from arena_core.db.arena import ArenaDb
from arena_core.db.pool import Connector, dsn_connector
from arena_core.events.load import load_recording
from arena_core.identity import resolve_dev_user


async def export(connect: Connector, actor: UUID, trial: UUID) -> dict[str, Any] | None:
    return await export_from(ArenaDb(connect, actor), trial)


async def export_from(db: ArenaDb, trial: UUID) -> dict[str, Any] | None:
    """`arena_core.events.load.load_recording`, shared with `GET /api/trials/{id}/recording` (no duplicated
    projection or visibility logic between the two callers)."""
    return await load_recording(db, trial)


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trial", type=UUID, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    resolved = dict(os.environ if env is None else env)
    settings = boot(ArenaRole.API, resolved)
    actor = resolve_dev_user(resolved).user_id
    recording = asyncio.run(export(dsn_connector(settings.dsn), actor, args.trial))
    if recording is None:
        sys.stderr.write(
            f"export-run: trial {args.trial} is not one of the acting user's trials, a dev tournament trial "
            "or a revealed one\n"
        )
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(recording, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    sys.stdout.write(f"export-run: wrote {args.out} ({len(recording['events'])} frames)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
