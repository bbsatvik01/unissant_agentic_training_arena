"""`python -m arena_referee`: run the S5 1.3 boot checks, then serve the scoring, review and internal
routes (S5 10.1: binds 127.0.0.1:8082 until WP-33's hosted variant). A boot refusal exits 1 before any
server starts (`create_app` calls `boot()`, which calls `sys.exit(1)` itself, S5 1.4); `main()` only
reaches `uvicorn.run` on a clean environment, and that call blocks until the process receives a shutdown
signal (uvicorn's own SIGINT/SIGTERM handling), returning 0 once the server has drained. `tests/test_main.py`
proves the refusal paths with the four roles' shared helper (which never reaches this line) and the serving
path with its own process control (SIGTERM, not a blocking wait) -- the same shape as `arena_subject`'s and
`arena_api`'s own `__main__.py`.
"""

import os
import sys

import uvicorn

from arena_core.config import BIND_HOST_VAR, LOCAL_BIND_HOST
from arena_referee.app import create_app
from arena_referee.app import port as referee_port


def main() -> int:
    env = dict(os.environ)
    app = create_app(env)  # boot() runs inside create_app; a refusal exits 1 before this line returns
    bind_host = env.get(BIND_HOST_VAR, LOCAL_BIND_HOST)
    bound = referee_port(env)
    sys.stdout.write(f"arena-referee: boot checks passed; serving on {bind_host}:{bound}\n")
    sys.stdout.flush()
    uvicorn.run(app, host=bind_host, port=bound, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
