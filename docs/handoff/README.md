# Handoff: persistent project brain

This folder is canonical. Every session reads it before acting and trusts it over memory or assumptions.

## Read order (session start)

1. `STATE.md`: what is happening now (phase, active subagents and workflows, blockers, next queue).
2. `HISTORY.md`: milestones and commits.
3. `DECISIONS.md`: locked choices and why.
4. `LESSONS.md`: bugs already paid for; do not repeat them.
5. `PATTERNS.md`: mandatory gates and habits.
6. `SUBAGENTS.md`: contracts for in-flight workers.

## Write rules

| File | Mode | When |
| --- | --- | --- |
| STATE.md | rewritten | end of every significant turn (dispatch, completion, milestone, blocker) |
| DECISIONS.md | append-only | a non-trivial choice locks |
| LESSONS.md | append-only | a bug is rooted and a prevention pattern emerges |
| PATTERNS.md | living | a new gate or habit becomes mandatory |
| HISTORY.md | append-only | a milestone or commit lands |
| SUBAGENTS.md | rewritten | dispatch adds an entry, completion removes it |

## Commit convention

`docs(handoff): <change>`, atomic per logical update, same turn as the triggering event.

## Related folders

- `docs/challenge/`: the sponsor problem statement (pptx, pdf, extracted text with speaker notes) and `REQUIREMENTS.md` (line-by-line traceability, stable IDs).
- `docs/research/`: research-harness outputs. `BRIEF.md` = shared brief; `internal/` = our own codebases; `external/` = web, vendor and paper research; `synthesis/` = reasoned reports and critique rounds.
