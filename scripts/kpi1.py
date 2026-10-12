"""KPI-1 study operations (S3 6.1, S4 training tables, S8 WP-30): set up the study and export its results.

    ARENA_REFEREE_DSN=... uv run --locked python -m scripts.kpi1 setup --emails a@x.org,b@y.org
    ARENA_REFEREE_DSN=... uv run --locked python -m scripts.kpi1 report [--scorer proxy|human]

`setup`, in one transaction as `arena_referee` (the role S4 grants INSERT on `training.participants` and
`training.case_set_members`; no new SQL function):

1. Writes case sets A and B (`training.case_set_members`) from the four KPI-1 families named in
   `cases/dev/README.md`: A = F06 truthful + F07 deceptive, B = F08 truthful + F09 deceptive. Each set is one
   truthful and one deceptive level-2 variant from different families of one domain (S3 6.1), checked here
   against the committed family files. Writing the sets is what removes F06-F09 from every user's practice
   draw (X-08); the sets are append-only in the database, so a re-run that finds them already written only
   confirms they are the same.
2. Adds each allowlisted email as a participant (`training.participants`: next free code P01, P02, ...,
   counterbalance AB or BA). Counterbalance is assigned by a seeded order (sha256 of seed and email), keeping
   AB and BA as even as the existing participants allow. A user who already practised on a KPI-1 family is
   refused (they have seen a test case). A user who is already a participant keeps their row.
3. Prints the study plan: each participant's code, pre-test set, post-test set and the session order.

`report` reads the study as `arena_referee` and prints one JSON object: the blinded per-participant results
(pseudonymous code, counterbalance, pre and post scores per set; no email, user id, session id or
timestamp) and the KPI-1 cohort estimate (`arena_core.scoring.kpi.kpi1`) over participants who completed the
protocol, or "KPI-1 not measured" when none did (S6 4.8, S7 1.10).

No model call. The DSN is read from the environment only, never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any
from uuid import UUID

import psycopg

from arena_core.db.pool import Connector, dsn_connector
from arena_core.identity import user_id_for
from arena_core.ids import read_json_text
from arena_core.scoring.kpi import kpi1

ROOT = Path(__file__).resolve().parents[1]
DEV_DIR = ROOT / "cases" / "dev"
DSN_VAR = "ARENA_REFEREE_DSN"
DEFAULT_SEED = 20261024
# cases/dev/README.md "KPI-1 case sets": the terse family supplies the truthful variant, the expansive family the
# deceptive one, so both sets have the same verbosity-by-variant pattern.
SETS: dict[str, tuple[tuple[str, str], ...]] = {
    "A": (("F06", "truthful"), ("F07", "deceptive")),
    "B": (("F08", "truthful"), ("F09", "deceptive")),
}
KPI1_FAMILIES = tuple(sorted(f for members in SETS.values() for f, _ in members))
SET_LEVEL = 2
PRACTICE_NEEDED = 3
STATEMENT = (
    "A demonstration of the instrument, not a causal claim: no control arm, so practice, regression to the mean "
    "and test familiarity are not separated (S3 6.1)."
)
NOT_MEASURED = "KPI-1 not measured"


class StudyError(RuntimeError):
    """The study cannot be set up or reported as asked; nothing was written."""


@dataclass(frozen=True)
class Member:
    set_code: str
    family_code: str
    role: str
    case_id: str


@dataclass(frozen=True)
class Participant:
    email: str
    user_id: UUID
    code: str
    counterbalance: str
    new: bool


# ---------------------------------------------------------------- offline: the sets and the counterbalance


def _family(dev_dir: Path, family_code: str) -> dict[str, Any]:
    path = dev_dir / f"{family_code}.json"
    try:
        raw = read_json_text(path.read_text(encoding="utf-8"))
    except OSError as exc:
        msg = f"{path}: cannot read: {exc}"
        raise StudyError(msg) from exc
    if not isinstance(raw, dict):
        msg = f"{path}: a case family is one JSON object"
        raise StudyError(msg)
    return raw


def case_sets(dev_dir: Path = DEV_DIR) -> list[Member]:
    """The four set members from the committed family files, checked against S3 6.1: per set one truthful and
    one deceptive variant from different families, every family level 2 and of one domain."""
    members: list[Member] = []
    domains: set[str] = set()
    for set_code, wanted in sorted(SETS.items()):
        if sorted(role for _, role in wanted) != ["deceptive", "truthful"] or len({f for f, _ in wanted}) != len(
            wanted
        ):
            msg = f"set {set_code} must be one truthful and one deceptive variant from different families"
            raise StudyError(msg)
        for family_code, role in wanted:
            family = _family(dev_dir, family_code)
            level = family.get("difficulty", {}).get("level")
            if level != SET_LEVEL:
                msg = f"{family_code}: KPI-1 sets use level {SET_LEVEL} families only (found {level})"
                raise StudyError(msg)
            domains.add(str(family.get("domain")))
            case_id = family.get("variants", {}).get(role, {}).get("case_id")
            if not isinstance(case_id, str):
                msg = f"{family_code}: no {role} variant"
                raise StudyError(msg)
            members.append(Member(set_code, family_code, role, case_id))
    if len(domains) != 1:
        msg = f"the KPI-1 sets span more than one domain: {sorted(domains)}"
        raise StudyError(msg)
    return members


def parse_emails(raw: str) -> list[str]:
    emails = sorted({e.strip().lower() for e in raw.split(",") if e.strip()})
    if not emails or any("@" not in e for e in emails):
        msg = "--emails takes a comma-separated list of allowlisted email addresses"
        raise StudyError(msg)
    return emails


def assign(emails: Sequence[str], existing: Mapping[UUID, tuple[str, str]], seed: int) -> list[Participant]:
    """Participants for `emails`: an existing row (`existing`: user id -> (code, counterbalance)) is kept; new
    ones get the next free codes and a counterbalance in a seeded order (sha256 of seed and email, S3 6.1's
    seeded shuffle) that keeps AB and BA as even as the existing rows allow."""
    counts = {"AB": 0, "BA": 0}
    for _code, cb in existing.values():
        counts[cb] += 1
    taken = [int(code[1:]) for code, _cb in existing.values()]
    next_no = max(taken, default=0) + 1
    out: dict[str, Participant] = {}
    fresh: list[str] = []
    for email in emails:
        uid = user_id_for(email)
        if uid in existing:
            code, cb = existing[uid]
            out[email] = Participant(email, uid, code, cb, new=False)
        else:
            fresh.append(email)
    fresh.sort(key=lambda e: hashlib.sha256(f"{seed}:{e}".encode()).hexdigest())
    for email in fresh:
        cb = "AB" if counts["AB"] <= counts["BA"] else "BA"
        counts[cb] += 1
        out[email] = Participant(email, user_id_for(email), f"P{next_no:02d}", cb, new=True)
        next_no += 1
    return [out[e] for e in emails]


def plan_text(participants: Sequence[Participant], members: Sequence[Member]) -> str:
    by_set: dict[str, list[str]] = {}
    for m in members:
        by_set.setdefault(m.set_code, []).append(f"{m.case_id} ({m.family_code} {m.role})")
    lines = ["KPI-1 study plan (S3 6.1)", ""]
    for code in sorted(by_set):
        lines.append(f"Set {code}: {', '.join(by_set[code])}")
    lines.append(f"Practice families: every dev family except {', '.join(KPI1_FAMILIES)} (one variant each, C-37)")
    lines.append("")
    for p in sorted(participants, key=lambda q: q.code):
        pre, post = p.counterbalance[0], p.counterbalance[1]
        state = "new" if p.new else "already a participant"
        lines.append(f"{p.code}  {p.email}  ({state})")
        lines.append(f"  1-2  pre-test, set {pre}: Assessment mode, text, both cases")
        lines.append(f"  3-5  practice: Practice mode, text, {PRACTICE_NEEDED} sessions, each finalized")
        lines.append(f"  6-7  post-test, set {post}: Assessment mode, text, both cases")
    lines.append("")
    lines.append("Seven sessions per participant; the database enforces the order (training.start_session).")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- database: setup


async def _rows(conn: psycopg.AsyncConnection[Any], query: str, params: tuple[object, ...] = ()) -> list[Any]:
    cur = await conn.execute(query, params)
    return list(await cur.fetchall())


async def setup(
    connect: Connector, *, emails: Sequence[str], members: Sequence[Member], seed: int
) -> list[Participant]:
    """Case sets and participants in one transaction (all or nothing), serialized against a concurrent run."""
    async with connect() as conn, conn.transaction():
        await conn.execute("select pg_advisory_xact_lock(hashtextextended('scripts.kpi1.setup', 0))")
        rows = await _rows(
            conn,
            "select f.family_code, v.variant_code, v.id from arena.case_variants v"
            " join arena.case_families f on f.id = v.family_id"
            " where f.split = 'dev' and v.variant_code = any(%s)"
            " and not exists (select 1 from arena.family_retirements r where r.family_id = f.id)",
            ([m.case_id for m in members],),
        )
        variant = {(str(r[0]), str(r[1])): r[2] for r in rows}
        missing = [m.case_id for m in members if (m.family_code, m.case_id) not in variant]
        if missing:
            msg = f"KPI-1 variants not ingested: {missing}; run make seed-hosted first"
            raise StudyError(msg)
        wanted = {(m.set_code, variant[(m.family_code, m.case_id)]) for m in members}
        current = {
            (str(r[0]), r[1]) for r in await _rows(conn, "select set_code, variant_id from training.case_set_members")
        }
        if not current:
            for set_code, variant_id in sorted(wanted, key=str):
                await conn.execute(
                    "insert into training.case_set_members (set_code, variant_id) values (%s, %s)",
                    (set_code, variant_id),
                )
        elif current != wanted:
            msg = "training.case_set_members already holds different members; the sets are fixed (append-only)"
            raise StudyError(msg)
        existing = {
            r[0]: (str(r[1]), str(r[2]))
            for r in await _rows(conn, "select user_id, code, counterbalance from training.participants")
        }
        participants = assign(emails, existing, seed)
        new = [p for p in participants if p.new]
        exposed = await _rows(
            conn,
            "select distinct s.user_id, f.family_code from training.sessions s"
            " join arena.trials t on t.id = s.trial_id join arena.case_variants v on v.id = t.variant_id"
            " join arena.case_families f on f.id = v.family_id"
            " where s.user_id = any(%s) and f.family_code = any(%s) order by 1, 2",
            ([p.user_id for p in new], list(KPI1_FAMILIES)),
        )
        if exposed:
            who = {p.user_id: p.email for p in new}
            seen = sorted(f"{who[r[0]]} ({r[1]})" for r in exposed)
            msg = f"already ran a session on a KPI-1 family, so cannot take its test unseen: {seen}"
            raise StudyError(msg)
        for p in new:
            try:
                await conn.execute(
                    "insert into training.participants (user_id, code, counterbalance, consented_at)"
                    " values (%s, %s, %s, now())",
                    (p.user_id, p.code, p.counterbalance),
                )
            except psycopg.errors.ForeignKeyViolation as exc:
                msg = f"{p.email} is not allowlisted; run make seed-hosted EMAIL={p.email} first"
                raise StudyError(msg) from exc
    return participants


# ---------------------------------------------------------------- database: report


def _num(x: Fraction | None) -> float | None:
    return None if x is None else round(float(x), 4)


async def report(connect: Connector, *, scorer: str, seed: int) -> dict[str, Any]:
    """The blinded results and the KPI-1 estimate (S3 6.1) from `training.rubric_scores` rows of `scorer` (the
    latest row per session when a session was scored more than once)."""
    async with connect() as conn:
        people = await _rows(conn, "select id, code, counterbalance from training.participants order by code")
        sessions = await _rows(
            conn,
            "select s.participant_id, s.id, s.phase, m.set_code,"
            " t.status in ('finalized', 'terminated'),"
            " training.session_counts(s.phase, t.mode, s.voice, t.status)"
            " from training.sessions s join arena.trials t on t.id = s.trial_id"
            " left join training.case_set_members m on m.variant_id = t.variant_id"
            " where s.participant_id is not null order by s.created_at",
        )
        scores = await _rows(
            conn,
            "select distinct on (r.session_id) r.session_id, r.total from training.rubric_scores r"
            " join training.sessions s on s.id = r.session_id"
            " where s.participant_id is not null and r.scorer = %s"
            " order by r.session_id, r.created_at desc",
            (scorer,),
        )
    score = {r[0]: int(r[1]) for r in scores}
    out: list[dict[str, Any]] = []
    pre: dict[str, list[int]] = {}
    post: dict[str, list[int]] = {}
    per_set: dict[str, list[int]] = {"A": [], "B": []}
    for pid, code, cb in people:
        mine = [s for s in sessions if s[0] == pid]
        ended = {ph: sum(1 for s in mine if s[2] == ph and s[4]) for ph in ("pre", "post")}
        practice = sum(1 for s in mine if s[2] == "practice" and s[5])
        tests = {ph: [score[s[1]] for s in mine if s[2] == ph and s[1] in score] for ph in ("pre", "post")}
        for s in mine:
            if s[2] in ("pre", "post") and s[1] in score and s[3] in per_set:
                per_set[s[3]].append(score[s[1]])
        completed = ended["pre"] >= len(SETS["A"]) and practice >= PRACTICE_NEEDED and ended["post"] >= len(SETS["B"])
        unscorable = sum(1 for s in mine if s[2] in ("pre", "post") and s[4] and s[1] not in score)
        out.append(
            {
                "code": str(code),
                "counterbalance": str(cb),
                "completed": completed,
                "pre_set": str(cb)[0],
                "post_set": str(cb)[1],
                "pre_scores": tests["pre"],
                "post_scores": tests["post"],
                "practice_sessions": practice,
                "unscorable_tests": unscorable,
            }
        )
        if completed:
            pre[str(code)], post[str(code)] = tests["pre"], tests["post"]
    result: dict[str, Any] = {
        "scorer": scorer,
        "n_participants": len(out),
        "n_completed": len(pre),
        "participants": out,
        "set_effect": {k: _num(Fraction(sum(v), len(v))) if v else None for k, v in per_set.items()},
        "statement": STATEMENT,
    }
    if not pre:
        result["kpi1"] = NOT_MEASURED
        return result
    k = kpi1(pre, post, seed)
    result["kpi1"] = {
        "mean_rel": _num(k.mean_rel),
        "ci_mean_rel": k.ci,
        "median_rel": _num(k.median_rel),
        "mean_abs": _num(k.mean_abs),
        "share_ge_20pct": _num(k.share_ge_20pct),
        "ratio_of_means": _num(k.ratio_of_means),
        "excluded_pre_zero": k.excluded_pre_zero,
        "attrition": k.attrition,
        "met": k.met,
        "bootstrap_seed": seed,
    }
    return result


# ---------------------------------------------------------------- CLI


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scripts.kpi1", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p_setup = sub.add_parser("setup", help="write case sets A and B and add participants")
    p_setup.add_argument("--emails", required=True, help="comma-separated allowlisted emails")
    p_setup.add_argument("--seed", type=int, default=DEFAULT_SEED, help="counterbalance order seed")
    p_report = sub.add_parser("report", help="print the blinded results and the KPI-1 estimate as JSON")
    p_report.add_argument("--scorer", choices=("proxy", "human"), default="proxy")
    p_report.add_argument("--seed", type=int, default=DEFAULT_SEED, help="bootstrap seed")
    args = parser.parse_args(argv)
    resolved = os.environ if env is None else env
    dsn = resolved.get(DSN_VAR, "")
    if not dsn:
        sys.stderr.write(f"kpi1: {DSN_VAR} is not set\n")
        return 1
    try:
        if args.command == "setup":
            members = case_sets()
            participants = asyncio.run(
                setup(dsn_connector(dsn), emails=parse_emails(args.emails), members=members, seed=args.seed)
            )
            sys.stdout.write(plan_text(participants, members))
        else:
            result = asyncio.run(report(dsn_connector(dsn), scorer=args.scorer, seed=args.seed))
            sys.stdout.write(json.dumps(result, indent=2, sort_keys=True) + "\n")
    except StudyError as exc:
        sys.stderr.write(f"kpi1: {exc}\n")
        return 1
    except psycopg.Error as exc:
        # psycopg's message can echo a malformed DSN (password included): print the class only.
        sys.stderr.write(f"kpi1: FAIL: {type(exc).__name__} (detail withheld: it can echo {DSN_VAR})\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
