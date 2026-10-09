---
applyTo: "{Makefile,pyproject.toml,tools/**,.github/workflows/**,conftest.py}"
description: "The CI and test gates are never softened. A failing gate means fix the code."
---

# Gates

`make check` is the single gate; CI calls the same make targets. Order: ruff check, ruff format --check, mypy strict, no-rigging, roles, cost-parity, ratchet, pytest with coverage, bandit `-ll -ii`.

- Thresholds live in `tools/gates/ratchet.toml` and only get stricter. Changing a threshold means changing it in its source file and in the ratchet in the same commit, and only upward.
- Suppressions are forbidden. The only exception is a proven false positive in `tools/gates/suppressions-allowlist.toml`: one file, one marker, the exact line, and a reason. Adding an entry is a gate change and needs its own review.
- Never add `continue-on-error`, remove a `needs:`, lower a timeout floor, or broaden an exclude.
- A new gate ships with a gateproof test that proves it fails on a seeded defect.
- Lifted files are recorded in `ATTRIBUTIONS.md` (source path, sha256, changes) and pass every gate like new code.
