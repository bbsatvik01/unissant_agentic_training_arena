# KPI-1 study runbook (Oct 24)

One page for the operator. The protocol is S3 6.1: each participant takes two pre-tests, three practice sessions and two post-tests. The database enforces the order and the mode (`training.start_session`), so a participant cannot run a step out of turn.

Case sets (from `cases/dev/README.md`, never used for practice once the sets are written):

| Set | Cases |
| --- | --- |
| A | C-6WQ3HD9P (F06 truthful), C-M7XH3R5P (F07 deceptive) |
| B | C-4VQ8N2HJ (F08 truthful), C-9HM3XQ6V (F09 deceptive) |

Half the participants take A first and B last (`AB`), half the reverse (`BA`).

## Before the day

1. Get each participant's consent to take part and to have their sessions scored. Setup records the consent time as the moment you run it, so run it only after both have agreed.
2. Allowlist each participant in the database, once per email, with `ARENA_OWNER_DSN` set in your shell:
   `make seed-hosted EMAIL=<email>`
3. Add each email to the users file (`ARENA_USERS_FILE`) with `roles = ["investigator"]`.
4. Decide the daily session quota. `ops.config.text_sessions_per_user_day` is 5, and the protocol takes 7 sessions, so a participant who starts all seven on one day is refused the sixth (the 6th start returns `quota`). Either run the post-tests the next day, or raise the quota for the study. Raising it is a config change and needs your explicit sign-off first. The per-user spend cap is $5 a day (D-017).

## Setup (once, before anyone runs a session)

With `ARENA_REFEREE_DSN` set in your shell (the value in `.env.local.referee`):

```
make kpi1-setup EMAILS=first@example.org,second@example.org
```

This writes case sets A and B, adds both people as participants (codes P01, P02, counterbalance AB or BA) and prints the plan for each. Keep the printed plan to yourself: it pairs emails with codes. Running it again changes nothing and prints the same plan.

Run setup right after seeding. Until the sets exist, F06-F09 appear in the practice library, and setup refuses anyone who has already run a session on one of them.

Setup stops with a message, and writes nothing, when:

| Message | Fix |
| --- | --- |
| `... is not allowlisted` | `make seed-hosted EMAIL=<email>`, then rerun |
| `KPI-1 variants not ingested` | `make seed-hosted EMAIL=<any email>` to ingest F01-F09 |
| `already ran a session on a KPI-1 family` | That person has seen a test case and cannot take part |
| `already holds different members` | The sets were written by hand; do not change them, ask before going on |

## On the day: one participant at a time

The local stack serves one user per run (S5 10.3), so participants take turns at the operator's machine.

1. Set `ARENA_DEV_USER=<participant email>` in the root `.env.local`. For the real study use the real models: `ARENA_MODEL_MODE` unset or `vertex`. Fake mode gives every session the same canned answers and scores.
2. `make dev`, then open the app.
3. The participant acknowledges the notice (EX-4) and follows the step label on screen:
   - Pre-test 1 and 2: the library lists only their two pre-test cases. Start each in Assessment mode, in text. Coaching is held until the end.
   - Practice 1 to 3: three different practice cases in Practice mode, in text. Each counts only if it ends with a committed finding.
   - Post-test 1 and 2: the library lists only the two post-test cases. Assessment mode, in text.
4. After each session, open the debrief so it is scored and published. Progress shows pre, post and the change once both post-tests are scored.
5. Stop the stack (Ctrl-C) before switching to the next participant.

## Results and report

With `ARENA_REFEREE_DSN` set:

```
make kpi1-report > kpi1-results.json
```

The output is blinded: participant codes only (no email, user id, session id or timestamp). It holds each participant's counterbalance, pre and post scores, practice count and unscorable tests; the case-set check (mean score on set A and on set B); and the KPI-1 estimate over participants who completed the protocol (mean relative change with its bootstrap interval, median, mean absolute change, share at or above 20%, ratio of means, `met`). With no participant who completed the protocol it reads `KPI-1 not measured`.

Scores are the proxy scorer's (R3) by default. Once blinded human ratings are stored, `make kpi1-report SCORER=human` gives the same report from them. S3 6.1 decides which one is primary: the proxy if EVL-7 calibration passed, otherwise the human score, with the proxy marked provisional.

When writing up, state:

- n (participants who completed) and who they were (team members, not outside volunteers);
- the primary score source and whether it is provisional;
- the sentence in the report's `statement`: a demonstration of the instrument, not a causal claim.
