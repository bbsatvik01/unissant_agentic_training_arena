"""`python -m arena_tournament`: with no argument, run the S5 1.3 boot checks and exit 0 (the WP-01
contract every role's `tests/test_main.py` proves identically). `run <tournament-id>` runs that already
frozen, already open tournament to completion (S5 5.3; WP-17): `arena_tournament.main.run_tournament` does
its own boot check first, from the same environment.
"""

import asyncio
import os
import sys
from uuid import UUID

from arena_core.config import ArenaRole, boot
from arena_tournament.main import run_tournament

RUN_ARGV_LEN = 2  # "run" plus the tournament id


def _run(tournament_id: str) -> int:
    summary = asyncio.run(run_tournament(os.environ, UUID(tournament_id)))
    sys.stdout.write(f"arena-tournament: tournament {summary.tournament_id} closed; outcomes {summary.outcomes}\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    """`argv` is the arguments after the module name, never read from `sys.argv` here (unlike `argparse`'s
    own `None` default): an in-process call such as `main()` means no arguments, not "whatever this
    interpreter -- pytest, say -- was started with"."""
    args = [] if argv is None else argv
    if not args:
        boot(ArenaRole.TOURNAMENT)
        sys.stdout.write("arena-tournament: boot checks passed (no runner yet; WP-17)\n")
        return 0
    if len(args) == RUN_ARGV_LEN and args[0] == "run":
        return _run(args[1])
    sys.stderr.write("usage: python -m arena_tournament [run <tournament-id>]\n")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
