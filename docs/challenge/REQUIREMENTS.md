# Requirements traceability: Investigative AI Training Arena

Source: `unissant-use-case.pptx` (11 slides) and its text export `unissant-use-case.txt`. Speaker notes on slides 5, 6, 7 and 9 carry the operating and scoring contracts; slides 1-4, 8, 10 and 11 have no notes. Read line by line on 2026-10-08, including the rendered slides (no visual-only content beyond logos and an icon).

Every line of the deck and its notes maps to an ID below. IDs are stable: cite them in code, tests, commits and the demo. Source column: slide number, `N` = speaker notes.

## 0. Context

- Host: George Mason University, Challenge X. Sponsor: Unissant. Prize: possible internship at Unissant (slide 11).
- Title: "Investigative AI Training Arena: Multi-Agent Interview Coaching and Evaluation" (slide 1).
- The deck labels its contracts "proposed" (5N, 6N, 7N, 9N). We treat them as the judges' reference design: implement them faithfully, and mark every extension as an extension.

## 1. Problem (slide 2)

| ID | Requirement | Implication for the build |
|---|---|---|
| PRB-1 | Investigators need repeated practice adjusting their questions when answers are incomplete or conflicting. | Unlimited replayable sessions; coaching targets incomplete and conflicting answers specifically. |
| PRB-2 | Today's scenarios are static, low-variety, and make fair comparison of AI assistants hard. | Generated case families with scripted dynamics, plus a controlled comparison harness. |
| PRB-3 | Training must reward catching deceptive subjects while protecting truthful people from false accusations. | Asymmetric scoring: the false-positive gate comes before any recall ranking. |
| PRB-4 | Truthful people can be confused, stressed or unable to recall. Nervousness, demeanor or accent must never be shortcuts to a deception label. | Style varies independently of role; flags must cite content, never style; style-stratified false-positive audit; coach calls out demeanor-driven questions. |

## 2. Challenge (slide 3)

| ID | Requirement |
|---|---|
| CH-1 | Build an AI training arena where investigators practice interviews with simulated subjects while competing AI assistants coach them. |
| CH-2 | Help investigators ask better follow-up questions, using the evidence in each answer. |
| CH-3 | Detect evasive answers and identify which subjects were assigned a perpetrator role. |
| CH-4 | Compare competing AI assistants fairly against truthful and deceptive subject agents. |
| CH-G | Goal: improve investigators' questioning and evidence-backed findings through repeatable AI agent competitions. |

## 3. Solution components (slide 4)

| ID | Requirement | Implication |
|---|---|---|
| SOL-1 | Text-based training platform with two types of competing AI agents. | The text transcript is the scored artifact. Any voice or avatar layer is presentation only. |
| SOL-2 | Investigative assistants review each question and answer, flag gaps and contradictions with transcript evidence, and suggest a neutral follow-up. | See AST-*. |
| SOL-3 | Simulated subjects play a truthful or deceptive role from a private profile; deceptive subjects try to hide an assigned violation within the scenario rules. | See SUB-*. |
| SOL-4 | Scenario engine locks case facts, releases new evidence on a script, sets interview limits, and hides role labels and scoring keys. | See SCN-*. |
| SOL-5 | Independent scoring compares each final finding (deceptive, truthful, or not enough evidence) with the hidden case facts. | Three-valued finding. The scorer is a separate component and the only one that reads evaluator packets. |
| SOL-6 | Two modes: Practice gives live coaching; Assessment saves feedback for the debrief. | Same pipeline; coaching visibility differs. |

## 4. Investigative assistant contract (slide 5 and 5N)

| ID | Requirement | Src | Implication |
|---|---|---|---|
| AST-1 | Assess each question against the answer received. | 5 | Per-turn answer-vs-question assessment. |
| AST-2 | Flag gaps and contradictions with transcript evidence. | 5 | |
| AST-3 | Suggest a neutral follow-up and a finding with confidence. | 5 | Running finding: deceptive / truthful / insufficient + confidence. |
| AST-4 | Goal: supported findings with few false accusations. | 5 | |
| AST-5 | Each candidate is a versioned combination of model, system prompt, retrieval/tool configuration and coaching policy. | 5N | Candidate registry; immutable versions with content hashes. |
| AST-6 | It evaluates the officer's latest question in context. | 5N | The coach grades the question itself (neutrality, relevance), not only the answer. |
| AST-7 | A flag must cite an exact transcript turn and name the relevant missing fact or conflicting statement. | 5N | Schema-enforced. A flag without a valid turn citation counts as unsupported (EVL-5). |
| AST-8 | Responses distinguish non-responsive answers, contradictions, explicit uncertainty and possible evasion. | 5N | Closed category enum. |
| AST-9 | Objective: useful coaching and correct scenario-role identification under a false-positive constraint. | 5N | |
| AST-10 | A candidate earns no credit simply for producing more flags or making a confident accusation. | 5N | Precision counts; false-positive gate; calibration reported. |

## 5. Simulated subject contract (slide 5 and 5N)

| ID | Requirement | Src | Implication |
|---|---|---|---|
| SUB-1 | Receive a private scenario profile and assigned role. | 5 | |
| SUB-2 | Truthful roles answer from known facts and may be uncertain; they say when they do not know. | 5, 5N | Uncertainty limits are part of the profile. |
| SUB-3 | Deceptive roles try to conceal the assigned violation within scenario rules. | 5 | |
| SUB-4 | Goal: profile fidelity plus the assigned truthful or evasive objective. | 5 | |
| SUB-5 | Each candidate model may receive a truthful or deceptive role. Truthful objective: accurate, consistent participation in the assigned profile. | 5N | |
| SUB-6 | A deceptive subject keeps the synthetic violation undiscovered while obeying the fixed case facts and the permitted disclosure policy. The profile may permit high-level evasive behaviors such as omission or deflection. | 5N | Permitted-behavior list per profile. |
| SUB-7 | The subject must not rewrite the underlying event or attack the actual platform. | 5N | Fabrication that contradicts canonical facts is a fidelity failure; prompt-injection attempts make the session invalid. |
| SUB-8 | Score truthful and deceptive runs separately. Invalid profile behavior is a fidelity failure, not successful evasion. | 5N | |

## 6. Scenario design (slide 6 and 6N)

| ID | Requirement | Src | Implication |
|---|---|---|---|
| SCN-1 | Assign a role, event timeline, permitted knowledge and a private objective. | 6 | |
| SCN-2 | Mix deceptive and truthful cases across matched levels of difficulty. | 6 | |
| SCN-3 | Vary communication style independently of the assigned role. | 6 | Factorial assignment of style; enables the PRB-4 audit. |
| SCN-4 | Lock case facts for each trial. Release new evidence through scripted events. | 6 | |
| SCN-5 | Keep role labels and scoring keys hidden from investigators and assistants. | 6 | |
| SCN-6 | Dynamic behavior must remain consistent with the scenario's ground truth. | 6 | |
| SCN-7 | Public case packet: case ID, investigation objective, known timeline, initial documents and interview context. | 6N | |
| SCN-8 | Private subject packet: role, relevant actions, what the subject actually knows, what it may disclose, uncertainty limits, objective and permitted response behaviors. | 6N | |
| SCN-9 | Evaluator-only packet: canonical event facts, assigned role, material contradictions, evidence release conditions, resolution criteria and an answer-scoring rubric. | 6N | |
| SCN-10 | Dynamic elements: the controller can release a new record, introduce a permitted clarification, vary difficulty or apply a predeclared context change. Every change is versioned and timestamped. The underlying event never changes to accommodate a subject's answer. | 6N | Append-only trial event log. |
| SCN-11 | Case families contain matched truthful and deceptive variants, with communication style and difficulty distributed independently of role. Include truthful uncertainty and misleading-looking circumstances so the system learns to request corroboration. | 6N | |
| SCN-12 | Development and hidden evaluation sets use disjoint case families. Held-out profiles stay out of prompts, retrieval indexes, tuning data and debrief access during a tournament. Tune between tournaments only on development cases. | 6N | Sealed hidden split; leakage audit. |

## 7. Bake-off protocol (slide 7, 7N and the slide 8 test bed)

| ID | Requirement | Src |
|---|---|---|
| BKO-1 | Matched cases: cross-pair assistant and subject candidates under equal budgets. | 7 |
| BKO-2 | Two test tracks: replay identical transcripts, then run interactive interviews. | 7, 8 |
| BKO-3 | Blinded scoring: compare locked findings with case facts and trainer ratings. | 7 |
| BKO-4 | Proposed MVP: 3 assistant and 3 subject candidates. | 7, 8 |
| BKO-5 | Freeze the candidates with recorded model and prompt versions. Each subject candidate plays both profile types across the case set. Use consistent public tools, context limits and response budgets. | 7N.1 |
| BKO-6 | Replay track: every assistant gets the same frozen transcripts and released evidence. Compare response-level flags, questioning assessment and final scenario classification. This isolates evaluation quality from differences in interview paths. | 7N.2 |
| BKO-7 | Interactive track: cross-pair each assistant with each subject. A fixed interviewer harness asks a common initial question, then relays the assistant's proposed follow-ups under a shared policy. Human training sessions form a separate study. Randomize candidate and case order. | 7N.3 |
| BKO-8 | Planning workload: 40 development and 120 hidden evaluation cases, balanced across roles. 3 x 3 x 120 x 2 repeats = 2,160 interactive trials. Proposed cap of 12 question-answer exchanges per trial. Final volume depends on the approved model-spend budget. | 7N.4 |
| BKO-9 | Commit findings before exposing labels. Ground-truth scoring and blinded trainer review produce separate assistant and subject leaderboards. Disclose invalid runs, cost, latency and unresolved findings. | 7N.5 |
| BKO-10 | Repeated runs of the same base case are correlated: confidence intervals must account for case-level clustering, results must disclose role prevalence, and hidden test performance must not tune candidates within the same tournament. | 7N.6 |

## 8. Example output and ground rule (slide 8)

| ID | Content | Implication |
|---|---|---|
| EX-1 | Exchange: investigator asks "Why did you enter?"; subject replies "It was a busy shift." | Canonical demo turn. |
| EX-2 | Flag: the purpose of entry is unanswered. Suggested neutral follow-up: "What task required entry?" | Non-responsive category, names the missing fact, neutral open follow-up. |
| EX-3 | Finding: more evidence needed. Verify the work order and timeline before reaching a finding. | "Insufficient evidence" is a first-class output, and it names the corroboration to seek. |
| EX-4 | Ground rule: all cases are synthetic. Evasive wording alone does not prove a violation, and a simulated score is not a finding about a real person. | Shown in the UI and docs; enforced in prompts and scoring. |

## 9. Evaluation (slide 9 and 9N)

| ID | Requirement | Src |
|---|---|---|
| EVL-1 | Separate scorecards for learning, detection and subject realism. | 9 |
| EVL-2 | Investigators: question quality, evidence coverage and improvement on unseen cases. | 9 |
| EVL-3 | Assistants: evasion-event precision/recall, role recall and false-positive rate. | 9 |
| EVL-4 | Subjects: consistency with assigned facts and success within scenario rules. | 9 |
| EVL-5 | All trials: unsupported flags, unresolved findings, latency and cost. | 9 |
| EVL-6 | Assistant ranking: pass false-positive and isolation gates, then compare recall and questioning quality. | 9 |
| EVL-7 | Investigator rubric: five dimensions, each 0-4, scored by a blinded trainer: clarity and neutrality, response relevance, evidence-based follow-up, testing alternative explanations, supported closure. Sum x 5 = 0-100. Trainers must calibrate it before use. | 9N |
| EVL-8 | Event precision = correctly flagged evasive events / all evasion flags. Event recall = correctly flagged events / trainer-labeled evasive events. Annotators distinguish evasion from uncertainty, legitimate non-disclosure and a poorly framed question, using transcript and scenario context, not style alone. | 9N |
| EVL-9 | Role score: deceptive-role recall, false-positive rate among all truthful cases, positive predictive value, and a 2 x 3 count matrix (truthful/deceptive ground truth vs truthful/deceptive/insufficient output). Unresolved deceptive cases are not detections. Unresolved truthful cases stay in the truthful denominator. Report unresolved rates by role so abstention cannot hide poor coverage. | 9N |
| EVL-10 | Eligibility: false-positive point estimate no greater than 5% and passing isolation/leakage tests. Rank eligible candidates by deceptive-role recall, then questioning quality. Publish precision, uncertainty, unresolved rates, cost and latency alongside rank. A tournament rank is not certification for real investigations. | 9N |
| EVL-11 | Subject fidelity = compliant turns / all turns; invalid sessions reported separately. A deceptive run succeeds only if the violation stays undetected within budget while the subject obeys the scenario. Report misleading clearance and unresolved cases separately. Truthful subjects earn credit for factual consistency and appropriate uncertainty; correct recognition is reported as an interaction outcome. | 9N |
| EVL-12 | Methodological reference: NIST AI RMF Playbook, Measure function (documented test methods, context-specific measurement, independent assessment). The thresholds are the proposal's own; NIST has not validated them. https://airc.nist.gov/airmf-resources/playbook/measure/ | 9N |

## 10. Impact targets (slide 10)

| ID | Target |
|---|---|
| KPI-1 | Improve investigators' questioning score by at least 20% over their own starting baseline. |
| KPI-2 | Identify at least 80% of deceptive roles; misclassify no more than 5% of truthful roles. |
| KPI-3 | Keep simulated subjects in character: at least 95% profile fidelity. |
| KPI-4 | Deliver coaching within 3 seconds for 95% of interview turns. |
| KPI-5 | Rank fairly: assistants first pass the false-accusation and isolation (no access to hidden answers) checks, then compete on detection and questioning quality. |

## 11. Exact formulas (from 9N)

T = truthful trials, D = deceptive trials. Output is one of {truthful, deceptive, insufficient}.

- Deceptive-role recall = count(D -> deceptive) / |D|. Insufficient deceptive outputs stay in |D|.
- False-positive rate = count(T -> deceptive) / |T|. Insufficient truthful outputs stay in |T|.
- PPV = count(D -> deceptive) / (count(D -> deceptive) + count(T -> deceptive)).
- Unresolved rate, per role X in {T, D} = count(X -> insufficient) / |X|.
- Event precision = correct evasion flags / all evasion flags. Event recall = correct evasion flags / labeled evasive events.
- Investigator score = 5 x (sum of five dimensions, each 0-4), range 0-100.
- Subject fidelity = compliant turns / all turns.
- Investigator improvement = (post score - own baseline) / own baseline, measured on unseen cases.
- Eligibility = (FPR point estimate <= 0.05) AND (isolation and leakage tests pass). Rank = deceptive-role recall, then questioning quality.

## 12. Ambiguities (our working interpretation, to confirm)

1. Falsehoods by deceptive subjects. 5N permits "high-level evasive behaviors such as omission or deflection" and forbids rewriting the event. Working rule: each profile lists permitted behaviors; any statement that contradicts a canonical fact is a fidelity failure.
2. "Trainer" ratings. No human trainers at hackathon scale. Working rule: calibrated LLM trainer-proxy plus a blinded human review queue on a sample, with agreement reported.
3. "Equal budgets". Working rule: equal turn cap, max output tokens, context limit and tool set. Dollar cost is reported, not equalized.
4. Interviewer harness "shared policy". Working rule: relay the assistant's top follow-up verbatim if it passes a neutrality check, otherwise a fixed neutral fallback; stop at 12 exchanges or when the assistant commits a finding.
5. Ground truth for evasion events. Working rule: the subject emits a sealed per-turn disclosure tag, checked by the fidelity judge and spot-checked by humans.
6. Investigator improvement (KPI-1). The human study is outside the bake-off (7N.3). Working rule: ship the measurement pipeline (baseline, practice, unseen post-test, blinded scoring) and run it on volunteer sessions.
7. Workload scale (BKO-8). 2,160 trials depends on the approved spend.
8. Candidate diversity under the Gemini-only constraint. Working rule: candidates differ by Gemini tier, prompt, tools and coaching policy, which matches AST-5.
