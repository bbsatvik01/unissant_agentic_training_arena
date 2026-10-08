# S7: Demo and Judging Package

Part of the build-ready spec for the Investigative AI Training Arena (GMU Challenge X, sponsor Unissant). Governed by `docs/research/synthesis/02-direction.md` (v10) and `docs/challenge/REQUIREMENTS.md`. Today is 2026-10-08; the demo is 2026-11-02. Every requirement ID cited below is from REQUIREMENTS.md; every design choice follows direction v10 and does not re-litigate it. Owner decisions D-001 to D-009 are hard constraints (D-007 superseded by D-009).

This document assumes the schedule in direction v10 section 3.2 holds: the sealed run and reveal (Oct 22-30) complete before the Oct 31-Nov 2 hardening and rehearsal window. That ordering matters for section 2: by demo day, a real revealed leaderboard exists, bound to a sealed inclusion-manifest hash — the leaderboard segment of the demo is not a projection, it is the actual sealed result, unless the schedule slips (see Open Questions, item 1).

---

## 1. Requirement coverage matrix

Every ID from REQUIREMENTS.md, mapped to the feature that satisfies it, the automated test or metric that proves it, and the moment in the judging package (demo, video, deck, trust center, or Q&A) where it is shown. "Hidden" means the feature is not directly visible because the data it touches is sealed by design (SCN-5, SCN-9) — these are shown as architecture claims (trust center, deck slide 4) rather than literal screen content, and are called out in Q&A if asked.

### 1.1 Problem (PRB)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| PRB-1 | Unlimited replayable practice sessions; coaching targets incomplete/conflicting answers | Session-creation test (no session-count ceiling); coach card's flag/follow-up fields exercise incomplete and contradiction categories (AST-8 fixtures) | Live practice interview segment (demo min 0:30-2:30) |
| PRB-2 | Generated case families (scenario engine, S1) feed a controlled comparison harness (BKO) | Generator validators: schema, consistency, AR-Bench-style solvability, role-leak-near-chance, diversity (section 6.4) | Deck slide 6 (scenario engine); Q&A Q14 |
| PRB-3 | False-positive gate precedes recall ranking (EVL-10 eligibility precondition) | `ranking()` unit tests: a candidate failing `fpr_point <= 0.05` is never ranked regardless of recall | Leaderboard segment: gate badges shown before rank (demo min 3:15-4:30) |
| PRB-4 | Style independent of role (SCN-3); flags must cite content, not style; style-stratified FPR audit; demeanor-based flags scored unsupported | Permutation test for style/role independence; fairness-audit script (FPR and flag rate by style, with intervals); demeanor negative-control fixtures prove the audit catches them | Trust center fairness panel (demo min 4:30-5:15); deck slide 6 |

### 1.2 Challenge (CH)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| CH-1 | The whole platform: arena with coaching assistants and simulated subjects | End-to-end integration test (one trial, text, dev case) | Entire live demo |
| CH-2 | Coach card's follow-up field, grounded in Strategic Use of Evidence and the Evidence Framing Matrix | Questioning-quality 0-4 proxy, blinded to candidate and outcome | Coach card moment (demo min 0:45-1:30) |
| CH-3 | Evasion flags (AST-8) and the finding field (deceptive/truthful/insufficient) | Evasion-event precision/recall metric | Insufficient-evidence finding moment (demo min 1:30-2:15) |
| CH-4 | Bake-off: matched trials, replay and interactive tracks, frozen candidates | BKO metric contracts (section 7.2); manifest-freeze test | Leaderboard segment |
| CH-G | Overall goal: repeatable AI agent competitions improving questioning and evidence-backed findings | Composite of EVL-2, EVL-6, KPI-1 pipelines | Close/recap (demo min 5:15-6:00); deck slide 1 and 12 |

### 1.3 Solution components (SOL)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| SOL-1 | Text transcript is the scored artifact; voice is presentation-only and stays out of scored results until its own test gate passes (section 9) | Test asserting voice sessions never enter `arena.scores` until the delayed-transcription/buffered-audio/reconnect/mid-word-interruption suite passes | Transcript panel visible throughout the interview segment |
| SOL-2 | Coach card: review, flag, suggest follow-up | AST-7 citation-validity test | Coach card moment |
| SOL-3 | Subject runtime plays a role from a private packet | Subject fidelity metric (KPI-3); drift test (packet re-injection) | Subject's response in the interview segment |
| SOL-4 | Scenario engine locks facts; `release_evidence()` releases on script; sealed schema hides labels | Isolation-gate pgTAP suite; predicate test (release only on scheduled turn / after minimum turn) | Evidence release moment (demo min 1:00-1:20) |
| SOL-5 | Referee scorer, independent of coach and subject, three-valued finding vs. hidden facts | 2x3 count-matrix computation test with fixtures | Debrief/leaderboard reveal (real, since demo follows reveal) |
| SOL-6 | Practice (live coaching) vs. Assessment (coaching withheld until debrief) modes, same pipeline | Assessment-mode test: no coaching event reaches the client before the session ends | Mode toggle shown once during framing (demo min 0:00-0:30) |

### 1.4 Investigative assistant contract (AST)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| AST-1 | Per-turn answer-vs-question assessment in the coach card | Answer-category enum validator | Coach card moment |
| AST-2 | Flags cite transcript evidence | Citation existence check (code) + claim-support check (semantic) | Coach card: flag appears with a turn citation |
| AST-3 | Neutral follow-up + running finding with confidence | Neutrality-lexicon check (harness relay rule); ICD 203 confidence-wording validator | Coach card moment; finding moment |
| AST-4 | Goal: supported findings, few false accusations | FPR metric (eligibility gate) | Leaderboard gate badge |
| AST-5 | Candidate = model + prompt + tools + coaching policy, versioned and hashed | Manifest-immutability test (no field changes after `frozen_at`) | Trust center candidate registry; deck slide 7 |
| AST-6 | Coach grades the officer's latest question (neutrality, relevance), not only the answer | Question-type enum validator (open/probing/closed/leading/suggestive/compound/forced-choice/opinion) | Coach card flags a leading/suggestive investigator question, if one occurs live; scripted into the fallback recording otherwise |
| AST-7 | Flag names an exact turn and the missing fact or conflicting statement | Schema-enforced citation; fixture with a fabricated quote must fail | Coach card: "Turn 4" citation shown on screen |
| AST-8 | Enum distinguishes non-responsive, contradiction, explicit uncertainty, possible evasion | Enum validator; evasion-event precision/recall | Coach card category label |
| AST-9 | Useful coaching and correct role identification under the FP constraint | `EVL-6` combined ranking function | Leaderboard segment |
| AST-10 | No credit for flag volume or confident accusation alone | Unsupported-flag-rate metric; calibration fixtures | Trust center: "credit is not given for raw flag count" callout; Q&A Q20-adjacent framing |

### 1.5 Simulated subject contract (SUB)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| SUB-1 | Private packet: profile and assigned role | Capability-matrix test: only `arena_subject` (runtime) and `arena_referee` (labeling) read it | Hidden by design; architecture slide (deck slide 4) |
| SUB-2 | Truthful roles answer from known facts, state uncertainty | Fidelity sub-metric: "appropriate uncertainty" | Subject says "I don't recall" in the live interview, if the case calls for it |
| SUB-3 | Deceptive roles conceal the assigned violation within scenario rules | Guard test: contradicting a canonical fact fails fidelity | Insufficient-evidence finding moment shows clean, in-rules evasion |
| SUB-4 | Goal: profile fidelity plus assigned objective | Subject fidelity metric (all-turn denominator) | Trust center subject metric card |
| SUB-5 | Each subject candidate plays both truthful and deceptive roles across the case set | BKO-5 manifest check: both profile types used per candidate | Deck slide 7 (lineup) |
| SUB-6 | Permitted evasive behaviors (omission, deflection); obedience to disclosure gates | Evidence Framing Matrix gating test (deep-secret leakage reduced to 3-8%, cited arXiv 2609.00982) | Hidden by design; Q&A if asked (fairness/subject-fidelity cluster) |
| SUB-7 | Subject must not rewrite the event or attack the platform | Persistent-injection fixture (attack at turn 2; later turns, finding, judges checked) | Not demonstrated live (would be an actual attack); trust center callout that the fixture suite exists; Q&A Q18 |
| SUB-8 | Score truthful/deceptive separately; invalid profile behavior is a fidelity failure, not successful evasion | `adjudicate_validity()` separates invalid sessions from genuine evasion | Debrief/leaderboard shows separate role metrics and an invalid-session rate |

### 1.6 Scenario design (SCN)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| SCN-1 | Role, timeline, knowledge, objective assigned per packet | Schema validator | Case packet panel shown at interview start |
| SCN-2 | Deceptive and truthful cases mixed at matched difficulty | Generator diversity/difficulty validator | Deck slide 6 (two matched variants shown side by side) |
| SCN-3 | Communication style independent of assigned role | Permutation test (style vs. role independence) | Trust center fairness chart |
| SCN-4 | Facts locked per trial; evidence released on script | pgTAP predicate test (scheduled-turn / minimum-turn gating) | Evidence release moment |
| SCN-5 | Role labels and scoring keys hidden from investigators and assistants | Capability-matrix route tests; direct calls to IAM-private services must fail | Architecture slide; isolation-gate pass badge in trust center |
| SCN-6 | Dynamic behavior stays consistent with ground truth | Fidelity guard tests | Not directly visible; implied by a coherent live interview |
| SCN-7 | Public packet: case ID, objective, known timeline, initial documents, interview context | Public-projection schema test | Case packet panel |
| SCN-8 | Private subject packet: role, actions, knowledge, disclosure limits, uncertainty limits, objective, permitted behaviors | Schema + capability test (readers restricted to `arena_subject`, `arena_referee`) | Hidden by design; architecture slide |
| SCN-9 | Evaluator-only packet: canonical facts, role, contradictions, release predicates, resolution criteria, rubric | Isolation gate: not exposed to PostgREST; reachable only through section 4.2 functions | Architecture slide; isolation-gate badge |
| SCN-10 | Dynamic elements (release, clarification, difficulty change, context change) versioned and timestamped; underlying event never changes to fit an answer | Append-only ledger trigger test; tamper fixture | Trust center: hash-chained ledger visual |
| SCN-11 | Matched truthful/deceptive variants; truthful uncertainty and misleading-but-innocent circumstances | Solvability gate; diversity check | Insufficient-evidence finding moment uses a misleading-but-innocent circumstance by design |
| SCN-12 | Disjoint dev/hidden families; hidden split sealed by hash; no leakage into prompts, tuning, or debrief before reveal | Leakage audit: hidden-family content absent from dev artifacts and candidate prompts | Trust center: "sealed hidden split" badge with the hash shown |

### 1.7 Bake-off protocol (BKO)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| BKO-1 | Matched cases, cross-paired under equal budgets (turn cap, token limit, context limit, tool set) | Manifest equal-budget check | Deck slide 7; methodology note on the leaderboard |
| BKO-2 | Two tracks: replay first, then interactive, in that order | Replay-corpus seal test (sealed before any interactive block starts) | Mentioned in the leaderboard segment narration |
| BKO-3 | Blinded scoring against case facts and trainer ratings | Judge-calibration kappa/AC2 threshold test | Trust center: judge-calibration card |
| BKO-4 | 3 assistant x 3 subject MVP lineup | Candidate-count check in the frozen manifest | Deck slide 7 (lineup) |
| BKO-5 | Frozen candidates, recorded model/prompt versions, consistent tools and budgets | Manifest-freeze test | Trust center manifest hash |
| BKO-6 | Replay track: identical frozen transcripts and evidence to every assistant | Replay-corpus hash-verification test | Mentioned in leaderboard narration |
| BKO-7 | Fixed interviewer harness, common opening question, relays top follow-up under a shared neutrality policy, stops at 12 exchanges or a committed finding | Neutrality-lexicon test; 12-exchange stop test | Live interview segment (exchange counter visible) |
| BKO-8 | Workload scale depends on the approved spend | `cost_model.py simulate_d009` (20 hidden cases, extendable to 26) | Trust center budget table; Q&A Q6-Q7 |
| BKO-9 | Commit findings before reveal; separate leaderboards; disclose invalid runs, cost, latency, unresolved findings | `finalize_trial()` / `reveal()` commitment-verification test; tamper fixture | "Commit, then reveal" demo beat inside the leaderboard segment |
| BKO-10 | Case-level clustering in intervals; role prevalence disclosed; no hidden-tournament tuning | Family-cluster bootstrap test (`stats_contracts.py`) | Leaderboard: intervals shown, not point estimates alone |

### 1.8 Example output and ground rule (EX)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| EX-1 | Canonical exchange: "Why did you enter?" / "It was a busy shift." | Fixture test using the exact exchange | Opening line of the live interview segment (demo min 0:30) |
| EX-2 | Flag naming the unanswered purpose of entry; neutral follow-up "What task required entry?" | Coach-card fixture matching the exact example | Coach card moment, replicating this example live |
| EX-3 | "Insufficient evidence" is a first-class finding that names the corroboration to seek | Insufficient-evidence fixture test | Insufficient-evidence finding moment (demo min 2:00-2:15) |
| EX-4 | Ground rule: cases are synthetic; evasive wording alone is not proof; a simulated score is not a finding about a real person | Presence test: the statement renders on onboarding, the interview room, debriefs, leaderboards, and every methodology page | Shown on screen throughout; called out explicitly once in the trust-center segment and once in the deck (slide 10) |

### 1.9 Evaluation (EVL)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| EVL-1 | Three separate scorecards: learning, detection, subject realism | Scorer-output schema test (three distinct scorecards) | Debrief screen shows all three |
| EVL-2 | Investigator score: question quality, evidence coverage, improvement on unseen cases | KPI-1 participant pipeline test | Debrief rubric card |
| EVL-3 | Assistant score: evasion precision/recall, role recall, FPR | Metric-contract tests (section 7.2) | Leaderboard metric columns |
| EVL-4 | Subject score: consistency with assigned facts, success within scenario rules | Fidelity + success metric tests | Subject leaderboard |
| EVL-5 | All trials: unsupported flags, unresolved findings, latency, cost | Unsupported-flag fixture test; KPI-4 session-cluster bootstrap; cost-ledger read | Trust center metrics panel; Phoenix p95 latency panel |
| EVL-6 | Ranking: pass FP and isolation gates, then compare recall and questioning quality | `ranking()` precondition unit tests | Leaderboard: gate badges, then rank |
| EVL-7 | Investigator rubric: five 0-4 dimensions, trainer-calibrated | Kappa (>=0.60) / Gwet's AC2 (>=0.70) threshold test | Debrief: five rubric cards |
| EVL-8 | Event precision/recall definitions; evasion distinguished from uncertainty, legitimate non-disclosure, poorly framed questions | Evasion-event metric fixture covering all four categories | Debrief: evasion-event highlight |
| EVL-9 | Role score: deceptive-role recall, FPR, PPV, 2x3 matrix, unresolved rates by role | 2x3-matrix computation test with fixtures | Leaderboard 2x3 matrix view |
| EVL-10 | Eligibility (FPR <=5% + isolation/leakage pass); rank by recall then quality; publish precision, uncertainty, unresolved, cost, latency; explicit "not certification" disclaimer | `ranking()` test; disclaimer-presence test | Leaderboard page; disclaimer called out verbally once; Q&A Q12 |
| EVL-11 | Subject fidelity = compliant/all turns, including invalid sessions in the denominator; misleading-clearance/unresolved split; truthful credit for consistency and appropriate uncertainty | Fidelity-metric fixture tests (all-turn denominator) | Subject scorecard detail |
| EVL-12 | NIST AI RMF MEASURE citation; explicit non-validation disclaimer | Presence test: NIST anchor and disclaimer render on every methodology page | Trust center methodology page; Q&A Q11-Q12 |

### 1.10 Impact targets (KPI)

| ID | Feature | Automated test / metric | Demo moment |
| --- | --- | --- | --- |
| KPI-1 | Investigator questioning score improves >=20% over own baseline | Participant-bootstrap test on volunteer pipeline (OWNER DECISION PENDING: whether real volunteer data exists by demo day — section 3) | Debrief: "+X% over your own baseline" card if real data exists; if not, the same card renders from the dev-pilot's own measured scores, labeled "dev-pilot measurement, not a volunteer result" |
| KPI-2 | >=80% deceptive-role recall at <=5% FPR | EVL-9/EVL-10 metrics on the sealed, revealed result | Leaderboard headline numbers |
| KPI-3 | >=95% subject fidelity | Fidelity bootstrap test | Subject leaderboard fidelity badge |
| KPI-4 | Coaching within 3 s for 95% of turns | Session-cluster bootstrap of p95 (section 7.2); Phoenix latency panel | Live latency readout during the coach-card moment; Phoenix panel in the trust center |
| KPI-5 | Fair ranking: FP and isolation gates before detection/quality comparison | `EVL-6`/`EVL-10` ranking function | Leaderboard: gate-then-rank visual |

---

## 2. Six-minute live demo script

Cold open on the hosted app (same-origin static web served by `arena-api` behind IAP, D-006/direction section 4), one allowlisted presenter account, screen-shared. Audio handled by a microphone the presenter controls (voice is development-cases-only per direction section 9 and is never the scored artifact — SOL-1); if the voice probe or the Oct 15/18 decision points landed on push-to-talk or text-only, this script runs identically in text, since the scored path never depends on voice.

| Time | Beat | What is shown | Requirement IDs on screen |
| --- | --- | --- | --- |
| 0:00-0:30 | Frame | One line on the problem (PRB-1..4) and the thesis: "we implement the sponsor's own protocol literally, with real numbers." Toggle Practice/Assessment mode once to show both exist. | PRB-1..4, SOL-6, CH-1 |
| 0:30-1:00 | Open the interview | Start a fresh practice session on the slide-8 case family (a development variant, never a hidden one). Case packet panel shows objective, timeline, initial documents (SCN-7). Presenter asks the canonical opening question; subject answers "It was a busy shift." (EX-1). | SCN-1, SCN-7, EX-1 |
| 1:00-1:20 | Evidence release | Presenter requests a listed record; `release_evidence()` authorizes it live, a ledger event appears, and the newly available document shows in the evidence panel. | SCN-4, SOL-4, BKO-7 |
| 1:20-1:45 | Coach card | The complete card renders: question-type assessment of the presenter's own last question (AST-6), answer category (non-responsive), a flag naming the unanswered purpose of entry with a turn citation (EX-2, AST-7), a neutral follow-up ("What task required entry?"), and a running finding with ICD 203 confidence wording. | AST-1..8, EX-2 |
| 1:45-2:15 | Second exchange toward insufficient evidence | Presenter asks the suggested follow-up; subject gives a consistent but unresolved answer. Coach card updates; finding becomes "insufficient evidence," naming the corroboration to seek (verify the work order and timeline) (EX-3). | EX-3, AST-3, AST-9 |
| 2:15-2:45 | Debrief | Session ends; debrief screen shows the five 0-4 rubric cards (EVL-7), the three scorecards (EVL-1), evidence coverage, and the investigator's improvement framing (KPI-1, with the OWNER DECISION PENDING fallback from section 1.10 if no volunteer data exists yet). | EVL-1, EVL-2, EVL-7, KPI-1 |
| 2:45-3:15 | Switch to the arena | Narration moves from one session to the tournament view: the frozen 3x3 lineup (BKO-4), the manifest hashes (AST-5, BKO-5), and a one-line note that the full bake-off already ran and was revealed before today (BKO-9). | BKO-4, BKO-5, AST-5 |
| 3:15-4:00 | Leaderboard: gates | Leaderboard shows each candidate's FPR and isolation-gate result as a pass/fail badge before any rank is shown (EVL-6, EVL-10, KPI-5, PRB-3). A candidate that would fail the gate is shown explicitly excluded from ranking, not hidden. | EVL-6, EVL-10, PRB-3, KPI-5 |
| 4:00-4:30 | Leaderboard: intervals and the 2x3 matrix | Eligible candidates ranked by deceptive-role recall then questioning quality, with bootstrap rank intervals (BKO-10) and the 2x3 count matrix with unresolved rates by role (EVL-9). Cost and latency columns are visible (EVL-5, KPI-4). | BKO-10, EVL-9, EVL-5, KPI-4, KPI-2 |
| 4:30-5:00 | Trust center: isolation and fairness | Capability matrix (who can read/write what), the sealed hidden-split hash (SCN-12), the hash-chained ledger (SCN-10), and the style-stratified fairness audit chart (PRB-4, SCN-3). | SCN-5, SCN-9, SCN-12, PRB-4 |
| 5:00-5:20 | Trust center: budget and NIST | Budget table (D-009, 20/26-case plan, actual spend to date) and the NIST AI RMF MEASURE mapping with the non-validation disclaimer (EVL-12). EX-4 ground rule shown explicitly on screen. | EVL-12, EX-4, BKO-8 |
| 5:20-6:00 | Close | Recap the nine-pillar thesis in one breath, point to the hosted link for self-serve judging, and open the floor. | CH-G |

### 2.1 Fallback path (recorded run)

Trigger: any of Vertex, Supabase, or Phoenix is unreachable, or the IAP-fronted hosted link fails health checks, in the 10 minutes before the demo slot, or mid-demo if a call does not return within 5 seconds.

- A pre-recorded run of the identical script (sections 2's beats, same case, same timings) is kept as a local video file, not a live stream, so it has no dependency on the day's network or quota state. It is recorded during rehearsal week (Oct 31-Nov 1) against the same hosted instance, immediately after a green pre-push quality bar.
- The presenter narrates live over the recording exactly as they would a live run; nothing in the script's wording changes, only the word "watch" replaces "I'll do this live."
- If the failure happens mid-demo, the presenter says once, plainly, "switching to a recorded run because [service] is unavailable" and resumes at the next beat boundary — no silent cut, and no claim that the recording is live.
- The recording is dated and the spend/metrics it shows are labeled with that date if they differ from the latest revealed leaderboard.

### 2.2 Hosted-link judge walkthrough

A one-page walkthrough handed to judges (and linked from the deck's last slide) for self-serve use after the live demo, covering: (1) sign in with an allowlisted Google account behind IAP; (2) start a practice session on any development case; (3) play one exchange, request one evidence record, read the coach card; (4) end the session and read the debrief; (5) open the arena's leaderboard and trust center; (6) the EX-4 ground-rule statement, repeated here in writing. Per-user rate limits and the budget kill switch (D-009, direction section 8.3) mean a judge cannot exhaust the project's spend ceiling; the walkthrough states this plainly so a judge who hits a rate limit understands why, rather than reading it as a bug.

---

## 3. Video plan (3-4 minutes)

Recorded screen capture with voiceover, no live audience dependency; this is the file judges watch asynchronously, so it must stand alone. Same case, same visual beats as the live script, compressed.

| Time | Beat | Notes |
| --- | --- | --- |
| 0:00-0:20 | Hook | One sentence on the problem (PRB-1..4) and the thesis line from section 2. Title card: "Investigative AI Training Arena — GMU Challenge X — Unissant." |
| 0:20-1:00 | Practice interview | EX-1 opening exchange, evidence release, coach card with citation (compressed version of demo 0:30-1:45). |
| 1:00-1:40 | Insufficient-evidence finding and debrief | EX-3 finding, then the debrief's five rubric cards and KPI-1 framing. |
| 1:40-2:30 | Leaderboard | Gates first, then rank with intervals, 2x3 matrix, cost/latency — same ordering as the live demo so the two never contradict each other. |
| 2:30-3:10 | Trust center | Isolation, fairness audit, budget table, NIST mapping, EX-4 restated on screen. |
| 3:10-3:45 | Close | Engineering-quality callout (CI, tests, scale-to-zero), hosted link, and the ask. |

Production requirements: 1080p minimum, on-screen captions for every disclaimer line (EX-4, EVL-10's "not certification," EVL-12's "not validated by NIST") since a muted autoplay viewer must still read them; narration script reviewed against the editorial-voice rule (no marketing words); final render checked against the same pre-push quality bar as the hosted app before submission, since a wrong number in a video cannot be hot-fixed after submission the way a hosted page can.

---

## 4. Deck outline (12 slides)

One message and one piece of evidence per slide; no slide repeats another slide's evidence.

| # | Slide | Message | Evidence |
| --- | --- | --- | --- |
| 1 | Title | Investigative AI Training Arena: multi-agent interview coaching and evaluation, built for GMU Challenge X / Unissant | Sponsor name, challenge name, one-line thesis |
| 2 | Problem | Practice is static and low-variety; detection must not cost truthful people false accusations | PRB-1..4 quoted directly from the sponsor's own deck |
| 3 | Approach | We implement the sponsor's protocol literally: coach, subject, scorer, with real numbers at every step | SOL-1..6 diagram |
| 4 | Architecture and isolation | Four credentials, narrow privileged functions, nothing public can read hidden data | Capability-matrix diagram; SCN-5/9 citation; isolation-gate pass badge |
| 5 | Coaching design | The coach card is grounded in interviewing science, not a generic chatbot | AST-1..10 card schema; Strategic Use of Evidence and Mendez Principles citation |
| 6 | Scenario engine and fairness | Matched case families; style varies independently of role; audited, not assumed | SCN-2/3/11; fairness-audit chart with intervals |
| 7 | Bake-off protocol | Honest statistics: a false-positive gate before any ranking, clustered intervals, disclosed precision | BKO table; zero-event bound numbers; 2x3 matrix |
| 8 | Results | The sealed, revealed numbers: recall, FPR, fidelity, latency, cost per candidate | Leaderboard screenshot bound to its manifest hash |
| 9 | Training experience | Investigators measurably improve on unseen cases | Debrief screenshot; five-dimension rubric; KPI-1 number (real or dev-pilot-labeled per section 1.10) |
| 10 | Trust center and grounding | Mapped to NIST AI RMF MEASURE, with an explicit non-validation disclaimer; synthetic-data ground rule stated everywhere | Trust-center screenshot; EX-4 text; EVL-12 citation |
| 11 | Engineering quality and scale-up | Production-grade gates today; the same architecture scales to the sponsor's full workload with a larger budget, no redesign | CI/test-coverage badges; `cost_model.py` projection to 120 cases x 2 repeats ($243-384) |
| 12 | Close | Recap the nine-pillar thesis; invite judges to the hosted link; state the ask | Hosted-link QR code; repo link |

---

## 5. Q&A preparation: 20 hardest questions

Grounded in the docs read for this spec; each answer is a fact already stated in direction v10 or REQUIREMENTS.md, not an improvisation.

| # | Category | Question | Answer |
| --- | --- | --- | --- |
| 1 | Isolation | How do you know the assistant can't see the hidden answer key? | `arena-api` only ever holds the `arena_public` credential; `sealed.evaluator_packets` is never exposed to PostgREST and is reachable only through named SECURITY DEFINER functions granted to exactly one role. pgTAP tests and direct-call tests (hitting the IAM-private services with the wrong credential) prove this fails, not just that it is undocumented. |
| 2 | Isolation | What stops someone from bypassing the UI and hitting the database directly? | `service_role` is never used at runtime; privileged writes are single SECURITY DEFINER functions with `EXECUTE` revoked from `PUBLIC`; the capability-matrix test fixture includes direct calls to `arena-subject` and `arena-referee`, which must fail for any caller without the IAM credential. |
| 3 | Fairness, accents | Could a non-native accent get an investigator flagged, or get a subject's truthful answer read as deceptive? | The coach never receives acoustic features, only the transcript; a flag without a valid turn citation is scored as unsupported by construction. Style (which includes manner of speaking) is assigned independently of role and audited with a style-stratified FPR; demeanor-driven flags are a tested negative control, not a passing behavior. |
| 4 | Fairness, accents | Could voice transcription errors introduce an accent-driven artifact even though the coach sees only text? | Yes, that is a real channel, which is why voice stays out of scored training results until matched-content fixtures (same content, different voices) pass, and why voice is development-cases-only in this build regardless. |
| 5 | Statistics, small sample | 20 hidden cases is tiny. How can you trust a 5% FPR number from that? | We do not claim precision we do not have. The FPR gate is a point-estimate decision rule the sponsor itself specified, not a confidence claim; we additionally publish the exact zero-event one-sided bound (25.9% at 10 truthful families) so judges see the real precision, plus family-cluster bootstrap intervals and rank intervals. The limitation is disclosed, not hidden. |
| 6 | Statistics, small sample | Why not just run more cases to tighten that bound? | Linear cost scaling against a hard $75 ceiling (D-009). The plan extends from 20 to 26 hidden cases only if the dev pilot's measured costs track the modeled expected column; getting to a 5% bound would need 59 equal-size families, far past this budget. |
| 7 | Budget honesty | What happens if costs run over budget live during the demo? | Every model and voice call reserves its own worst-case cost in a transaction before running; a kill switch disables public ingress and model calls; GCP billing alerts fire at $25/$50/$65 with an automated billing-disable at $70 as the backstop for the costs that cannot be hard-capped in-app (Cloud Run, storage, logs). |
| 8 | Budget honesty | Are you hiding true infra cost by excluding Cloud Run and storage from the model-spend cap? | No. D-009 is a single $75 ceiling covering everything billed on GCP, model and non-model together. Non-model cost gets an explicit $15 allowance (itemized: $2.88 expected, $9.67 high) precisely because GCP has no project-wide spend cap and usage metrics lag — that gap is disclosed as a known limitation with alerts and a kill switch as the backstop, not papered over. |
| 9 | Same-family judging | Isn't it circular that the deceiving subject and the evasion-labeling judge share a model checkpoint? | It is disclosed, not hidden: subject S1 and the referee's evasion-label call both run on `gemini-3.1-flash-lite` at LOW thinking. The subject's own tag proposal is never ground truth — the referee independently re-labels every turn from the canonical facts and the private packet in a separate blinded call, and a blinded human sample calibrates that judge against predeclared thresholds. |
| 10 | Same-family judging | How do you know your LLM judge is any good at all? | A frozen judge-calibration protocol: anchors authored on dev data, 2-3 blinded human raters score about 30 dev transcripts, and the judge must hit quadratic-weighted kappa >=0.60 and Gwet's AC2 >=0.70 against human consensus before it is trusted; short of that, results are reported as provisional, not suppressed. |
| 11 | NIST AI RMF | Which NIST AI RMF functions does this actually satisfy? | MEASURE 1.3 (documented test methods — our metric contracts), 2.1/2.3 (performance metrics, reported disaggregated by role and style), 2.5 (resilience — injection fixtures), 2.7 (mitigations verified — guard and quarantine tests), 2.11 (fairness — the style-stratified audit), plus the NIST AI 600-1 generative-AI profile. |
| 12 | NIST AI RMF | Are you claiming NIST certification? | No. Every methodology page states explicitly, per EVL-12, that NIST has not validated these thresholds. The mapping is a methodology anchor, not a compliance claim, and the leaderboard itself says a tournament rank is not certification for real investigations. |
| 13 | Why Gemini only | Why not benchmark against GPT or Claude too — wouldn't that be a fairer bake-off? | The Gemini-only constraint (D-001) is an owner decision locked before research started; candidate diversity instead comes from model tier, prompt, tool configuration, and coaching policy (AST-5), which still answers the sponsor's "compare assistants fairly" requirement (CH-4). An A2A exhibition track for external endpoints is a drafted, owner-gated extension if that constraint changes later. |
| 14 | Why Gemini only | Isn't 3 assistants by 3 subjects too small to generalize from? | It matches the sponsor's own proposed MVP size (BKO-4). The replay track specifically isolates evaluation quality from interview-path variance, and every statistic is reported with its interval rather than oversold as a general claim. |
| 15 | Scale-up path | What would it take to run the sponsor's full 120-case x 2-repeat workload? | `cost_model.py` prices that workload at $243-384 for the bake-off alone at this lineup's rates. The architecture does not change — every call already reserves its own cost — only the budget ceiling and the frozen roster size would need to grow. |
| 16 | Scale-up path | What's the single biggest technical risk right now? | Coaching latency (KPI-4) is unmeasured as of today. Gemini 2.5 retires on Vertex Oct 16-20, so only 3.x models remain, and none of them fully disables thinking. Mitigation is a day-1 latency benchmark, compact prompts, a Priority tier, and a disclosed definition of exactly what window is measured. |
| 17 | Operational | What if the live voice demo fails? | Voice is development-cases-only by design and is never the scored artifact (text is, per SOL-1), so a voice failure never touches the actual bake-off result; a recorded fallback segment (section 2.1) covers the live demo itself. |
| 18 | Security | How do you stop a deceptive subject's own text from attacking your system — prompt injection? | An untrusted-data boundary (the gokbase `injection_defense` pattern) plus a deterministic guard runs before any write; a detected attack quarantines the trial atomically and the trial never enters rankings. Persistent-injection fixtures attack at turn 2 specifically to check later turns, the finding, and the judges are unaffected. |
| 19 | Integrity | How do you stop someone from re-running a trial to fish for a better outcome? | The trial roster is frozen before the run (BKO-10); hidden families are sealed by hash before candidates freeze, with no retrieval index or few-shot access to hidden content (SCN-12); every privileged write carries a work-item ID, so a retry returns the original result instead of advancing state. |
| 20 | Integrity | If a later review finds a subject session was invalid, can you quietly fix the leaderboard? | No. Validity adjudication is append-only and never edits a transcript, finding, or commitment. A later adjudication produces a new, separately labeled corrected leaderboard bound to a new inclusion-manifest hash; the original result is never silently changed. |

---

## 6. Vocabulary guidance

Grounded in `X6-sponsor-challengex-intel.md`: Unissant serves ICE, CBP, USCIS, DHS, TSA, US Marshals, DoS, DoD, NIH, VA, CMS, HHS, and the sponsor's founder sits on GMU's AI-in-Gov Council, so judges are likely fluent in federal investigative-interviewing doctrine and in NIST AI RMF language. The deck's own vocabulary ("neutral follow-up," "insufficient evidence," "verify the work order and timeline," "learn to request corroboration") already tracks that doctrine; use it rather than inventing new terms.

### 6.1 Use these terms

| Term | Where it comes from | Use it for |
| --- | --- | --- |
| Neutral follow-up, non-accusatory | PEACE model (UK) and its US adoption; REQUIREMENTS.md EX-2 | Describing the coach's suggested next question |
| Corroboration, corroboration-based interviewing | USCIS FDNS's "Corroboration-Based Interviewing (CBI)" training program (X6, Q3) | Describing the "insufficient evidence — verify before concluding" finding (EX-3, SCN-11) |
| Evidence-based follow-up, testing alternative explanations | EVL-7 rubric dimensions; Mendez Principles | Describing the investigator rubric and the coach's grounding |
| Disclosed interval, point estimate, provisional | `stats_contracts.py`, direction v10 section 7.2 | Any statistic with a sample-size limitation — never state a number without its interval or its caveat |
| Mapped to NIST AI RMF MEASURE; NIST has not validated these thresholds | EVL-12 | Any reference to NIST compliance |
| Synthetic, simulated role, not a finding about a real person | EX-4 | Every reference to the subject's deceptive/truthful classification |

### 6.2 Avoid these phrases

| Avoid | Why | Use instead |
| --- | --- | --- |
| "Lie detector," "catch the liar," "guilty," "suspect" | Accusatory framing from the discredited Reid technique, which PEACE and the Mendez Principles explicitly moved away from (X6, Q3); also risks implying a real-world finding, which EX-4 forbids | "Deceptive-role classification in a synthetic scenario," "the subject assigned the deceptive role" |
| "Interrogation room" (in judge-facing copy) | An internal working name; carries an accusatory connotation at odds with PEACE/non-accusatory framing even though it is accurate to the coding project | "Interview room" in anything a judge reads; "interrogation room" may stay as an internal code name only |
| "NIST-certified," "NIST-compliant," "validated by NIST" | False; EVL-12 and the leaderboard both state NIST has not validated these thresholds | "Mapped to NIST AI RMF MEASURE functions" |
| "Proven," "100% accurate," "guaranteed" | Oversells a 20-hidden-case result with disclosed, wide intervals | "Measured," "point estimate of X, interval Y-Z" |
| "AI-powered," "next-gen," "seamless," "unleash," "empower," "elevate" | Marketing language forbidden by the editorial-voice rule | Describe the actual mechanism instead (e.g., "a scored complete card every turn," not "AI-powered coaching") |
| "Lie detection accuracy of 80%" (unqualified) | Drops the denominator and the FPR precondition; misstates KPI-2, which pairs recall with an FPR ceiling, not a bare accuracy number | "80% deceptive-role recall at a 5% false-positive gate" |
| Emoji in any judge-facing material | Global no-emoji rule | Plain text |

---

## Open questions

1. **Demo-day data dependency on the reveal schedule.** This script assumes the sealed run and reveal (direction v10 section 3.2, Oct 22-30) finish before the Oct 31-Nov 2 hardening window, so the live leaderboard segment shows real revealed numbers, not a projection. If the sealed run or reveal slips past Oct 30, the Nov 1-2 demo would have no revealed result to show. Proposed fix: the leaderboard segment falls back to the dev pilot's own measured metrics (10 cases, section 3.2 window Oct 19-22), explicitly labeled "dev-pilot measurement, not the sealed tournament result" rather than silently substituting one for the other; the real reveal, once it lands, replaces the recorded fallback video (section 2.1) before the final submission deadline if there is time, and is otherwise shown live even after the scripted demo if it becomes available between Nov 1 and Nov 2.
2. **KPI-1 volunteer data availability by demo day.** OWNER DECISION PENDING on team roster and KPI-1 volunteer recruitment (direction v10 section 13.2, item 9; section 3.2 window Oct 22-29 for KPI-1 sessions). Section 1.10 and section 2's debrief beat are designed to work either way (real volunteer improvement number, or a dev-pilot-labeled number), but the demo script's exact wording at 2:15-2:45 should be finalized once the owner confirms whether volunteer sessions ran.
3. **Phoenix hosted for judges.** Direction v10 section 8 lists Phoenix hosting with CPU sign-off as an item needing separate owner approval (also gated by the global server/infra-config approval rule). If Phoenix stays local-only through the demo, the trust-center segment's latency panel (KPI-4) should show a static screenshot from the team's local Phoenix instance rather than a live hosted link; this spec's trust-center beat (demo min 5:00-5:20) works with either, but the hosted-link judge walkthrough (section 2.2) should drop any live Phoenix link if hosting is not approved.
