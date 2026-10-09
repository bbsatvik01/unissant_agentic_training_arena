"""arena_api: ARENA_ROLE=api. Investigator REST, SSE and the voice relay edge (S5 1.1).

WP-01 ships only the boot-check entry point (`python -m arena_api`); `app.py` and every route land in
WP-13 (and WP-22 for voice). Must never import `arena_subject` or `arena_referee` (S5 1.2 item 2 rule a).
"""
