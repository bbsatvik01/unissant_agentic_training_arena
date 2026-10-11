"""`python -m arena_api`: the S5 1.3 boot checks, then serve on 127.0.0.1:8080 (S5 10.1) until signalled.
A boot refusal exits 1 before any server starts (`state_from_env` calls `boot()`)."""

import os
import sys

import uvicorn

from arena_api.app import create_app, guard_config, state_from_env
from arena_api.state import PORT


def main() -> int:
    state = state_from_env(os.environ)
    app = create_app(state, guard_config(os.environ), phoenix_url=os.environ.get("ARENA_PHOENIX_URL") or None)
    sys.stdout.write(f"arena-api: boot checks passed; serving on 127.0.0.1:{PORT}\n")
    sys.stdout.flush()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
