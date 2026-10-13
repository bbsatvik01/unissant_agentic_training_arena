"""`python -m arena_subject`: run the S5 1.3 boot checks, then serve `POST /internal/answer` (S5 10.1: the
role binds 127.0.0.1:8081, started by `make dev`; `scripts/run_local.py`, WP-13, will spawn this).

A boot-check refusal exits 1 before any server starts (`state_from_env` calls `boot()`, which calls
`sys.exit(1)` itself, S5 1.4); `main()` only reaches `uvicorn.run` on a clean environment, and that call
blocks until the process receives a shutdown signal (uvicorn's own SIGINT/SIGTERM handling), returning 0
once the server has drained. `tests/test_main.py` proves the refusal paths with the four roles' shared
helper (which never reaches this line) and the serving path with its own process control (SIGTERM, not a
blocking wait).
"""

import logging
import os
import sys

import uvicorn

from arena_subject.app import PORT, create_app, state_from_env


def main() -> int:
    state = state_from_env(os.environ)
    app = create_app(state)
    sys.stdout.write(f"arena-subject: boot checks passed; serving on {state.bind_host}:{PORT}\n")
    sys.stdout.flush()
    # The role's own INFO lines (voice session openings and closes) reach the console beside uvicorn's.
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s %(message)s"))
    role_log = logging.getLogger("arena_subject")
    role_log.addHandler(handler)
    role_log.setLevel(logging.INFO)
    uvicorn.run(app, host=state.bind_host, port=PORT, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
