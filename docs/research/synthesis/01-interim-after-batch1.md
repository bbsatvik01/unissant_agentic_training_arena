# Interim synthesis after batch 1

Date: 2026-10-08. Inputs: `docs/research/internal/I1-I5*.md`, `docs/research/external/X1-X6*.md` (run `wf_d67bee29-e11`; 98 Google web, 25 GDK, 18 Context7, 127 internal files). Status: hypotheses, not decisions. Confidence labels: H / M / L.

## 1. What is now known

### Product and science
- **The deck's three-packet design is the converged pattern (H).** Werewolf Arena (Apache-2.0), ChatArena (Apache-2.0) and Among-Agents (MIT) all separate a public transcript, private agent state and a scripted moderator, which matches SCN-7/8/9. [X2a]
- **The coach has a scientific spine (H).** Strategic Use of Evidence (withhold evidence, let the subject commit, disclose late, test statement-evidence inconsistency) maps onto scripted evidence release (SCN-4, SCN-10) and evidence-based follow-ups (CH-2, AST-3). Unanticipated-question and cognitive-load tactics are cheap to prompt. A question-type enum (open, probing, closed, leading, suggestive, compound, forced-choice, opinion) gives a mechanical first pass for AST-6 and rubric dimension 1. The Mendez Principles give the non-accusatory stance. [X1]
- **PRB-4 is empirically grounded (H).** Human deception-judgment accuracy is ~54% (Bond and DePaulo 2006); single cues average d ~0.10 (DePaulo 2003); accented speech is rated less truthful (Lev-Ari and Keysar 2010). This justifies a style-stratified false-positive audit as a bake-off check, not just a principle. [X1, X5]
- **Direct precedent for KPI-1 (H on existence, M on details).** A 2026 Law and Human Behavior RCT found that training against LLM "AI suspects" with simple SUE-based rules transferred to better interviews of real mock suspects. Full text pending (batch 2, X9). [X2a]
- **No public 0-4 investigative rubric exists (H).** EVL-7 anchors must be authored; binary sub-checks mapped to anchors beat raw Likert judging (CheckEval, +0.45 agreement). [X1, I3]
- **Evasion taxonomy exists (M).** Bavelas's equivocation theory and Bull's non-reply typology support four annotation classes: evasion, genuine uncertainty, legitimate non-disclosure, poorly framed question (the last routes to the investigator's clarity score). [X1]

### Sponsor
- **Unissant (H):** Herndon, VA; clients include ICE, CBP, USCIS, DHS, TSA, US Marshals, DoS, DoD, NIH, VA, CMS, HHS; markets "iExamen" for investigative case management (M). Founder Manish Malhotra is a founding member of GMU's AI-in-Gov Council. "Challenge X" has no public footprint, so no published rubric. [X6]
- **Vocabulary match (H):** USCIS FDNS buys "Corroboration-Based Interviewing" training, which mirrors SCN-11 ("request corroboration") and EX-3. The US is moving from Reid to PEACE-style interviewing. Judges will likely know NIST AI RMF and OMB M-25-21. [X6]

### Internal assets to lift
- **TechnoMile (H):** `holdout_scoring` schema (sealed once, cutover-dated, hash-proven complete, append-only, zero default privileges, 32 pgTAP assertions) is the template for sealed evaluator packets and hidden families (SCN-9, SCN-12, BKO-9). Persona-slice plus cite-or-drop role-play; typed turns with Pydantic validation and one repair; Vertex-only boot check; default-deny span export; ticketed SSE; `scripts/audit_gcp_cost.py`; `make check` with `ratchet.toml` and anti-rigging linters. [I1]
- **TechnoMile has no real A2A transport (H).** It uses A2A-shaped types (AgentCard, messages, task states) over an in-process bus, chosen to avoid ~25 local ports and forbidden ADK orchestration. gokbase and cloudforce do not use A2A either. [I1, I5]
- **PangeaChat adapi-av2 (H):** single ADK LlmAgent on Vertex; Phoenix via OTLP + OpenInference `GoogleADKInstrumentor`; one parent span per turn across retries; Phoenix cost attributes renamed so Postgres stays the only cost source; redact-before-export span processor; golden dataset with deliberate fabrications; CI gates (ruff, format, mypy, 90% coverage + 90% diff coverage, two-pass bandit, fail-closed CodeQL, verified-only TruffleHog). Gaps: mypy non-strict; Phoenix is local-only in deployed environments. [I4]
- **gokbase and cloudforce (H):** production Gemini Live voice stacks with per-session cost meters and safety watchdogs; a Vertex-only multi-speaker TTS pipeline (cloudforce `audio_overview.py`); a complete companion-pet system (gokbase `kin`: 18 SVG/CSS characters, a status FSM, talk-sync through a CSS variable driven by audio amplitude); rubric hashing with lineage logs (recruiter-backend); PII redaction and MAD-z anomaly detectors. No live AI interviewer exists in recruiter-backend. [I5]

### Stack facts (2026-10-08)
- google-adk 2.11.0; a2a-sdk 1.2.2 (A2A spec v1.0, Linux Foundation project since 2026-08-17); arize-phoenix 20.19.0; openinference-instrumentation-google-adk 1.0.3 (H). [X4]
- Gemini on Vertex: gemini-3.1-pro-preview (Preview, global), 3.5 to 3.8 Flash, Flash-Lite variants, and the 2.5 family. No new GA text model since 2026-09-25 (H). [X3]
- Gemini 3.x cannot fully disable thinking (floor MINIMAL, thought signatures required across turns); only 2.5 models accept thinking_budget=0 (H). [X3]
- Safety filters default OFF on 2.5 and 3.x, so synthetic deception role-play is not blocked by default (H); the Prohibited Use Policy fiction carve-out is unconfirmed for a training simulator (L). [X3]
- Model Armor fails open on outage and skips inputs under 3 words (H): it cannot be the only injection defense. Adaptive attacks beat published classifiers; privilege separation is the real boundary (H). [X3, I3]
- Vertex Agent Engine defaults to min_instances 1 and its docs recommend >= 1 (H): conflicts with the scale-to-zero gate; Cloud Run remains the default. [X4, I2]
- Phoenix needs Supabase's session pooler (5432), not the transaction pooler (H); Phoenix on Cloud Run with request-based billing may drop spans (M, source-reasoned). [I2]

### Evaluation methodology
- Independent unit for FPR is the case, not the trial; 60 truthful hidden cases sits near the rule-of-three minimum for a 5% claim; a +/-2 pt band needs ~400-500 case clusters (H). Neither scipy nor statsmodels does clustered resampling; build a case-level bootstrap (H). [X2b]
- LMArena shows rank as an interval when CIs overlap (H). Commit-reveal hashes and hash-chained logs implement BKO-9 and SCN-10 on Supabase with no new infrastructure (H). Canary strings give a concrete leakage test (H). [X2b, X5]
- Same-family judge bias cannot be removed under Gemini-only; mitigate with deterministic ground truth wherever possible, tier separation, blinding, binary sub-checks, human calibration samples, and disclosure (H). Gwet's AC2 handles skewed base rates better than kappa (M). [X2b]
- Vertex Gen AI Evaluation Service supports custom pointwise rubric metrics and non-LLM custom metrics; adaptive rubrics cost 6 judge calls per instance, so offline only (H). [X2b]
- A balanced pairing scheme can still bias a leaderboard through joint-assignment correlation; run a permutation test (H, TechnoMile lesson). [I3]

## 2. Risks, ranked

1. **KPI-4 latency.** Gemini 3.x thinking floor plus published TTFT figures (Flash-Lite ~6 s on benchmark prompts) put 3 s p95 at risk. Unknown: latency of a short schema-bound call at MINIMAL thinking, and whether the 2.5 family (thinking off) survives to November. Needs a measured spike on a dedicated project.
2. **Voice vs Vertex-only.** Both internal Live stacks call `gemini-3.1-flash-live-preview` through an AI Studio key because Vertex Live rejected them ("the live model is Gemini-API-only", gokbase SPEC D2). This conflicts with D-001. Options: a Vertex-available Live model, an owner exception for the voice leg, or allowlisting. Batch 2 (X7) is verifying.
3. **KPI-2 detection.** Benchmarks show LLM deception outpacing detection (WOLF precision 71-73%). Our setting differs: facts are locked, fabrication is a fidelity failure, evidence is scripted, so detectability is a property of case design. Each deceptive variant must be provably solvable.
4. **KPI-3 fidelity.** Persona drift appears by ~8 rounds; per-turn re-injection cuts drift 35-38% but does not remove it. Mitigation: structured ledger state outside the transcript, sealed per-turn disclosure tags, a pre-send guard.
5. **Statistical power under a $100 cap.** CIs will be wide; present every gate with its interval.
6. **Same-family judging.** Disclose; rely on deterministic scoring where the design allows.
7. **Injection from subjects.** Classifiers fail open or get bypassed; the assistant must hold no private data and no state-changing channel.
8. **Phoenix for judges.** Reference repos run Phoenix locally only; a hosted option needs its own decision.
9. **Free-tier pausing** (Supabase) near demo day: unverified.
10. **Wrong GCP project.** The workstation's default gcloud project is `kbg-production` (gokbase production). Never run arena commands against it; a dedicated project is required.

## 3. Contradictions to resolve
- ADK `output_schema` + tools on 2.5 Flash: docs show it working; the 2026-09-25 baseline said 3.x only. Smoke test.
- Context-cache minimum for 3.x Flash/Pro: 4,096 vs 6,144 tokens across two Google pages. Live probe; the case packet exceeds both anyway.
- Agents-at-work UI: full transparency (AI Village) vs progressive disclosure (agent-UX consensus). Likely answer: summary first, detail on demand, plus a "theater" view for the live demo.
- Companion pets: keep the warmth, drop guilt and neglect mechanics; the pet reacts to evidence-based questioning quality.

## 4. Emerging architecture hypothesis (to test in synthesis)
- One Python service (FastAPI) on Cloud Run, scale to zero: scenario engine, turn orchestrator, agent port (google-genai on Vertex, typed outputs), SSE to the UI. The scorer is a separate module that alone holds the database role able to read sealed data. The tournament runner is a Cloud Run Job built from the same image.
- Candidates run in-process behind A2A-shaped manifests (versioned and hashed, AST-5). A real A2A v1.0 endpoint adapter lets external assistants enter the arena under the same gates.
- Supabase: app schema under RLS; sealed schema (evaluator packets, hidden families, labels) not exposed to PostgREST and readable only by the scorer role; hash-chained trial event log; commit-reveal findings.
- Voice gateway lifted from gokbase, endpoint choice pending X7.
- Next.js frontend with the gokbase pet system, TechnoMile's agents-at-work motion system, and the owner's DESIGN.md.
- Observability: OpenInference into Phoenix, one span per turn, default-deny redaction, Postgres as the cost source of truth; hosted Phoenix option pending X10.
- Gates: TechnoMile `make check`, `ratchet.toml`, `audit_gcp_cost.py`; Pangea-style CI workflows with strict mypy.

## 5. Batch 2 (dispatched, run `wf_70bb0865-2f7`)

| Route | Closes |
| --- | --- |
| X7 Gemini Live + TTS on Vertex; 2.5 retirement dates | Risk 2; part of risk 1 |
| X8 Latency + cost engineering under $100; benchmark plan | Risks 1 and 5 |
| X9 Scenario generation, AI-suspect RCT, annotation guidelines, rubric anchors | Risks 3 and 4; EVL-7, EVL-8 |
| X10 Judge hosting: Phoenix, Supabase, Cloud Run, spend guards | Risks 8 and 9; D-008 |
| X11 A2A v1.0 in practice for BYO agents | Architecture choice for candidates |
| I6 gokbase live voice lift map | D-006 lift; Vertex-switch impact |
| I7 UI lift map: pets, avatars, agents at work | UI build plan pending DESIGN.md |
