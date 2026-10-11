"""referee_subject / referee_assistant label calls (S2 7.2, 7.3): there is no standalone `/label` HTTP route.

The calls themselves live in `arena_referee.scoring` (`run_r1`, `run_r2`), reached through
`POST /internal/trials/{id}/score` (interactive trials, `routes/score.py`) and, for a training session's R3,
through `POST /internal/sessions/{id}/debrief` (`routes/debrief.py`). This file is kept as the WP-14 scope's
named placeholder; nothing is routed from it.
"""
