-- 011_adjudication.sql (sql/TESTS.md section 11; SUB-7, SUB-8, EVL-11; WP-04b). No dblink: every scenario
-- here is a single-session sequence, not a race.
begin;
\ir harness/fixtures.psql
select plan(13);
select tests.users();

-- a fresh completed interactive (truthful) trial, started and finalized, ready for adjudication.
create or replace function pg_temp.ad_trial() returns uuid
language plpgsql as $$
declare
  v_tour  uuid := tests.tournament('dev', array['interactive']);
  v_trial uuid := tests.trial(v_tour, 3);
begin
  perform tests.as_role('arena_public', format('select arena.start_trial(%L)', v_trial));
  perform tests.exchange(v_trial, 'Question 1', '{}'::text[], 'Answer 1');
  return v_trial;
end $$;
create or replace function pg_temp.ad_finalize(p_trial uuid, p_key text default 'f') returns void
language plpgsql as $$
declare v_wi uuid;
begin
  v_wi := (arena.open_work_item(p_trial, 'finalize', tests.k(p_trial, 1, 'finalize', p_key)) ->> 'work_item_id')::uuid;
  perform arena.finalize_trial(p_trial, v_wi, jsonb_build_object('label', 'insufficient_evidence', 'likelihood',
    'roughly_even_chance', 'confidence', 'low', 'rationale', 'ad', 'basis_flag_refs', '[]'::jsonb,
    'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------- AD-01, AD-02, AD-03
create temp table ad1 on commit drop as select pg_temp.ad_trial() as trial;
select pg_temp.ad_finalize((select trial from ad1));
create temp table ad1row on commit drop as
  select ledger.adjudicate_validity((select trial from ad1), 'valid', 'ad-01 reason', null, 'ad01reviewer',
    'ad01-key-001') as id;
select is((select after_reveal from ledger.validity_adjudications where id = (select id from ad1row)), false,
  'AD-01 adjudicating a completed interactive trial valid gives a row with after_reveal = false');

select is((select ledger.adjudicate_validity((select trial from ad1), 'valid', 'ad-01 reason', null, 'ad01reviewer',
    'ad01-key-001')), (select id from ad1row),
  'AD-02 the same key with the same content returns the same adjudication id');

select is(tests.error(format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', (select trial from ad1),
    'subject_invalid', 'ad-01 reason', 'ad01reviewer', 'ad01-key-001')),
  'AR003: idempotency key reused with a different adjudication',
  'AD-03 the same key with a different verdict is refused (AR003)');

-- ---------------------------------------------------------------------------- AD-04
create temp table ad04train on commit drop as select tests.family('AD04TRN', 'dev') as id;
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table ad04t on commit drop as
  select (training.start_session(tests.variant('AD04TRN', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), false, 'ad04-training-01') ->> 'trial_id')::uuid as trial;
select set_config('arena.actor_id', '', true);

create temp table ad04qtour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table ad04qt on commit drop as select tests.trial((select tour from ad04qtour), 4) as trial;
select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from ad04qt)));
select arena.submit_question((select trial from ad04qt), 0, 'Question 1',
  tests.k((select trial from ad04qt), 1, 'question', 'q1'), 'harness_fixed');
create temp table ad04qwi on commit drop as
  select (arena.open_work_item((select trial from ad04qt), 'subject_answer',
            tests.k((select trial from ad04qt), 1, 'subject_answer', 'ans')) ->> 'work_item_id')::uuid as wi;
select arena.record_subject_turn((select trial from ad04qt), (select wi from ad04qwi), '', null,
  '{"passed": false, "rule": "G0_blocked"}'::jsonb);

create temp table ad04rtour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table ad04r on commit drop as select tests.trial((select tour from ad04rtour), 3) as trial;
select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from ad04r)));

select is(array[
    tests.error(format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', (select trial from ad04t),
      'valid', 'ad-04 reason', 'ad04reviewer', 'ad04-training-k1')),
    tests.error(format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', (select trial from ad04qt),
      'valid', 'ad-04 reason', 'ad04reviewer', 'ad04-quarantine-k1')),
    tests.error(format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', (select trial from ad04r),
      'valid', 'ad-04 reason', 'ad04reviewer', 'ad04-running-k001'))],
  array['AR001: subject validity is adjudicated on tournament interviews only',
        'AR001: only completed or assistant_failed interviews need subject review',
        'AR001: only completed or assistant_failed interviews need subject review'],
  'AD-04 a training trial, a quarantined trial and a running trial are each refused (AR001)');

-- ---------------------------------------------------------------------------- AD-05
create temp table ad05before on commit drop as select
  (select count(*) from arena.turns where trial_id = (select trial from ad1)) as turns,
  (select count(*) from ledger.finding_commitments where trial_id = (select trial from ad1)) as commitments,
  (select answer from arena.turns where trial_id = (select trial from ad1) and turn_no = 1) as answer,
  (select ledger.verify_commitment((select trial from ad1))) as verified;
select ledger.adjudicate_validity((select trial from ad1), 'valid', 'ad-05 another reason', null, 'ad05reviewer',
  'ad05-key-0001');
select is(array[
    (select count(*)::text from arena.turns where trial_id = (select trial from ad1)),
    (select count(*)::text from ledger.finding_commitments where trial_id = (select trial from ad1)),
    (select answer from arena.turns where trial_id = (select trial from ad1) and turn_no = 1),
    (select ledger.verify_commitment((select trial from ad1)))::text],
  array[(select turns::text from ad05before), (select commitments::text from ad05before),
        (select answer from ad05before), (select verified::text from ad05before)],
  'AD-05 a second adjudication changes no transcript, finding or commitment: verify_commitment still true, '
  || 'row counts unchanged');

-- ---------------------------------------------------------------------------- AD-06, AD-08
create temp table ad68tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table ad68a on commit drop as select tests.trial((select tour from ad68tour), 3) as trial;
create temp table ad68b on commit drop as select tests.trial((select tour from ad68tour), 4) as trial;
select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from ad68a)));
select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from ad68b)));
select tests.exchange((select trial from ad68a), 'Question 1', '{}'::text[], 'Answer A');
select tests.exchange((select trial from ad68b), 'Question 1', '{}'::text[], 'Answer B');
select pg_temp.ad_finalize((select trial from ad68a), 'fin-a');
select pg_temp.ad_finalize((select trial from ad68b), 'fin-b');
create temp table ad68first on commit drop as select
  ledger.adjudicate_validity((select trial from ad68a), 'valid', 'first pass', null, 'ad68r1', 'ad68-a-first-001') as id;
select ledger.adjudicate_validity((select trial from ad68b), 'valid', 'first pass', null, 'ad68r1', 'ad68-b-first-001');
select arena.close_tournament_run((select tour from ad68tour));
select arena.begin_scoring((select tour from ad68tour));
select ledger.reveal((select tour from ad68tour));
create temp table ad68second on commit drop as select
  ledger.adjudicate_validity((select trial from ad68a), 'subject_invalid', 'correction after reveal', null, 'ad68r2',
    'ad68-a-second-01') as id;
select ledger.seal_corrected_manifest((select tour from ad68tour));
create temp table ad68manifest on commit drop as select manifest from ledger.inclusion_manifests
 where tournament_id = (select tour from ad68tour) order by version desc limit 1;
select is(array[
    (select (manifest ~ (select id::text from ad68second)) from ad68manifest)::text,
    (select (manifest ~ (select id::text from ad68first)) from ad68manifest)::text],
  array['true', 'false'],
  'AD-06 the manifest ledger.build_manifest (via seal_corrected_manifest) uses the latest adjudication of a '
  || 'trial, not one it has since superseded');
select is(array[
    (select after_reveal from ledger.validity_adjudications where id = (select id from ad68first))::text,
    (select after_reveal from ledger.validity_adjudications where id = (select id from ad68second))::text],
  array['false', 'true'],
  'AD-08 an adjudication before reveal has after_reveal = false; a second adjudication of the same trial '
  || 'after reveal has after_reveal = true');

-- ---------------------------------------------------------------------------- AD-07
select is(tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_public',
    format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', (select trial from ad1),
      'valid', 'ad-07 reason', 'ad07reviewer', 'ad07-key-0001'))),
  '42501',
  'AD-07 arena_public has no execute grant on ledger.adjudicate_validity (42501)');

-- ---------------------------------------------------------------------------- AD-09
create temp table ad09auto on commit drop as select
  ledger.adjudicate_validity((select trial from ad68b), 'valid', 'auto rule pass', null, 'auto_rule',
    'ad09-auto-rule-1') as id;
select is(array[
    tests.sqlstate(format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', (select trial from ad1),
      'valid', 'reason', '', 'ad09-empty-by01')),
    tests.sqlstate(format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', (select trial from ad1),
      'valid', 'reason', 'bad decided by!', 'ad09-bad-by-002')),
    tests.error(format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', (select trial from ad1),
      'valid', 'ad-01 reason', 'someoneelse', 'ad01-key-001')),
    (select decided_by from ledger.v_adjudications where id = (select id from ad1row)),
    (select decided_by from ledger.v_adjudications where id = (select id from ad09auto))],
  array['23514', '23514', 'AR003: idempotency key reused with a different adjudication', 'ad01reviewer', 'auto_rule'],
  'AD-09 decided_by empty or malformed (23514 each); the same key with another decided_by (AR003); auto_rule '
  || 'and a reviewer id both stored and shown in ledger.v_adjudications (C-33)');

-- ---------------------------------------------------------------------------- AD-10
select tests.as_role('arena_referee', format(
  'insert into sealed.independent_labels (trial_id, turn_no, labeler, label, compliant, rationale) '
  || 'values (%L, 1, %L, %L, true, %L) returning jsonb_build_object(%L, true)',
  (select trial from ad1), 'model', 'responsive', 'model label', 'ok'));
select tests.as_role('arena_referee', format(
  'insert into sealed.independent_labels (trial_id, turn_no, labeler, label, compliant, rationale) '
  || 'values (%L, 1, %L, %L, true, %L) returning jsonb_build_object(%L, true)',
  (select trial from ad1), 'human_consensus', 'responsive', 'consensus label', 'ok'));
select is(array[
    tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_referee', format(
      'insert into sealed.independent_labels (trial_id, turn_no, labeler, label, compliant, rationale) '
      || 'values (%L, 1, %L, %L, true, %L)', (select trial from ad1), 'human', 'responsive',
      'per-rater rows go to judgments'))),
    (select count(*)::text from sealed.independent_labels where trial_id = (select trial from ad1) and turn_no = 1)],
  array['23514', '2'],
  'AD-10 labeler = ''human'' is refused (23514, per-rater rows belong in sealed.judgments); a model row and a '
  || 'human_consensus row for the same turn are both accepted (C-34)');

-- ---------------------------------------------------------------------------- AD-11
select tests.as_role('arena_referee', format(
  'insert into sealed.judgments (trial_id, kind, rater_id, payload, idempotency_key) values (%L, %L, %L, %L, %L) '
  || 'returning jsonb_build_object(%L, true)',
  (select trial from ad1), 'calibration', 'rater1', '{"score": 1}'::jsonb, 'ad11-calib-ok-001', 'ok'));
select tests.as_role('arena_referee', format(
  'insert into sealed.judgments (trial_id, kind, payload, idempotency_key) values (%L, %L, %L, %L) '
  || 'returning jsonb_build_object(%L, true)',
  (select trial from ad1), 'fidelity_detail', '{"detail": "F1"}'::jsonb, 'ad11-fidel-ok-001', 'ok'));
select is(array[
    tests.sqlstate(format('insert into sealed.judgments (trial_id, kind, payload, idempotency_key) '
      || 'values (%L, %L, %L, %L)', (select trial from ad1), 'calibration', '{"score": 1}'::jsonb, 'ad11-calib-no-r')),
    tests.sqlstate(format('insert into sealed.judgments (trial_id, kind, rater_id, payload, idempotency_key) '
      || 'values (%L, %L, %L, %L, %L)', (select trial from ad1), 'fidelity_detail', 'rater1', '{"score": 1}'::jsonb,
      'ad11-fidel-has-r')),
    (select count(*)::text from sealed.judgments where trial_id = (select trial from ad1)
      and idempotency_key in ('ad11-calib-ok-001', 'ad11-fidel-ok-001'))],
  array['23514', '23514', '2'],
  'AD-11 calibration without a rater_id, and fidelity_detail with one, are each refused (23514); calibration '
  || 'with a rater and fidelity_detail without are both accepted');

-- ---------------------------------------------------------------------------- AD-12
select lives_ok(format(
  'insert into sealed.independent_labels (trial_id, turn_no, labeler, label, compliant, rationale) '
  || 'values (%L, 2, %L, %L, true, %L)', (select trial from ad1), 'model', 'responsive', ''),
  'AD-12 SG2-08: a model label responsive with an empty rationale (R1''s evidence quote) is accepted');

-- ---------------------------------------------------------------------------- AD-13
select tests.as_role('arena_referee', format(
  'insert into sealed.judgments (trial_id, kind, payload, idempotency_key) values (%L, %L, %L, %L) '
  || 'on conflict (idempotency_key) do nothing returning jsonb_build_object(%L, true)',
  (select trial from ad1), 'flag_support', '{"flag": 1}'::jsonb, 'ad13-dup-key-001', 'ok'));
select tests.as_role('arena_referee', format(
  'insert into sealed.judgments (trial_id, kind, payload, idempotency_key) values (%L, %L, %L, %L) '
  || 'on conflict (idempotency_key) do nothing returning jsonb_build_object(%L, true)',
  (select trial from ad1), 'flag_support', '{"flag": 2}'::jsonb, 'ad13-dup-key-001', 'ok'));
select is((select count(*)::text from sealed.judgments where idempotency_key = 'ad13-dup-key-001'), '1',
  'AD-13 D3, D8: a judgment inserted twice with the same idempotency_key, the second via '
  || 'on conflict (idempotency_key) do nothing, leaves one row');

select * from finish();
rollback;
