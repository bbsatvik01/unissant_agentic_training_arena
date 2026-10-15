"""Instructor mode (UI v2, owner D-036), as `arena_referee`: the class with each trainee's progress, case
assignments, and notes on a trainee's training trial at a moment of its recording.

Trainees are the users-file rows with the `investigator` role (the allowlist is the authority on who is in the
class, S5 10.3); their sessions, debriefs and assignments are read from the training tables `arena_referee` may read
(S4 4.2). Writes go to `training.assignments` and `training.annotations`, both append-only. Deliberately thin: each
function is close to its SQL (`it_admin.py` runs it against the real migrated schema).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from arena_core.db.pool import Connector, one_statement
from arena_core.identity import AllowlistedUser, user_id_for

TRAINEE_ROLE = "investigator"


@dataclass(frozen=True)
class Trainee:
    user_id: UUID
    display_name: str


def trainees(allowlist: Mapping[str, AllowlistedUser]) -> list[Trainee]:
    """The class: every allowlisted investigator, by display name."""
    rows = [Trainee(user_id_for(u.email), u.display_name) for u in allowlist.values() if TRAINEE_ROLE in u.roles]
    return sorted(rows, key=lambda t: (t.display_name.lower(), str(t.user_id)))


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


async def _rows(connect: Connector, query: str, params: tuple[object, ...]) -> list[tuple[Any, ...]]:
    async with connect() as conn:
        cur = await one_statement(conn, query, params)
        return list(await cur.fetchall())


async def class_progress(connect: Connector, users: Iterable[Trainee]) -> list[dict[str, Any]]:
    """Each trainee's sessions (started, ended, voice), published scores and assignments."""
    people = list(users)
    ids = [t.user_id for t in people]
    sessions = await _rows(
        connect,
        "select s.user_id, s.id, s.trial_id, s.phase, s.voice, t.mode, t.status, s.created_at,"
        " (d.payload -> 'rubric' ->> 'total')::integer, coalesce((d.payload ->> 'scored')::boolean, false)"
        " from training.sessions s join arena.trials t on t.id = s.trial_id"
        " left join training.debriefs d on d.session_id = s.id"
        " where s.user_id = any(%s) order by s.created_at",
        (ids,),
    )
    assigned = await _rows(
        connect,
        "select a.user_id, a.id, p.packet ->> 'case_id', p.packet ->> 'title', a.created_at,"
        " exists (select 1 from training.sessions s join arena.trials t on t.id = s.trial_id"
        "          where s.user_id = a.user_id and t.variant_id = a.variant_id)"
        " from training.assignments a join arena.public_packets p on p.variant_id = a.variant_id"
        " where a.user_id = any(%s) order by a.created_at",
        (ids,),
    )
    out = []
    for trainee in people:
        mine = [r for r in sessions if r[0] == trainee.user_id]
        scores = [int(r[8]) for r in mine if r[9] and r[8] is not None]
        out.append(
            {
                "user_id": str(trainee.user_id),
                "display_name": trainee.display_name,
                "sessions": len(mine),
                "ended": sum(r[6] in ("finalized", "terminated") for r in mine),
                "scored": len(scores),
                "mean_score": round(sum(scores) / len(scores), 1) if scores else None,
                "last_session_at": _iso(mine[-1][7]) if mine else None,
                "recent": [
                    {
                        "session_id": str(r[1]),
                        "trial_id": str(r[2]),
                        "phase": r[3],
                        "voice": bool(r[4]),
                        "mode": r[5],
                        "status": r[6],
                        "created_at": _iso(r[7]),
                        "score": int(r[8]) if r[9] and r[8] is not None else None,
                    }
                    for r in reversed(mine[-10:])
                ],
                "assignments": [
                    {
                        "assignment_id": str(r[1]),
                        "case_id": r[2],
                        "title": r[3],
                        "assigned_at": _iso(r[4]),
                        "started": bool(r[5]),
                    }
                    for r in assigned
                    if r[0] == trainee.user_id
                ],
            }
        )
    return out


async def dev_variant(connect: Connector, case_id: str) -> UUID | None:
    """The active development variant whose public packet names `case_id` (`arena.v_dev_cases`), else None."""
    rows = await _rows(
        connect, "select variant_id from arena.v_dev_cases where public_packet ->> 'case_id' = %s", (case_id,)
    )
    return rows[0][0] if rows else None


async def assign(connect: Connector, user: UUID, variant: UUID, by: UUID) -> dict[str, Any]:
    """`training.assignments`: one row per (trainee, variant); assigning it again returns the first row."""
    rows = await _rows(
        connect,
        "with added as (insert into training.assignments (user_id, variant_id, assigned_by) values (%s, %s, %s)"
        " on conflict (user_id, variant_id) do nothing returning id, created_at)"
        " select id, created_at from added"
        " union all select id, created_at from training.assignments where user_id = %s and variant_id = %s"
        " limit 1",
        (user, variant, by, user, variant),
    )
    return {"assignment_id": str(rows[0][0]), "assigned_at": _iso(rows[0][1])}


async def training_trial(connect: Connector, trial: UUID) -> bool:
    """Whether `trial` is a training session's trial (only those take notes)."""
    rows = await _rows(connect, "select exists (select 1 from training.sessions where trial_id = %s)", (trial,))
    return bool(rows and rows[0][0])


async def annotate(connect: Connector, trial: UUID, author: UUID, t_ms: int, text: str) -> dict[str, Any]:
    rows = await _rows(
        connect,
        "insert into training.annotations (trial_id, author_user_id, t_ms, text) values (%s, %s, %s, %s)"
        " returning id, created_at",
        (trial, author, t_ms, text),
    )
    return {"annotation_id": str(rows[0][0]), "t_ms": t_ms, "text": text, "created_at": _iso(rows[0][1])}
