"""Coach Gym command line (D-036). Make targets: `coach-gym-dataset`, `coach-gym-run BUDGET=<usd>`,
`coach-gym-report`, `coach-gym-lessons`, `coach-promote VERSION=<id> BY=<name> [REGISTER=1]`.

    ARENA_REFEREE_DSN=... python -m scripts.coach_gym dataset [--phoenix]
    ARENA_REFEREE_DSN=... python -m scripts.coach_gym run --budget 2.00 [--candidate A1] [--max-evals 300]
    python -m scripts.coach_gym report
    python -m scripts.coach_gym lessons [--approve ID | --reject ID] [--by NAME]
    python -m scripts.coach_gym promote --version A1@1.2.0 --by NAME [--register]   (ARENA_REFEREE_DSN with --register)

`run` calls the model through the agent port and the database spend guard (ARENA_MODEL_MODE=fake for a zero-spend
run; unset or `vertex` for Gemini on Vertex, ARENA_GCP_PROJECT=cna-guardian). `--budget` caps the whole run.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sys
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

from arena_core.agents.templates import REPO_ROOT
from arena_core.coachgym import registry
from arena_core.db.pool import dsn_connector
from arena_core.providers.mode import FAKE, MODE_VAR, model_adapter
from arena_core.providers.port import AgentPort, PortOptions
from arena_core.spend.guard import DbSpendGuard
from scripts.coach_gym import gym
from scripts.coach_gym.fake import FAKE_GYM_REPLIES
from scripts.coach_gym.phoenix import phoenix_from

DSN_VAR = "ARENA_REFEREE_DSN"
MAX_BUDGET = Decimal(20)  # a typo in BUDGET must not authorize a large spend


class UsageError(ValueError):
    """A command line or environment the gym refuses before doing anything."""


def budget(text: str) -> Decimal:
    try:
        value = Decimal(text)
    except InvalidOperation as exc:
        msg = f"--budget {text!r} is not a number of dollars"
        raise UsageError(msg) from exc
    if not Decimal(0) < value <= MAX_BUDGET:
        msg = f"--budget must be more than $0 and at most ${MAX_BUDGET}"
        raise UsageError(msg)
    return value


def _dsn(env: Mapping[str, str]) -> str:
    dsn = env.get(DSN_VAR, "")
    if not dsn:
        msg = f"{DSN_VAR} is not set"
        raise UsageError(msg)
    return dsn


def run_id() -> str:
    return f"gym-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(3)}"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m scripts.coach_gym", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p_data = sub.add_parser("dataset", help="build the dev-only dataset (and upload it to Phoenix)")
    p_data.add_argument("--phoenix", action="store_true", help="also upload it to PHOENIX_BASE_URL")
    p_run = sub.add_parser("run", help="GEPA search, holdout grading, reflector; records a challenger")
    p_run.add_argument("--budget", required=True, help="USD cap for the whole run")
    p_run.add_argument("--candidate", default="A1")
    p_run.add_argument("--max-evals", type=int, default=300)
    p_run.add_argument("--val-size", type=int, default=24)
    p_run.add_argument("--phoenix", action="store_true", help="log the holdout grading to PHOENIX_BASE_URL")
    sub.add_parser("report", help="versions, pending lessons and the latest experiments as JSON")
    p_lessons = sub.add_parser("lessons", help="list pending lessons, or approve or reject one")
    p_lessons.add_argument("--approve")
    p_lessons.add_argument("--reject")
    p_lessons.add_argument("--by", default="")
    p_promote = sub.add_parser("promote", help="promote a challenger that passed the holdout rule")
    p_promote.add_argument("--version", required=True, help="e.g. A1@1.2.0")
    p_promote.add_argument("--by", required=True, help="the human approving the promotion")
    p_promote.add_argument("--register", action="store_true", help="also register it in arena.candidates")
    return parser


def _run(args: argparse.Namespace, env: Mapping[str, str], root: Path) -> dict[str, object]:
    cap = budget(args.budget)
    adapter = model_adapter(env, canned=FAKE_GYM_REPLIES)
    port = AgentPort(adapter, DbSpendGuard(dsn_connector(_dsn(env))), PortOptions())
    mode: Literal["fake", "vertex"] = "fake" if env.get(MODE_VAR, "").strip() == FAKE else "vertex"
    cfg = gym.RunConfig(run_id(), args.candidate, cap, mode, args.max_evals, val_size=args.val_size)
    phoenix = phoenix_from(env) if args.phoenix else None
    return asyncio.run(gym.run_gym(cfg, port, root, phoenix)).model_dump(mode="json")


def _lessons(args: argparse.Namespace, root: Path) -> object:
    if args.approve or args.reject:
        if args.approve and args.reject:
            msg = "--approve or --reject, not both"
            raise UsageError(msg)
        lesson = args.approve or args.reject
        registry.review_lesson(root, lesson, "approved" if args.approve else "rejected", args.by)
        return {"lesson_id": lesson, "status": "approved" if args.approve else "rejected"}
    return registry.pending_view(root)


def main(argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None, root: Path = REPO_ROOT) -> int:
    args = _parser().parse_args(argv)
    resolved = os.environ if env is None else env
    try:
        out: object
        if args.command == "dataset":
            phoenix = phoenix_from(resolved) if args.phoenix else None
            out = asyncio.run(gym.build_dataset(dsn_connector(_dsn(resolved)), root, phoenix))
        elif args.command == "run":
            out = _run(args, resolved, root)
        elif args.command == "report":
            out = gym.report(root)
        elif args.command == "lessons":
            out = _lessons(args, root)
        else:
            register = dsn_connector(_dsn(resolved)) if args.register else None
            out = asyncio.run(gym.promote(root, args.version, args.by, register))
    except (UsageError, gym.GymError, registry.RegistryError) as exc:
        sys.stderr.write(f"coach_gym: {exc}\n")
        return 1
    if args.command == "dataset" and isinstance(out, dict):
        out = {k: v for k, v in out.items() if k != "forbidden"}  # never print the reference-only strings
    sys.stdout.write(json.dumps(out, indent=2, sort_keys=True, default=str) + "\n")
    return 0
