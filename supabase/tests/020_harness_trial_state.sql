-- 020_harness_trial_state.sql (WP-28; S5 5.3, S4 2.3, 5.5, 9.1, Q1; SCN-12, L7): the tournament job's own
-- in-flight reads of a running trial (arena.harness_trial_state), and proof that no public or investigator
-- path reads a hidden trial before reveal: not the projection views a recording export reads
-- (`make export-run`, `GET /api/trials/{id}/recording`, `arena_core.events.load`), with or without an actor,
-- and not this function once the trial has left `running`.
begin;
\ir harness/fixtures.psql
select plan(12);
select tests.users();

create temp table hs on commit drop as select tests.tournament('hidden', array['interactive']) as tour;
create temp table hs3 on commit drop as select tests.trial((select tour from hs), 3) as trial;
create temp table hs4 on commit drop as select tests.trial((select tour from hs), 4) as trial;

-- ---------------------------------------------------------------------------- HS-01
-- A planned trial has no in-flight state yet.
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', format('select arena.harness_trial_state(%L)', (select trial from hs4))),
  'AR001', 'only while the trial runs', 'HS-01 a planned (not started) tournament trial is refused (AR001)');

select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from hs3)));
select tests.exchange((select trial from hs3), 'Question 1', '{}'::text[], 'Answer 1');
select tests.exchange((select trial from hs3), 'Question 2', array['rec-01'], 'Answer 2');
select tests.exchange((select trial from hs3), 'Question 3', '{}'::text[], 'Answer 3');

-- ---------------------------------------------------------------------------- HS-02
create temp table hs02 on commit drop as
  select tests.as_role('arena_public', format('select arena.harness_trial_state(%L)', (select trial from hs3))) as s;
select is(array[
    (select s ->> 'trial_id' from hs02), (select s ->> 'kind' from hs02), (select s ->> 'exchanges' from hs02),
    (select s ->> 'open_question' from hs02),
    ((select s -> 'public_packet' from hs02) = (select p.packet from sealed.hidden_public_packets p
                                                  join arena.trials t on t.variant_id = p.variant_id
                                                 where t.id = (select trial from hs3)))::text,
    (select s -> 'released' from hs02)::text,
    (select jsonb_agg(jsonb_build_array(e ->> 'kind', e -> 'turn_no', e -> 'payload')) from hs02,
       jsonb_array_elements(s -> 'coach_events') e)::text,
    (select jsonb_agg((e ->> 'seq')::integer) from hs02, jsonb_array_elements(s -> 'coach_events') e)::text],
  array[(select trial from hs3)::text, 'interactive', '3', 'false', 'true',
    '[{"title": "Work order", "record_id": "rec-01", "released_after_exchanges": 1}, '
      || '{"title": "Badge log", "record_id": "rec-02", "released_after_exchanges": 2}]',
    '[["coach_card", 1, {"card": "fixture", "turn_no": 1}], ["coach_card", 2, {"card": "fixture", "turn_no": 2}], '
      || '["coach_card", 3, {"card": "fixture", "turn_no": 3}]]',
    (select jsonb_agg(seq order by seq) from arena.trial_events
      where trial_id = (select trial from hs3) and kind = 'coach_card')::text],
  'HS-02 the job (arena_public, no actor) reads its running hidden trial''s own state: the sealed public packet byte '
  || 'for byte, released record ids, titles and exchange counts (never their content), and its coach events');

-- ---------------------------------------------------------------------------- HS-03
-- Before reveal, the projections a recording export reads (arena_core.events.load: v_trials meta, v_trial_events,
-- v_released_evidence, the packet from v_dev_cases or v_hidden_cases; and the transcripts, findings, commitment
-- payloads and ledger rows) show nothing of the same running trial, with no actor (`make export-run` run as a
-- job-shaped caller, or dev_tournament_demo) and with an investigator's actor alike.
create or replace function pg_temp.hs_visible(p_trial uuid) returns text
language sql as $$
  select tests.as_role('arena_public', format(
    'select jsonb_build_array('
    || '(select count(*) from arena.v_transcripts where trial_id = %1$L),'
    || '(select count(*) from arena.v_released_evidence where trial_id = %1$L),'
    || '(select count(*) from arena.v_trial_events where trial_id = %1$L),'
    || '(select count(*) from arena.v_findings where trial_id = %1$L),'
    || '(select count(*) from ledger.v_commitments where trial_id = %1$L and payload is not null),'
    || '(select count(*) from ledger.v_events where trial_id = %1$L),'
    || '(select count(*) from ledger.v_adjudications where trial_id = %1$L),'
    || '(select count(*) from arena.v_dev_cases where variant_id = %2$L),'
    || '(select count(*) from arena.v_hidden_cases where variant_id = %2$L))',
    p_trial, (select variant_id from arena.trials where id = p_trial)))::text
$$;
select set_config('arena.actor_id', '', true);
create temp table hs03none on commit drop as select pg_temp.hs_visible((select trial from hs3)) as v;
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table hs03actor on commit drop as select pg_temp.hs_visible((select trial from hs3)) as v;
select set_config('arena.actor_id', '', true);
select is(array[(select v from hs03none), (select v from hs03actor)],
          array['[0, 0, 0, 0, 0, 0, 0, 0, 0]', '[0, 0, 0, 0, 0, 0, 0, 0, 0]'],
  'HS-03 before reveal no projection shows the running hidden trial''s content or packet, with or without an actor');

-- ---------------------------------------------------------------------------- HS-04
select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from hs4)));
select arena.submit_question((select trial from hs4), 0, 'Question 1',
                             tests.k((select trial from hs4), 1, 'question', 'harness_fixed'), 'harness_fixed');
create temp table hs04 on commit drop as
  select tests.as_role('arena_public', format('select arena.harness_trial_state(%L)', (select trial from hs4))) as s;
select is(array[(select s ->> 'open_question' from hs04), (select s ->> 'exchanges' from hs04),
                (select s -> 'released' from hs04)::text, (select s -> 'coach_events' from hs04)::text,
                ((select s -> 'public_packet' from hs04) = (select p.packet from sealed.hidden_public_packets p
                   where p.variant_id = tests.variant('THID', 'deceptive')))::text],
          array['true', '0', '[]', '[]', 'true'],
  'HS-04 a question with no answer yet reads as open_question (the job''s between-turns check, S5 5.4), and each '
  || 'trial reads its own variant''s packet');

-- ---------------------------------------------------------------------------- HS-05
select set_config('arena.actor_id', tests.uid('A')::text, true);
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', format('select arena.harness_trial_state(%L)', (select trial from hs3))),
  'AR040', 'may not act on this trial', 'HS-05 an investigator request (actor set) on a tournament trial is refused (AR040)');

-- ---------------------------------------------------------------------------- HS-06
create temp table hs06 on commit drop as select tests.family('HSPRAC', 'dev') as id;
create temp table hs06s on commit drop as
  select (training.start_session(tests.variant('HSPRAC', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), false, 'hs06-practice') ->> 'trial_id')::uuid as trial;
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', format('select arena.harness_trial_state(%L)', (select trial from hs06s))),
  'AR040', 'may not act on this trial', 'HS-06 the owner''s own running training trial is refused too (harness requests only)');
select set_config('arena.actor_id', '', true);

-- ---------------------------------------------------------------------------- HS-07
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', format('select arena.harness_trial_state(%L)', (select trial from hs06s))),
  'AR040', 'may not act on this trial', 'HS-07 a training trial with no actor is refused (AR040)');

-- ---------------------------------------------------------------------------- HS-08
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', format('select arena.harness_trial_state(%L)', gen_random_uuid())),
  'AR040', 'may not act on this trial', 'HS-08 an unknown trial id is refused like a forbidden one (AR040, no oracle)');

-- ---------------------------------------------------------------------------- HS-09
select is(array[tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject',
                  format('select arena.harness_trial_state(%L)', (select trial from hs3))))::text,
                tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_referee',
                  format('select arena.harness_trial_state(%L)', (select trial from hs3))))::text],
          array['42501', '42501'],
  'HS-09 arena_subject and arena_referee may not execute it (42501)');

-- ---------------------------------------------------------------------------- HS-10
-- Finalized: nothing hidden is readable by arena_public until reveal (S4 Q1), through this function or any view.
select arena.finalize_trial((select trial from hs3),
  (arena.open_work_item((select trial from hs3), 'finalize', tests.k((select trial from hs3), 3, 'finalize', 'hs10'))
     ->> 'work_item_id')::uuid,
  jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
    'rationale', 'hs', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb,
    'corroboration_needed', '[]'::jsonb));
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', format('select arena.harness_trial_state(%L)', (select trial from hs3))),
  'AR001', 'only while the trial runs', 'HS-10 a finalized hidden trial is refused (AR001): the read ends with the run');

-- ---------------------------------------------------------------------------- HS-11
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table hs11actor on commit drop as select pg_temp.hs_visible((select trial from hs3)) as v;
select set_config('arena.actor_id', '', true);
select is(array[pg_temp.hs_visible((select trial from hs3)), (select v from hs11actor)],
          array['[0, 0, 0, 0, 0, 0, 0, 0, 0]', '[0, 0, 0, 0, 0, 0, 0, 0, 0]'],
  'HS-11 after finalization, before reveal, every projection still shows nothing of the hidden trial');

-- ---------------------------------------------------------------------------- HS-12
-- Terminated by an execution failure: refused the same way (only `running` is in flight).
select arena.record_execution_failure((select trial from hs4),
  (arena.open_work_item((select trial from hs4), 'failure', tests.k((select trial from hs4), 0, 'failure', 'infra_failed'))
     ->> 'work_item_id')::uuid, 'infra_failed', 'hs fixture');
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', format('select arena.harness_trial_state(%L)', (select trial from hs4))),
  'AR001', 'only while the trial runs', 'HS-12 a terminated hidden trial is refused (AR001)');

select * from finish();
rollback;
