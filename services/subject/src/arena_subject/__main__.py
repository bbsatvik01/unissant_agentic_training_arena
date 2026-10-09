"""`python -m arena_subject`: run the S5 1.3 boot checks, then (until WP-12 adds answer()) exit 0."""

import sys

from arena_core.config import ArenaRole, boot


def main() -> int:
    boot(ArenaRole.SUBJECT)
    sys.stdout.write("arena-subject: boot checks passed (no answer() route yet; WP-12)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
