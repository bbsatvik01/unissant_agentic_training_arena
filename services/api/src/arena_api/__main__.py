"""`python -m arena_api`: run the S5 1.3 boot checks, then (until WP-13 adds routes) exit 0."""

import sys

from arena_core.config import ArenaRole, boot


def main() -> int:
    boot(ArenaRole.API)
    sys.stdout.write("arena-api: boot checks passed (no routes yet; WP-13)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
