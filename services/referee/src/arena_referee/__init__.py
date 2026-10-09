"""arena_referee: ARENA_ROLE=referee. Loads the authored case families through S1's loader (D-014: authored
offline, no generation or validation call at runtime), independent labels, scoring, R3 debriefs,
adjudication, reveal, leaderboards; admin and trainer consoles on its own origin (S5 1.1).

WP-01 ships only the boot-check entry point (`python -m arena_referee`); routes land across WP-08,
WP-14, WP-16, WP-20a. Must never serve an investigator route or be reached from the arena-api origin.
"""
