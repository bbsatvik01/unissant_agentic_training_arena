# State

- **Date:** 2026-10-08
- **Branch:** `main` (local only, no remote yet)
- **Phase:** 0, discovery and research (research-harness). Deadline 2026-11-02 (D-005).

## Last completed milestone
- Batch 2 research complete (run `wf_70bb0865-2f7`, 7/7 routes, 0 errors). Reports: `docs/research/internal/I6-I7*.md`, `docs/research/external/X7-X11*.md`. Cumulative sources: 143 Google web (incl. 1 orchestrator fetch), 64 GDK, 34 Context7, 198 internal files.
- Batch 1 research complete (run `wf_d67bee29-e11`, 12/12 routes, 0 errors, ~15 min). Reports in `docs/research/internal/I1-I5*.md` and `docs/research/external/X1-X6*.md`. Sources so far: 98 Google web, 25 GDK, 18 Context7, 127 internal files (all research-harness floors met).
- Owner answers locked as D-005 (deadline 2026-11-02, all in), D-006 (real-time voice via Gemini Live, lift gokbase live mode), D-007 ($100 bake-off spend cap), D-008 (all four judging formats).

## Active subagents / workflows
| agent_id | description | model | dispatched_at | expected_completion | output_path |
| --- | --- | --- | --- | --- | --- |
| (none) | | | | | |

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
1. Synthesis report with decision matrix (`docs/research/synthesis/02-direction.md`).
2. Codex adversarial critique (`codex exec` in the foreground, TechnoMile lesson) until green x green.
3. Present direction to the owner.

## Local commits ahead of origin
- No remote configured.

## Live infrastructure
- None.
