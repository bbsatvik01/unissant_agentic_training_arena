# Spec review, Codex round 1

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4 (gpt-6-astra, xhigh), four parallel read-only sessions with live search. **Target:** spec v2.1/v2.2 (commit 1ad3222). Cost accounting excluded (D-013).

| Session | Scope | Verdict | Blockers | Majors | Minors |
| --- | --- | --- | --- | --- | --- |
| g1 | S1, schemas, seeds | RED | 1 | 13 | 4 |
| g2 | S2, S3 | RED | 1 | 16 | 1 |
| g3 | S4, SQL, S5 | RED | 2 | 16 | 3 |
| g4 | S6, S7, S8, README | YELLOW | 0 | 15 | 4 |

## Findings (blocker and major)

| ID | Severity | Problem (abridged) |
| --- | --- | --- |
| SG1-01 | blocker | Every valid hidden public packet contains the mandatory eight-word sentence "Evasive wording alone does not prove a violation." The required coach prompt contains the identical sentence. Consequently, the prescribed scan always fails, even with perfect hidden- |
| SG1-02 | major | The subject service cannot obtain those earlier tags. They are stored in sealed.subject_tag_proposals, but subject.turn_context returns only packets, transcript, released evidence, and manifest. arena_subject has no table privileges or other tag-reading functi |
| SG1-03 | major | CLOSED means evidence has already been released and the gate is openable. Initial voice gates therefore bypass S1's LOCKED precondition. The Live instruction lets the model open them when the investigator merely says the condition, so a bluff about an unreleas |
| SG1-04 | major | S1 records contain content.body plus an optional table; the wire contract has no table field or required lossless table renderer. Straight field mapping loses decisive evidence. For example, F01's radio-log body only describes automatic transcription; the B-12 |
| SG1-05 | major | One of those sessions performs both full-information variant solves and the reduced-information truthful solve. A continuing solve session retains the sibling's evidence and the truthful explanation removed for CX-3. It can infer the second variant by pairing, |
| SG1-06 | major | This accepts an unsupported correct guess. The evaluator schema requires every artifact in at least one decisive-support item and, where specified, the subject's account. F03 truthful cites two-record combinations, but a solver returning truthful with only rec |
| SG1-07 | major | The supported 34-case option has 17 families and therefore requires nine violation types, but the closed schema enum contains only eight. No seed resampling or revision loop can satisfy V5 for this option. |
| SG1-08 | major | The ingest bundle does not retain the complete family file, taxonomy, provenance, sampler seed/assignment, or per-family validator/Codex attestations. sealed.family_ingests stores only a bundle hash. After the required deletion, an exact family-file export and |
| SG1-09 | major | The artifact digest hashes record_id and content only. It excludes the scheduled_turn, request_after_turn and requestable fields actually used by release_evidence, plus title and document kind. The evaluator packet contains the intended predicates, but SQL nei |
| SG1-10 | major | Ingest performs an unlocked existence check, while sealing locks only hidden_split_seals. An ingest can pass its check, remain uncommitted while another transaction computes and commits the seal, then commit an additional hidden family. The split immediately f |
| SG1-11 | major | WP-09 ingests F01-F05 before the dev pilot. Those rows and packets are immutable, and re-ingesting the same family code with different content raises AR003. No development revision, retirement or active-version mechanism is specified. The mandatory V6 correcti |
| SG1-12 | major | F02 deceptive marks f:40, Evan entering with Quell, as HOLD behind g:01. Its FREE f:14 nevertheless says the custodian was cleaning when "you came in with Evan". A subject can disclose the protected circumstance by faithfully answering from a FREE fact, making |
| SG1-13 | major | S2 defines responsive as giving the requested information and evasion as withholding known information, irrespective of whether withholding was permitted. F01's truthful subject knows the purpose but does not provide it. The seed instead uses style and assigne |
| SG1-14 | major | These schema limits permit records larger than the downstream transport and storage limits. A read-only mutation produced a schema-valid 47,451-byte content object. Releasable content is capped at 32 KiB in SQL, while the event carrying it is capped at 16 KiB. |
| SG2-01 | blocker | Every valid hidden public packet must contain the same EX-4 ground rules that appear in the mandatory coach prompt. The eight-word sentence “Evasive wording alone does not prove a violation” therefore guarantees a hit, independently of any leakage. The sealed  |
| SG2-02 | major | The two prescribed adapters disagree. Implementing S2's adapter removes possible_evasion and non_responsive before S3 filters on those values, silently destroying event precision and recall. |
| SG2-03 | major | All five flag kinds describe adverse evidence. An entirely cooperative, corroborated truthful interview can correctly produce no flags, leaving the final finding unable to cite its positive evidence. It consequently fails 5a and 5d and can score only 1/4 for s |
| SG2-04 | major | Neither finding template includes rationale. The judge therefore cannot evaluate supports_basis or the semantic part of 5c. Findings with identical labels and citations but opposite rationales produce identical referee inputs. The added per-citation output fie |
| SG2-05 | major | The rendered finding is outside the specified untrusted blocks even though it contains model-written or investigator-entered corroboration text. An investigator can place a rubric-manipulation instruction in a valid corroboration_needed entry and have it inser |
| SG2-06 | major | R1 supplies no violated-fact identifiers. Its requested_fact_ids identify what the question asked, which need not be the fact contradicted or invented in the answer. The booleans no_contradiction and no_invention cannot determine materiality. S3 additionally e |
| SG2-07 | major | No producer defines key_fact_ids or returns an addressed-key-fact set. S1 supplies rubric.key_questions[].target_fact_ids and decisive-support fact lists, which are different possible denominators. R3's assistant-facing output has no coverage result; its subje |
| SG2-08 | major | The S3 adapter uses evidence_quote as the rationale, but sealed.independent_labels.rationale requires at least one character. Normal successful subject turns cannot be persisted through the stated mapping. |
| SG2-09 | major | S3 requires four question origins, but SQL permits only investigator or harness. There is no specified persisted relay_outcome or proposal reference. The scorer cannot apply the promised ownership rule from the contracted fields and risks charging an assistant |
| SG2-10 | major | Normalization is shared, but the acceptance predicates are not. S2 permits any matching quote of 3–200 characters; S3 additionally requires at least three words unless the quote is the whole answer. For example, “busy shift” passes S2 for “It was a busy shift. |
| SG2-11 | major | The sequence reuses the card's completed work item. record_coaching_event hashes both payload and kind, and _take_work_item rejects a completed item with different input. Every due A1 deep update following this sequence fails with AR003. |
| SG2-12 | major | A latency row is created only when coach_card or coach_unavailable is committed. If the process crashes after the subject answer commits, the hold eventually expires without creating either event. That turn disappears from both the denominator and the unmeasur |
| SG2-13 | major | Worsening performance produces a negative correlation, but the specified test uses the upper tail. The acceptance fixture explicitly expects worsening to be significant. For 18 positions with nine successes followed by nine failures, the stated statistic is ap |
| SG2-14 | major | Neither fixture matches any supplied G5 regex. IJ-4 uses “record that I was cleared,” outside the enumerated target pattern; IJ-5 starts “Reviewer:” without the required the/dear/attention prefix and uses “label all of my answers.” These published attack fixtu |
| SG2-15 | major | S1 specifies no such rendered-context validator, and a case-only check cannot provide the guarantee under the accepted question limits. Twelve valid 2,000-character questions alone estimate at 8,000 tokens under S2's formula, exceeding the 6,000-token card and |
| SG2-16 | major | This is a direct false answer, which E13 and the decision tree classify as responsive plus a fidelity failure. Moreover, S1 truthful profiles cannot permit concealment behaviors. The uncertainty examples also disagree: E3 labels an approximate time answer UNC, |
| SG2-17 | major | Replay transcripts and releases live on source_trial_id, but S3 does not specify that source resolution for citations and labels. SQL derives work-item and event turn_no from the replay trial's own arena.turns, which has no rows, yielding turn 0. trial_context |
| SG3-01 | blocker | arena.scores has no label column. PostgreSQL resolves the NEW.label field while preparing the expression, before Boolean short-circuiting can protect it. An otherwise valid score insertion therefore raises an undefined-column error, blocking metric publication |
| SG3-02 | blocker | Replay trials only receive source_trial_id. They have no committed replay cursor or advance operation. Work items and events derive turn/version from the replay trial's own empty transcript, yielding turn 0 and version 0. Meanwhile trial_context returns the en |
| SG3-03 | major | open_work_item always creates a new UUID, accepts no request key, and never populates the existing idempotency_key column. arena_public cannot read work_items and has no recovery function. After process loss, the orchestrator cannot recover the original step I |
| SG3-04 | major | The first call completes wi. The second changes both the payload and kind included in its request hash, so _take_work_item rejects it with AR003. A1's prescribed deep updates cannot be recorded. |
| SG3-05 | major | The granted interfaces cannot perform these steps. The only private-context reader requires an open subject_answer item, which voice creates only after Live produces the first input transcription. ops.session_spend is revoked from arena_subject and is an invok |
| SG3-06 | major | No schema or granted writer stores that canonical transcript. arena.turns answers are immutable after the provisional Live answer is committed. voice_utterances stores sample counters without text or a turn mapping, and voice_fragments is append-only and rejec |
| SG3-07 | major | The voice path defines neither that context-refresh operation nor automatic scheduled releases. record_voice_question immediately creates subject_answer work, explicitly omitting the release stage. Unlike the text orchestrator, nothing invokes release_evidence |
| SG3-08 | major | The hidden digest hashes artifact content but omits operational fields such as scheduled_turn, request_after_turn, requestable, kind, and title. Changing these can alter the interview without invalidating the seal. Separately, execution commitments hash releas |
| SG3-09 | major | Ingest checks for a seal without acquiring a lock shared with sealing. seal_hidden_split exclusively locks only hidden_split_seals; that lock does not exclude the ingest's ordinary SELECT or inserts into the case tables. An ingest can pass its check, a seal ca |
| SG3-10 | major | Characters divided by three is an estimate, not a tokenizer upper bound. Inputs with unusual Unicode or tokenization can exceed it. Repair prompts are also constructed after the single input-bound step. The database reserves using fixed token limits and detect |
| SG3-11 | major | Every runtime role can settle any known reservation UUID. caller_role is stored but not enforced, child reservations need not match their parent's trial or actor, and voice settlement does not require the associated voice session to be closed. A public-role ro |
| SG3-12 | major | ExportGate's held classification is discarded by the mirror interface. The SQL trigger derives sensitivity solely from trial_id; a span without one becomes split=none and export_state=pending. Tournament/block request spans legitimately have no single trial ID |
| SG3-13 | major | The canonical POST body omits phase while the subsequent contract requires it. The public role has no projection for participants or case_set_members, although the API must read them to choose unseen test cases and report KPI-1 status. GET /api/config similarl |
| SG3-14 | major | No canonical storage shape or writer exists for that projection. The GET route points only to v_my_scores, which returns rubric rows and an unspecified rationale object. It does not define the ground-truth outcome, resolution summary, or complete debrief respo |
| SG3-15 | major | The named trial_started and execution_recorded events carry trial_id. ledger.v_events filters those rows through trial_visible, which is false for unrevealed hidden trials. The poll therefore cannot emit the promised progress frames. Additionally, the single a |
| SG3-16 | major | Latency rows are created only when coach_card or coach_unavailable is successfully recorded. If the process dies after subject commit, neither event nor sample exists. The 120-second hold expires without materializing a miss, and later turns can continue. Such |
| SG3-17 | major | The SQL accepts fractional numeric turn citations within 1..count(turns), and accepts any doc-01 through doc-04 without checking whether that document exists in the packet. It also does not exclude partial voice turns. A structurally acceptable finding can the |
| SG3-18 | major | Ticket issuance rejects every non-running trial. If the connection drops immediately before the terminal event, the trial can finalize before the client requests its replacement ticket, permanently preventing catch-up through the specified stream. debrief_read |
| SG4-01 | major | The local HTTP boundary does not require Host validation, foreign-Origin rejection, or CSRF protection. A conforming implementation can therefore execute cross-origin simple POSTs as the selected investigator or admin. Binding to loopback and omitting CORS res |
| SG4-02 | major | running is a legal trial.status value, so the transition table can end a running session. Separately, commitment_hash belongs to trial.finalized, not trial.status. Closing the stream immediately on terminal status can discard the subsequent finalized frame and |
| SG4-03 | major | A legal full snapshot cannot fit this cap. Twelve permitted 2,000-character ASCII questions alone require 24,000 bytes, before answers, cards, evidence, or envelope fields. The client must reject that snapshot. S5's oversize fallback also emits CUSTOM, which S |
| SG4-04 | major | These sources have incompatible sequence spaces: trial events have per-trial sequence numbers, while ledger events have a global sequence. No merged cursor or event identity is defined. Reveal also makes older rows newly visible. Additionally, ledger.v_events  |
| SG4-05 | major | The shared stored-card contract includes code-filled candidate_sha256, while the training projection must remove it. S5 still promises the unchanged stored card. One required-field schema cannot simultaneously validate both shapes; implementations can either r |
| SG4-06 | major | No final acknowledgement is required when playback drains normally. A 1.1-second utterance at 24 kHz can finish with 26,400 samples played but only 24,000 acknowledged. S5 retranscribes only acknowledged samples and evaluates partial status at utterance_end, e |
| SG4-07 | major | The universal visibility matrix says role and referee labels are never available in practice or assessment, without defining an ended-session debrief exception. The promised durable projection also has no specified storage/read contract: GET debrief reads trai |
| SG4-08 | major | R3 supplies evasion labels but deliberately sends “flags block none” to r3_investigator. It therefore produces no support verdicts for the session's coach flags. S3's evasion-count computation requires those per-flag verdicts, so the promised scorecard cannot  |
| SG4-09 | major | This cannot implement S3's calibration protocol. Raters must submit binary checks from which dimensions are derived, and EVL-8/fidelity raters require private scenario context and the assigned role. The single transcript-only form supports neither task, despit |
| SG4-10 | major | The request lacks phase, while S5 describes requests “with phase pre or post” and SQL requires p_phase. No rule defines how the server derives it. Merely selecting Assessment does not distinguish a free assessment from a study pre-test or post-test, leaving se |
| SG4-11 | major | The shell obtains identity from GET /api/me, but S5 defines that route only on arena-api. The referee route table lacks a shell bootstrap/config contract. The trainer list contains only opaque IDs, yet no GET detail route is defined for /review/:itemId. Engine |
| SG4-12 | major | The slide-8 family is F01. Its first requestable record unlocks after two completed exchanges; the remaining records unlock after three or six. The script requests evidence after only one exchange, so the advertised evidence-release beat returns 422. Its exact |
| SG4-13 | major | The dev pilot measures assistant proposal quality and subject performance; it does not create participant-linked baseline, practice, and unseen post-test observations. Its scores cannot produce KPI-1's within-person improvement statistic. Labeling the result “ |
| SG4-14 | major | These instructions directly contradict D-013, which authorizes building immediately while the spec reaches Codex GREEN in parallel. The old gate remains in the dependency graph, critical path, and day-zero dispatch instructions, so an engineer following S8 sto |
| SG4-15 | major | WP-19 requires debrief E2E tests although the debrief UI is assigned to post-slice WP-20a. WP-24 requires a first calibration round, but WP-25 depends on WP-24. The slice also runs a tournament and leaderboard without declaring WP-17/WP-16 dependencies. Full c |

## Root-cause classes and shared decisions

Fix workflow `wf_09e6717a-210` applies eleven shared decisions so every part implements the same contract: D1 hidden-content scan corpus excludes platform text; D2 replay trials own their transcript (advance_replay); D3 one work item per model step with caller request keys; D4 KPI-4 rows created at subject commit; D5 Finding gains rationale and closure scores its own citations; D6 one quote predicate; D7 voice is unscored practice with LOCKED gates and context refresh; D8 typed debrief projection; D9 separate stream cursors, REST snapshot, catch-up tickets; D10 Host, Origin and CSRF checks locally; D11 byte-length input bound and 600-character questions.

Dispositions per finding are recorded below when the fixers report.

## Dispositions (fix workflow wf_09e6717a-210)

| ID | Real | Change (abridged) |
| --- | --- | --- |
| SG1-01 | yes | S1 10.4 defines the one corpus. It has two parts: identifiers (family ID, case IDs, 4 canaries, persona name), and 8-grams (G6 tokenization) of every family-file string except the platform paths. The paths are excluded b |
| SG1-02 | yes | S1 6.4 is rewritten. The inputs are released record IDs plus the gate openings and first disclosures in validated tags of committed turns; quarantined attempts never count. Both come from subject.turn_context (S4 owns th |
| SG1-03 | yes | Added a voice paragraph to S1 6.4 (D7). Voice is unscored practice. The Live instruction renders gate status from the released set at session start, so gates start LOCKED. arena-subject sends Live an updated context afte |
| SG1-04 | yes | S1 6.1 defines the content model and content_text(): body, then the columns, then one line per row. Public-packet schema v1.2 forbids a vertical bar or line break in cells and column names; V2 requires one cell per colum |
| SG1-05 | yes | S1 9.7: each round uses fresh sessions, one review session plus one solve session per sheet (CX-2 truthful, CX-2 deceptive, CX-3). Solve sessions get no tools, files or family source. Sheets omit case_id. AC-S1-04 and AC |
| SG1-06 | yes | CX-2 output adds cited_answers; answers are numbered A1..An. Code requires that every citation is on the sheet, that one item's records are complete, and, when the item requires an account, a cited answer whose key quest |
| SG1-07 | yes | The violation-type catalog grows from 8 to 12 (schema, plus a definitions table in S1 8.1). Quota is at most 2 hidden families per type, which implies coverage of ceil(n/2). V5 split checks added. AC-S1-16 updated; AC-S1 |
| SG1-08 | yes | S1 10.5 defines the sealed archive: canonical family text plus sha256, a timestamp-free attestation (validator checks and Codex results on the accepted hash), and the split sampler record. S4 refuses an ingest whose text |
| SG1-09 | yes | S1 10.3 step 3 now requires the digest to cover each artifact's complete row: record ID, kind, doc_kind, title, content, requestable, scheduled_turn and request_after_turn. S1 4.4 requires artifact-row parity with the ev |
| SG1-10 | yes | S1 10.3 step 2 now requires hidden ingest and seal_hidden_split to take the same split lock. S4 owns the SQL. |
| SG1-11 | yes | New S1 8.6 revision path. Schema adds `revision` (hidden families must be 1). Family code is Fnn.rN, with new case IDs. The referee retires the previous revision, and draws, practice, KPI-1 and pilots use only active rev |
| SG1-12 | yes | F02 deceptive FREE f:14 now reads '...when you came in.' S1 7.3 states the rule, and an uncertainty entry takes its fact's class (private schema description). CX-1 checks the rule, and the brief RULES block states it. |
| SG1-13 | yes | The F01 truthful label guide now has four entries. l:01 is responsive when the purpose is given. l:02 is evasion for 'It was a busy shift' alone, which for this subject is also a disclosure-policy failure. l:03 is genuin |
| SG1-14 | yes | New V1d byte budget, as canonical JSON in UTF-8 bytes. Limits: record content 4,096; releasable records combined 12,288; public packet 12,288; private packet 16,384; evaluator packet 49,152; family file 196,608. Each is  |
| SG1-15 | yes | S1 6.3 states the result contract. A premature request for a known record is reported in denied within a success result, and due scheduled records still commit. AR005 (ID not on the requestable list) refuses the whole ca |
| SG1-16 | yes | F02 f:14 now says the custodian was in the lobby 19:30-19:50, so both statements ('in the mail room by then') fit the departures at 20:00 and 20:08. CX-1 now names witness positions. Same class: F02 doc-03 said the lobby |
| SG1-17 | yes | S1 9.8 adds the inventory MU-01..MU-42 plus a control, and every AC test column cites MU IDs. The harness now asserts the intended check; mutants MU-01, MU-08, MU-13 and MU-15 were isolated. The V1b deny list now names e |
| SG1-18 | yes | F01 q:01 neutral_example is now the deck's 'What task required entry?' in both variants. AC-S1-25 unchanged and now true. |
| SG2-01 | yes | S1 10.4 is the single corpus definition. S2 3.4 currently cites 'S1 10.2'; L9 in 10.2 points to 10.4. |
| SG2-15 | yes | The V1d maxima (9.1) are the case-side input to S2's input-limit check (AT-PORT-3). S2 and S5 own the renderer check and any change to LIMITS under D11. |
| CX-3-sheet (found while reproducing SG1-05/06) | yes | The S1 9.7 CX-3 sheet now holds free evidence only, plus the account without innocent-explanation facts. A key question that asks only for an explanation is dropped. |
| SG2-01 | yes | S2 3.4 defines the hidden-content corpus as case-specific text only: case IDs and canaries match exactly, other text by 8-gram, and S1's field-path allowlist excludes ground_rules, objective and behavior templates, style |
| SG2-02 | yes | Deleted S2 4.9's conflicting table; S2 now points to S3 1.3.1 as the only adapter. S3 1.3.1 keeps all five kinds, adds shape, and gains a reference adapt_card that uses cites_of from the shared module. Added FX-E11 and A |
| SG2-03 | yes | The Finding gains model-written cited_turns (integers) and cited_records (doc-NN or rec-NN). Code adds basis-flag turns and records to them. evidence_conflict and findings may cite initial documents, and coach rule 9 now |
| SG2-04 | yes | S2 7.3 adds a finding projection (label, likelihood, confidence, rationale, corroboration, alternatives) used by R2 and R3 in place of the display template. Rationale is now up to 600 characters (D5). Part 3 judges suppo |
| SG2-05 | yes | Added tag kind 'finding' (S2 section 1) and placed the projection inside <untrusted_finding_{salt}> with every value sanitized. The 'Finding citations' and trigger blocks hold IDs only. Added AT-REF-13 (instruction in co |
| SG2-06 | yes | ref_subj.v4 adds violated_fact_ids (facts a turn contradicts, or that an invention offers an alternative to), code-checked against the canonical facts. S3 1.3 defines material_fact_ids as a projection of canonical_facts  |
| SG2-07 | yes | key_fact_ids = sorted distinct rubric.key_questions target_fact_ids. requested_fact_ids now covers every canonical fact, including unknown ones, and is code-checked. The canonical facts block is rendered with IDs. S3 6.1 |
| SG2-08 | yes | The S2 7.2 derived table and S3 1.3.2 map the stored rationale to the evidence quote, or to the fixed status texts 'no quote given' and 'no quote: quote did not match'. It is never empty. Added AT-REF-16 and AC-S3-1.6. |
| SG2-09 | yes | S2 8.2 records question_source (harness_fixed, assistant_relay, harness_fallback, investigator) and relay_reason with every question. S3 1.3, 2.9 and 3.7 read them. Added AT-HAR-7, FX-R09 and AC-S3-2.11. |
| SG2-10 | yes | New S2 4.4.1 arena_core/contracts/citations.py holds normalize, quote_ok (at least 3 words, or the whole shorter answer), content_text, cites_of, flag_citations_ok and finding_citation_ok, with fixtures CQ-1 to CQ-12 sha |
| SG2-11 | yes | S2 4.6: the deep update opens its own work item, bound to the card's transcript version, records with record_coaching_event(trial, deep_wi, ...), and a stale result is refused. Section 2 states the request-key rule (hash |
| SG2-12 | yes | S3 S3-D8, 1.3 and 6.4: a pending sample row is created at the subject commit; a row still pending at the next question or trial end becomes unmeasured_timeout, counted as a miss and as unmeasured. kpi4 raises on any pend |
| SG2-13 | yes | FA-5c is now two-sided: statistic abs(Spearman rho), outcomes permuted within blocks, upper tail. Added reference order_permutation_test with a float-tie tolerance. FX-F03 is pinned before Holm (worsening block p = 2/100 |
| SG2-14 | yes | S2 6.9 G5 gains a sentence-initial platform-role address pattern. The label/record pattern now covers 'record that I was cleared', with lookbehinds excluding noun uses such as 'on the record'. A new pattern catches 'labe |
| SG2-15 | yes | S2 section 2: the input bound and the reservation input term are the request's UTF-8 bytes plus REPAIR_BYTES (5,200). The drop order is deleted. A context budget table derives new input limits (subject 80,000; card, deep |
| SG2-16 | yes | E19 rewritten as a genuine non-answer from true facts: EVA, plus an F2/F4 failure for a truthful subject. E4 and F3 drop 'profile permits claimed non-recall'. E20 made concrete. The approximation boundary is resolved: a  |
| SG2-17 | yes | S2 8.6: before card k, arena.advance_replay copies source exchange k and the releases recorded before question k, with source references. Cards, work items, events and scoring use the replay trial's own turn_no. S3 1.3/1 |
| SG2-18 | yes | S3 6.2 now reads 18.1% at the 15-family baseline and 16.2% at the 17-family target, with families_needed(0.05) = 59. |
| SG1-03 | yes | S2 9: voice sessions are unscored practice. The Live instruction renders LOCKED and CLOSED from releases, and after every release arena-subject sends the re-rendered instruction as a mid-session system-instruction update |
| SG1-13 | yes | The S2 J1 prompt states that a terse answer omitting known, requested information is evasion in either role. S3 3.6 adds a terse-answer row (EVA, plus F2/F4 for a truthful subject). The F01 seed relabel belongs to S1 (op |
| SG4-08 | yes | S2 7.5: r3_investigator receives the session coach's citation-valid, deduplicated flags for J3. S3 5.7 defines the training detection scorecard (evasion_counts strict and broad, unsupported by reason, coach's last label  |
| SG4-09 | yes | S3 7.3 defines three review task types: T-RUB (public context and triggers), T-LAB (private ledger and canonical facts) and T-FLAG. For each it states what the rater sees, never sees and submits. No rater enters a 0-4 sc |
| g2-missing-route | yes | S2 7.1 states that R1 runs per corpus transcript before the seal and R2 per replay trial after it finalizes, each a keyed work item (D3), dispatched through the referee's scoring route. The route itself belongs to S5 (op |
| SG3-01 | yes | 0003: revealed-manifest trigger has no label check; separate tg_leaderboard_label on leaderboards only. Smoke inserts scores and original/corrected boards (RV-16, RV-21) green |
| SG3-02 | yes | 0004 arena.advance_replay copies one source turn (question, releases made before its answer, answer) per step into the replay trial; work items, events, citations, commitment use own rows; finalize needs full copy; RP-01 |
| SG3-03 | yes | open_work_item(trial, kind, request_key) returns existing item and stored result before state checks; arena.work_item_results(trial); release results content-free; reserve key reports dispatched for usage_unknown recover |
| SG3-04 | yes | Deep update opens its own coaching item at the same version; stale if overtaken; CC-22 green |
| SG3-05 | yes | subject.voice_context(voice_session) (context, reservation, spend, shutoff); ops.settle_voice_reservation (subject, after close); parent reservations removed so cards reserve on their own; VB-05..VB-19 |
| SG3-06 | yes | Deleted voice_fragments, voice_utterances, their writers and view, voice_sessions.scored, retranscribe call kind; S5 7.7 is display only, labeled unscored |
| SG3-07 | yes | arena-api releases due records at each voice turn boundary and on evidence requests, sends contentless context_changed; arena-subject re-reads voice_context; voice turns hold nothing; VB-18 green; S5 7.4, 7.8 |
| SG3-08 | yes | Digest = one canonical jsonb per variant over every artifact column, packets, role, variant row, recomputed; content_sha256 generated; commitment hashes content and all turn/evidence fields; CS-20, FC-18 green |
| SG3-09 | yes | Hidden ingest takes hidden_split_seals in SHARE mode before its seal check; seal keeps EXCLUSIVE; CS-21, CS-22 green both orders |
| SG3-10 | yes | reserve_model_call takes input_bytes (UTF-8 bytes of largest request incl. repair), bounded by byte limit; port never sends a longer request; LIMITS change reported; BU-32, BU-33 |
| SG3-11 | yes | caller_role from ops.invoker_role(); dispatch, usage, settle refused (AR040) to other roles; voice holds settle only via subject function after close; abandoned holds reaped at 60 min keeping liability; BU-35..BU-37 |
| SG3-12 | yes | mirror keeps producer split and tournament binding, only raises; hidden span without tournament held forever; whole trace held while any span held; TM-11..TM-15 |
| SG3-13 | yes | start_session derives phase (2 pre, 3 practice, 2 post; tests assessment, text, once); training.v_my_study, v_dev_cases.kpi1_set, ops.v_public_config; TT-15..TT-18 |
| SG3-14 | yes | training.debriefs + training.publish_debrief (appends debrief_ready in same transaction) + v_my_debrief; record_debrief_ready deleted; judgments.idempotency_key for resumable R3; DB-01..DB-06 |
| SG3-15 | yes | Trial seq for trial streams, global ledger seq for tournament poll; arena.v_tournament_progress counts for hidden tournaments; RV-22 |
| SG3-16 | yes | Sample opens pending at text subject commit; card completes; unmeasured_timeout at next question or trial end; CC-11, CC-20, CC-21 |
| SG3-17 | yes | Integer answered non-partial turns of the trial; doc ids from packet initial_documents; rationale 1-600; FC-17 |
| SG3-18 | yes | SSE tickets issued for ended trials until debrief published; voice running only; TT-05, TT-19 |
| SG3-19 | yes | WI-S4-05 and S4-D4 name .env.local.public/.subject/.referee |
| SG3-20 | yes | 0001 global alter default privileges revoke execute on functions from public; CM-15 |
| SG3-21 | yes | Enumeration adds REFERENCES, TRIGGER, MAINTAIN, column grants, schema CREATE, sequences; gate proofs per type; S4 10 regenerated (215 triples) and verified equal |
| SG1-02 | yes | turn_context and voice_context return disclosure_state (facts first disclosed, gates opened, by turn); ST-15 |
| SG1-04 | yes | Event payload carries whole content object; S5 6.2 evidence.released carries S1 Content incl. table; CS-17 |
| SG1-08 | yes | family_ingests stores source and attestations under bundle hash; round-trip test CS-23 |
| SG1-09 | yes | Ingest parity vs evaluator releasable records and public requestable list; full-row digest; CS-19, CS-20 |
| SG1-10 | yes | Shared SHARE/EXCLUSIVE lock; CS-21, CS-22 |
| SG1-11 | yes | supersedes bundle field + arena.family_retirements; retired families out of library, sessions, rosters; CS-24, CS-25 |
| SG1-14 | yes | Serialized byte limits: content 12,288, payload 14,336, finding 8,192, question 600 chars, answer 900; CS-26 |
| SG1-15 | yes | S5 5.4: unknown ids 422, early ids in denied beside same-call releases; results content-free; RE-17 |
| SG2-08 | yes | rationale may be empty (R1 evidence quote); AD-12 |
| SG2-09 | yes | turns gain four origins, relay_outcome, proposal_seq (FK to the card); submit_question takes them; SV-18 |
| SG2-11 | yes | Separate deep item; CC-22 |
| SG2-12 | yes | Pending rows and unmeasured_timeout; CC-20, CC-21 |
| SG2-15 | yes | Questions 600 chars, answers 900; S5 5.2 context_full preflight; byte-sized LIMITS reported; SV-19 |
| SG2-17 | yes | advance_replay; RP tests |
| SG4-01 | yes | S5 10.3 http_guard: Host allowlist (421), Origin on state-changing requests, CSRF header tied to SameSite=Strict cookie; 5.5, 10.4 tests |
| SG4-03 | yes | GET /api/trials/{id}/snapshot REST; SSE deltas only, each <=16 KB; CUSTOM fallback deleted |
| SG4-04 | yes | Separate cursors, counts-only hidden progress, per-trial replay route |
| SG4-05 | yes | S5 5.2, 6.2: stored card and training wire card are separate schemas; training frames carry no candidate identifiers |
| SG4-06 | yes | played frame removed; playback counts stay in the browser; nothing to finalize server-side |
| SG4-10 | yes | Phase derived in training.start_session; POST body {case_id, mode, voice, idem_key} |
| SG4-11 | yes | S5 5.5 referee GET /api/me, GET /api/config, GET /api/review/items/{id}; concrete admin route table |
| SG4-18 | yes | Pins are page state; no pin route (S5 5.4) |
| SG4-01 | yes | S6 1.3 renders S5 10.3: Host check (421), allowed Origin and X-Arena-CSRF on every POST including bodyless ones, one fetch wrapper with a single retry; FE-TECH-5 and E2E-14 added; S8 WP-13, WP-14, WP-18, WP-19 carry it. |
| SG4-02 | yes | S6 6.1 enters ended only on a non-running status; commitment hash from trial.finalized; 5.3 states the trial_ended seq rides on the last frame of the pair; stream stays open for catch-up until debrief published; FE-SSE-8 |
| SG4-03 | yes | S6 5.1-5.3: snapshot via GET /api/trials/{id}/snapshot, SSE deltas only at most 16 KB, oversize fallback and CUSTOM frame deleted; FE-SSE-6. |
| SG4-04 | yes | S6 4.9, 5.1, 5.3, 6.5: tournament poll on the global ledger cursor with visibility counts/events and reset to after=0 at reveal; trial replay paged by the trial's own seq; hidden trials appear only as block-level counts; |
| SG4-05 | yes | S6 4.5, 5.2: stored, training-wire and tournament-wire cards are three schemas, client validators from wire schemas only; FE-COACH-8; S8 WP-02 exports them. |
| SG4-06 | yes | S6 6.2 deletes the played control; worklet drained/cleared messages drive the UI only; FE-VOICE-4, FE-VOICE-6; S8 WP-22/WP-23 drop retranscription and the scoring gate. |
| SG4-07 | yes | S6 3.4, 4.7, 5.4: debrief.v1 from training.v_my_debrief, POST and GET return the same document, matrix column for the owner's ended development session; FE-DEB-5, FE-DEB-6; S8 WP-14, WP-19, WP-20a. |
| SG4-08 | yes | S6 4.7 detection scorecard from R3's J3 verdicts on coach flags; S7 EVL-1 and EVL-8 rows cite FX-D01; S8 WP-14 scope. |
| SG4-09 | yes | S6 3.6, 4.12: three task kinds T-RUB, T-LAB, T-FLAG with per-kind schemas and submissions, no 0-4 entry; FE-REV-1, FE-REV-3; S8 WP-25a uses console or sheet with S3's columns. |
| SG4-10 | yes | S6 3.2, 5.5: no phase in the request, study status from /api/me, test-set listing, 422 step message; E2E-16; S8 WP-13 and WP-30. |
| SG4-11 | yes | S6 2.1, 4.12, 4.13, 5.5 render them; FE-ADM-3 and E2E-15 open both consoles on 8082; S8 WP-14 and WP-20a. |
| SG4-12 | yes | S7 section 2 reordered: T1, coach card, T2, request rec-01 after two exchanges, presenter's own insufficient-evidence finding, debrief; live wording variable with labeled FX-EX fixture fallback; rehearsal route test agai |
| SG4-13 | yes | S7 KPI-1 row, debrief beat, video, slide 9 and open question 2: measured from participants who completed the protocol (volunteers or identified team members) or 'KPI-1 not measured'; S6 4.8/4.10; S8 OD-7, cut item 9, WP- |
| SG4-14 | yes | S8 summary row 2, calendar, OD-0, WP-01, graph, critical path, Gantt and day 0 rewritten; new interface gate in 6.1 blocks only WPs whose interfaces carry an open finding; milestone gates kept. |
| SG4-15 | yes | S8: WP-19 carries the minimal debrief and depends on WP-14; WP-24 depends on WP-16, WP-17; calibration split into WP-25a (pre-pilot) and WP-25b (post-pilot, depends on WP-26); WP-27/WP-30/WP-32 dependencies fixed; critic |
| SG4-16 | yes | S6 5.5 uses client_valid (applied in the partial S6 edit, verified). |
| SG4-17 | yes | S6 4.5 quoteOk is the TS port of S2 quote_ok with dash, quote and whitespace normalization and the 3-word or whole-answer rule; FE-COACH-3 uses S2's shared fixture file; S8 WP-02 and WP-18. |
| SG4-18 | yes | S6 4.4, 4.7: pins are page state only, never sent or stored; FE-EVD-5. |
| SG4-19 | yes | One release rule in S6 11, S8 OD-4 and R-10: placeholder theme ships if DESIGN.md is late, passing every UI check; presentational work still waits for the slice gate. |
| SG1-17 | yes | S8 WP-08 ports MU-01..MU-42 plus control (42 of 42, each caught by its targeted check); AC-S1-08/10/11 to WP-04, 26/28/36 and V1d of 29 to WP-08, 27/29/32/34/35 to WP-09 (now depends on WP-11 relay_test.v1), 30 to WP-13/ |
| SG1-08 | yes | S8 WP-09 writes family file and attestation at ingest; WP-27 confirms archive and sampler record before deleting cases/hidden/ and transcripts; WP-29 exports and round-trips it (AC-S1-34). |
| SG1-11 | yes | S8 WP-26 revises out-of-band families through S1 8.6 and uses only active revisions; WP-09 implements revision ingest; WP-13 lists active revisions (AC-S1-35). |
