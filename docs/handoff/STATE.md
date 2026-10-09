# State

- **Date:** 2026-10-08
- **Branch:** `main` (local only, no remote yet)
- **Phase:** 0, discovery and research (research-harness). Deadline 2026-11-02 (D-005).

## Last completed milestone
- UI/UX research-harness complete (U1-U5: 69 web, 9 GDK, 17 Context7); UI direction v1 written (`docs/research/synthesis/03-ui-direction.md`): kin-style status pet, generated portrait avatars with amplitude mouths, Motion + GSAP + CSS, pill voice bar, rail-first agents view, no-jargon copy rules, Stitch/impeccable pipeline; Live Avatar out of scope. Codex UI critique running.
- D-011 local-first (owner): hosting deferred; plan now 30 hidden cases (~$43 / ~$66), 34 pilot-gated. Owner also asked for a research-harness pass on UI/UX (animations, speaking avatars, pets, Claude skills); launching now.
- **Direction GREEN** (Codex round 9: 0 majors; orchestrator green). `docs/research/synthesis/02-direction.md` v10.1 awaits owner review. Plan: 20 hidden cases baseline (~$37 / ~$63), 26 pilot-gated. $0 GCP spend so far.
- Codex round 8: YELLOW (2 majors, 1 minor), fourth round on the non-model bound; v10 resolves the class by not claiming a hard non-model bound ($15 allowance, alerts, billing-disable at $70) and serving the web same-origin behind IAP. Plan: 20 hidden cases (~$37 / ~$63, complete in both); 26 after the pilot. Owner asked to front-load token-heavy design work now.
- Codex round 7: YELLOW (1 major, 3 minors). Direction v9: deployment-level non-model contract (Spark static web, IAP, billable-instance-time watchdog), voice session fits 480 s; plan 26 hidden cases ~$42 expected / ~$70 conservative. $0 GCP spend so far.
- Codex round 6: YELLOW (2 majors, 2 minors), both on D-009 enforcement. Direction v8: non-model upper bound $10.32 at gross rates with enforced caps; voice whole-session reservations; plan now 26 hidden cases + 10-case dev pilot (~$43 expected / ~$72 conservative, complete in both). Still $0 GCP spend.
- Codex round 5: YELLOW (4 majors, 2 minors), all on D-009 accounting. Direction v7: call-level spend-guard simulation, non-model envelope over a finite window with teardown, Live context rebilling, undiscounted liability rates. Plan: 30 hidden cases + 10-case dev pilot, ~$44 expected / ~$72 conservative, complete in both. No GCP spend has occurred yet ($0).
- Owner set D-009: total GCP spend hard cap $75, target $50 (supersedes D-007). Direction v6 re-plans: 30 hidden cases x 1 + 10-case dev pilot, lean-75 lineup, all online; whole-project simulation ~$49 expected / ~$73 conservative, complete in both; per-call reservations make overshoot impossible; extend to 40 cases only if dev-pilot costs track expected.
- Codex critique round 4: YELLOW (5 majors, 3 minors). Non-convergence diagnosed as mechanism growth; v5 removes mechanisms (no batch, assistants never invalidated, sealed inclusion manifest) and proves spend feasibility with `simulate_admission()`. Dispositions: `critique-round-4.md`.
- Budget (v5, all online): option B 80 cases in the $100 bake-off cap ($68 / $98; guard completes all at expected usage, replay + 34/40 blocks at conservative); option A 120 cases needs ~$145; preparation ~$37-55.
- Codex critique round 3: YELLOW (6 majors, 4 minors; converging 24 -> 12 -> 6). Direction v4 applies enforceable spend reservations, own-valid eligibility with attrition sensitivity, execution vs validity layers, three budget buckets, batch cutoff and fallback. Dispositions: `critique-round-3.md`.
- Budget (v4): option B, 80 hidden cases inside the $100 bake-off cap ($52 / $75 batch; $66 / $94 online fallback) plus preparation ~$35-52; option A, 120 cases, needs a ~$145 bake-off ceiling.
- Codex critique round 2: YELLOW (0 blockers, 12 majors, 3 minors; 14 round-1 findings confirmed fixed). Five fixes recurred, so v3 applies deeper rules: privileged SQL functions deriving state from committed rows, lineup-as-data cost model with reservations, durable telemetry barrier. Direction v3 + `stats_contracts.py` written; dispositions in `critique-round-2.md`.
- Budget (v3, full accounting): sponsor-sized 120 x 1 power-first ~$121 expected / ~$175 conservative all-in; all-in under $100 conservative = 40 hidden cases ($54 / $79, zero-FP bound 13.9%). 59 truthful families are the minimum for a 5% bound.
- Codex critique round 1: YELLOW (0 blockers, 24 majors, 2 minors). All 26 findings real; grouped into 8 root-cause classes; applied in direction v2 (`docs/research/synthesis/02-direction.md`) with `cost_model.py` and `decision_matrix.py`. Dispositions: `docs/research/synthesis/critique-round-1.md`.
- Budget finding: the sponsor's full workload (120 hidden x 2) costs ~$223-385; recommended 120 x 1 power-first lineup keeps the bake-off at ~$68-94 but needs ~$35-50 extra for generation and the dev pilot; all-in-$100 means 60 hidden cases (FPR bound 9.5% at zero false positives). Owner decision pending.
- Batch 2 research complete (run `wf_70bb0865-2f7`, 7/7 routes, 0 errors). Reports: `docs/research/internal/I6-I7*.md`, `docs/research/external/X7-X11*.md`. Cumulative sources: 143 Google web (incl. 1 orchestrator fetch), 64 GDK, 34 Context7, 198 internal files.
- Batch 1 research complete (run `wf_d67bee29-e11`, 12/12 routes, 0 errors, ~15 min). Reports in `docs/research/internal/I1-I5*.md` and `docs/research/external/X1-X6*.md`. Sources so far: 98 Google web, 25 GDK, 18 Context7, 127 internal files (all research-harness floors met).
- Owner answers locked as D-005 (deadline 2026-11-02, all in), D-006 (real-time voice via Gemini Live, lift gokbase live mode), D-007 ($100 bake-off spend cap), D-008 (all four judging formats).

## Active subagents / workflows
| agent_id | description | model | dispatched_at | expected_completion | output_path |
| --- | --- | --- | --- | --- | --- |
| codex exec (UI round 1) | Codex critique of `03-ui-direction.md` | gpt-6-astra xhigh | 2026-10-08 ~20:25 | ~20:40 | scratchpad `codex/ui1.json` |
| task `wvney9kpk` / run `wf_7986355a-2f8` | Spec-package workflow S1-S8 (Opus x7, Sonnet x1) | Opus/Sonnet | 2026-10-08 ~21:00 EDT | ~21:45-22:30 EDT | `docs/spec/**` |

## Early signals from batch 1 (unverified until synthesis)
- KPI-4 risk: Gemini 3.x cannot fully disable thinking; third-party TTFT figures are far above 3 s. Needs a measured latency spike and a deliberate design (2.5 thinking-off tier, two-stage coaching, or Practice/Assessment split).
- $100 cap fits the full 2,160-trial protocol only on cheap tiers (X3 estimate: ~$42 all-Flash-Lite, ~$195 balanced).
- Model Armor fails open and skips inputs under 3 words; cannot be the only injection defense.

## Voice vs Vertex conflict (surfaced 2026-10-08, X7 verified)
- gokbase and cloudforce call `gemini-3.1-flash-live-preview` through an AI Studio key. That model is not on Vertex and shuts down on the Developer API 2026-11-17.
- Vertex lists GA Live models `gemini-3.8-live` and `gemini-live-2.5-flash-native-audio`, but 2026 forum reports show a per-project allowlist gate on audio output. Needs a live connect() probe on the arena project; Vertex-clean fallback is Chirp 3 STT + text subject + Gemini TTS.

## Model lifecycle (X7, X8)
- Gemini 2.5 Flash / Flash-Lite / Pro retire on Vertex 2026-10-16 to 10-20, before the deadline. Only 3.x remains; thinking cannot be disabled (floor MINIMAL; 3.7/3.8 Flash have no MINIMAL tier).

## Waiting for (owner input)
- A dedicated GCP project with Vertex AI and billing (needed for latency and cost spikes). The workstation default `kbg-production` must not be used.
- Supabase project details, DESIGN.md, GitHub repo destination, team members, any Challenge X rubric or submission rules.

## Next dispatch queue
1. Spec-package workflow S1-S8 running; then Codex review of the spec package (`codex exec` in the foreground, TechnoMile lesson) until green x green.
2. Apply findings, re-run until green x green; record rounds in `docs/research/synthesis/critique-round-N.md`.
3. Present direction to the owner.

## Local commits ahead of origin
- No remote configured.

## Live infrastructure
- None.
