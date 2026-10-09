"""arena_subject: ARENA_ROLE=subject. answer(), the deterministic guard, Live voice sessions (S5 1.1).

WP-01 ships only the boot-check entry point (`python -m arena_subject`); `answer()` lands in WP-12,
`live_session.py` in WP-22. Must never import `arena_referee` (S5 1.2 item 2 rule b); never accepts
browser traffic directly.
"""
