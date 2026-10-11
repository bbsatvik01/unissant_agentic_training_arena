-- 003_role_reads.sql (sql/TESTS.md section 3, ""role cannot read X""; SCN-5, SCN-9, SCN-12; WP-04a).
-- Default-deny checks: each row runs `select 1 from <object> limit 1` (or calls the function) as the role.
begin;
\ir harness/fixtures.psql
select plan(17);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

-- ---------------------------------------------------------------------------- RR-01..RR-15
-- arena_public: every sealed table (10), subject.private_packets, ledger.events, arena.trials, arena.turns,
-- arena.work_items, ops.budget_reservations (16 objects; one assertion loops over all of them).
select is_empty($$
  select t from unnest(array[
      'sealed.evaluator_packets', 'sealed.hidden_public_packets', 'sealed.evidence_artifacts',
      'sealed.family_ingests', 'sealed.hidden_split_seals', 'sealed.subject_tag_proposals',
      'sealed.quarantined_artifacts', 'sealed.independent_labels', 'sealed.judgments', 'sealed.commitment_nonces',
      'subject.private_packets', 'ledger.events', 'arena.trials', 'arena.turns', 'arena.work_items',
      'ops.budget_reservations']) t
   where tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_public', format('select 1 from %s limit 1', t)))
         <> '42501' $$,
  'RR-01..RR-15 arena_public is denied select on every sealed table, subject.private_packets, ledger.events, '
  || 'arena.trials, arena.turns, arena.work_items and ops.budget_reservations (42501 each)');

-- ---------------------------------------------------------------------------- RR-16, RR-17
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public',
         format('select subject.turn_context(%L, %L)', gen_random_uuid(), gen_random_uuid())),
  '42501', 'permission denied', 'RR-16 arena_public cannot call subject.turn_context');
select is_empty($$
  select f from unnest(array['ledger.verify_commitment(gen_random_uuid())',
                             'ledger.build_manifest(gen_random_uuid())',
                             'select 1 from training.acknowledgements limit 1']) f
   where tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_public',
           case when f like 'select %' then f else format('select %s', f) end)) <> '42501' $$,
  'RR-17 arena_public cannot call ledger.verify_commitment, ledger.build_manifest, or read training.acknowledgements');

-- ---------------------------------------------------------------------------- RR-18..RR-21
select is_empty($$
  select t from unnest(array['subject.private_packets', 'sealed.evaluator_packets', 'arena.v_transcripts',
                             'arena.trials']) t
   where tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject', format('select 1 from %s limit 1', t)))
         <> '42501' $$,
  'RR-18..21 arena_subject is denied select on subject.private_packets, sealed.evaluator_packets, '
  || 'arena.v_transcripts and arena.trials');

-- ---------------------------------------------------------------------------- RR-22
select is_empty($$
  select f from unnest(array[format('arena.trial_context(%L, %L)', gen_random_uuid(), gen_random_uuid()),
                             format('arena.finalize_trial(%L, %L, %L)', gen_random_uuid(), gen_random_uuid(), '{}'::jsonb),
                             format('arena.open_work_item(%L, %L, %L)', gen_random_uuid(), 'release', 'rr22-key-00001'),
                             format('arena.work_item_results(%L)', gen_random_uuid())]) f
   where tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject', 'select ' || f)) <> '42501' $$,
  'RR-22 arena_subject cannot call arena.trial_context, arena.finalize_trial, arena.open_work_item or '
  || 'arena.work_item_results');

-- ---------------------------------------------------------------------------- RR-23, RR-24
create temp table rr on commit drop as select tests.family('RRDEV', 'dev') as id;
create temp table rrtour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table rrt on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from rrtour), 3)))) ->> 'trial_id')::uuid as trial;
create temp table rrq on commit drop as
  select arena.submit_question((select trial from rrt), 0, 'Why did you enter room 4?',
                               tests.k((select trial from rrt), 1, 'question', 'harness_fixed'), 'harness_fixed') as q;
create temp table rrwi_release on commit drop as
  select (arena.open_work_item((select trial from rrt), 'release', tests.k((select trial from rrt), 1, 'release', 'turn'))
          ->> 'work_item_id')::uuid as wi;
select arena.release_evidence((select trial from rrt), (select wi from rrwi_release), '{}');
create temp table rrwi_coach on commit drop as
  select (arena.open_work_item((select trial from rrt), 'coaching', tests.k((select trial from rrt), 1, 'coaching', 'card'))
          ->> 'work_item_id')::uuid as wi;
create temp table rrwi_answer on commit drop as
  select (arena.open_work_item((select trial from rrt), 'subject_answer', tests.k((select trial from rrt), 1, 'subject_answer', 'ans'))
          ->> 'work_item_id')::uuid as wi;
select is(array[
    tests.error(format('select tests.as_role(%L, %L)', 'arena_subject',
                       format('select subject.turn_context(%L, %L)', (select trial from rrt), (select wi from rrwi_coach)))),
    tests.error(format('select tests.as_role(%L, %L)', 'arena_subject',
                       format('select subject.turn_context(%L, %L)', (select trial from rrt), (select wi from rrwi_release))))],
  array['AR003: context needs the open subject_answer work item at the current version',
        'AR003: context needs the open subject_answer work item at the current version'],
  'RR-23 subject.turn_context refuses a coaching item and a done (release) item, each AR003');
select ok(
  (tests.as_role('arena_subject', format('select subject.turn_context(%L, %L)', (select trial from rrt), (select wi from rrwi_answer)))
    ? 'private_packet'),
  'RR-24 subject.turn_context returns private_packet for the open subject_answer item at the current version');
-- ---------------------------------------------------------------------------- RR-25
select is_empty($$
  select r || ' ' || o from unnest(array['anon', 'authenticated']) r, unnest(array['arena.trials', 'ops.config']) o
   where tests.sqlstate(format('select tests.as_role(%L, %L)', r, format('select 1 from %s limit 1', o))) <> '42501' $$,
  'RR-25 anon and authenticated are denied on representative objects of the six schemas');

-- ---------------------------------------------------------------------------- RR-26
select is((select count(*) from arena.v_dev_cases v
             join arena.case_families f on f.family_code = v.family_code where f.split <> 'dev'),
          0::bigint, 'RR-26 arena.v_dev_cases contains no hidden variant');

-- ---------------------------------------------------------------------------- RR-27, RR-28
create temp table rrh on commit drop as select tests.tournament('hidden', array['interactive']) as tour;
create temp table rrht on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from rrh), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from rrht), 0, 'Why did you enter room 4?',
                             tests.k((select trial from rrht), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.release_evidence((select trial from rrht),
         (arena.open_work_item((select trial from rrht), 'release', tests.k((select trial from rrht), 1, 'release', 'turn'))
           ->> 'work_item_id')::uuid, '{}');
select arena.record_subject_turn((select trial from rrht),
         (arena.open_work_item((select trial from rrht), 'subject_answer',
            tests.k((select trial from rrht), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'A busy shift.', null, '{"passed": true}'::jsonb);
create temp table rrhwi on commit drop as
  select (arena.open_work_item((select trial from rrht), 'coaching', tests.k((select trial from rrht), 0, 'coaching', 'rr27'))
          ->> 'work_item_id')::uuid as wi;
create temp table rrhctx on commit drop as
  select tests.as_role('arena_public', format('select arena.trial_context(%L, %L)', (select trial from rrht),
                                              (select wi from rrhwi))) as ctx;
select is(array[((select ctx from rrhctx) -> 'public_packet') is not null,
                not ((select ctx from rrhctx) ?| array['role', 'facts', 'concealed'])],
          array[true, true],
  'RR-27 arena.trial_context on a running hidden trial with an open coaching item returns the hidden public '
  || 'packet and no key of the private or evaluator packet');
select arena.record_coaching_event((select trial from rrht), (select wi from rrhwi),
         jsonb_build_object('card', 'fixture', 'turn_no', 1));
select arena.finalize_trial((select trial from rrht),
         (arena.open_work_item((select trial from rrht), 'finalize', tests.k((select trial from rrht), 0, 'finalize', 'rr28'))
           ->> 'work_item_id')::uuid,
         jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
                            'rationale', 'no evidence yet', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', '[]'::jsonb,
                            'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public',
         format('select arena.trial_context(%L, %L)', (select trial from rrht), (select wi from rrhwi))),
  'AR003', 'open coaching, finalize or release work item on a running trial',
  'RR-28 arena.trial_context on the same trial after finalization is refused (the item is done and the trial is not running)');

-- ---------------------------------------------------------------------------- RR-29
select is_empty($$
  select v from unnest(array['arena.v_findings', 'arena.v_released_evidence', 'arena.v_transcripts',
                             'arena.v_trial_events', 'arena.v_trials', 'ledger.v_adjudications', 'ledger.v_commitments',
                             'ledger.v_events', 'ops.v_call_costs', 'ops.v_latency', 'training.v_my_acknowledgements',
                             'training.v_my_debrief', 'training.v_my_scores', 'training.v_my_sessions',
                             'training.v_my_study', 'training.v_my_voice_exchanges']) v
   where tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_referee', format('select 1 from %s limit 1', v)))
         <> '42501' $$,
  'RR-29a arena_referee is denied select on the 16 actor-scoped views (S4 section 10 deny rows, SG3-45)');
select is(array[
    tests.error(format('select tests.as_role(%L, %L)', 'arena_referee',
      format('update training.voice_sessions set status = %L', 'closed'))),
    tests.error(format('select tests.as_role(%L, %L)', 'arena_referee',
      format('update training.voice_exchanges set lines = %L', '[]'::text)))],
  array['42501: permission denied for table voice_sessions', '42501: permission denied for table voice_exchanges'],
  'RR-29b arena_referee is denied update on training.voice_sessions and training.voice_exchanges');

-- ---------------------------------------------------------------------------- RR-30
create temp table rr30c on commit drop as select tests.candidate('assistant', 'RR30A') as cand;
insert into arena.isolation_checks (candidate_id, check_name, passed, evidence)
  values ((select cand from rr30c), 'rr30_probe', true, jsonb_build_object('commit_sha', repeat('a', 40)));
select is(array[
    (select count(*) from arena.v_isolation_checks where candidate_id = (select cand from rr30c))::text,
    (select count(*) from information_schema.columns
      where table_schema = 'arena' and table_name = 'v_isolation_checks' and column_name = 'evidence')::text],
          array['1', '0'],
  'RR-30 arena_public reads arena.v_isolation_checks (check, candidate, pass/fail, run time, commit SHA) and no '
  || 'evidence column');
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', 'select 1 from arena.isolation_checks limit 1'),
  '42501', 'permission denied', 'RR-30 arena_public cannot read arena.isolation_checks directly');
select is((select count(*) from information_schema.columns
            where table_schema = 'arena' and table_name = 'v_dev_cases' and column_name = 'style'),
          0::bigint, 'RR-30 arena.v_dev_cases has no style column (C-22, C-26)');

-- ---------------------------------------------------------------------------- RR-31
select is_empty($$
  select f from unnest(array[format('subject.voice_context(%L)', gen_random_uuid()),
                             format('ops.settle_voice_reservation(%L, %L)', gen_random_uuid(), 'released'),
                             format('training.publish_debrief(%L, %L)', gen_random_uuid(), '{}'::jsonb),
                             'select 1 from training.participants limit 1', 'select 1 from ops.config limit 1']) f
   where tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_public',
           case when f like 'select %' then f else format('select %s', f) end)) <> '42501' $$,
  'RR-31 arena_public cannot call subject.voice_context, ops.settle_voice_reservation, training.publish_debrief, '
  || 'or read training.participants or ops.config');

select * from finish();
rollback;
