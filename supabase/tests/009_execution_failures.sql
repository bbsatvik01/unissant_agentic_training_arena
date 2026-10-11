-- 009_execution_failures.sql (sql/TESTS.md section 9; F15, BKO-9, EVL-5; WP-04a).
begin;
\ir harness/fixtures.psql
select plan(24);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

-- ---------------------------------------------------------------------------- EF-01, EF-02
create temp table ef on commit drop as select tests.family('EFDEV', 'dev') as id;
create temp table eftour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table efplanned on commit drop as select tests.trial((select tour from eftour), 3) as trial;
create temp table ef01 on commit drop as
  select arena.record_execution_failure((select trial from efplanned),
    (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from efplanned), 'failure',
       tests.k((select trial from efplanned), 0, 'failure', 'ef01'))) ->> 'work_item_id')::uuid,
    'budget_skipped', 'no budget headroom') as r;
select is(array[(select state from ledger.terminal_records where trial_id = (select trial from efplanned)),
                (select status from arena.trials where id = (select trial from efplanned)),
                (select payload ->> 'reason' from arena.trial_events where trial_id = (select trial from efplanned) and kind = 'trial_ended')],
          array['budget_skipped', 'terminated', 'budget'],
  'EF-01 budget_skipped from planned writes a terminal record, terminates the trial, and emits trial_ended '
  || 'reason budget');
create temp table ef02planned on commit drop as select tests.trial((select tour from eftour), 4) as trial;
create temp table ef02running on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from ef02planned))) ->> 'trial_id')::uuid as trial;
select is(array[
    tests.error(format('select arena.record_execution_failure(%L, %L, %L, %L)', (select trial from ef02running),
      (arena.open_work_item((select trial from ef02running), 'failure', tests.k((select trial from ef02running), 0, 'failure', 'ef02a'))
        ->> 'work_item_id'), 'budget_skipped', 'too late')),
    tests.error(format('select arena.record_execution_failure(%L, %L, %L, %L)', (select trial from efplanned),
      gen_random_uuid(), 'assistant_failed', 'too early'))],
  array['AR001: budget_skipped is not allowed from running', 'AR003: unknown work item'],
  'EF-02 budget_skipped from running (AR001) and assistant_failed from planned via an unknown item (AR003, the '
  || 'terminated trial from EF-01 holds no open failure item either) are each refused');

-- ---------------------------------------------------------------------------- EF-03
create temp table efcorpus on commit drop as select tests.tournament('dev', array['replay_corpus']) as tour;
create temp table efct on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from efcorpus), 1)))) ->> 'trial_id')::uuid as trial;
select is(array[
    tests.error(format('select arena.record_execution_failure(%L, %L, %L, %L)', (select trial from efct),
      (arena.open_work_item((select trial from efct), 'failure', tests.k((select trial from efct), 0, 'failure', 'ef03a'))
        ->> 'work_item_id'), 'assistant_failed', 'no assistant here')),
    tests.error(format('select arena.record_execution_failure(%L, %L, %L, %L)', (select trial from ef02running),
      (arena.open_work_item((select trial from ef02running), 'failure', tests.k((select trial from ef02running), 0, 'failure', 'ef03b'))
        ->> 'work_item_id'), 'bogus_state', 'x')),
    tests.error(format('select arena.record_execution_failure(%L, %L, %L, %L)', (select trial from ef02running),
      (arena.open_work_item((select trial from ef02running), 'failure', tests.k((select trial from ef02running), 0, 'failure', 'ef03c'))
        ->> 'work_item_id'), 'assistant_failed', ''))],
  array['AR007: state must be a failure state valid for this trial, with a reason',
        'AR007: state must be a failure state valid for this trial, with a reason',
        'AR007: state must be a failure state valid for this trial, with a reason'],
  'EF-03 assistant_failed on a corpus trial, an unknown state, and an empty reason are each refused (AR007)');

-- ---------------------------------------------------------------------------- EF-04
select arena.record_execution_failure((select trial from ef02running),
  (arena.open_work_item((select trial from ef02running), 'failure', tests.k((select trial from ef02running), 0, 'failure', 'ef04setup'))
    ->> 'work_item_id')::uuid, 'infra_failed', 'network blip');
select tests.throws(
  format('select arena.open_work_item(%L, %L, %L)', (select trial from ef02running), 'failure',
         tests.k((select trial from ef02running), 0, 'failure', 'ef04later')),
  'AR001', 'is terminated', 'EF-04 a failure work item on a terminated trial is refused (AR001)');

-- ---------------------------------------------------------------------------- EF-05, EF-06
-- retry_trial takes the planned_trial id (arena.planned_trials.id), not an attempt's own trial id.
create temp table ef02pt on commit drop as select planned_trial_id as pt from arena.trials where id = (select trial from ef02planned);
create temp table ef05a2 on commit drop as select arena.retry_trial((select pt from ef02pt)) as trial;
select is((select status from arena.trials where id = (select trial from ef05a2)), 'planned',
  'EF-05 retry_trial after infra_failed creates attempt 2 (planned)');
create temp table ef05a2run on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from ef05a2))) ->> 'trial_id')::uuid as trial;
select arena.record_execution_failure((select trial from ef05a2run),
  (arena.open_work_item((select trial from ef05a2run), 'failure', tests.k((select trial from ef05a2run), 0, 'failure', 'ef05a3'))
    ->> 'work_item_id')::uuid, 'infra_failed', 'blip 2');
create temp table ef05a3 on commit drop as select arena.retry_trial((select pt from ef02pt)) as trial;
select tests.throws(
  format('select arena.retry_trial(%L)', (select pt from ef02pt)),
  'AR001', 'infra_failed latest attempt below 3 attempts', 'EF-05 a fourth attempt is refused (AR001, at most 3 attempts)');
select tests.throws(
  format('select arena.retry_trial(%L)', (select planned_trial_id from arena.trials where id = (select trial from efplanned))),
  'AR001', 'infra_failed latest attempt below 3 attempts', 'EF-06 retry_trial after assistant_failed is refused (efplanned''s latest is budget_skipped, the same guard)');
select tests.throws(
  format('select arena.retry_trial(%L)', (select pt from ef02pt)),
  'AR001', 'infra_failed latest attempt below 3 attempts', 'EF-06 retry_trial after a completed attempt (and, equally, after 3) is refused (AR001)');

-- ---------------------------------------------------------------------------- EF-07
select is((select state from ledger.planned_execution((select tour from eftour)) where planned_trial_id = (select pt from ef02pt)),
          (select state from ledger.terminal_records where trial_id = (select trial from ef05a3)),
  'EF-07 ledger.planned_execution reports the planned trial''s latest-attempt state');

-- ---------------------------------------------------------------------------- EF-08
-- Attempt 1, once started, is always 'running' or terminated by the time a later attempt exists (infra_failed
-- requires it to have run first), so re-starting it hits the earlier state check with this message first; still
-- the same AR001 refusal the row asks for.
select tests.throws(
  format('select arena.start_trial(%L)', (select trial from ef02planned)),
  'AR001', 'starts only while its tournament runs', 'EF-08 start_trial on attempt 1 after attempt 2 exists is refused (AR001)');

-- ---------------------------------------------------------------------------- EF-09
create temp table efrep1 on commit drop as select tests.tournament('dev', array['replay_corpus', 'replay']) as tour;
create temp table efrepcorpus on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from efrep1), 1)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from efrepcorpus), 0, 'Question 1',
         tests.k((select trial from efrepcorpus), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select trial from efrepcorpus),
         (arena.open_work_item((select trial from efrepcorpus), 'subject_answer',
            tests.k((select trial from efrepcorpus), 1, 'subject_answer', 'q'))->> 'work_item_id')::uuid,
         'an unsafe utterance', null, jsonb_build_object('passed', false, 'rule', 'G3_nonneutral'));
-- A quarantined corpus trial still carries a terminal record, so the corpus can still be sealed (seal_replay_corpus
-- requires an execution record for every corpus row, and the SG2-27 R1/adjudication gate applies only to
-- completed ones); the replay row can then start, finds no completed+valid source, and is source_unavailable.
select ledger.seal_replay_corpus((select tour from efrep1));
create temp table efrep2 on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from efrep1), 2)))) ->> 'trial_id')::uuid as trial;
select is((select state from ledger.terminal_records where trial_id = (select trial from efrep2)), 'source_unavailable',
  'EF-09 a replay trial whose corpus transcript was quarantined is recorded source_unavailable at start_trial');

-- ---------------------------------------------------------------------------- EF-10
-- A fresh tournament with all three tracks: the corpus has not even started, so the replay track holds no
-- execution record at all, which already blocks interactive (the same AR001 covers both of BKO-2's gates).
create temp table efrep10 on commit drop as select tests.tournament('dev', array['replay_corpus', 'replay', 'interactive']) as tour;
select tests.throws(
  format('select arena.start_trial(%L)', (select tests.trial((select tour from efrep10), 3))),
  'AR001', 'interactive trials start after the replay track', 'EF-10 interactive start before the replay track has execution records is refused (AR001, BKO-2)');

-- ---------------------------------------------------------------------------- EF-11
select tests.throws(
  format('select arena.start_trial(%L)', (select tests.trial((select tour from efrep10), 2))),
  'AR001', 'replay scoring starts after the corpus seal', 'EF-11 replay start before the corpus seal is refused (AR001, BKO-2/6)');

-- ---------------------------------------------------------------------------- EF-12
select tests.throws(
  format('update ledger.terminal_records set reason = %L where trial_id = %L', 'edited', (select trial from efplanned)),
  'AR010', 'append-only', 'EF-12 terminal records are append-only (AR010)');

-- ---------------------------------------------------------------------------- EF-13
select tests.throws(
  format('select ledger.seal_replay_corpus(%L)', (select tour from efrep10)),
  'AR001', 'execution record', 'EF-13 setup: efrep10''s corpus row has no execution record yet (AR001, distinct from the R1/adjudication gate below)');
select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select tests.trial((select tour from efrep10), 1))));
select arena.submit_question((select tests.trial((select tour from efrep10), 1)), 0, 'Question 1',
         tests.k((select tests.trial((select tour from efrep10), 1)), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select tests.trial((select tour from efrep10), 1)),
         (arena.open_work_item((select tests.trial((select tour from efrep10), 1)), 'subject_answer',
            tests.k((select tests.trial((select tour from efrep10), 1)), 1, 'subject_answer', 'ef13')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
select arena.finalize_trial((select tests.trial((select tour from efrep10), 1)),
         (arena.open_work_item((select tests.trial((select tour from efrep10), 1)), 'finalize',
            tests.k((select tests.trial((select tour from efrep10), 1)), 1, 'finalize', 'ef13')) ->> 'work_item_id')::uuid, null);
select tests.throws(
  format('select ledger.seal_replay_corpus(%L)', (select tour from efrep10)),
  'AR001', 'R1 report and an initial validity verdict', 'EF-13 SG2-27: a completed corpus transcript lacking its R1 report is refused (AR001)');
insert into sealed.judgments (trial_id, kind, payload, idempotency_key)
  values ((select tests.trial((select tour from efrep10), 1)), 'fidelity_detail', jsonb_build_object('summary', 'none'), 'ef13-r1-00');
select tests.throws(
  format('select ledger.seal_replay_corpus(%L)', (select tour from efrep10)),
  'AR001', 'R1 report and an initial validity verdict', 'EF-13 SG2-27: lacking an adjudication too is refused (AR001)');
select ledger.adjudicate_validity((select tests.trial((select tour from efrep10), 1)), 'valid', 'no deception', null, 'auto_rule', 'ef13-adj');
create temp table ef13seal1 on commit drop as select ledger.seal_replay_corpus((select tour from efrep10)) as h;
select ok((select h from ef13seal1) ~ '^[0-9a-f]{64}$', 'EF-13 with both an R1 report and an adjudication, the corpus seals');
do $$
begin
  alter table sealed.judgments disable trigger judgments_append_only;
  update sealed.judgments set payload = jsonb_build_object('summary', 'changed') where idempotency_key = 'ef13-r1-00';
  alter table sealed.judgments enable trigger judgments_append_only;
end $$;
select isnt((select corpus_sha256 from ledger.corpus_digest((select tour from efrep10))), (select h from ef13seal1),
  'EF-13 the digest changes if that transcript''s first R1 payload is altered (trigger disabled)');
do $$
begin
  alter table sealed.judgments disable trigger judgments_append_only;
  update sealed.judgments set payload = jsonb_build_object('summary', 'none') where idempotency_key = 'ef13-r1-00';
  alter table sealed.judgments enable trigger judgments_append_only;
end $$;

-- ---------------------------------------------------------------------------- EF-14
create temp table ef14 on commit drop as select tests.tournament('dev', array['replay_corpus', 'replay']) as tour;
create temp table ef14corpus on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from ef14), 1)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from ef14corpus), 'Question 1', '{}', 'Answer 1');
select arena.finalize_trial((select trial from ef14corpus),
         (arena.open_work_item((select trial from ef14corpus), 'finalize', tests.k((select trial from ef14corpus), 1, 'finalize', 'ef14'))
           ->> 'work_item_id')::uuid, null);
insert into sealed.judgments (trial_id, kind, payload, idempotency_key)
  values ((select trial from ef14corpus), 'fidelity_detail', jsonb_build_object('summary', 'none'), 'ef14-r1-00');
select ledger.adjudicate_validity((select trial from ef14corpus), 'subject_invalid', 'evasive throughout', null, 'auto_rule', 'ef14-adj1');
create temp table ef14seal on commit drop as select ledger.seal_replay_corpus((select tour from ef14)) as h;
create temp table ef14rep on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from ef14), 2)))) ->> 'trial_id')::uuid as trial;
select is((select state from ledger.terminal_records where trial_id = (select trial from ef14rep)), 'source_unavailable',
  'EF-14 SG2-27: a replay trial whose source''s initial (sealed) verdict is subject_invalid is recorded source_unavailable');
select ledger.adjudicate_validity((select trial from ef14corpus), 'valid', 'corrected on review', null, 'reviewer-1', 'ef14-adj2');
select is((select corpus_sha256 from ledger.corpus_digest((select tour from ef14))), (select h from ef14seal),
  'EF-14 a later correcting adjudication does not change the corpus seal digest (the seal fixes the first '
  || 'verdict, not the latest)');

-- ---------------------------------------------------------------------------- EF-15
select is(ledger.seal_replay_corpus((select tour from ef14)), (select h from ef14seal),
  'EF-15 SG3-24: a second seal_replay_corpus call on the same tournament returns the same hash (idempotent)');
-- A replay_corpus-only tournament (no 'replay' track): close_tournament_run's seal check is otherwise
-- unreachable, since starting a 'replay' trial itself requires the corpus to already be sealed (BKO-2/6).
create temp table ef15 on commit drop as select tests.tournament('dev', array['replay_corpus']) as tour;
create temp table ef15corpus on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from ef15), 1)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from ef15corpus), 'Question 1', '{}', 'Answer 1');
select arena.finalize_trial((select trial from ef15corpus),
         (arena.open_work_item((select trial from ef15corpus), 'finalize', tests.k((select trial from ef15corpus), 1, 'finalize', 'ef15'))
           ->> 'work_item_id')::uuid, null);
insert into sealed.judgments (trial_id, kind, payload, idempotency_key)
  values ((select trial from ef15corpus), 'fidelity_detail', jsonb_build_object('summary', 'none'), 'ef15-r1-00');
select ledger.adjudicate_validity((select trial from ef15corpus), 'valid', 'no deception', null, 'auto_rule', 'ef15-adj-00');
select tests.throws(
  format('select arena.close_tournament_run(%L)', (select tour from ef15)),
  'AR001', 'replay corpus must be sealed', 'EF-15 close_tournament_run before the seal is refused (AR001) once every planned trial has an execution record');
create temp table ef15seal on commit drop as select ledger.seal_replay_corpus((select tour from ef15)) as h;
select arena.close_tournament_run((select tour from ef15));
select is(array[(select status from arena.tournaments where id = (select tour from ef15)),
                (select corpus_sha256 from ledger.corpus_seals where tournament_id = (select tour from ef15))],
          array['sealed', (select h from ef15seal)],
  'EF-15 close_tournament_run succeeds after the seal, and does not reseal (the stored hash is still the one '
  || 'seal_replay_corpus returned)');

select * from finish();
rollback;
