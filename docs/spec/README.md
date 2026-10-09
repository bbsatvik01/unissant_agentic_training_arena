# Spec package

Build specification for the arena, in eight parts. **Version 2.4, 2026-10-09: Codex round 2 fixes; D-016 simplifications.** Each part cites requirement IDs from `docs/challenge/REQUIREMENTS.md` and the direction sections it implements.

| Part | Scope |
| --- | --- |
| `S1-scenario-engine.md` (+ `schemas/`, `seed-families/`) | Case families, the three packets, release predicates, offline authoring, validation, sealing |
| `S2-agents-and-prompts.md` | Agent port, candidates A1-A3 and S1-S3, referee, prompts, schemas |
| `S3-scoring-rubrics-metrics.md` | Rubrics, 9N metrics, statistics, leaderboard rules |
| `S4-data-layer.md` (+ `sql/`) | Schemas, roles, privileged functions, ledger, spend guard, trace mirror; pgTAP plan in `sql/TESTS.md` |
| `S5-backend-and-lift.md` | Services, routes, orchestration, voice relay, lift map from the reference repos |
| `S6-frontend-ux.md` | Screens, components, motion, voice surface, copy rules |
| `S7-demo-and-judging.md` | Demo script, judge paths, video and deck |
| `S8-build-plan.md` | Sequenced build plan to 2026-11-02 |

## Status

Version 1 (2026-10-08, workflow `wf_7986355a-2f8`) was written against direction v10; S8 section 9 lists 48 cross-part conflicts (C-01 to C-48). v2 (c293bec) reconciled S2-S8; its cross-check was RED (`review-v2-crosscheck.md`). v2.1 fixed S1 and the interface findings and applied D-013. Codex spec round 1 returned RED, RED, RED, YELLOW (`review-codex-r1.md`); v2.3 fixes every part against one set of shared decisions (D1-D11 below) and goes to Codex until GREEN. Codex round 2 returned 4 blockers and 35 majors (`review-codex-r2.md`); v2.4 resolves them under D-016, removing or narrowing mechanisms a local team-run demo does not need where that settles a finding (dispositions in `review-codex-r2.md`). The build runs in parallel (D-013); S8's interface gate holds back only work packages whose interfaces carry an open finding.

## Governing sources (the spec follows these; where they disagree, these win)

1. `docs/research/synthesis/02-direction.md` v10.4 (Codex round 9 GREEN on v10; v10.3-v10.4 re-cost the plan and apply D-013, D-014) with D-011 local-first.
2. `docs/research/synthesis/03-ui-direction.md` v2.1 (Codex UI round 2 GREEN).
3. `docs/handoff/DECISIONS.md` (D-001 to D-016). D-013: build first; cost tuning deferred; keep it simple. D-014: case families authored offline by Claude agents with Codex review. D-016: a local demo run only by the team; simple and clean over completeness, with credential isolation, the spend guard, scoring correctness and the tournament protocol kept.
4. Numbers come from scripts, never typed: dollar figures and bucket ceilings from `cost_model.py` (`budget_plan()`, `simulate_d009()`, `demo_ceiling()`), matrix totals from `decision_matrix.py`, statistical bounds from `stats_contracts.py`. A spec table that shows a figure names the function that produced it.

## Baseline facts the parts must agree on

- **Run mode:** local-first (D-011). Services run as separate local processes, each with its own database role and credential (`arena_public`, `arena_subject`, `arena_referee`); Phoenix runs locally; Vertex AI is the only GCP service billed. The Cloud Run and IAP design is the hosted variant, kept as an optional later phase, never the default path.
- **Plan (direction v10.4, `PLAN` in `cost_model.py`):** 30 hidden cases (15 matched families) x 1 repeat plus a 10-case dev pilot (5 families) and 4 more development families for KPI-1 (9 in total: F01-F03 plus 6 authored); 34 hidden cases if the dev pilot's measured costs track the expected column (OD-8). Case families are authored offline by Claude agents with Codex review (D-014); no Gemini Pro and no runtime generator. Training: R3 (the two referee calls in investigator mode) on every scored training session; KPI-1 for up to 10 volunteers x 7 sessions; 20 calibration transcripts.
- **Spend guard (D-012, D-013):** one global ceiling. The migrations seed only the `global` bucket at $0 (fail-closed); the operator applies `budget_plan()` (`python3 cost_model.py --plan-json` prints `{"global": 74.00}` locally; $60.00 hosted) and a test asserts equality. Every model call reserves its worst case and every voice session its whole-session worst case against that ceiling before running, so spend cannot pass the $75 cap. Per-phase buckets and per-test cost tuning are deferred until the pipeline runs end to end (D-013).
- **Demo allocation:** 40 text sessions, 8 voice sessions (whole-session reservation each), at most 62 character images (a count cap in code); all reserve against the one `global` ceiling.
- **UI:** one server-authorized event projection feeds every animation, caption, connector, pipeline detail and replay; coaching cards appear only when complete, validated and transcript-current; voice state combines connection, capture, server activity and playback; presentational work starts after the 2026-10-18 slice gate.
- **Voice (D7, D-016):** voice sessions are unscored development practice; they never enter a score, a KPI or a leaderboard (eligibility is the session's, so a text continuation stays unscored), and no playback acknowledgement or retranscription exists. A dropped connection ends the voice session and a reconnect is a new voice session built from the database; there is no resume credential or Live handle. Gates in voice follow the same LOCKED rule as text, and evidence is requested through the same board.
- **Local HTTP boundary (D10):** `arena-api` and the referee console check Host, reject a foreign Origin on every state-changing browser request and require a CSRF header tied to a `SameSite=Strict` cookie on every browser POST. Service routes under `/internal/` take the internal policy instead: a caller token for that route, and no browser credentials accepted (S5 10.3).
- **KPI-1:** reported only from participants who completed the counterbalanced protocol; otherwise "KPI-1 not measured". No other data stands in for it.

## Shared decisions of v2.3 (Codex round 1)

| ID | Decision | Owner part |
| --- | --- | --- |
| D1 | The hidden-content scan corpus is case-specific hidden text only; platform text shared by every packet (EX-4, templates, agency, limits) is excluded by a field-path allowlist | S1 10.4, S2 3.4 |
| D2 | A replay trial owns its transcript: `arena.advance_replay` copies each source turn, and everything downstream uses the replay trial's own turn numbers | S4, S5 5.3 |
| D3 | One work item per model step, keyed by a caller request key; a repeated key returns the stored result; `arena.work_item_results` recovers a restarted orchestrator | S4, S5 5.1 |
| D4 | A KPI-4 sample opens pending at the subject turn; one still pending at the next question or finalization becomes `unmeasured_timeout` (a miss and unmeasured) | S3 6.4, S4 |
| D5 | The finding carries a rationale (at most 600 characters); closure checks score its own citations; every finding field is fenced as untrusted in referee prompts | S2, S3 |
| D6 | One quote predicate in one module, ported to the browser: normalize dashes, quotes and whitespace; accept 3 or more words, or the whole of a shorter answer | S2, S6 4.5 |
| D7 | Voice is unscored practice; LOCKED gates and context refresh after every release; subject-owned voice context and settlement | S1, S2, S5 7, S6 6.2 |
| D8 | `training.debriefs`, written only by `training.publish_debrief`, read through `training.v_my_debrief`; role and resolution only after the session ends; R3 receives the session's coach flags | S3 5.7, S4, S5 5.4, S6 4.7 |
| D9 | Trial stream with its own cursor; tournament view polls the ledger cursor, counts only before reveal; REST snapshot, SSE deltas at most 16 KB; catch-up tickets until the debrief is published | S5 6, S6 5 |
| D10 | Host, Origin and CSRF checks on both local HTTP services | S5 10.3, S6 1.3 |
| D11 | Reservations use the UTF-8 byte length of the final request; questions at most 600 characters | S2, S4, S5 4 |

## Changes in v2.3

| ID | What changed |
| --- | --- |
| Status | Codex round 1 recorded; v2.3 applies D1-D11 across the parts; the build runs in parallel under D-013 with S8's interface gate (SG4-14). |
| SG4-13 | Baseline fact added: KPI-1 only from participants who completed the protocol, otherwise "not measured". |
| D7, D10 | Baseline facts added for unscored voice and the local HTTP boundary; the shared decisions table lists D1-D11 with their owning parts. |
| D-013 | Demo allocation: the portrait cap is a count cap against the one `global` ceiling, not a sub-budget. |

## Changes in v2.4

| ID | What changed |
| --- | --- |
| Codex round 2 | 4 blockers fixed by the orchestrator; 35 majors and 3 minors dispositioned in `review-codex-r2.md` (real, false positive or removed by simplification, with the change). |
| D-016 | Voice resume credentials and Live handles removed (reconnect is a new voice session); the voice turn boundary release commits with the answer inside `record_subject_turn`; referee calls use judgment stage keys, not work items; one executor per trial in the local stack. |
