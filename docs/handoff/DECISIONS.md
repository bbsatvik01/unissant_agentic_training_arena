# Decisions (append-only)

## 2026-10-08 · D-001 Gemini on Vertex AI is the only LLM provider
- **Decision:** every model call (assistants, subjects, scenario generation, judges, TTS, image) uses Gemini models through Vertex AI.
- **Reasoning:** owner directive this session ("gemini models all throughout from vertex, no chinese models"). Matches the TechnoMile stack, so its provider port and Phoenix wiring transfer.
- **Alternatives considered + why rejected:** other providers on Vertex Model Garden and open-weight models: excluded by the owner.
- **Files affected:** all future model clients.
- **Reversibility:** locked-in (owner).

## 2026-10-08 · D-002 Reference repos are read-only
- **Decision:** TechnoMile, PangeaChat, gokbase and cloudforce are read, never modified. Patterns are lifted by copying into this repo with attribution.
- **Reasoning:** owner directive: they are proven, hosted projects.
- **Alternatives considered + why rejected:** none.
- **Files affected:** none in this repo; governs every agent brief.
- **Reversibility:** locked-in (owner).

## 2026-10-08 · D-003 Platform constraints
- **Decision:** Supabase for data, Arize Phoenix for observability, GCP hosting that scales to zero (no min-instances >= 1, no CPU always-allocated), sized for 1-2 concurrent users, simple architecture.
- **Reasoning:** owner directive this session plus the global scale-to-zero gate.
- **Alternatives considered + why rejected:** always-on hosting: forbidden by the global gate.
- **Files affected:** future infra and deploy files.
- **Reversibility:** locked-in (owner).

## 2026-10-08 · D-004 Lift-first research
- **Decision:** reuse TechnoMile's late-September research corpus and code (Vertex/Gemini/ADK, Phoenix, Supabase + GCP topology, UI/UX, role-play, agent security) and research fresh only what is specific to this challenge or has moved since.
- **Reasoning:** the corpus is two weeks old and was critiqued over seven Codex rounds; redoing it wastes the owner's usage budget, which the owner asked to conserve for the build.
- **Alternatives considered + why rejected:** full re-research of every route: duplicate cost for little new information.
- **Files affected:** `docs/research/**`.
- **Reversibility:** cheap.

## 2026-10-08 · D-005 Deadline and scope: November 2, 2026, all in
- **Decision:** submission/demo is 2026-11-02 (25 days out). Scope is the full brief, built with parallel Claude agents and Codex gates.
- **Reasoning:** owner answer this session ("we have enough time ... go all in").
- **Alternatives considered + why rejected:** a tight MVP: rejected by the owner.
- **Files affected:** plan and roadmap (to come).
- **Reversibility:** moderate (scope can be trimmed late, not grown).

## 2026-10-08 · D-006 Real-time voice interrogation via Gemini Live, lifted from gokbase
- **Decision:** the arena supports real-time spoken interviews on the Gemini Live API (owner named "Gemini 3.1 Live"; exact Vertex model ID to verify), lifting the gokbase live talk mode (`backend/app/rag/live/session.py`, voice WebSocket, cost ledger). Text stays the scored artifact: every spoken turn is transcribed and scored as text (SOL-1).
- **Reasoning:** owner answer this session; gokbase already runs it in production, so the lift is low risk.
- **Alternatives considered + why rejected:** text + TTS only, or text only: the owner chose real-time voice.
- **Files affected:** voice gateway, transcript pipeline, UI interrogation room (to come).
- **Reversibility:** moderate.

## 2026-10-08 · D-007 Model-spend ceiling: $100 for the bake-off (SUPERSEDED by D-009)
- **Decision:** the bake-off may spend at most $100 of Vertex AI usage. The runner enforces the cap in code (cost ledger with reservations and a hard stop) and the GCP project carries a billing budget alert.
- **Reasoning:** owner answer this session. Batch 1 estimate (X3, low confidence): the full 2,160-trial protocol costs about $42 all-Flash-Lite, $195 for a balanced mix, $333 all-Pro, so the full protocol fits only with cheap tiers or a scaled-down run.
- **Alternatives considered + why rejected:** larger budgets: not approved.
- **Files affected:** tournament runner, cost ledger, GCP budget config (to come).
- **Reversibility:** owner can raise it.

## 2026-10-08 · D-008 Judging formats: all four
- **Decision:** prepare for a live demo with Q&A, a hosted link judges use themselves, a video plus deck submission, and repo/code review.
- **Reasoning:** owner answer this session.
- **Implications:** hosted deploy that scales to zero with auth, per-user rate limits and spend guards so judges cannot exhaust the $100 cap; demo-path polish; recorded walkthrough and deck; full CI gates, docs and tests in the repo.
- **Files affected:** deploy, auth, guardrails, docs (to come).
- **Reversibility:** locked-in (owner).

## 2026-10-08 · D-009 Total GCP spend: hard cap $75, target $50 (supersedes D-007)
- **Decision:** everything billed on GCP (Vertex model calls for experiments, case generation, dev pilot, bake-off, judge sessions and voice; Cloud Run; Phoenix hosting; storage) stays at or under $75 in total, aiming for $50. Never overshoot.
- **Reasoning:** owner directive this session ("the cost on gcp should not exceed 50-75 dollars, do not over shoot it").
- **Enforcement:** one global ceiling of $75 in the transactional reservation ledger, split into buckets with their own ceilings; every call reserves its worst case before running; a kill switch; GCP billing budget alerts at $25, $50 and $65 as a secondary alarm.
- **Alternatives considered + why rejected:** the $100 bake-off cap (D-007) and the $145-175 options in direction v3-v5: over the new ceiling.
- **Files affected:** `docs/research/synthesis/cost_model.py`, `02-direction.md` section 8, future spend-guard code.
- **Reversibility:** owner can raise it.

## 2026-10-08 · D-010 Research direction v10.1 accepted by the research harness (pending owner review)
- **Decision:** `docs/research/synthesis/02-direction.md` v10.1 is the working direction: typed agent port, four Cloud Run deployables with credential-boundary isolation and privileged SQL functions, in-process candidates on the official leaderboard, two-stage vs single-call coaching tested in the bake-off, Vertex Live voice on development cases, local Phoenix during the build, static web served same-origin behind IAP, 20 hidden cases baseline under D-009.
- **Reasoning:** 19 research routes (143 web, 64 GDK, 34 Context7, 198 internal files) and nine Codex critique rounds ending GREEN.
- **Alternatives considered + why rejected:** see the decision matrices in section 5 and `decision_matrix.py`.
- **Files affected:** `docs/spec/**` (being written), the build.
- **Reversibility:** cheap until the build starts; owner review is the final gate.

## 2026-10-08 · D-011 Local-first: build and run everything locally; GCP hosting only if time permits
- **Decision:** the arena runs locally (services as local processes or docker compose, local Phoenix, the owner's Supabase project, Vertex AI for models). Cloud Run, IAP and hosted judge links are deferred and revisited only if time permits.
- **Reasoning:** owner directive this session ("do not worry about hosting on gcp, do it all locally only first").
- **Effect:** under D-009 only Vertex model and voice calls bill GCP, all reserved by the guard; the non-model allowance drops to a $1 margin; the plan grows to 30 hidden cases (~$43 expected / ~$66 conservative, complete in both), 34 pilot-gated. Credential boundaries stay: subject and referee run as separate local processes with separate database roles.
- **Reversibility:** cheap; the hosted design in direction sections 4, 5.6 and 8.3 remains the plan if hosting returns.

## 2026-10-08 · D-012 Budget ceilings are generated and applied, never typed; buckets start at $0
- **Decision:** the SQL migrations create the spend-guard bucket tree with $0 ceilings (fail-closed); the operator applies `cost_model.budget_plan()` (printed by `cost_model.py --plan-json`) through `ops.set_bucket_ceiling`, and a test asserts the applied ceilings equal that output. Local tree: global $74.00 with children demo, art, training and build (leaves experiments, generation, dev_pilot, replay, interactive).
- **Reasoning:** the spec drafts typed $60.00 / $12.43 / $47.57 from direction v10, which were stale within hours (D-011, UI art cap, training costs). Generated-and-applied removes the duplicated numbers; fail-closed means a missing plan stops spend instead of running on stale ceilings. Simpler than S8 C-01's generated migration (`--emit-sql`), which would make migrations a build artifact.
- **Alternatives:** typed seeds (rejected: drift, LESSONS 2026-10-08); generated SQL at migration build time (rejected: extra build step, migrations no longer static).
- **Plan baseline (recommendation, owner decision OD-8):** 24 hidden cases, 30 if the dev pilot tracks the expected column (direction v10.3).
- **Files affected:** `docs/research/synthesis/cost_model.py`, `docs/spec/README.md`, `docs/spec/sql/0006_ops_budget_traces.sql` (in reconciliation), S4, S5, S8.
- **Reversibility:** cheap.

## 2026-10-08 · D-013 Build first; cost tuning deferred; one global spend ceiling
- **Decision:** owner directive: "do not worry on the per test spend, first build the pipeline end to end and the feature itself, then we will see what we can do on the cost"; "keep things simple and straightforward". The build starts now (owner half of gate G0); the spec package is brought to Codex GREEN in parallel. Per-activity cost accounting (Codex round 10 R10-01..R10-05, spec cross-check X-03, X-04, X-05) is deferred until the pipeline runs end to end. The D-009 $75 hard cap stays, enforced as one global ceiling (local: $74) with per-call and whole-voice-session reservations; no bucket tree in use (the SQL seeds only the `global` row at $0 and the operator applies `budget_plan()`, which now returns that single ceiling).
- **Reasoning:** the bucket tree and per-phase sizing generated recurring findings (rounds 10 and cross-check) without changing what gets built; a single ceiling keeps the hard guarantee that matters (never overshoot $75) with less code.
- **Alternatives:** keep the per-phase tree (rejected: complexity before anything runs); drop the guard (rejected: D-009).
- **Files affected:** `cost_model.py` (`budget_plan()`), S4 seed and tests, S5 section 4, S8 WP-05.
- **Reversibility:** cheap; the tree functions remain in SQL if per-phase limits are wanted later.
