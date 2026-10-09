# S4 pgTAP test plan

Spec part S4 (`../S4-data-layer.md`), version 1, 2026-10-08. Every test below is a pgTAP assertion in `supabase/tests/NNN_*.sql`, one transaction per file, ending in `ROLLBACK` (concurrency files clean up their committed rows). Requirement IDs refer to `docs/challenge/REQUIREMENTS.md`; F- and R- IDs refer to the direction's critique findings.

## 0. Harness

| Item | Decision | Source |
| --- | --- | --- |
| Runner | `supabase/tests/harness/run_pgtap.sh <admin-dsn>`: drop and create a throwaway database, load the shim, `create extension pgtap, dblink`, apply `supabase/migrations/*.sql` in order, run every test file with `pg_prove` | Lift TechnoMile `supabase/tests/harness/run_pgtap.sh` lines 1-30 |
| Shim | Stand-ins for `anon`, `authenticated`, `service_role`, `auth.users`, `extensions` on plain Postgres 16/17. Never applied to a Supabase project | Lift TechnoMile `supabase/tests/harness/supabase_shim.psql` lines 1-34 |
| Fixtures | `tests.h(text)`, `tests.uid('A'..'C')`, `tests.bundle(code, split)` (a matched truthful and deceptive family), `tests.tournament(split, tracks)` (creates, freezes, opens a small roster), `tests.exchange(trial, question, release_ids, answer)` (one full exchange: question, release, subject answer, coach card) | Pattern of TechnoMile `supabase/tests/harness/fixtures.psql` |
| Roles | Assertions switch with `set local role arena_public / arena_subject / arena_referee`; investigator requests also `set_config('arena.actor_id', <uuid>, true)`; harness requests leave it unset | TechnoMile `001_security_rls.sql` lines 82-96 |
| Concurrency | Real sessions through `dblink` (`dblink_send_query`, `dblink_is_busy`, `dblink_get_result`); each concurrent case opens fresh connections | TechnoMile `007_checkpoint_fence_concurrency.sql` lines 10-40 |
| Gate | Part of `make check`; CI fails on any failing or skipped test. No `skip`, no `todo` (global never-rig rule) | `docs/handoff/PATTERNS.md` |
| Plan counts | Each file states `plan(n)` equal to its rows below; a changed count is reviewed like code | |

Expected errors use SQLSTATE: `42501` permission denied; `AR001` wrong state; `AR002` stale transcript version; `AR003` work item or key mismatch; `AR004` no open question or turn in progress; `AR005` not requestable; `AR006` release limit; `AR007` invalid input; `AR010` append-only; `AR020` reveal precondition; `AR021` seal or hash mismatch; `AR031` open child reservations; `AR040` caller, ticket or quota refused; `23505`, `23514` constraint.

### 0.1 Smoke run already done on the drafts

The six draft migrations were applied in order to a throwaway local PostgreSQL 16.13 cluster in the session scratchpad (no Supabase project, no network). Plain-SQL smoke scripts (pgTAP is not installed there) covered: role denials on base tables and on other roles' functions; forged, replayed and cross-trial work items; stale versions; turn in progress; release predicates (requestable after a turn, scheduled at a turn); quarantine; finalize idempotency and commitment verification; BKO-2 ordering; reveal preconditions, manifest completeness and the manifest rules for completed, replay and quarantined trials; corrected manifest; ledger append-only and chain verification; caller separation; the SSE projection; budget caps on a leaf, on an ancestor and per user; non-leaf refusal; unit admission; voice totals and concurrency; overrun and the kill switch; trace-mirror idempotency and single export; and two dblink concurrency cases (concurrent finalize: the second session waits on the trial lock and then fails; reservation race at a cap: the second waits on the bucket lock and is refused, liability 2.016 of 2.10). All passed. The privilege allowlist in S4 section 10 was exported from that database, not typed by hand. This shows the drafts are coherent; it does not replace this suite.

## 1. `001_capability_matrix.sql` (SCN-5, SCN-9, EVL-10, KPI-5)

| ID | Assertion | Expected |
| --- | --- | --- |
| CM-01 | Actual privileges of `arena_public`, `arena_subject`, `arena_referee`, `anon`, `authenticated`, `service_role` on every schema, table, view and function in the six schemas (from `has_schema_privilege`, `has_table_privilege` for SELECT/INSERT/UPDATE/DELETE/TRUNCATE, `has_function_privilege`), minus the expanded fixture (S4 section 10) | Empty (nothing beyond the allowlist) |
| CM-02 | Expanded fixture minus actual privileges | Empty (nothing on the allowlist missing) |
| CM-03 | Rows for `anon`, `authenticated`, `service_role` | 0 |
| CM-04 | Tables in the six schemas with `relrowsecurity = false` | Empty |
| CM-05 | Functions in the six schemas without `search_path=""` in `proconfig` (SECURITY DEFINER and plain alike) | Empty |
| CM-06 | Functions executable by PUBLIC (`aclexplode(coalesce(proacl, acldefault('f', proowner)))` with grantee 0) | Empty |
| CM-07 | The six privileged functions (`arena.release_evidence`, `arena.record_subject_turn`, `arena.finalize_trial`, `arena.record_execution_failure`, `ledger.adjudicate_validity`, `ledger.reveal`) are each executable by exactly one runtime role, matching direction 4.2 | `arena_public`, `arena_subject`, `arena_public`, `arena_public`, `arena_referee`, `arena_referee` |
| CM-08 | `arena_public` and `arena_subject` hold no privilege on any base table (relkind `r`) | 0 |
| CM-09 | `arena_public` has USAGE on `sealed` or `subject` | false, false |
| CM-10 | Runtime roles: `rolinherit = false`, `rolbypassrls = false`, `rolsuper = false`, `rolcreaterole = false`, no row in `pg_auth_members` with them as member | Holds |
| CM-11 | Views in the six schemas without `security_barrier=true` | Empty |
| CM-12 | Owner-only functions (`ops.set_kill_switch`, `ops.set_bucket_ceiling`) are executable by no runtime role | Holds |
| CM-13 | Gate-proof: inside the test transaction, `grant select on sealed.evaluator_packets to arena_public`, then CM-01 | Non-empty (the gate catches a real leak; rolled back) |

## 2. `002_cases_and_seal.sql` (SCN-1, SCN-5, SCN-7..SCN-12, AST-5, BKO-5)

| ID | Assertion | Expected |
| --- | --- | --- |
| CS-01 | No column in schema `arena` is named `role` or ends in `_role` | 0 |
| CS-02 | Ingest of a dev bundle writes `arena.public_packets`; of a hidden bundle writes `sealed.hidden_public_packets` and nothing in `arena.public_packets` | Holds |
| CS-03 | Owner insert of a hidden variant's packet into `arena.public_packets` | `AR001` |
| CS-04 | Bundle with only truthful variants | `AR007` |
| CS-05 | Variant with 7 artifacts | `AR006` |
| CS-06 | Identical re-ingest; same `family_code` with changed content | Same id; `AR003` |
| CS-07 | `seal_hidden_split()` returns 64 hex; `verify_hidden_seal()` is true in a later statement | Holds |
| CS-08 | Second `seal_hidden_split()` | `AR001` |
| CS-09 | Hidden ingest after the seal | `AR001` |
| CS-10 | Tamper fixture: owner disables the trigger, edits one hidden artifact, re-enables; `verify_hidden_seal()` | false |
| CS-11 | `update` or `delete` on each case table (families, variants, three packet tables, artifacts, ingests, seals, candidates) | `AR010` each |
| CS-12 | Candidate manifest without `timeout_s`; assistant manifest without `tools` | `23514` each |
| CS-13 | `register_candidate` same version, different manifest | `AR003` |
| CS-14 | `arena_public` calls `sealed.ingest_case_family` | `42501` |

## 3. `003_role_reads.sql` ("role cannot read X"; SCN-5, SCN-9, SCN-12)

Each row runs `select 1 from <object> limit 1` (or calls the function) as the role.

| ID | Role | Object | Expected |
| --- | --- | --- | --- |
| RR-01..RR-15 | `arena_public` | each table in `sealed` (10) and `subject` (1); `ledger.events`; `arena.trials`; `arena.turns`; `ops.budget_reservations` | `42501` each |
| RR-16 | `arena_public` | `subject.turn_context(...)` | `42501` |
| RR-17 | `arena_public` | `ledger.verify_commitment(...)`, `ledger.build_manifest(...)` | `42501` each |
| RR-18..RR-21 | `arena_subject` | `subject.private_packets`, `sealed.evaluator_packets`, `arena.v_transcripts`, `arena.trials` | `42501` each |
| RR-22 | `arena_subject` | `arena.trial_context(...)`, `arena.finalize_trial(...)`, `arena.open_work_item(...)` | `42501` each |
| RR-23 | `arena_subject` | `subject.turn_context` with a `coaching` item, a done item, or an item at an old version | `AR003` |
| RR-24 | `arena_subject` | `subject.turn_context` returns `private_packet` for the open `subject_answer` item at the current version | Holds |
| RR-25 | `anon`, `authenticated` | any object in the six schemas | `42501` |
| RR-26 | `arena_public` | `arena.v_dev_cases` contains no hidden variant | 0 hidden rows |
| RR-27 | `arena_public` | `arena.trial_context` on a running hidden trial with an open coaching item returns the hidden public packet and no key of the private or evaluator packet (`role`, `facts`, `concealed`) | Holds |
| RR-28 | `arena_public` | `arena.trial_context` on the same trial after finalization | `AR003` |
| RR-29 | `arena_referee` | `training.voice_resumes` (Live handles stay with `arena_subject`) | `42501` |

## 4. `004_turns_and_versions.sql` (SCN-10, BKO-7, BKO-8, F07)

| ID | Assertion | Expected |
| --- | --- | --- |
| SV-01 | `submit_question` at version 0 returns turn 1 and version 1; emits `question_recorded` and a ledger `question_asked` with the question hash | Holds |
| SV-02 | Same key and question again | Same jsonb |
| SV-03 | Same key, different question | `AR003` |
| SV-04 | New key with expected version 0 after SV-01 | `AR002` |
| SV-05 | Second question while turn 1 is unanswered | `AR004` |
| SV-06 | Question 13 after 12 exchanges | `AR001` |
| SV-07 | `question_source` is `investigator` for training and `harness` for tournament trials, never caller-chosen | Holds |
| SV-08 | `open_work_item(trial, 'subject_answer')` with no open question | `AR004` |
| SV-09 | Version arithmetic over one exchange: question +1, release +1 (only if something is released), answer +1, coaching +0, finalize +1 | Matches |
| SV-10 | Owner `update arena.turns set question = ...` | `AR010` |
| SV-11 | Owner second write of an answer | `AR010` |
| SV-12 | Owner insert into `arena.turns` of a finalized trial | `AR001` |
| SV-13 | Turn in progress: after the subject answers on a trial with an assistant, `submit_question` and `release_evidence` | `AR004` each |
| SV-14 | The same after a `coach_card` or `coach_unavailable` event | Accepted |
| SV-15 | The same 121 s after the answer with no coach event (owner backdates `answered_at` with the turn trigger disabled) | Accepted (expiry) |
| SV-16 | `coach_deep` does not end the turn in progress | `AR004` still |
| SV-17 | Corpus trials (no assistant) never set `coaching_pending` | Holds |

## 5. `005_release_evidence.sql` (SCN-4, SCN-10)

| ID | Assertion | Expected |
| --- | --- | --- |
| RE-01 | Empty request at 0 exchanges, nothing scheduled at 0 | `released = []`, version unchanged |
| RE-02 | Request of a record with `request_after_turn` 1, at 0 exchanges | In `denied`; nothing released |
| RE-03 | Same request after 1 exchange (with the next question open) | Released once; version +1; one `evidence_released` event and one ledger event carrying its sha256 |
| RE-04 | Scheduled record at `scheduled_turn` 2 is released by an empty-list call after 2 exchanges | Released |
| RE-05 | Re-requesting a released record | In `already_released`; no new row |
| RE-06 | Unknown id; non-requestable id | `AR005` each |
| RE-07 | A `clarification` artifact emits a `clarification` event, a `record` emits `evidence_released` | Holds |
| RE-08 | Work item of another trial | `AR003` |
| RE-09 | Work item of kind `coaching` | `AR003` |
| RE-10 | Same work item, same list | Original result |
| RE-11 | Same work item, different list | `AR003` |
| RE-12 | Work item opened before a later version change | `AR002` |
| RE-13 | Release on a `replay` trial; on a finalized trial | `AR001` each |
| RE-14 | Seventh release on a case (the owner inserts a seventh artifact directly) | `AR006` |
| RE-15 | `arena.v_released_evidence` for a hidden running trial, as `arena_public` | 0 rows |
| RE-16 | The subject's `turn_context` for the open question includes evidence released for that question | Holds |

## 6. `006_record_subject_turn.sql` (SUB-7, SUB-8, SCN-6; forged turn and cross-trial)

| ID | Assertion | Expected |
| --- | --- | --- |
| ST-01 | Valid answer to the open question | `recorded`; answer stored; exchanges +1; tag proposal in `sealed.subject_tag_proposals`; `subject_turn` event |
| ST-02 | Forged turn: a `coaching` or `release` item presented as an answer | `AR003` |
| ST-03 | Forged turn: a random uuid | `AR003` |
| ST-04 | Forged turn: the done item of turn 1 with a different utterance | `AR003` |
| ST-05 | Replay of the done item with identical input | Original result; no second write |
| ST-06 | Cross-trial: trial B's open item presented on trial A | `AR003` |
| ST-07 | Item opened before a version change (owner bumps the version) | `AR002` |
| ST-08 | Item whose turn is not the latest open turn | `AR004` |
| ST-09 | Missing `guard_result.passed`; non-object tag; empty utterance | `AR007` each |
| ST-10 | Guard rejection: `quarantined`; utterance only in `sealed.quarantined_artifacts`; answer stays null; trial `terminated`; terminal `subject_quarantined`; `trial_ended` event with reason `subject_invalid` and no detail; all or nothing (an error raised after the call in the same transaction leaves no row) | Holds |
| ST-11 | Any later write on the quarantined trial | `AR001` |
| ST-12 | `arena_public` calls `record_subject_turn` | `42501` |
| ST-13 | Persistent-injection fixture: attack text at turn 2 that passed the guard (simulated miss) appears in later `trial_context` only inside `transcript` (data); no function interprets transcript text | Holds |
| ST-14 | `p_partial = true` stores `answer_partial` and the commitment's transcript hash covers it | Holds |

## 7. `007_coaching_events_caller.sql` (AST-1..8, SOL-6, KPI-4, F07; S5 section 6)

| ID | Assertion | Expected |
| --- | --- | --- |
| CC-01 | `coach_card` at the current version | Event with the next per-trial seq; candidate id from the trial |
| CC-02 | Stale version: coaching item opened before the answer, card recorded after it | `AR002` |
| CC-03 | Duplicate work item, same card and kind | Same `seq` |
| CC-04 | Card larger than 16 KiB | `23514` |
| CC-05 | Coaching on a `replay_corpus` trial; unknown kind | `AR001`; `AR007` |
| CC-06 | Per-trial event seq is gap-free and starts at 1 across all kinds | Holds |
| CC-07 | Visibility: training practice coach events `live`, assessment coach events `debrief`, every tournament event `internal` | Holds |
| CC-08 | `arena.events_after` for the owner: live rows always; debrief rows only after the trial ends; internal rows never; another actor or no actor gets nothing | Holds |
| CC-09 | `arena.v_trial_events` hides debrief rows while the trial runs | Holds |
| CC-10 | `events_after` page size is capped at 200 | Holds |
| CC-11 | KPI-4: `coach_card` writes `ops.latency_samples` with `server_ms` = coach event time minus subject event time; `coach_unavailable` writes `miss = true` | Holds |
| CC-12 | `record_client_latency` sets `client_ms` once; `kpi4_ms` = max(server, client) | Holds |
| CC-13 | `trial_context` with a closed item, wrong trial, or `failure` kind | `AR003` |
| CC-14 | Caller separation: actor set on a tournament trial | `AR040` |
| CC-15 | Caller separation: actor B on actor A's training trial | `AR040` |
| CC-16 | Caller separation: no actor on a training trial | `AR040` |
| CC-17 | `start_session` with no actor | `AR040` |

## 8. `008_finalize_commitment.sql` (BKO-9, SOL-5, EVL-9)

| ID | Assertion | Expected |
| --- | --- | --- |
| FC-01 | Finalize with a valid finding returns `commitment_sha256` and `payload_sha256`; writes `arena.final_findings`, a 32-byte `sealed.commitment_nonces` row, `ledger.finding_commitments`, terminal `completed`; trial `finalized`; `trial_ended` event | Holds |
| FC-02 | Duplicate work item, same finding | Same result; one commitment |
| FC-03 | Duplicate work item, different finding | `AR003` |
| FC-04 | Classification outside the three values; missing confidence; cited turn 9 of a 2-turn transcript; non-numeric cited turn | `AR007` each |
| FC-05 | Finalize over an open question | `AR004` |
| FC-06 | Finalize a corpus trial with a finding; an interview without one | `AR007` each |
| FC-07 | `verify_commitment` after finalization | true |
| FC-08 | Tamper fixture: owner disables the trigger and edits one answer | `verify_commitment` false |
| FC-09 | Tamper fixture: edit the stored finding | false |
| FC-10 | Tamper fixture: edit one coach event payload | false |
| FC-11 | Recompute `sha256(nonce || payload::text)` in the test from the nonce and `ledger.finding_commitments` | Equals the stored commitment |
| FC-12 | Two finalizations of identical payloads produce different commitments (fresh nonces) | Holds |
| FC-13 | `open_work_item` on a finalized trial | `AR001` |
| FC-14 | A replay trial's commitment hashes the source corpus transcript and evidence | `transcript_sha256` equals the corpus trial's |
| FC-15 | Training finalization emits `finding_committed` (live); tournament finalization does not | Holds |

## 9. `009_execution_failures.sql` (F15, BKO-9, EVL-5)

| ID | Assertion | Expected |
| --- | --- | --- |
| EF-01 | `budget_skipped` from `planned` | Terminal record; trial `terminated`; `trial_ended` reason `budget` |
| EF-02 | `budget_skipped` from `running`; `assistant_failed` from `planned` | `AR001` each |
| EF-03 | `assistant_failed` on a corpus trial; unknown state; empty reason | `AR007` each |
| EF-04 | A failure work item on a terminated trial | `AR001` |
| EF-05 | `retry_trial` after `infra_failed` creates attempt 2 (`planned`); a fourth attempt | Holds; `AR001` |
| EF-06 | `retry_trial` after `assistant_failed` or `completed` | `AR001` |
| EF-07 | `ledger.planned_execution` reports the latest attempt's state | Holds |
| EF-08 | `start_trial` on attempt 1 after attempt 2 exists | `AR001` |
| EF-09 | Replay trial whose corpus transcript was quarantined: `start_trial` records `source_unavailable` | Holds |
| EF-10 | Interactive start before the replay track has execution records (tournament with a replay track) | `AR001` (BKO-2) |
| EF-11 | Replay start before the corpus seal | `AR001` |
| EF-12 | Terminal records are append-only | `AR010` |

## 10. `010_concurrency.sql` (dblink)

| ID | Assertion | Expected |
| --- | --- | --- |
| CO-01 | Concurrent finalize: A finalizes with item X in an open transaction; B finalizes with item Y | B blocks (`dblink_is_busy = 1`) until A commits, then `AR001`; one terminal record, one commitment |
| CO-02 | Concurrent finalize with the same item X in both | Both return the same commitment; one row |
| CO-03 | Concurrent `submit_question`, different keys, same version | One succeeds; the other `AR002` after the lock |
| CO-04 | Concurrent `record_subject_turn`, same item, different utterances | One `recorded`; the other `AR003` |
| CO-05 | Reservation race in a bucket with room for one (test bucket 2.10, two 2.016 reservations) | First `reserved`; second waits on the bucket lock, then `refused` (`cap`); liability <= ceiling |
| CO-06 | 20 parallel reservations (4 sessions x 5) against the per-user cap | Liability of the user's reservations <= `per_user_daily_usd` |
| CO-07 | Two reservations racing in sibling leaf buckets for the last room in their parent | Exactly one admitted; parent liability <= parent ceiling |
| CO-08 | `adjudicate_validity` in A holds the tournament share lock; `reveal` in B | B waits; the manifest contains A's adjudication |
| CO-09 | `ledger.events.seq` after CO-01..CO-08 | `max(seq) = count(*)` |

## 11. `011_adjudication.sql` (SUB-7, SUB-8, EVL-11)

| ID | Assertion | Expected |
| --- | --- | --- |
| AD-01 | Adjudicate a completed interactive trial `valid` | Row with `after_reveal = false` |
| AD-02 | Same key, same content | Same id |
| AD-03 | Same key, different verdict | `AR003` |
| AD-04 | Training trial; quarantined trial; running trial | `AR001` each |
| AD-05 | Adjudication changes no transcript, finding or commitment (`verify_commitment` still true; row counts unchanged) | Holds |
| AD-06 | The latest adjudication is the one `build_manifest` uses | Holds |
| AD-07 | `arena_public` calls `adjudicate_validity` | `42501` |
| AD-08 | Adjudication after reveal has `after_reveal = true` | Holds |

## 12. `012_reveal_manifest.sql` (BKO-9, EVL-9, EVL-10, F14, F15)

| ID | Assertion | Expected |
| --- | --- | --- |
| RV-01 | Reveal in `draft`, `frozen`, `running`, `sealed` | `AR020` each |
| RV-02 | A planned trial without an execution record (owner forces `scoring` for the test) | `AR020` |
| RV-03 | A completed interactive trial without review | `AR020` |
| RV-04 | An `assistant_failed` interactive trial without review | `AR020` |
| RV-05 | Corpus seal missing; corpus transcript tampered after the seal | `AR021` each |
| RV-06 | One commitment that does not verify | `AR021` |
| RV-07 | Broken ledger chain (owner edits an event with the trigger disabled) | `AR021` |
| RV-08 | Hidden tournament whose seal no longer verifies | `AR021` |
| RV-09 | Roster row tampered after freeze | `AR021` |
| RV-10 | Successful reveal: status `revealed`; manifest version 1; `manifest_sha256 = hash_jsonb(manifest)`; ledger `tournament_revealed` with the same hash | Holds |
| RV-11 | Manifest completeness: `jsonb_array_length(manifest->'trials')` equals the planned trials and each `planned_trial_id` appears once | Holds |
| RV-12 | Manifest rules, one fixture per row of the table in S4 section 7.5 (completed+valid, assistant_failed+valid, completed+subject_invalid, quarantined, infra_failed, budget_skipped, budget_truncated, source_unavailable, replay on an invalid corpus, corpus rows) | Each entry's `assistant`, `subject`, `reason` match |
| RV-13 | Every adjudication id in force appears in the manifest | Holds |
| RV-14 | `ledger.revealed_nonces` holds one row per commitment of the tournament, equal to the sealed nonce in hex | Holds |
| RV-15 | Second reveal | Same manifest id and hash |
| RV-16 | Leaderboard insert before reveal; with another tournament's manifest; `original` on manifest v2; `corrected` on v1 | `AR020` each |
| RV-17 | Later adjudication, then `seal_corrected_manifest`: version 2 with `supersedes_id` = v1; v1 unchanged byte for byte | Holds |
| RV-18 | `seal_corrected_manifest` with nothing changed | Returns the latest version; no new row |
| RV-19 | Before reveal, as `arena_public`: hidden trials in `v_transcripts`, `v_findings`, `v_trial_events`, `v_adjudications`; `v_commitments.payload` | 0 rows; payload null while the commitment hash is visible |
| RV-20 | After reveal: the same views return the rows | Holds |

## 13. `013_ledger_chain.sql` (SCN-10, BKO-9)

| ID | Assertion | Expected |
| --- | --- | --- |
| LC-01 | After a scripted flow, `verify_chain()` | null (intact) |
| LC-02 | Each `prev_sha256` equals the previous `sha256`; seq starts at 1, gap-free | Holds |
| LC-03 | `chain_head` equals the last event | Holds |
| LC-04 | `update`/`delete` on `ledger.events` | `AR010` |
| LC-05 | Tamper fixture: payload edit with the trigger disabled | `verify_chain()` returns that seq |
| LC-06 | Tamper fixture: row deletion | Returns the first seq after the gap |
| LC-07 | Ledger payloads contain no key `role`, `answer`, `utterance`, `question` or `facts` (hashes only) | 0 |
| LC-08 | Digest independent of the session TimeZone (recompute under two settings) | Equal |

## 14. `014_budget.sql` (D-009, BKO-1, EVL-5; reservations never exceed caps)

| ID | Assertion | Expected |
| --- | --- | --- |
| BU-01 | Seeds: `global` 60.00; `demo` 12.43 + `build` 47.57 <= `global`; voice 1.635720 and 0.132140; `attempts_per_call` 4; call limits equal `cost_model.py` LIMITS (S5 parity script checks the same from Python) | Holds |
| BU-02 | Worst case `card` on `gemini-3.5-flash-lite` | 0.023200 |
| BU-03 | Worst case `generate` on `gemini-3.1-pro-preview` | 2.016000 |
| BU-04 | Fill `build` with `generate` reservations until refused | Refused at the 24th; liability 46.368000 <= 47.57 |
| BU-05 | Invariant after every step of this file: for every bucket, subtree liability <= ceiling | Holds |
| BU-06 | Per-user cap (proposed 3.00): `card` reservations for one actor | Refused after 129 (2.992800), reason `per_user_cap` |
| BU-07 | Unknown model or call kind | `AR007` |
| BU-08 | Same key, same inputs; different inputs | `exists` with the same id; `AR003` |
| BU-09 | Usage before dispatch | `AR001` |
| BU-10 | Attempt 5; a different model on a receipt | `AR007` each |
| BU-11 | Cost computed by the function (3000 in, 300 out on 3.5-flash-lite) | 0.001650 |
| BU-12 | Settle `committed` equals the receipts; second settle | Holds; `already_settled` |
| BU-13 | Settle `released` after dispatch | `AR001` |
| BU-14 | Settle `usage_unknown` keeps the full reservation | settled = reserved |
| BU-15 | `committed` with no receipts | `AR007` |
| BU-16 | Overrun: receipts beyond the reservation are recorded, `overrun = true`, kill switch on, a `kill_switch_events` row | Holds |
| BU-17 | Kill switch on: `reserve_model_call`, `reserve_voice`, `mark_dispatched`, `admit_unit` | `refused` / `skip` with reason `kill_switch` |
| BU-18 | `set_kill_switch` and `set_bucket_ceiling` by any runtime role | `42501` |
| BU-19 | Settled rows: any update; identity change on an open row | `AR010` each |
| BU-20 | `ops.model_prices`, `ops.call_limits` updates | `AR010` |
| BU-21 | Bucket tree: owner adds `experiments` 7.00 and `interactive` 40.57 under `build`; adding `generation` 0.01 | Accepted; `AR007` (children above parent) |
| BU-22 | Reservation into the non-leaf `build` | `AR007` |
| BU-23 | `experiments` fills to 6.048 and refuses the 4th `generate` (cap at `experiments`) | Holds |
| BU-24 | `set_bucket_ceiling` below current liability; changing a bucket's parent; making a bucket with reservations a parent | `AR007` each |
| BU-25 | `admit_unit`: admit when every bucket on the path has >= 1.5 x the high cost free, else skip | admit/admit/skip for 0.10, 15.00, 30.00 in the BU-21 tree |
| BU-26 | `ops.budget_status` reports subtree liability per bucket, released at 0, open and unknown at reserved, committed at settled | Holds |

## 15. `015_voice.sql` (D-006, D-009, direction 8.3 and 9; S5 section 7)

| ID | Assertion | Expected |
| --- | --- | --- |
| VB-01 | `reserve_voice('voice_session')` reserves 1.635720 and returns shutoff 1.090481 | Holds |
| VB-02 | `voice_probe` reserves 0.132140 | Holds |
| VB-03 | Third open voice reservation with `max_open_voice_sessions` 2 | `voice_concurrency` |
| VB-04 | Ninth voice session (`voice_sessions_total` 8); 31st probe | `voice_total_cap` each |
| VB-05 | Child coaching reservation counts against the session, not the bucket | Bucket liability unchanged |
| VB-06 | Child whose worst case exceeds the session's remaining room | `session_reservation_exhausted` |
| VB-07 | Usage reports return `shutoff = true` once spend reaches two thirds of the reservation, or when the kill switch is on | Holds |
| VB-08 | Settle the session with an open child | `AR031` |
| VB-09 | Settle `committed` = usage receipts + children's settled amounts | Holds |
| VB-10 | `arena_public` calls `reserve_voice` | `42501` |
| VB-11 | `open_voice_session` with an unclaimed ticket, a probe reservation, or another trial's reservation | `AR040` |
| VB-12 | Second open voice session on one training session | `23505` |
| VB-13 | `record_voice_question` on a closed session or another trial | `AR040`; on success returns turn, version and a `subject_answer` item; same key returns the same turn |
| VB-14 | `record_voice_utterance` keeps counts monotonic; `partial` true when ended with played < received | Holds |
| VB-15 | Resume: `issue_voice_resume` 4th time | `AR040` |
| VB-16 | `redeem_voice_resume` twice; after 10 minutes; by another actor; on a closed session | `AR040` each |
| VB-17 | `take_voice_handle` before redemption, twice, or 2 minutes after redemption | `AR040` each; once returns the stored handle |

## 16. `016_training_tickets.sql` (SOL-6, KPI-1, EVL-7, SCN-12, direction 4.3)

| ID | Assertion | Expected |
| --- | --- | --- |
| TT-01 | `start_session` on a hidden variant | `AR001` |
| TT-02 | Same key twice | Same session |
| TT-03 | `pre`/`post` outside the participant's counterbalanced set; `pre` in practice mode | `AR007` each |
| TT-04 | Sixth session in a day with `text_sessions_per_user_day` 5 | `AR040` |
| TT-05 | Ticket for another actor's trial; for a finalized trial; unknown kind | `AR040` each |
| TT-06 | Voice ticket with an open voice session on the trial; above `voice_sessions_per_user_day`; on a session without the voice flag | `AR040` each |
| TT-07 | Redeem twice; after expiry (owner backdates); by another actor; wrong kind | `AR040` each |
| TT-08 | Only `ticket_sha256` is stored | Holds |
| TT-09 | `claim_voice_ticket` before redemption, twice, with a different user, trial or mode | false each; true once for the correct binding |
| TT-10 | `rubric_scores.total` = 5 x sum; a dimension of 5 | Holds; `23514` |
| TT-11 | `v_my_scores` hides scores until the session's trial ends | Holds |
| TT-12 | `v_my_sessions`, `v_my_voice_fragments` return only the actor's rows; no actor returns none | Holds |
| TT-13 | `record_voice_fragment` on a closed session | `AR001` |

## 17. `017_trace_mirror.sql` (EVL-5, KPI-4, direction 10, R3-03; S5 section 8)

| ID | Assertion | Expected |
| --- | --- | --- |
| TM-01 | `mirror_spans` inserts; the same batch again inserts 0 | Holds |
| TM-02 | `tournament_id`, `split` and `export_state` are derived from `trial_id` | Holds |
| TM-03 | `otlp` over 32 KiB | `23514` |
| TM-04 | A span of a running hidden tournament is `held` and absent from `ops.v_exportable_spans`; present after reveal | Holds |
| TM-05 | `set_export_state(..., 'exported')` on a held span before reveal | 0 rows |
| TM-06 | `pending -> exported -> verified`; a second `exported` | Holds; 0 rows |
| TM-07 | Any change other than export state | `AR010` |
| TM-08 | Batch of 501 spans | `AR007` |
| TM-09 | `prune_trace_mirror(6)`; `prune_trace_mirror(7)` leaves hidden and unverified spans; an owner `delete` of one | `AR007`; Holds; `AR010` |
| TM-10 | `record_trace_summary`: `telemetry_incomplete` true when mirrored < expected, failures > 0, or expected = 0 | Holds |

## 18. `018_keepalive_and_misc.sql`

| ID | Assertion | Expected |
| --- | --- | --- |
| KA-01 | `ops.keepalive('scheduler')` inserts one ping and prunes pings older than 14 days | Holds |
| KA-02 | Each trial, ledger, training-session and budget write function (S4 sections 6 to 8) refuses a SERIALIZABLE transaction | `AR001` |
| KA-03 | Delete from `arena.tournaments`, `arena.trials`, `ops.budget_buckets` | `AR010` each |
| KA-04 | Freeze a hidden tournament before the seal | `AR021` |
| KA-05 | `add_planned_trials` after freeze | `AR001` |
| KA-06 | Replay row referencing a corpus row of another variant | `AR007` |
