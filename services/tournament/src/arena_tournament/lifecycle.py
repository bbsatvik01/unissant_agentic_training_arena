"""Operator lifecycle calls against `arena_referee` (S4 6.4): candidate registration and tournament setup
for the demo CLI (`scripts/dev_tournament_demo.py`, D-021).

These six functions have no HTTP route of their own (WP-20a's admin console builds the browser-facing one
later) and only `arena_referee` may call them (S4 9.3: `create_tournament`, `add_planned_trials`,
`freeze_tournament`, `open_tournament`, `register_candidate`); the operator tool therefore connects with its
own `arena_referee` DSN, separate from the running job's `arena_public` connection, the same pattern the spec
already names for case ingest ("the operator CLI calls the same" function the admin route would, S5 5.5).
This module is deliberately not boot-gated (`arena_core.config.boot` refuses a process holding more than one
role DSN): it is a one-off setup tool, not a running service.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import cast
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from arena_core.agents.manifests import CandidateManifest
from arena_core.db.pool import Connector
from arena_tournament.roster import PlannedRow


class LifecycleError(Exception):
    """One S4 refusal (`code` is the SQLSTATE) from an operator lifecycle call."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True, kw_only=True)
class TournamentSpec:
    """`arena.create_tournament`'s own parameters, bundled so the wrapper stays under the arg-count lint."""

    name: str
    split: str
    seed: int
    bucket: str = "global"
    max_exchanges: int = 12


async def _call(connect: Connector, query: str, params: Sequence[object]) -> object:
    try:
        async with connect() as conn, conn.transaction():
            cur = await conn.execute(query, params)
            row = await cur.fetchone()
            return row[0] if row else None
    except psycopg.Error as exc:
        raise LifecycleError(exc.sqlstate or "XX000", exc.diag.message_primary or str(exc)) from exc


async def register_candidate(connect: Connector, manifest: CandidateManifest) -> UUID:
    """`arena.register_candidate`: idempotent on (kind, name, version) with the same manifest content (S4
    6.4); the manifest's own `candidate_id` and `version` are the name and version the function checks."""
    raw = manifest.model_dump(mode="json")
    value = await _call(
        connect,
        "select arena.register_candidate(%s, %s, %s, %s)",
        (manifest.kind, manifest.candidate_id, manifest.version, Jsonb(raw)),
    )
    return UUID(str(value))


async def candidate_kinds(connect: Connector, candidates: Sequence[UUID]) -> dict[UUID, str]:
    """Every given candidate's registered kind (`roster.check_no_negative_controls`'s input)."""
    if not candidates:
        return {}
    async with connect() as conn:
        cur = await conn.execute("select id, kind from arena.candidates where id = any(%s)", (list(candidates),))
        return {row[0]: row[1] for row in await cur.fetchall()}


async def create_tournament(connect: Connector, spec: TournamentSpec) -> UUID:
    """`arena.create_tournament`: idempotent by name with the same parameters (S4 6.4)."""
    value = await _call(
        connect,
        "select arena.create_tournament(%s, %s, %s, %s, %s)",
        (spec.name, spec.split, spec.seed, spec.bucket, spec.max_exchanges),
    )
    return UUID(str(value))


async def add_planned_trials(connect: Connector, tournament: UUID, rows: Sequence[PlannedRow]) -> int:
    """`arena.add_planned_trials`: draft only; refuses a negative-control or referee-kind candidate itself
    (AR007), in addition to `roster.check_no_negative_controls`'s own check before this is ever called."""
    payload = [row.as_json() for row in rows]
    value = await _call(connect, "select arena.add_planned_trials(%s, %s)", (tournament, Jsonb(payload)))
    return int(cast("int", value))


async def freeze_tournament(connect: Connector, tournament: UUID) -> str:
    """`arena.freeze_tournament`: hashes the roster and creates attempt 1 of every planned trial; returns
    the roster hash (`roster_sha256`)."""
    return str(await _call(connect, "select arena.freeze_tournament(%s)", (tournament,)))


async def open_tournament(connect: Connector, tournament: UUID, *, split: str) -> None:
    """`arena.open_tournament`: frozen -> running. A hidden tournament needs the referee's hidden-text scan
    first (S5 5.3, D1); that scan is WP-16's, so this refuses a hidden split outright rather than open one
    unscanned -- `open_tournament` itself has no isolation check of its own to lean on."""
    if split == "hidden":
        msg = "a hidden tournament needs the S5 5.3 hidden-text scan before it opens (D1; WP-16); not run here"
        raise LifecycleError("AR001", msg)
    await _call(connect, "select arena.open_tournament(%s)", (tournament,))
