# S1: Scenario engine and case families

Spec part S1 of the build-ready specification. Version 2.2, 2026-10-08: D-014 offline authoring. Governing sources: `docs/spec/README.md` (baseline facts; it wins over this part), `docs/research/synthesis/02-direction.md` v10.4 (sections 3.1, 3.2, 4.1, 4.2, 4.6, 6.2-6.4, 7.2, 8, 13.1), `docs/spec/S8-build-plan.md` section 9 (C-nn resolutions). Locked decisions D-001 to D-014 apply (D-007 superseded by D-009; D-011 local-first; D-012 and D-013: one global spend ceiling, applied from `cost_model.budget_plan()`; D-014: case families authored once, offline, by Claude agents with Codex review, no runtime generator). Requirement IDs are from `docs/challenge/REQUIREMENTS.md`.

Deliverables of this part:

| File | What it is |
| --- | --- |
| `docs/spec/S1-scenario-engine.md` | This document |
| `docs/spec/schemas/public-packet.schema.json` | SCN-7 public case packet, schema v1.1 (JSON Schema draft 2020-12) |
| `docs/spec/schemas/private-packet.schema.json` | SCN-8 private subject packet, schema v1.0; a superset of S2's `SubjectPacket` contract |
| `docs/spec/schemas/evaluator-packet.schema.json` | SCN-9 evaluator-only packet, schema v1.0 |
| `docs/spec/schemas/case-family.schema.json` | SCN-11 case family, schema v1.1: event graph plus matched truthful and deceptive variants, each with its three packets |
| `docs/spec/seed-families/F01.json`, `F02.json`, `F03.json` | Three development seed families, validated (section 11) |

## 0. Decisions in one table

| # | Decision | Requirement | Section |
| --- | --- | --- | --- |
| 1 | A case family is one canonical event graph with a matched truthful and deceptive variant. Both variants share the persona, the public packet, the record skeleton, difficulty and style. | SCN-11, SCN-2, SCN-3 | 3 |
| 2 | Public packets of the two variants are byte-identical except for an opaque `case_id`, and initial plus scheduled records are identical too. A role guesser that sees only free material is at exactly chance by construction. The public packet (schema v1.1) also carries the harness inputs (opening question, three replay topics, optional record dates) and the presentation (portrait, display name, voice), so both variants share them; it has no demeanor or style field. | SCN-5, SCN-7, BKO-6, BKO-7, PRB-4 | 4.1, 10.2 |
| 3 | Atomic fact IDs (`f:NN`) on a canonical event graph with typed, time-checked edges. Every packet field that states a fact points at a fact ID. | SCN-1, SCN-4, SCN-6, SCN-9 | 5 |
| 4 | Evidence is a fixed set of records: at most 4 initial documents and at most `MAX_RELEASES = 6` releasable records per case. Each releasable record has one deterministic predicate: scheduled after N completed exchanges, or on request after N completed exchanges. `release_evidence()` evaluates it from committed state. | SCN-4, SCN-10, SOL-4 | 6 |
| 5 | The subject ledger follows S2's four fact classes (FREE, HOLD, CORE, PRIVATE). A HOLD fact sits behind a gate that opens when the investigator presents the evidence (S2). A gate is LOCKED until a linked record has been released at the gate's Evidence Framing Matrix level, and S2's tag validator rejects opening a LOCKED gate (C-20). The violation is always CORE: never volunteered, confirmed or denied. | SCN-8, SUB-2, SUB-6, SUB-7 | 6.4, 7 |
| 6 | Style is assigned per family by a balanced factorial over S2's five axes and is shared by both variants, so style is independent of role exactly. It is stored in the public-tier variant row for the fairness audit and never returned by an investigator or assistant route before reveal (C-26). | SCN-3, PRB-4, SCN-11 | 4.4, 7.5 |
| 7 | Difficulty is three levels defined by five knobs the validator computes from the packets. | SCN-2 | 7.6 |
| 8 | Families are authored once, offline (D-014). Per family, code renders an authoring brief (seed spec, construction rules, one development family's design brief as the example); a Claude agent writes the family source, and the deterministic assembler builds the family JSON (schema v1.1) with all six packets. No runtime generator and no `gemini-3.1-pro-preview`. | SCN-12, D-014 | 8 |
| 9 | Deterministic validators run in code: V1 schema (with the relay test on the opening question and the rendered replay script), V2 fact graph, V3a structural solvability, V4 role leak, V5 diversity. A Codex review per family (ground-truth consistency, solvability, role leakage) replaces the model checks V3b and V3c. The agent revises until both pass. V6 pilot difficulty runs on development families only. | SCN-6, SCN-11, SCN-12 | 8.5, 9 |
| 10 | Hidden families are authored by isolated agents into a git-ignored directory that nobody on the team reads, then ingested and sealed in Postgres (S4 `sealed.seal_hidden_split()`) before candidates freeze. Validator and Codex output for hidden families is codes and counts only. | SCN-12, BKO-9, BKO-10 | 10 |

## 1. Requirement coverage

| ID | Where it is met | How it is tested |
| --- | --- | --- |
| SOL-4 | Engine locks facts, releases evidence on a script, sets limits (12 exchanges, 6 releases), hides labels | AC-S1-01..12 |
| SCN-1 | Private packet: role, persona, relevant actions, ledger, objective; event timeline in the event graph and public known timeline | AC-S1-02, AC-S1-05 |
| SCN-2 | Difficulty level shared by both variants of a family; knob table | AC-S1-14 |
| SCN-3, PRB-4 | Style factorial, shared within family; never an input to coaching | AC-S1-15, AC-S1-16 |
| SCN-4 | Packets immutable once ingested; trials bind to packet hashes; releases only through `release_evidence()` | AC-S1-08..11 |
| SCN-5 | Role and keys live only in private and evaluator packets; public invariance L1, L2 | AC-S1-12, AC-S1-13 |
| SCN-6 | Ledger, gates, forbidden assertions, uncertainty entries; fidelity judged against canonical facts | AC-S1-05, AC-S1-06 |
| SCN-7 | `public-packet.schema.json` | AC-S1-01 |
| SCN-8 | `private-packet.schema.json` | AC-S1-01, AC-S1-05 |
| SCN-9 | `evaluator-packet.schema.json` | AC-S1-01, AC-S1-07 |
| SCN-10 | Clarifications and predeclared context changes are scheduled records released and ledgered by the same function; difficulty is fixed per variant (section 6.5) | AC-S1-10 |
| SCN-11 | Matched variants, misleading-but-innocent circumstances with one explanation each, genuine uncertainty | AC-S1-03, AC-S1-04, AC-S1-17 |
| SCN-12 | Disjoint splits, dev-only brief example, hidden families authored unread and sealed, leakage rules L1-L12 | AC-S1-18..24 |
| SUB-1..SUB-3, SUB-6, SUB-7 | Ledger classes, permitted behaviors (omission, deflection, minimization), forbidden behaviors and assertions | AC-S1-05, AC-S1-06 |
| EX-1..EX-3 | F01 contains the slide-8 exchange and the work-order and timeline corroboration path | AC-S1-25 |
| EX-4 | `ground_rules` is a schema constant in every public packet | AC-S1-01 |
| EVL-8 | Per-variant turn-label guide distinguishing evasion, genuine uncertainty, legitimate non-disclosure, poorly framed question and responsive turns | AC-S1-07 |
| BKO-8 | 12-exchange cap in every packet; release predicates at most 10 so two questions remain | AC-S1-09 |
| BKO-6, BKO-7 | Public packet `opening_question` (common initial question) and `replay_topics` (replay script), relay-tested at authoring (V1c); requestable records released by the replay script at their first eligible exchange (6.2, C-23) | AC-S1-27 |

## 2. Terms

| Term | Meaning |
| --- | --- |
| Family | One canonical incident with two matched variants (truthful, deceptive). The sealing and storage unit. |
| Variant / case | One role-assigned instance of a family, with an opaque `case_id` and three packets. A trial runs one case. |
| Fact | One atomic proposition with an ID (`f:NN`), kind, optional time, actors, tags and the variants it holds in. |
| Record | An evidence artifact: an initial document (`doc-NN`) or a releasable record (`rec-NN`). |
| Exchange | Question Q(t) plus answer A(t), t = 1..12. "After N exchanges" means once N answers are committed. |
| EFM level | Evidence Framing Matrix strength of a record for a fact: 1 weak source and low precision, 2 weak and high, 3 strong and low, 4 strong and high (Granhag, Stromwall, Willen and Hartwig 2013, via X9 Q1). |
| Gate | A rule that opens HOLD facts. LOCKED until a precondition record is released, then CLOSED (openable), then OPEN once the investigator presents its condition (6.4). |
| Free evidence | Initial documents plus scheduled records: what every interview receives without asking. |

ID formats are shared with S2 section 1 (C-16): facts `f:NN`, uncertainty `u:NN`, gates `g:NN`, records `rec-NN` and initial documents `doc-NN` in every part; turns are keyed in the database by (`trial_id`, `turn_no`), model-facing text uses `tNN` = `f"t{turn_no:02d}"`, and the UI label `T{n}` is display only. S1 adds `x:NN` (forbidden assertions), `c:NN` (contradictions), `r:NN` (decisive support items), `q:NN` (key questions), `a:NN` (alternative explanations), `l:NN` (turn-label guide entries). Case IDs are `C-` plus 8 Crockford base32 characters. Portrait IDs are `persona-NN`. Development family IDs are `F01`..`F999`; hidden family IDs are `H` plus 10 random hex characters.

## 3. Case-family model (SCN-11, SCN-2, SCN-3)

A family file (`case-family.schema.json`) holds: metadata (title, split, taxonomy, difficulty, style, provenance), the canonical `event_graph` (facts with variant membership, edges) and `variants.truthful` and `variants.deceptive`, each with `case_id`, `public_packet`, `private_packet` and `evaluator_packet`. The whole file is evaluator-tier. A loader splits it into the S4 tables (section 4.4); nothing reads the file at runtime.

Matching rules (validator V2 and V4 enforce every one):

| Rule | Statement |
| --- | --- |
| M1 | Same persona, same organization, same facility, same incident date, interview context and presentation (portrait, display name, voice) in both variants. |
| M2 | Public packets identical except `case_id` (L1). |
| M3 | Same record skeleton: identical record IDs, kinds, titles, descriptions and release predicates. Initial and scheduled contents identical (L2); on-request contents may differ. |
| M4 | Shared facts carry the same ID and statement. Variant-only facts have IDs that never collide (by convention 20-39 truthful, 40-59 deceptive, 01-19 shared). |
| M5 | Same difficulty level and equal computed knobs K, E and U in both variants (section 7.6). |
| M6 | Same style assignment in both variants (section 7.5). |

What differs between variants is only the event itself: the truthful variant has misleading-but-innocent circumstances, each with exactly one innocent explanation; the deceptive variant has exactly one violation with one motive, one opportunity and one means (AR-Bench triple constraint, Zhou et al. 2025, arXiv 2506.08295, via X9 Q2), plus a true cover activity the subject can describe without lying.

Why identical free evidence: the investigator must earn discriminating evidence by asking for the right record at the right time (Strategic Use of Evidence; EVL-7 dimension 3, evidence-based follow-up). Free material cannot reveal the role, so the interview always matters (CH-3, AST-10).

## 4. The three packets (SCN-7, SCN-8, SCN-9)

### 4.1 Public packet (`public-packet.schema.json` v1.1, SCN-7)

| Field | Content | Notes |
| --- | --- | --- |
| `case_id` | Opaque per-variant ID | Never derived from family, variant or role (L3) |
| `domain`, `title`, `difficulty_level` | `facility_access`; role-neutral title; 1-3 | Difficulty is shown in practice mode |
| `investigation_objective` | What the investigation must establish | Neutral; no presumption |
| `interview_context` | Fictional agency, facility, timezone, interview date, setting, investigator role, subject (name, position, unit, tenure), `purpose_statement` read to the subject | Non-accusatory purpose statement (Mendez Principles, X1 Q2) |
| `presentation` | `{persona_id, display_name, voice_id}`: portrait from the art pool (`persona-NN`, S6 6.4), the subject's name, a prebuilt Gemini Live voice name (S2 9.2, S5 7.4) | Per family, so both variants carry the same object (C-21). `display_name` equals the subject name (V2). No `baseline_demeanor` or any other style-like attribute (C-22, PRB-4) |
| `opening_question` | The common initial question every trial of the case asks first (S2 8.1, BKO-7) | Written by the authoring agent from public material only; passes S2 `relay_test.v1` (V1c) |
| `replay_topics` | Exactly 3 noun phrases of at most 12 words, rendered into the replay script (S2 8.6, BKO-6) | Public material only; every rendered script question passes the relay test (V1c) |
| `known_timeline` | 2-12 entries, each sourced to an initial document | Only what initial documents show |
| `initial_documents` | 1-4 documents (`doc-NN`) with kind, title, body and optional table | Identical across variants |
| `requestable_records` | 1-6 entries (`rec-NN`): kind, title, description, `requestable_after_exchanges`, optional `date` (`YYYY-MM-DD`) | Titles only; contents released by `release_evidence()`. Scheduled records are never listed; they appear when released. `date` is set only when the title does not already carry one |
| `limits` | `max_exchanges` 12, `max_releases` 6 | Schema constants (BKO-8, SOL-4) |
| `ground_rules` | The three EX-4 sentences | Schema constant, shown in the room and debrief |

Absent by construction: role, fact IDs, release schedule, scheduled-record contents, style, demeanor, rubric. The validator scans every public-tier string, including the opening question, the replay topics and the contents of every record (which become public on release), for role and verdict words, ledger identifiers and real agency names (V4b).

Why the portrait comes from a pool: a hidden family's persona cannot be drawn from its content before reveal without exposing hidden text (L6). The seed sampler (8.1) draws `persona_id` and `voice_id` before authoring, from lists that contain no case content; both are shared by the two variants, so neither can correlate with role.

### 4.2 Private packet (`private-packet.schema.json`, SCN-8)

The private packet is a superset of S2's `SubjectPacket` rendering contract (S2 section 6.2), so S2 renders it without translation.

| Field | Used by | Content |
| --- | --- | --- |
| `role` | S2 role block | `truthful` or `deceptive` (SUB-1) |
| `persona` | S2 | name, position, organization (fictional), unit, tenure, background |
| `matter` | S2 | The public objective, verbatim |
| `objective` | Referee, audit | SCN-8 private objective. Fixed text per role; the deceptive text names the concealment target. S2's role blocks carry the operative instructions. |
| `facts[]` | S2 ledger | `{id, class, text, certainty, gate_id}`. Text in second person. Classes below. |
| `relevant_action_ids` | Referee | SCN-8 relevant actions: ledger facts describing what the subject did |
| `unknown_facts[]` | J2 fidelity judge | Canonical facts a natural question may touch that the subject does not know; S2's closed-world rule covers them at runtime |
| `uncertainty[]` | S2 | `{id, fact_id, text, answer_form (dont_know, range, unsure), range_text}`. Every `approximate` fact has exactly one range or unsure entry (SUB-2). |
| `gates[]` | S2 ledger, arena-subject code | `{id, condition, opens[], min_evidence_level, precondition_records[]}` (section 7.2). Deceptive only. |
| `permitted_behaviors` | S2 role block D | Subset of `omission`, `deflection`, `minimization` (SUB-6). Empty for truthful. |
| `forbidden_behaviors` | J2 | Constant: `deny_known_fact`, `assert_false_fact`, `feign_uncertainty`, `invent_material_fact`, `reveal_role_or_packet`, `address_the_platform`, `break_character` (SUB-7) |
| `forbidden_assertions[]` | J2 | Family-specific false statements, quoted as the subject might say them, each naming the fact it contradicts |
| `style` | S2 style block | Five axes (section 7.5) |
| `limits`, `canary` | Code | 12 exchanges; canary token never rendered (S3 IG-6) |

Fact classes (S2 section 6.2 and 6.4):

| Class | Truthful | Deceptive | Subject behavior |
| --- | --- | --- | --- |
| FREE | Yes | Yes | Shared when a question calls for it |
| PRIVATE | Yes | Yes | Personal and unrelated to the matter; may be declined with the reason (EVL-8 legitimate non-disclosure). Never denied. |
| HOLD | No | Yes | Protected by omission, deflection or minimization until its gate opens; acknowledged after |
| CORE | No | Yes, at least one (the violation) | Never volunteered, confirmed or denied; deflect or decline if asked directly |

The violation fact is always CORE. A deceptive subject therefore never confesses; detection rests on records plus the evasion pattern, which matches the information-gathering model (Mendez Principles, X1 Q2) and EX-4 (wording alone proves nothing; the finding must cite content). Concealment without lying follows the LH-Deception split (concealment and equivocation permitted, falsification a fidelity failure; arXiv 2510.03999 via X9 Q3; REQUIREMENTS ambiguity 1).

### 4.3 Evaluator packet (`evaluator-packet.schema.json`, SCN-9)

| Field | Content |
| --- | --- |
| `family_id`, `variant`, `role` | Role label (SCN-9); `role` equals `variant` (validator) |
| `synopsis` | What really happened, including the misleading circumstances or distractors |
| `canonical_facts`, `event_edges` | The event graph filtered to this variant (section 5) |
| `evidence_artifacts[]` | Every record: ID, kind, title, description, `release` predicate, full `content`, `supports[]` with `{fact_id, source_strength, precision, level}` |
| `max_releases` | Constant 6 |
| `material_contradictions[]` | `{id, type, description, fact_ids, artifact_ids, forbidden_assertion_ids, resolution, resolved_by}`. Types: `statement_vs_evidence`, `evidence_vs_evidence` (deceptive), `apparent` (truthful, with an innocent resolution). |
| `resolution_criteria` | `correct_finding`; `decisive_support[]` (any one item suffices; each lists records, facts and whether the subject's own account is required); `corroboration_to_name` (EX-3: what an "insufficient evidence" finding should name); `unsupported_grounds` (PRB-4, EX-4) |
| `rubric` | Answer-scoring rubric: key questions with target facts and a neutral example; records worth requesting; alternative explanations with tests; family notes for the five EVL-7 dimensions. The shared 0-4 anchors live in S3. |
| `turn_label_guide[]` | Anticipated subject-turn situations with the EVL-8 label they should get in this variant. Reference material for reviewing J1's labels in the dev pilot and for calibration answer keys (S3 section 7); J1 does not read it, so its labels stay independent of the case author's expectations |
| `canary` | Leakage audit token |

### 4.4 Storage and the S4 ingest bundle

The loader (`arena/scenario/load.py`, run under `arena_referee`) converts a family file into the bundle that S4's `sealed.ingest_case_family(p_bundle)` accepts (`docs/spec/sql/0002_cases.sql`):

| S4 bundle field | Source in the family file |
| --- | --- |
| `family_code`, `domain`, `split` | `family_id`, `domain`, `split` |
| `variants[].variant_code` | The variant's `case_id`. Never `truthful`, `deceptive`, `T` or `D`: `arena.case_variants` is public tier (L3), and S4's check `variant_code ~ '^C-[0-9A-HJKMNP-TV-Z]{8}$'` refuses anything else (C-25). |
| `variants[].role` | `evaluator_packet.role` |
| `variants[].style`, `difficulty` | Family `style`, `difficulty.level`. Style stays in public-tier `arena.case_variants` because the fairness audit needs it and both variants share it; no investigator or assistant route and no `PublicTrialView` field returns it before reveal (S5 route and type test, C-26). |
| `variants[].public_packet`, `private_packet`, `evaluator_packet` | The three packets, verbatim |
| `variants[].artifacts[]` | Every `rec-NN` record (initial documents stay in the public packet): `record_id`; `kind` mapped `clarification` to `clarification`, `context_change` to `context_change`, every other S1 kind to `record`; `doc_kind` = the S1 record kind (`artifactKind`), so the evidence board keeps the document kind (C-24); `title`; `content`; `requestable` true for `on_request`; `scheduled_turn` = `after_exchanges` for `scheduled`; `request_after_turn` = `after_exchanges` for `on_request` |

S4 stores dev public packets in `arena.public_packets` and hidden ones in `sealed.hidden_public_packets` until a running trial projects them; private packets in `subject.private_packets`; evaluator packets in `sealed.evaluator_packets`; releasable records in `sealed.evidence_artifacts`. All are immutable after insert (S4 triggers). A record's `date` is not an artifact column: it is public from the start, and consumers (S2 8.6 evidence slot, S6 evidence board) read it from the trial's public packet `requestable_records` by `record_id`; a scheduled record has no listed date and uses the undated form.

## 5. Atomic facts and the canonical event graph (SCN-1, SCN-4, SCN-6)

Fact rules:

| Rule | Statement |
| --- | --- |
| F1 | One proposition per fact, past tense, third person, at most 300 characters. A fact that needs "and" to join two checkable claims is split (for example "card A-2291 opened N-3" and "the database lists A-2291 to Haddad" are two facts). |
| F2 | `kind` in `action`, `state`, `record`, `context`, `knowledge`. `time` is facility-local `YYYY-MM-DDTHH:MM[:SS]` when the fact has one. |
| F3 | `variants` lists where the fact holds. Shared facts are the same in both variants. |
| F4 | `material: true` when any resolution criterion depends on the fact. |
| F5 | Tags: `violation`, `motive`, `opportunity`, `means`, `concealment`, `cover` (deceptive mechanics); `misleading`, `innocent_explanation` (truthful mechanics); `privacy` (PRIVATE class). |

Edge rules (validator V2):

| Relation | Constraint |
| --- | --- |
| `precedes`, `causes` | Acyclic; `from.time <= to.time` when both are timed |
| `motivates` | `motive` fact to the `violation` |
| `enables` | `opportunity` or `means` fact to the `violation` |
| `explains` | `innocent_explanation` fact to a `misleading` fact |
| Any | Endpoints exist and share at least one variant; the evaluator packet's `event_edges` is exactly the subset with both endpoints in the variant |

Locking (SCN-4): packets are immutable after ingest (S4 triggers); each trial binds to the variant's packet hashes; `finalize_trial()` commits transcript and released-evidence hashes (direction 4.2). The event never changes to fit a subject's answer (SCN-10): there is no write path from a trial into a packet.

## 6. Evidence artifacts and release (SCN-4, SCN-10, SOL-4)

### 6.1 Records

Each record has an ID, a kind (`public-packet.schema.json#/$defs/artifactKind`, a facility-access vocabulary taken from X9 Q6: badge and door logs, alarm and dispatch logs, work orders, visitor registers, lockbox logs, credential records, seal audits, statements, notices), a title, a description for requestable records, a release predicate, content (plain-text body up to 2,000 characters plus an optional table of at most 30 rows) and `supports[]`.

A support link says how strongly and how precisely the record establishes a fact. Source strength: `strong` for system records and first-hand statements by the record's owner, `weak` for recollection by third parties. Precision: `high` when the record states the fact specifically (room, time, count, name), `low` when it implies it. Level = 1 weak/low, 2 weak/high, 3 strong/low, 4 strong/high. Levels drive gate preconditions (7.2) and the difficulty knobs (7.6).

Authoring limits (V1, V2): at most 4 initial documents; at most `MAX_RELEASES = 6` releasable records per case (direction 4.2; `cost_model.MAX_RELEASES`); every predicate value at most 10.

### 6.2 Release predicates

`arena.release_evidence()` (S4 `sql/0004_privileged_functions.sql`) runs after A(n) is committed and before A(n+1): between turns (S5's evidence-request route), or right after Q(n+1) is recorded, which S4's turn order does on every question with an empty list if nothing is requested, so scheduled releases apply. It is refused while the coaching for the last answer is pending (AR004). Let n be the number of completed exchanges, read from the committed trial row, never from the caller.

| Predicate | Fires | Visible to the investigator |
| --- | --- | --- |
| `{"type": "initial"}` (`doc-NN`) | At trial start (part of the public packet) | From the start |
| `{"type": "scheduled", "after_exchanges": k}` | On the first call with n >= k, whether or not anything is requested | Before the subject answers exchange k+1 |
| `{"type": "on_request", "after_exchanges": m}` | On a call with n >= m whose `requested_record_ids` contains the record | When the call returns |

### 6.3 How `release_evidence(trial, work_item, requested_record_ids)` evaluates them

S4 implements this contract; the steps below are what S1 requires of it and what its tests (S4 `TESTS.md` RE-xx) check.

```text
lock trial row FOR UPDATE; check caller, work item (a repeat returns the stored result), status running,
  transcript version current, coaching for the last answer not pending      (S4 arena.release_evidence)
reject the call if any requested id is not a requestable record of this variant        (AR005)
n      := completed exchanges from the committed trial row
due    := records not yet released with
            (scheduled and after_exchanges <= n)
         or (on_request and id in requested and after_exchanges <= n)
if released_count + |due| > 6: raise AR006                                             (defense in depth;
                                                                                         V2 caps at 6)
for each due record in record_id order: insert released row (content, sha256, after n exchanges);
append one ledger event 'evidence_released' with ids and hashes; bump transcript version
return released (public content only), already_released ids, denied ids (no reason given)
```

Determinism: the output depends only on committed rows (trial exchanges, prior releases) and the request list. A request made too early is denied without a reason; the investigator UI shows `requestable_after_exchanges` from the public packet, so the investigator can ask again. Each record is released at most once per trial.

Replay corpus (C-23, S2 8.6): before exchange n+1 the replay script requests every requestable record whose `requestable_after_exchanges` is at most n and that it has not yet requested, in record-ID order, through this same function. Each requestable record is therefore released at its first eligible exchange with no assistant input, so replay transcripts carry the variant-specific on-request evidence that the identical free evidence (L2) does not.

### 6.4 Gate state from releases (C-20)

Arena-subject keeps, per trial, the set of released record IDs (initial documents count as released from the start; `subject.turn_context` returns released evidence). Gate status, rendered in S2's ledger (S2 6.7):

| Status | When |
| --- | --- |
| LOCKED | None of the gate's `precondition_records` is released |
| CLOSED | At least one precondition record is released; the gate can open |
| OPEN | A validated subject tag opened it while it was CLOSED; it stays open for the rest of the trial |

S2's tag validator V2 rejects `gates_opened` for a gate that is LOCKED or already OPEN (S2 6.8; tests AT-SUBJ-3, AT-SUBJ-4). This is the only use the subject service makes of evidence links, and it is deterministic.

### 6.5 Dynamic elements (SCN-10)

| Element | How S1 models it |
| --- | --- |
| Release a new record | Scheduled or on-request record |
| Permitted clarification | A scheduled record of kind `clarification` (F03 `rec-05`, outage procedure OP-7) |
| Predeclared context change | A scheduled record of kind `context_change` (F02 `rec-05`, the sensor fault notice) |
| Vary difficulty | Fixed per family and shared by both variants, so bake-off trials stay matched (SCN-2, BKO-1). Practice mode varies difficulty by choosing a family of the wanted level. S4's `difficulty_change` kind is not used by S1. |
| Versioned and timestamped | Every release is a ledger event with record ID, content hash and exchange count (S4) |

## 7. Subject disclosure model (SCN-8, SUB-2, SUB-3, SUB-6, SUB-7)

### 7.1 Ledger construction

The private packet's ledger is the persona slice of the canonical facts: the facts the subject knows, in second person (pattern: TechnoMile `services/run/src/bh_run/tail/roleplay.py` lines 128-139, `persona_slice`, where each persona sees only claims about itself). Facts the subject does not know are left out of the ledger and listed in `unknown_facts` for the fidelity judge. Structured fact packets outperform free prose for role-play grounding (I3 section a, BDE schema result), and a ledger re-injected each turn targets the drift that persona research reports inside 8-12 exchanges (X2a Q2, Q3).

### 7.2 Gates on evidence strength (Evidence Framing Matrix)

A gate has:

| Field | Meaning |
| --- | --- |
| `condition` | What the investigator's question must present for the gate to open, written in terms of the record ("presents the seal audit finding that box ACQ-117 was resealed at 14:15 with seal #55419"). Judged by the subject model and independently by J2 (S2 6.4, 7.3). |
| `opens` | HOLD facts the gate opens |
| `min_evidence_level` | EFM level the presented evidence must reach |
| `precondition_records` | Derived: every record whose support for an opened fact is at least `min_evidence_level` |

So a gate opens only when (a) a strong-enough record exists in this trial and (b) the investigator actually puts it to the subject. Condition (a) is code; it stops a bluff from opening a gate (an investigator who claims a record the case has not released gets nothing), which also keeps the arena on the non-deceptive side of interviewing practice (Mendez Principles, X1 Q2). Condition (b) is the Strategic Use of Evidence mechanic: the interviewer controls when evidence is disclosed, and stepwise disclosure from weak to strong exposes statement-evidence inconsistency (Granhag et al. 2013 via X9 Q1; the 2026 Law and Human Behavior RCT used SUE-based AI suspects, Li, Granhag, Shi, Sun, Nyman, Haginoya and Santtila, 50(3), 240-260). Gating cut deep-secret leakage from 19-37% to 3-8% in disclosure-gated simulation (arXiv 2609.00982 via X9 Q3).

Truthful variants have no gates: truthful subjects share FREE facts when asked and may decline PRIVATE ones.

### 7.3 Uncertainty (SUB-2)

Each approximate fact has one entry with `answer_form` `range` (with the exact words, `range_text`) or `unsure`. `dont_know` entries are allowed only for facts listed in `unknown_facts`. Feigned uncertainty about a certain fact is a forbidden behavior, so genuine uncertainty stays a truthful-or-declared signal, never a concealment tool. Uncertainty counts are matched across variants (knob U).

### 7.4 Forbidden behaviors and assertions (SUB-7, EVL-11)

The seven forbidden behaviors are constant. Each family adds 2-8 forbidden assertions: the specific false statements a subject under pressure is most likely to make (for F01 deceptive: "I had a work task in B-12", contradicting `f:44`). J2 checks every turn against canonical facts, the ledger and this list. Contradicting a canonical fact is a fidelity failure, never successful evasion (SUB-8).

### 7.5 Style factorial (SCN-3, PRB-4)

Axes and levels match S2 section 6.6; S2 owns the rendered wording, S1 owns the assignment.

| Axis | Levels in the hidden split | Extra level for practice |
| --- | --- | --- |
| verbosity | terse, expansive | moderate |
| fluency | fluent, disfluent | |
| affect | calm, anxious | |
| register | formal, informal | |
| language | native, second_language (OWNER DECISION PENDING) | |

Assignment for a split of n families (seeded, recorded). n is an input to the sampler and the factorial; nothing else depends on it. The planned hidden split is n = 15 (30 cases) baseline, or n = 17 (34 cases) if the dev pilot's measured costs track the expected column (S8 OD-8; README baseline; `cost_model.PLAN`, direction v10.4):

1. Each family gets one style; both variants share it. Role is therefore independent of style exactly, with no sampling error.
2. For every axis in use, each level goes to floor(n/2) or ceil(n/2) families (n = 15: 7 and 8; n = 17: 8 and 9).
3. Difficulty levels are balanced: each level gets floor(n/3) or ceil(n/3) families (n = 15: 5, 5, 5; n = 17: 6, 6, 5, the level with 5 chosen by the seeded draw in step 4).
4. Draw 10,000 balanced assignments with the recorded seed; keep the one that minimizes the largest absolute phi coefficient between any two axes and between any axis and any difficulty indicator. Record the seed, the chosen assignment and its largest phi in the family provenance.

If the owner declines `second_language`, the language axis is fixed to `native` and the remaining four axes are balanced; nothing else changes. If the owner approves it, language is balanced like the others and S2's wording rule applies (no caricature, meaning always clear). The basis for testing it is Lev-Ari and Keysar (2010): listeners rate accented statements as less credible (X1 Q3); the fairness audit checks whether assistants reproduce that bias (direction 7.2).

Style never reaches coaching: S2 excludes the style assignment from every assistant input (S2 5.1), and no investigator or assistant route returns it before reveal (S5 route and type test, C-26). It reaches the referee only for J2's `style_followed` check. The public packet carries no style or demeanor attribute (C-22).

### 7.6 Difficulty knobs and levels (SCN-2)

The validator computes five knobs from the packets; the family stores them and the two must agree.

| Knob | Definition | Matched across variants |
| --- | --- | --- |
| K `key_record_after_exchanges` | Over the decisive-support items, the smallest value of "latest predicate value among the item's records" (0 if all initial) | Yes, K equal |
| E `evidence_directness` | Fewest records in any decisive-support item | Yes, E equal |
| M `misleading_count` | Facts tagged `misleading` in the truthful variant | Family-level |
| U `uncertainty_count` | Uncertainty entries per variant | Yes, U equal |
| G `gate_level` | Lowest `min_evidence_level` among the deceptive variant's gates | Family-level |

| Level | K | E | M | G |
| --- | --- | --- | --- | --- |
| 1 | <= 2 | 1 | >= 1 | <= 2 |
| 2 | 3-4 | <= 2 | >= 2 | 3 |
| 3 | >= 5 | >= 2 | >= 2 | 4 |

The bands are initial values, tuned in the dev pilot: V6 (section 9.6) checks whether measured outcomes order by level, and the bands are revised on development data only, before hidden authoring.

## 8. Authoring pipeline (D-014; direction 6.4)

Case families are made once, offline, before the build needs them: Claude agents write them, code checks them, Codex reviews them. Nothing in the product generates a case, and `gemini-3.1-pro-preview` is not used anywhere. Claude and Codex are build-time tools, like the editor the code is written in; no non-Gemini model runs in the product (D-014, exception to D-001). Authoring makes no Vertex call, so it reserves nothing against the global ceiling and adds no cost line (`cost_model.CASE_AUTHORING = "offline"`; `cost_model.family_generation_calls()` returns no calls for the `d009` lineup).

```mermaid
flowchart LR
  SS["Seed sampler (code, seeded)"] --> B["Authoring brief (code): rules, one DEV design brief, seed spec"]
  B --> W["Claude agent writes FamilySource"]
  W --> A["Assembler (code): family JSON v1.1, six packets, IDs, hashes"]
  A --> V["V1, V2, V3a, V4, V5 (code)"]
  V -- fail --> W
  V -- pass --> C["Codex review CX-1..CX-4 (9.7)"]
  C -- fail --> W
  C -- pass, dev --> R["cases/dev/Fnn.json (repository)"]
  C -- pass, hidden --> H["cases/hidden/ (git-ignored, unread)"]
  R --> I["S4 sealed.ingest_case_family()"]
  H --> I
  I --> S["S4 sealed.seal_hidden_split() (hidden only)"]
```

### 8.1 Seed spec (deterministic, no model call)

`arena/scenario/seed.py` draws, from a recorded seed: `family_id` (dev: next `Fnn`; hidden: `H` plus 10 random hex), split, violation type (catalog in `case-family.schema.json#/$defs/violationType`, 8 types; at most ceil(n/8) hidden families per type: 2 for n = 15, 3 for n = 17), one to three misleading types (catalog `misleadingType`), difficulty level and knob targets, the style assignment (7.5), the presentation (`persona_id` from the portrait pool, whose entries carry a neutral one-line description that goes into the seed spec so the persona fits the portrait, and `voice_id` from the Live voice list; 4.1), the facility (from a list partitioned between dev and hidden, L4), the subject's occupation, an incident date (weekday, February to April 2026) and interview date (2 to 7 days later), and a list of names already used (persona names must be unique across all families). The agency is fixed: Brannock Administrative Services Agency (fictional).

### 8.2 Authoring brief (one per family)

`arena/scenario/brief.py` renders, per seed, a plain-text brief. The agent works from the brief, the `FamilySource` model and the commands that run the assembler and the validators; it is given no other case content.

| Block | Content |
| --- | --- |
| `RULES` (`prompts/scenario/authoring.rules.v1.txt`, hashed) | Task: author one synthetic case family for an investigative-interview training arena. Rules: fictional organizations, people and places only; administrative facility-access register; no violence, no protected-class traits as clues, no medical detail beyond a named condition category; demeanor and accent are never evidence; EX-4. Construction rules: atomic facts (F1-F5); matching rules M1-M6; truthful variant with each misleading fact explained exactly once and genuine uncertainty; deceptive variant with exactly one violation, one motive, one opportunity, one means, a true cover activity, the violation CORE and at least one gate; free evidence identical across variants; at most 4 initial documents and 6 releasable records; predicate values at most 10; EFM level definitions; knob targets; an open, neutral opening question and three replay topics (noun phrases of at most 12 words) written from public material only, with S2's relay-test rules (8.2) stated; no role or verdict words and no IDs in any record or public text; S2 guard vocabulary (G3-G5) never used in any text. |
| `DOMAIN` | Facility-access record vocabulary (X9 Q6 table) and the allowed record kinds |
| `EXAMPLE` | One development family rendered as a design brief (facts with variant marks and tags, edges, records with per-variant contents and support levels, ledger classes, gates, uncertainty, forbidden assertions, decisive support). Header: "Example from a different case. Do not reuse its people, places, records or events." Chosen from the dev pool with a different violation type from the seed; the renderer raises on any family whose split is not `dev` (L5). |
| `SEED` | The seed spec as JSON |

Revision rounds add the failing validator codes and messages and the Codex findings for this family only, never content from any other family. Measured size of a design brief from the v1.1 seeds (characters / 4, scratch `brief()` on each seed file): 2,306-2,989 tokens.

### 8.3 `FamilySource`: what the agent writes and what code derives

The family source is a Pydantic model (`arena/scenario/source.py`). The agent writes a source file that validates against it and runs the assembler, which emits the family JSON against schema v1.1. Patterns, lengths and constants are enforced by V1 against the full draft 2020-12 schemas. The agent never sets a code-owned field by hand: the assembler writes them and V2 recomputes them.

| Agent writes | Code derives |
| --- | --- |
| Title, objective, interview context (except agency), persona, known timeline, opening question, three replay topics | `case_id`s (random), `family_id` from the seed; `presentation` (`persona_id` and `voice_id` from the seed, `display_name` = the subject's name) |
| Facts (ID, statement, kind, time, actors, material, tags, variants) and edges | Both public packets (identical), `initial_documents` and `requestable_records` from records |
| Records: ID, kind, title, description, optional date, predicate, `content` and, when variant-specific, `content_deceptive`; supports per variant as source strength and precision | EFM levels, gate IDs, `precondition_records`, evidence links |
| Per variant: ledger (fact ID, certainty, second-person text), non-FREE classes (PRIVATE, CORE, HOLD with gate condition and level), relevant actions, unknown facts, uncertainty entries, forbidden assertions, concealment target, synopsis, contradictions, resolution criteria, rubric, turn-label guide | Objective text, permitted and forbidden behaviors, style (from the seed), limits, ground rules, canaries, knobs (computed, must match the seed's targets), evaluator `canonical_facts` and `event_edges` (filtered), provenance |

Provenance uses schema v1.1 as it stands: `method` `generator` (AI-authored), `generator_model` the authoring agent's model ID, `prompt_sha256` the brief hash, `seed_spec_sha256`, `few_shot_family_ids` the example family. F01-F03 keep `method` `hand`. The agent never chooses the case ID, the agency, the style, the presentation, the canaries or anything a validator computes.

### 8.4 Assembler

`arena/scenario/assemble.py` is deterministic: same source and seed, same family file. The reference implementation written for this spec (session scratchpad, used to build F01-F03 and rebuilt for schema v1.1) derives every field in the right column above; the build ports it. Canonical JSON for repository hashes is `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` encoded UTF-8 (gokbase `recruiter-backend/app/matching/rubrics.py` lines 60-61, `_canonical`), hashed with sha256. The brief hash covers the rules file, the example brief and the seed spec, as gokbase's `rubric_hash` folds scoring parameters into the hash (same file, lines 124-130).

### 8.5 Authoring loop

1. The agent writes the source, runs the assembler, then V1, V2, V3a, V4 and V5 (section 9), and revises until all pass.
2. Codex reviews the assembled family (9.7). A finding goes back to the agent, which revises and returns to step 1.
3. A family is accepted when the validators and the Codex review pass on the same family-file hash. A finding is resolved by changing the family, never by changing a validator, a check or a solve sheet.
4. A seed that has not passed after 5 rounds (initial value, tuned in the dev pilot) is discarded with its failure codes, and the sampler draws the next seed under the same quotas.
5. The authoring report records, per run, families accepted, seeds discarded, rounds per family and counts per failure code. For development families it also lists family IDs, file hashes and per-round codes; for hidden families it carries codes and counts only (L7).

Accepted development families are committed to `cases/dev/`; CI reruns V1-V5 on every change, and a changed development family goes through the Codex review again. Hidden families follow section 10.3.

## 9. Validators

All deterministic validators are pure functions of the family file and run in code: in the authoring loop on every family (8.5) and in CI on every development family. The Codex review (9.7) is the one non-deterministic check; it replaces the model checks V3b and V3c of v2.1. A reference implementation of V1 (with V1b and V1c), V2, V3a, V4a, V4b, V4c and V5 was written for this spec and run on the v1.1 seeds (section 11); a mutation suite of 29 deliberate defects (role word in a record, public packets differing, duplicate or extra records, wrong knob, time-order violation, wrong gate precondition, unreachable gate, other variant's case ID in public text, truthful HOLD fact, violation not CORE, unexplained misleading fact, second motive, real agency name, hidden split with a dev ID, fact ID in public text, skeleton drift, missing uncertainty entry, style mismatch, role label mismatch, wrong correct finding, scheduled record differing by variant; and for v1.1: `baseline_demeanor` in the presentation, two replay topics, a tag-question opening, a replay topic that makes a compound question, a non-neutral replay topic, display name differing from the subject name, presentation differing by variant, record date differing by variant) was caught 29 of 29 on F01. The build ports both and keeps the mutation suite as tests.

### 9.1 V1 Schema

The family file validates against `case-family.schema.json` (draft 2020-12, with the three packet schemas resolved by `$id`). V1b: no real agency, department or sponsor name anywhere in the file (deny list: the federal agencies Unissant serves per X6, NARA, GSA, OPM, IRS, FEMA, and Unissant itself). V1c, relay test (C-21): the replay script rendered from the public packet with no releases (S2 8.6: `opening_question` as row 1, `replay_topics` in rows 4, 5, 7, 9, 10 and 11), checked in row order with the repeat rule, and the evidence-slot question for every releasable record (its title and, when listed, its `date`) each pass S2 `relay_test.v1` (S2 8.2). The validator imports S2's relay-test module, so the two never drift; S2's AT-HAR-5 repeats the check in the build on every dev case.

### 9.2 V2 Fact-graph consistency

| Check | Rule |
| --- | --- |
| Facts | Unique IDs; edges reference existing facts sharing a variant; precedes and causes acyclic and time-ordered; relation-tag rules (section 5) |
| Packet agreement | Evaluator `canonical_facts` and `event_edges` equal the graph filtered by variant; public initial documents and requestable records equal the evaluator's records (ignoring the public-only `date`); timeline sources are initial documents; `matter` equals the objective; persona name and organization match the public context; `presentation.display_name` equals the subject name |
| Records | Unique IDs; at most 6 releasable; predicate values at most 10; supports point at facts in the variant; level matches strength and precision; same skeleton across variants (M3) |
| Ledger | Ledger facts, unknown facts and relevant actions are in the variant; ledger and unknown disjoint; PRIVATE exactly the `privacy`-tagged facts; violation is CORE; every HOLD fact names an existing gate and every gate opens only HOLD facts pointing at it; `precondition_records` equal the derived set and are non-empty; each approximate fact has exactly one range or unsure entry; `dont_know` entries point at unknown facts; forbidden assertions contradict facts in the variant; style equals the family style |
| Evaluator | Role equals variant; `correct_finding` equals role; truthful contradictions are `apparent`; every reference in contradictions, decisive support, corroboration, rubric resolves |
| Knobs | Computed K, E, M, U, G equal the stored knobs; K, E, U equal across variants; knobs inside the level's band (7.6) |

### 9.3 V3 Solvability (AR-Bench style)

V3a, structural (code):

| Variant | Check |
| --- | --- |
| Deceptive | Exactly one `violation` fact; exactly one `motive` with a `motivates` edge into it, one `opportunity` and one `means` with `enables` edges (the triple constraint that makes the culprit uniquely supportable, AR-Bench, arXiv 2506.08295 via X9 Q2); the violation is CORE; at least one gate, and every gate openable by exchange 10 |
| Truthful | No violation fact; each `misleading` fact has exactly one `explains` edge from an `innocent_explanation` fact; that explanation is in the subject's ledger or is supported by a record at level 2 or more (so the corroboration path exists, EX-3) |
| Both | At least one decisive-support item whose records can all be released by exchange 10 |

The semantic solves that were the model checks V3b and V3c are now Codex checks CX-2 and CX-3 (9.7); their inputs and pass rules are unchanged.

### 9.4 V4 Role leak

| Check | Kind | Rule |
| --- | --- | --- |
| V4a L1 | Code | Public packets identical except `case_id`. A role guesser on the public packet is at exactly 50% per family, so the direction's model-based public-packet check is redundant and is not run. Cues a lexical scan misses are Codex check CX-4 (9.7). |
| V4a L2 | Code | Initial and scheduled record contents identical across variants, so the free-evidence bundle is also exactly uninformative |
| V4b lexical | Code | No match in any public-tier string (public packet plus every record title, description and content) for role or verdict words (`deceptive`, `deception`, `truthful`, `guilty`, `innocent`, `perpetrator`, `culprit`, `liar`, `lying`, `lied`, `role label`, `scoring key`, `evaluator`), ledger or evaluator IDs (`[fugxcrqal]:NN`), the other variant's case ID, or a real agency name |
| V4c guard vocabulary | Code | No public or subject-renderable private string (persona, matter, ledger text, uncertainty text, gate conditions, record contents) matches S2 guard rules G3, G4 or G5 (S2 6.2 obligation on the case author, 6.9). Ground rules are excluded: they are platform text never rendered to the subject. |

### 9.5 V5 Diversity

| Check | Rule |
| --- | --- |
| Signature | Within a split, no two families share (violation type, first misleading type) |
| Lexical | Jaccard similarity of word 3-gram sets over all fact statements is at most 0.20 (initial value, tuned in the dev pilot) for every pair within a split and for every hidden-dev pair (seeds measured 0.001-0.003, scratch `validate.py` `shingles()`) |
| Names | Persona names unique across all families; hidden facilities drawn from a list disjoint from dev facilities |
| Coverage | A hidden split of n families covers at least ceil(n/2) violation types and every difficulty level |

The case-authoring pilot (WP-09: F04, F05) computes pairwise values for authored families, and the threshold is set from development data only. For a hidden split, V5 runs inside the isolated authoring session against the development files and reports counts only.

### 9.6 V6 Pilot difficulty (development families only)

Run once, on the dev pilot (direction 3.2, Oct 19-22; 10 cases). Per family and level: the share of committed findings that are correct across the nine pairings, per variant; the median exchange at which the running finding first becomes correct; the subject fidelity rate (S3). Bands for the role-pooled correct share (initial values, tuned in the dev pilot): level 1 0.60-0.95, level 2 0.40-0.85, level 3 0.20-0.70, with level means ordered 1 > 2 > 3. A family outside its band is relabeled or revised (development data only); if a whole level misses, the knob table (7.6) is revised before any hidden family is authored. Hidden families are never piloted: running them before the tournament would expose them (SCN-12). Their difficulty rests on knob compliance (V2), V3a and the Codex solves CX-2 and CX-3.

### 9.7 Codex review (replaces V3b and V3c)

Codex reviews every family after the deterministic validators pass, in two sessions per round so that the solves stay blind to the key.

| Check | Session and input | Pass |
| --- | --- | --- |
| CX-1 Ground-truth consistency | Review session: the whole family file and the rules file | Per variant, the synopsis, facts, edges, record contents, ledger text, forbidden assertions and resolution criteria tell one story; no record content contradicts a canonical fact; names, times and places agree across records; every forbidden assertion is false in its variant |
| CX-2 Full-information solve, per variant (was V3b) | Solve session: a solve sheet built by code with no evaluator or private packet and no variant label, holding the public packet, every record's content as if released, and an account sheet built from the rubric's key questions (each `neutral_example` question followed by the subject's answer: the ledger text of its FREE and HOLD targets with all gates treated as presented, "declined: personal matter" for PRIVATE targets, "no direct answer" for CORE targets). Output per sheet: `{finding: truthful \| deceptive \| insufficient_evidence, cited_records[], basis (60 words max)}` | Code compares: `finding` equals the correct finding and `cited_records` intersects the union of the variant's decisive-support records. This is the MuSR practice of checking each case against its own reasoning key (arXiv 2310.16049 via X9 Q2). |
| CX-3 Misleading check, truthful only (was V3c) | Solve session: a sheet with the public packet, the free evidence, every on-request record that does not support an `innocent_explanation` fact at level 2 or more, and an account sheet without the innocent-explanation facts | Code compares: `finding` is `deceptive` or `insufficient_evidence`. The misleading circumstances look suspicious before corroboration (SCN-11), and the corroboration path, not the free evidence, is what clears the subject. |
| CX-4 Role leakage | Review session | No public-tier string, free-evidence record, opening question, replay topic, record title or description cues the role, and no on-request record states a verdict or the role rather than evidence. Complements V4's lexical scans. |

The review session returns `{verdict: pass | fail, findings: [{code: CX-1 | CX-4, refs: [IDs], note}]}`; the round passes when its verdict is `pass` with no findings and the code comparison passes CX-2 and CX-3 on every sheet. For a hidden family both sessions run inside the isolated authoring session and only codes and counts leave it (L7).

## 10. Splits, sealing and leakage (SCN-12)

### 10.1 Split plan

| Split | Count | Use |
| --- | --- | --- |
| Development | 9 families (18 cases): F01-F03 hand-authored (this spec) and 6 authored through section 8: F04 and F05 in the case-authoring pilot (direction 13.1 item 3; with F01-F03 they make the 5-family, 10-case dev pilot) and 4 for KPI-1 case sets (WP-26, C-43; `cost_model.KPI1_EXTRA_DEV_FAMILIES`). Stored in the repository under `cases/dev/`. | Slice, dev pilot, prompt tuning, judge calibration, practice mode, KPI-1, voice sessions (direction 9) |
| Hidden | 15 families (30 cases) baseline; 17 families (34 cases) if the dev pilot's measured costs track the expected column (S8 OD-8; README baseline, `cost_model.PLAN`, direction v10.4). Authored by isolated agents into the git-ignored `cases/hidden/` (10.3). | Sealed tournament only |

n (the number of families in a split) is an input to the seed sampler (8.1), the style and difficulty factorial (7.5), the diversity checks (9.5) and the seal (10.3); no S1 rule is written for one value of n.

### 10.2 Leakage rules

| Rule | Statement | Enforced by |
| --- | --- | --- |
| L1 | Public packets identical across variants except `case_id` | V4a |
| L2 | Free evidence identical across variants | V4a |
| L3 | Opaque IDs: random `case_id`; S4 `variant_code` = `case_id`; hidden `family_id` random; fact and gate IDs never in public text | Assembler, loader, V4b |
| L4 | Disjoint families: no shared family ID, persona name or facility between splits; hidden-dev lexical similarity at most 0.20 | V5 |
| L5 | The authoring brief's example comes only from families with `split = dev`; the brief renderer raises on any other; a hidden family never becomes an example within its tournament. After reveal it may move to development for a later tournament only. | Unit test AC-S1-20 |
| L6 | Hidden plaintext exists only in the git-ignored `cases/hidden/` directory, the isolated authoring session's own transcripts (Claude and Codex) and the sealed schema. The loader ingests from the directory with the `arena_referee` credential through `sealed.ingest_case_family`; its Phoenix spans carry no bodies and go to the restricted `ops.trace_mirror` (direction 10). After the seal is committed, the directory and those transcripts are deleted; the sealed schema is the copy of record. Nothing hidden reaches the repository, CI artifacts or logs. | `.gitignore`, sealing sequence (10.3), AC-S1-21 |
| L7 | Nobody reads hidden contents before reveal: not the team, not the orchestrating session. Validator and Codex output for hidden families leaves the isolated session as codes and counts only (OD-2 pending on any exception). Disclosed on the methodology page (D-014). | Authoring report format, AC-S1-24 |
| L8 | No retrieval index exists for candidates; prompt files contain no case content (S2 3.4) | S2, S4 isolation gate |
| L9 | Tuning only on development cases: candidate manifests freeze after the seal; the referee's 8-gram scan of prompts against hidden content (S2 3.4) and the canary audit (S3 IG-6) run before the tournament leaves `frozen` | S2, S3, S4 |
| L10 | Hidden debriefs, exports and spans locked until reveal | Direction 4.1, S4 views |
| L11 | Practice and KPI-1 sessions during a tournament use development cases only | S4 `arena.tg_packet_split` (hidden public packets live in `sealed`) |
| L12 | Seal before freeze: the hidden split is sealed before the tournament roster freezes, and the seal hash is published | S4 `sealed.seal_hidden_split()` |

### 10.3 Sealing sequence

1. The operator starts an isolated authoring session: a Claude agent whose transcript the team and the orchestrating session do not read, working only in `cases/hidden/`, given n and the repository's authoring code and rules. Inside it, the sampler draws the hidden seed specs and the style and difficulty assignment (7.5) from one recorded seed, kept in each family's provenance.
2. The agent authors each family through the loop (8.5) with the Codex review (9.7) run from the same session; the session returns only the authoring report (codes and counts). The loader ingests each accepted family with `sealed.ingest_case_family()` (refuses a hidden family once the split is sealed, AR001; refuses a re-ingest with different content, AR003).
3. When the planned count has passed, call `sealed.seal_hidden_split()`. It hashes, in Postgres, one line per hidden variant (`family_code:variant_code:public_sha:private_sha:evaluator_sha:artifacts_sha`, sorted, newline-joined; S4 `0002_cases.sql`, `sealed.hidden_split_digest()`), stores the seal once and appends a public ledger event. The pattern is TechnoMile's sealed holdout: hash the sorted case list before anything is scored and verify coverage against that hash at the end (`supabase/migrations/20260928001100_holdout_scoring.sql` lines 1-14, 16-24, 115-150; `packages/core/src/bh_core/analytics/bidders/backtest/lock.py` lines 63-64; `tools/anl_backtest.py` lines 19-20).
4. Commit the seal hash, the family count and the authoring report to the repository (published commitment); delete `cases/hidden/` and the isolated session's transcripts (L6); then freeze candidates (L12).
5. At reveal, `sealed.verify_hidden_seal()` must return true (S4); hidden family files are exported for audit. Because S4 hashes `jsonb::text`, outside verification re-ingests the exported files into a scratch database and compares digests.

The repository-level `sha256` of a family file (section 11) is an integrity check for development files, not the seal.

## 11. Seed families (development, never hidden)

All three use the fictional Brannock Administrative Services Agency, Halvern Street Annex. Validation status of the files as committed (schema v1.1, rebuilt 2026-10-08 by the scratch assembler): V1 (with V1b and V1c), V2, V3a, V4a, V4b, V4c and V5 pass; The Codex review (9.7) has not been run on them; it runs in the case-authoring pilot (WP-09). The v1.1 rebuild changed only the public packets: every private and evaluator packet hashes the same as in v1.0.

| Family | Title | Violation (deceptive) | Misleading (truthful) | Level | K, E, M, U, G | Style |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | Records vault entry during a busy shift | Entered the vault with no task and broke a sealed bid box to read evaluations for a contract his cousin's firm is bidding on | Late work order, door-held alarm, vault off his roster, supervisor unsure which room she named | 2 | 3, 1, 3, 2, 3 | terse, fluent, anxious, informal, native |
| F02 | After-hours entry with a double count | Brought her unregistered partner onto the restricted records floor | Tailgate sensor double count (known wet-weather fault), camera outage, private medical reason for the visit | 1 | 2, 1, 2, 1, 2 | expansive, disfluent, calm, formal, native |
| F03 | Network room entry on another person's card | Used a colleague's lent personal badge after her own access lapsed | Card still listed to its former holder (records backlog), her own access suspended, private performance plan | 3 | 5, 2, 2, 2, 4 | expansive, fluent, anxious, formal, second_language |

| Family | Case IDs (truthful, deceptive) | Facts (T, D) | Ledger classes, deceptive | Releasable records (predicate) | Gates (deceptive): opens, level, openable after |
| --- | --- | --- | --- | --- | --- |
| F01 | C-7Q2MXK4D, C-H3N8RW5B | 22, 24 | 13 FREE, 2 HOLD, 3 CORE | rec-01 work orders (request, 2); rec-02 radio log (request, 3); rec-03 alarm history (request, 3); rec-04 seal audit (request, 6); rec-05 supervisor statement (scheduled, 5) | g:01 f:44 no B-12 task, 3, 2; g:02 f:49 reseal, 4, 6 |
| F02 | C-K9TB2ZQF, C-4XVM7HPA | 19, 22 | 10 FREE, 1 PRIVATE, 2 HOLD, 3 CORE | rec-01 visitor register (request, 2); rec-02 elevator trip records (request, 2); rec-03 floor-3 door log (request, 2); rec-04 custodian statement (request, 4); rec-05 sensor notice, context change (scheduled, 3) | g:01 f:40 partner came in, 2, 2; g:02 f:46 left together, 3, 2 |
| F03 | C-R6DJ3NWC, C-PA8E5TKY | 17, 18 | 11 FREE, 1 PRIVATE, 3 HOLD, 3 CORE | rec-01 lockbox sheet (request, 5); rec-02 badge record (request, 5); rec-03 incident ticket (request, 3); rec-04 card holder's email (request, 7); rec-05 OP-7, clarification (scheduled, 4) | g:01 f:43 no sign-out, 4, 5; g:02 f:44 card active, 4, 5; g:03 f:40 badge lent, 4, 7 |

Public packet v1.1 fields (shared by both variants of each family):

| Family | `presentation` (persona, display name, voice) | `opening_question` | `replay_topics` | Record `date` |
| --- | --- | --- | --- | --- |
| F01 | `persona-01`, Jordan Pell, `Charon` | "Can you describe, in your own words, what you did at the Halvern Street Annex on the afternoon of 12 March 2026?" | your entry to Records Vault B-12 at 14:07; the vault door being held open from 14:09 to 14:12; your tasks during the 12 March afternoon shift | none (every title carries its date) |
| F02 | `persona-02`, Mara Quell, `Kore` | "Can you describe, in your own words, what you did at the Halvern Street Annex on the evening of 10 March 2026?" | your entry through the east staff door at 19:42; the tailgate sensor counting two people at the east staff door; where you went inside the building that evening | none (every title carries its date) |
| F03 | `persona-03`, Avery Lindqvist, `Aoede` | "Can you describe, in your own words, what you did at the Halvern Street Annex on the morning of 13 March 2026?" | the entry to Network Room N-3 at 07:12; the switch SW-2B outage that morning; the badge record for card A-2291 | rec-03 incident ticket, 2026-03-13 |

Portrait IDs are placeholders until the art pool exists (WP-21); voice names are from the Live voice list (Vertex "Configure language and voice", fetched 2026-10-08) and are confirmed by the day-1 Live probe.

Repository hashes (canonical JSON, sha256) as committed in v2.1: F01 `520179a844f8459f6738ee41a9b0613f8358cf2cd13ceedff0d5c13ae9bccf11`; F02 `4a50ce85c5aac620f71d6abaf941361cb7e92c3ce0adb4d37da828cd81af6255`; F03 `9d8137aaaedbd86098f56017af6aef1906adbc875eeb4521909ea2b3973d6461`. Any edit changes them; CI recomputes.

### 11.1 F01 and the slide-8 situation (EX-1 to EX-3)

| Deck | In F01 |
| --- | --- |
| EX-1: "Why did you enter?" / "It was a busy shift." | The public packet shows a 14:07 vault entry during a short-staffed shift (doc-01, doc-03). The style is terse and anxious in both variants. A truthful Pell gives brief context; a deceptive Pell deflects on HOLD fact f:44 (no B-12 task). The label guide marks the first as `responsive` (an assistant should flag it non-responsive, not as possible evasion) and the second as `evasion`. |
| EX-2: flag "purpose of entry is unanswered", follow-up "What task required entry?" | Key question q:01 targets the purpose (f:22 truthful, f:44 deceptive) with exactly that neutral example. |
| EX-3: "More evidence needed. Verify the work order and timeline." | `corroboration_to_name` lists rec-01 (work orders), rec-02 (radio log), rec-03 (alarm history). In the truthful variant the work order was logged at 14:31, after the 14:07 entry: misleading on its own, explained by the 14:01 radio dispatch naming B-12 and by the supervisor's practice on short shifts. In the deceptive variant the same records put the dispatch in B-10, finished at 14:05, before the B-12 entry. |

Genuine uncertainty (SCN-11): truthful Pell does not know the exact minute he left (range) or whether his radio call went through (unsure), and does not know when the work order was logged.

### 11.2 F02 and F03 in brief

F02 tests the privacy boundary and a known sensor fault. Truthful Quell came back alone in the rain for medication she keeps private; her umbrella produced the double count and the facilities notice (scheduled after exchange 3) explains it; the elevator record (rec-02) shows one person. Deceptive Quell brought her partner up to the records floor; the same notice is a distractor, and rec-02 shows two people both ways. Declining to name the medical condition is `legitimate_non_disclosure` in both variants and is listed as an unsupported ground.

F03 is the hard level. Free evidence (the badge log listing card A-2291 to a colleague on leave, her own access suspended the evening before, the OP-7 clarification) looks equally bad in both variants. The truthful account (spare card signed out under OP-7; the card's holder name never updated) is corroborated only by combining rec-01 and rec-02, available after exchange 5. The deceptive subject's gates need level-4 evidence, the earliest after exchange 5. Second-language style exercises the PRB-4 fairness audit if the owner keeps that axis.

## 12. Acceptance criteria

| ID | Criterion | Test |
| --- | --- | --- |
| AC-S1-01 | Every development family file validates against `case-family.schema.json` v1.1 with the three packet schemas resolved by `$id` (draft 2020-12) | CI: `jsonschema` Draft202012Validator over `cases/dev/*.json` |
| AC-S1-02 | V2 passes on every development family | CI: validator unit tests plus the seed files |
| AC-S1-03 | V3a passes on every family; the deceptive variant fails V3a when a second motive edge is added | CI mutation test |
| AC-S1-04 | The Codex review (CX-1 to CX-4) passes for every family before ingest, on the same family-file hash as the final validator pass | Authoring report: per-family pass codes (dev), pass counts (hidden) |
| AC-S1-05 | Every ledger fact is in the variant's canonical facts; every approximate fact has exactly one range or unsure entry; the violation is CORE | CI mutation tests "violation not CORE", "approximate without uncertainty" |
| AC-S1-06 | Every gate's `precondition_records` equals the derived set and is non-empty; the subject ledger shows a gate LOCKED until one of them is released, and a tag opening a LOCKED gate is rejected (C-20) | CI mutation tests "gate precondition wrong", "gate unreachable"; S2 AT-SUBJ-3 and AT-SUBJ-4 on the F01 fixture |
| AC-S1-07 | Every evaluator packet has a resolution with `correct_finding` equal to its role, at least one decisive item, `corroboration_to_name`, unsupported grounds and at least two label-guide entries | V1 plus V2; mutation "resolution wrong" |
| AC-S1-08 | `release_evidence()` with a request before `after_exchanges` denies; at or after it releases once; a second request returns `already_released` | S4 tests RE-xx, run on the F01 fixture |
| AC-S1-09 | No predicate value exceeds 10; no case has more than 6 releasable records (schema pattern `rec-0[1-6]`, V2 count, S4 AR006) | CI mutation "seven releasable"; S4 test |
| AC-S1-10 | A scheduled record (F02 rec-05 context change, F03 rec-05 clarification) is released on the first call after its `after_exchanges` with no request, with a ledger event | S4 test on F02, F03 fixtures |
| AC-S1-11 | Packets are immutable after ingest; a trial's finalize hashes match the stored packets | S4 tests CS-xx |
| AC-S1-12 | Public packets of a family's variants are equal except `case_id` | CI mutation "public packets differ" |
| AC-S1-13 | No role word, ledger ID, other-variant case ID or real agency name in public-tier text; no S2 G3-G5 match in subject-renderable text | CI mutations "role word in a record", "fact id in public text", "other case id", "real agency"; guard scan |
| AC-S1-14 | Computed knobs equal stored knobs and sit inside the level band; K, E, U equal across variants | CI mutation "knob mismatch" |
| AC-S1-15 | Style identical in both variants of every family | CI mutation "style differs" |
| AC-S1-16 | For a hidden split of n families, every style level appears in floor(n/2) or ceil(n/2) families, every difficulty level in floor(n/3) or ceil(n/3), and the recorded largest phi is at most 0.40 (initial value, tuned in the dev pilot) | Authoring report (counts) |
| AC-S1-17 | Every misleading fact in a truthful variant has exactly one innocent explanation reachable by the subject or a record at level 2 or more | CI mutation "unexplained misleading fact" |
| AC-S1-18 | No family ID, persona name or facility is shared between dev and hidden; pairwise hidden-dev word 3-gram Jaccard at most 0.20 | Authoring report V5 counts |
| AC-S1-19 | A hidden family file with a dev-style ID, or a dev family with a hidden-style ID, fails V1 | CI mutation "hidden split with dev id" |
| AC-S1-20 | The brief renderer raises when given an example family whose split is not `dev` | Unit test with a hidden-split fixture |
| AC-S1-21 | After hidden authoring, no hidden family text (any 8-gram of its packets) appears in the repository, CI artifacts, logs or judge-visible Phoenix; `cases/hidden/` is git-ignored and is gone after the seal commit | Referee scan at freeze (S2 3.4) plus canary audit (S3 IG-6), zero hits; `git check-ignore cases/hidden/x.json` succeeds |
| AC-S1-22 | `sealed.seal_hidden_split()` runs before roster freeze; its hash is committed to the repository before any candidate manifest is frozen | Ledger event order; git history |
| AC-S1-23 | `sealed.verify_hidden_seal()` returns true at reveal | S4 reveal precondition |
| AC-S1-24 | A hidden authoring report holds codes and counts only (no family ID, text or free-text field); authoring makes no Vertex call | Schema test on the report model; `cost_model.family_generation_calls(LINEUPS["d009"], hidden=True)` is empty |
| AC-S1-25 | F01 contains the slide-8 exchange path: key question q:01 with neutral example "What task required entry?", label-guide entries for "It was a busy shift" in both variants, and `corroboration_to_name` naming the work orders and the radio log | Fixture test on `cases/dev/F01.json` |
| AC-S1-26 | The assembler is deterministic: the same source and seed produce byte-identical family files | Unit test, two runs |
| AC-S1-27 | Every family's opening question, its replay script rendered from `replay_topics` and its evidence-slot questions pass S2 `relay_test.v1` (V1c, C-21) | CI mutations "tag-question opening", "compound replay topic", "non-neutral replay topic", "two replay topics"; S2 AT-HAR-5 |
| AC-S1-28 | Both variants carry the same `presentation`; `display_name` equals the subject name; no `baseline_demeanor` or other style-like key exists in any public packet (C-21, C-22) | CI mutations "presentation differs by variant", "display name differs", "baseline_demeanor in presentation"; S6 FE-AV-3 |

## 13. Interfaces with other parts

| Part | Contract S1 provides | Contract S1 relies on |
| --- | --- | --- |
| S2 (agents and prompts) | Private packet is a superset of `SubjectPacket` (classes, gates with conditions and `precondition_records`, uncertainty with answer forms, style axes, ID formats); public packet v1.1 `opening_question` (8.1), `replay_topics` and record `date` (8.6), `presentation.voice_id` (9.2) | Ledger rendering with LOCKED, CLOSED and OPEN gates and V2 rejecting a LOCKED gate (6.7, 6.8; C-20), role blocks, guard G1-G7, `relay_test.v1` (8.2, used by V1c), replay script requesting each requestable record at its first eligible exchange (8.6; C-23) |
| S3 (scoring) | `resolution_criteria`, `unsupported_grounds`, `corroboration_to_name`, rubric notes per EVL-7 dimension, `turn_label_guide` as calibration and review material, canaries | Shared 0-4 anchors, label definitions, IG-6 canary audit |
| S4 (SQL, `docs/spec/sql/`) | Ingest bundle mapping with `doc_kind` (4.4; C-24); release predicate semantics (6.2, 6.3) | `sealed.ingest_case_family`, `arena.release_evidence`, `seal_hidden_split`, `verify_hidden_seal`, immutability triggers, the `variant_code` shape check (C-25) |
| S5 (backend) | `presentation.voice_id` for the Live session (7.4); style held in `arena.case_variants` | Route and type test that no investigator or assistant route returns style before reveal (C-26); public packet projection that carries record `date` to the evidence event |
| S8 (build plan) | Authoring pipeline (8) for WP-09 and the case-authoring pilot (F04, F05); hidden authoring and seal (10.3) for WP-27 | `cases/hidden/` listed in `.gitignore`; methodology-page disclosure of offline authoring (D-014) |
| S6, S7 (UI, demo) | F01 as the slide-8 dev case; `presentation` per family (6.4); `requestable_after_exchanges`, titles, kinds, `doc_kind` and optional `date` for the evidence board | Practice mode on development cases only; neutral portrait with no demeanor input (C-22) |

## 14. Open questions and proposed fixes

| # | Issue | Status in v2.1 |
| --- | --- | --- |
| 1 | A gate must not open before a linked record is released, or a bluffing investigator could open it. | Closed (C-20): S2 renders such a gate LOCKED and its V2 rejects `gates_opened` for it (6.4). |
| 2 | With identical scheduled records across variants (L2), a replay script that used only scheduled releases would carry no discriminating evidence (BKO-6). | Closed (C-23): S2 8.6 requests each requestable record at its first eligible exchange (6.3). |
| 3 | S4's artifact `kind` has four values, so the evidence board would lose S1's document kind. | Closed (C-24): S4 adds nullable `doc_kind`; the loader fills it (4.4). |
| 4 | `arena.case_variants.variant_code` is public tier; a loader that wrote the role there would leak it. | Closed (C-25): loader rule L3 plus S4's shape check (4.4). |
| 5 | Direction 4.1 lists style as subject-private, but it is stored in public-tier `arena.case_variants`. | Closed (C-26): kept there for the fairness audit (it cannot leak role); S5's route and type test keeps it out of every investigator and assistant response before reveal (4.4, 7.5). |
| 6 | A validator failure costs a second Pro call plus three validation calls, which `cost_model.py` does not count. | Closed (D-014): no generation or validation model call exists; authoring is offline and costs nothing on GCP (8). The authoring report records rounds per family. |
| 7 | Two few-shot briefs would push the generation prompt past the 10,000-token conservative input. | Closed (D-014): there is no Vertex prompt; the brief carries one example (8.2). |
| 8 | On-request records in deceptive variants can be close to decisive alone (F02 rec-02 elevator count), so an assistant could classify from records without coaching well. | Accepted by design: requesting the right record is part of evidence-based follow-up (EVL-7). AST-10 and questioning-quality scoring keep coaching quality in the ranking; V6 reports how often records alone decided a dev trial. |
| 9 | KPI-1 needs two matched case sets plus practice cases, all from development families the participant has not seen. | Closed (C-43): 9 development families (10.1); the 4 KPI-1 families are authored through section 8 (D-014) and make no Vertex call. |
| 10 | S2's J1 does not read `turn_label_guide`. | Closed without an S2 change: the guide is reference material for dev-pilot review and calibration answer keys (4.3); J1 labels from S3's guideline alone. |
| 11 | The semantic solves (V3b and V3c in v2.1, CX-2 and CX-3 now) were not executed on the seeds. | Open: the Codex review (9.7) runs on F01-F03 in the case-authoring pilot; a failure is fixed in the seed, never by relaxing the check. |

## 15. Owner decisions pending

| # | Question | Design under either answer |
| --- | --- | --- |
| OD-1 | May the hidden split use the `second_language` style level? | Yes: language is a balanced fifth axis. No: language fixed to `native`, four axes balanced. F03 stays a development family either way. |
| OD-2 | May any person inspect hidden families before reveal (for example a case steward)? | Default no: validators and Codex report codes and counts only. If yes: the steward is named, is excluded from candidate tuning, and each inspection is a ledger event. |
| OD-3 | Hidden family count (S8 OD-8): 15 (30 cases) baseline, or 17 (34 cases) if the dev pilot's measured costs track the expected column | Seed sampler, factorial and validators take n as input; nothing else changes (7.5, 8.1, 10.1). |

## 16. Sources

- Requirements: `docs/challenge/REQUIREMENTS.md` (SOL-4, SCN-1..12, SUB-1..8, EX-1..4, EVL-7, EVL-8, BKO-6..10, PRB-4, AST-10).
- Baseline and decisions: `docs/spec/README.md`; `docs/handoff/DECISIONS.md` D-011, D-012, D-013, D-014; `docs/spec/review-v2-crosscheck.md` (X-01); `docs/spec/S8-build-plan.md` section 9 (C-01, C-16, C-20 to C-26, C-43).
- Direction: `docs/research/synthesis/02-direction.md` v10.4, sections 3, 4.1, 4.2, 4.6, 6.2, 6.4, 7.2, 8, 10, 13.1; `docs/research/synthesis/cost_model.py` names `MAX_RELEASES`, `CASE_AUTHORING`, `family_generation_calls()` (no calls for `LINEUPS["d009"]`, D-014), `KPI1_EXTRA_DEV_FAMILIES`, `PLAN`, `budget_plan()` (`--plan-json` prints `{"global": ...}` only, D-013).
- Research: X9 Q1 (Evidence Framing Matrix; Li et al. 2026 RCT), Q2 (MuSR arXiv 2310.16049; AR-Bench arXiv 2506.08295), Q3 (disclosure-gated simulation arXiv 2609.00982; LH-Deception arXiv 2510.03999; SOTOPIA-TOM arXiv 2605.02307), Q4 (evasion annotation, SemEval-2026 Task 6 agreement), Q6 (facility-access record vocabulary); X1 Q1-Q5 (SUE, Vrij, Mendez Principles, DePaulo 2003, Bond and DePaulo 2006, Lev-Ari and Keysar 2010, Bavelas 1990); X2a Q2-Q3 (persona drift, LedgerAgent); I1, I3.
- Parallel parts (v2): `docs/spec/S2-agents-and-prompts.md` sections 1, 6.2-6.9, 7.1, 8.1-8.7, 9.2, 9.3; `docs/spec/S3-scoring-rubrics-metrics.md` IG-6 and section 7; `docs/spec/S5-backend-and-lift.md` 1.2, 5.5, 7.4; `docs/spec/S6-frontend-ux.md` 4.4, 6.4; `docs/spec/sql/0002_cases.sql` (`arena.case_variants`, `sealed.evidence_artifacts`, `sealed.ingest_case_family`), `0004_privileged_functions.sql` (`arena.release_evidence`, turn order header), `TESTS.md`.
- Lifted patterns (read-only repositories):
  - TechnoMile `services/run/src/bh_run/tail/roleplay.py` lines 128-139 (`persona_slice`).
  - TechnoMile `supabase/migrations/20260928001100_holdout_scoring.sql` lines 1-14, 16-24, 115-150 (sealed holdout, coverage proof).
  - TechnoMile `packages/core/src/bh_core/analytics/bidders/backtest/lock.py` lines 63-64 (`case_list_digest`); `tools/anl_backtest.py` lines 19-20 (`seal`).
  - gokbase `recruiter-backend/app/matching/rubrics.py` lines 60-61 (`_canonical`), 124-130 (`rubric_hash`).
- Live voices: Vertex AI "Configure language and voice" (docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/configure-language-voice, 30 prebuilt `voice_name` values), via Google Developer Knowledge MCP, 2026-10-08.

## Changes in v2.1

S1 had not been reconciled in spec v2 (cross-check X-01, blocker). v2.1 reconciles it to the README baseline, direction v10.3, D-011 to D-013 and S8 section 9, and matches the names S2 v2, S4 v2 (`sql/0002_cases.sql`, `sql/0004_privileged_functions.sql`), S5 v2 and S6 v2 already consume.

| C-ID or item | What changed |
| --- | --- |
| X-01 | Version line, governing sources and decision range (D-001 to D-013) updated; every item below applied; seeds rebuilt and re-hashed. |
| C-01 | Split plan (10.1): 9 development families (F01-F03, 2 from the case-generation pilot, 4 for KPI-1); hidden 12 families (24 cases) baseline, 15 (30) pilot-gated under OD-8. n is an input everywhere; balance rules stated for n = 12 and 15 (7.5); violation-type quota restated without n = 10 (8.1); OD-3 points at S8 OD-8. |
| C-16 | ID formats (2): database key (`trial_id`, `turn_no`), model-facing `tNN`, UI `T{n}` display only, `rec-NN`, `doc-NN`; portrait IDs `persona-NN`. |
| C-20 | Gate status LOCKED, CLOSED, OPEN (6.4, terms, decision 5); S2's V2 rejects `gates_opened` for a LOCKED gate; open question 1 closed; AC-S1-06 cites S2 AT-SUBJ-3 and AT-SUBJ-4. |
| C-21 | `public-packet.schema.json` v1.1: required `presentation {persona_id, display_name, voice_id}`, `opening_question`, `replay_topics` (exactly 3, at most 12 words each), optional `date` on requestable records; `case-family.schema.json` v1.1. New validator V1c runs S2 `relay_test.v1` on the rendered replay script and evidence-slot questions; V2 checks `display_name`. F01-F03 carry the fields (11) and are re-hashed; their private and evaluator packets are unchanged. AC-S1-27 and AC-S1-28 added. |
| C-22 | No `baseline_demeanor` or style-like field in any public packet (4.1, 7.5); `presentation` has `additionalProperties: false`; mutation test added. |
| C-23 | Replay corpus requests each requestable record at its first eligible exchange through `release_evidence()` (6.3); open question 2 closed. |
| C-24 | Loader fills `doc_kind` with the S1 record kind (4.4); open question 3 closed. |
| C-25 | Loader rule L3 plus S4's `variant_code` shape check (4.4); open question 4 closed. |
| C-26 | Style stays in `arena.case_variants`; S5's route and type test keeps it out of investigator and assistant responses before reveal (4.4, 7.5); open question 5 closed. |
| C-43 | KPI-1 families counted in the development split (10.1); open question 9 closed. |
| D-013 | Generation reserves against the one global ceiling (8.5, AC-S1-24); costing regenerations and the KPI-1 families is deferred (D-013); no cost line added. |
| Release timing | 6.2 and 6.3 follow S4 v2.1's turn order (a release call on every question, refused only while coaching is pending) instead of v1's "no open question" rule; citations by function name instead of line numbers. |
| Turn-label guide | Open question 10 closed without an S2 change: the guide is dev-pilot review and calibration material; J1 does not read it (4.3). |
| Numbers | Thresholds labeled "initial value, tuned in the dev pilot" (knob bands, Jaccard 0.20, V6 bands, phi 0.40); brief and source sizes re-measured on the v1.1 seeds; `cost_model.py` cited by name. |
| Verification | Scratch scripts (`assemble.py`, `src_f01..f03.py`, `build.py`, `validate.py`, `relay.py`, `mutate.py`, `brief.py`, `guardscan.py`) updated for v1.1: F01-F03 pass every deterministic check; mutation suite 29 of 29 caught; guard scan 0 hits; no model, GCP or Vertex call made. |

## Changes in v2.2

D-014 (owner): case families are authored once, offline, by Claude agents with Codex review; no runtime generator and no `gemini-3.1-pro-preview`.

| Item | What changed |
| --- | --- |
| Section 8 | Generator pipeline rewritten as the authoring pipeline: per-family authoring brief (rules, one dev design brief, seed spec; 8.2), the agent writes `FamilySource` and runs the assembler to produce the family JSON v1.1 (8.3, 8.4), authoring loop until the validators and Codex both pass, bounded at 5 rounds (initial value, tuned in the dev pilot; 8.5). Vertex call configuration, response-schema lint and prompt token limits removed. Provenance fits schema v1.1 unchanged (`method` `generator` = AI-authored). |
| Section 9 | V1, V2, V3a, V4, V5 run in code; the model checks V3b and V3c are replaced by the Codex review CX-1 to CX-4 (9.7: ground truth, blind full-information solve, misleading check, role leak); V4a's model role-guesser demonstration dropped. |
| Section 10 | Hidden families authored by an isolated agent into git-ignored `cases/hidden/`, ingested, sealed, then the directory and session transcripts deleted (L6, 10.3); hidden validator and Codex output is codes and counts only (L7); dev families in `cases/dev/` (10.1). |
| Counts | Hidden split 15 families (30 cases) baseline, 17 (34) pilot-gated (7.5, 10.1, OD-3); balance rules for n = 15 (7/8; 5, 5, 5) and n = 17 (8/9; 6, 6, 5); violation-type quota ceil(n/8) per type (8.1). Development: F01-F03 plus 6 authored (F04, F05, 4 for KPI-1). |
| Acceptance | AC-S1-04 (Codex review), AC-S1-16, 18 (authoring report), AC-S1-20 (brief renderer), AC-S1-21 (git-ignored directory), AC-S1-24 (codes-and-counts report, no Vertex call) rewritten. |
| Open questions | 6 and 7 closed by D-014; 9 restated (KPI-1 families authored, no Vertex call); 11 now runs the Codex review on F01-F03. S8 row added to the interfaces table. No cost line added (D-013). |
