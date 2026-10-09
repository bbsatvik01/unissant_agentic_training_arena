"""`python -m arena_tournament`: run the S5 1.3 boot checks, then (until WP-17 adds the runner) exit 0."""

import sys

from arena_core.config import ArenaRole, boot


def main() -> int:
    boot(ArenaRole.TOURNAMENT)
    sys.stdout.write("arena-tournament: boot checks passed (no runner yet; WP-17)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
