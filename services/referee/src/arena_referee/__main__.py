"""`python -m arena_referee`: run the S5 1.3 boot checks, then (until WP-08/14 add routes) exit 0."""

import sys

from arena_core.config import ArenaRole, boot


def main() -> int:
    boot(ArenaRole.REFEREE)
    sys.stdout.write("arena-referee: boot checks passed (no routes yet; WP-08, WP-14)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
