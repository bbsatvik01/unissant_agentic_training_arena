"""arena_tournament: ARENA_ROLE=tournament job. Frozen roster, block scheduling, harness trials, unit
admission (S5 1.1).

WP-01 ships only the boot-check entry point (`python -m arena_tournament`); `roster.py`, `blocks.py`
and `admission.py` land in WP-17. Must never read subject or evaluator tiers.
"""
