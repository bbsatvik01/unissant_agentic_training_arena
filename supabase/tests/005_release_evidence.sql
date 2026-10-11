-- 005_release_evidence.sql (sql/TESTS.md section 5; SCN-4, SCN-10; WP-04a). AC-S1-08 (release_evidence request
-- predicates, same-call scheduled-plus-denied shape) is exercised here as the RE-xx rows the spec cites.
begin;
\ir harness/fixtures.psql
select plan(18);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

-- tests.tournament always ingests its own fixed family code (TDEV/THID); a test that needs its own custom
-- thresholds or extra artifacts ingests its own family first, then builds a one-slot tournament on that
-- variant directly (the same steps tests.tournament takes, minus the hardcoded family).
create or replace function pg_temp.re_trial(p_variant uuid) returns uuid
language plpgsql as $$
declare
  v_tour  uuid;
  v_trial uuid;
begin
  v_tour := arena.create_tournament('re-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), 'dev', 1, 'global');
  perform arena.add_planned_trials(v_tour, jsonb_build_array(jsonb_build_object(
    'position', 1, 'track', 'interactive', 'block_no', 1, 'variant_id', p_variant,
    'assistant_candidate_id', tests.candidate('assistant', 'A1'), 'subject_candidate_id', tests.candidate('subject', 'S1'))));
  perform arena.freeze_tournament(v_tour);
  perform arena.open_tournament(v_tour);
  select t.id into v_trial from arena.trials t join arena.planned_trials p on p.id = t.planned_trial_id
   where p.tournament_id = v_tour and p.position = 1;
  return (tests.as_role('arena_public', format('select arena.start_trial(%L)', v_trial)) ->> 'trial_id')::uuid;
end $$;

-- A variant with an added on-request clarification (rec-03) beside the default rec-01 (on-request after 1) and
-- rec-02 (scheduled after 2).
create temp table refile on commit drop as
  select jsonb_set(
           jsonb_set(f, '{variants,truthful,evaluator_packet,evidence_artifacts}',
             (f #> '{variants,truthful,evaluator_packet,evidence_artifacts}') || jsonb_build_array(
               jsonb_build_object('artifact_id', 'rec-03', 'kind', 'clarification', 'title', 'A clarification',
                                  'content', jsonb_build_object('text', 'Shift ended at 22:00'),
                                  'release', jsonb_build_object('type', 'on_request', 'after_exchanges', 1)))),
           '{variants,truthful,public_packet,requestable_records}',
           (f #> '{variants,truthful,public_packet,requestable_records}') || jsonb_build_array(
             jsonb_build_object('record_id', 'rec-03', 'kind', 'clarification', 'title', 'A clarification',
                                'requestable_after_exchanges', 1))) as f
    from (select tests.family_file('REDEV', 'dev') as f) x;
create temp table rebundle on commit drop as select tests.bundle_of((select f from refile)) as b;
create temp table re on commit drop as select sealed.ingest_case_family((select b from rebundle)) as id;
create temp table ret on commit drop as select pg_temp.re_trial(tests.variant('REDEV', 'truthful')) as trial;

-- ---------------------------------------------------------------------------- RE-01
select arena.submit_question((select trial from ret), 0, 'Why did you enter room 4?',
                             tests.k((select trial from ret), 1, 'question', 'harness_fixed'), 'harness_fixed');
create temp table re01wi on commit drop as
  select (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 1, 'release', 'empty'))
          ->> 'work_item_id')::uuid as wi;
create temp table re01 on commit drop as
  select arena.release_evidence((select trial from ret), (select wi from re01wi), '{}') as r;
select is(array[(select r -> 'released' from re01)::text,
                (select (transcript_version = 1) from arena.trials where id = (select trial from ret))::text],
          array['[]', 'true'],
  'RE-01 an empty request at 0 exchanges with nothing scheduled releases nothing, version unchanged');

-- ---------------------------------------------------------------------------- RE-02
create temp table re02wi on commit drop as
  select (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 1, 'release', 'early'))
          ->> 'work_item_id')::uuid as wi;
create temp table re02 on commit drop as
  select arena.release_evidence((select trial from ret), (select wi from re02wi), array['rec-01']) as r;
select is(array[(select r -> 'denied' from re02)::text, (select r -> 'released' from re02)::text],
          array['["rec-01"]', '[]'], 'RE-02 a request on a record due after 1 exchange, at 0 exchanges, is denied');

-- ---------------------------------------------------------------------------- RE-03
select arena.record_subject_turn((select trial from ret),
         (arena.open_work_item((select trial from ret), 'subject_answer',
            tests.k((select trial from ret), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'A busy shift.', null, '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from ret),
         (arena.open_work_item((select trial from ret), 'coaching', tests.k((select trial from ret), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
select arena.submit_question((select trial from ret), 2, 'Which task needed entry?',
                             tests.k((select trial from ret), 2, 'question', 'harness_fixed'), 'harness_fixed');
create temp table re03wi on commit drop as
  select (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 2, 'release', 'turn'))
          ->> 'work_item_id')::uuid as wi;
create temp table re03v0 on commit drop as select transcript_version as v from arena.trials where id = (select trial from ret);
create temp table re03 on commit drop as
  select arena.release_evidence((select trial from ret), (select wi from re03wi), array['rec-01']) as r;
select is(array[(select r -> 'released' from re03)::text,
                ((select transcript_version from arena.trials where id = (select trial from ret)) - (select v from re03v0))::text,
                (select count(*)::text from arena.trial_events where trial_id = (select trial from ret) and kind = 'evidence_released'
                   and payload ->> 'record_id' = 'rec-01'),
                (select count(*)::text from ledger.events e where e.trial_id = (select trial from ret)
                   and e.event_type = 'evidence_released' and e.payload -> 'records' @> jsonb_build_array(
                     jsonb_build_object('record_id', 'rec-01', 'sha256', (select a.sha256 from sealed.evidence_artifacts a
                       where a.variant_id = (select variant_id from arena.trials where id = (select trial from ret))
                         and a.record_id = 'rec-01'))))],
          array['[{"kind": "record", "doc_kind": "work_order", "record_id": "rec-01"}]', '1', '1', '1'],
  'RE-03 the same request after 1 exchange releases once, version +1, with one evidence_released event and one '
  || 'ledger event carrying its sha256');

-- ---------------------------------------------------------------------------- RE-04
select arena.record_subject_turn((select trial from ret),
         (arena.open_work_item((select trial from ret), 'subject_answer',
            tests.k((select trial from ret), 2, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'The HVAC ticket.', null, '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from ret),
         (arena.open_work_item((select trial from ret), 'coaching', tests.k((select trial from ret), 2, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 2));
create temp table re04 on commit drop as
  select arena.release_evidence((select trial from ret),
           (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 3, 'release', 'scheduled'))
             ->> 'work_item_id')::uuid, '{}') as r;
select is((select r -> 'released' from re04)::text, '[{"kind": "record", "doc_kind": "badge_log", "record_id": "rec-02"}]',
  'RE-04 the scheduled record (after 2 exchanges) is released by an empty-list call after 2 exchanges');

-- ---------------------------------------------------------------------------- RE-05
create temp table re05 on commit drop as
  select arena.release_evidence((select trial from ret),
           (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 3, 'release', 'rerequest'))
             ->> 'work_item_id')::uuid, array['rec-01']) as r;
select is(array[(select r -> 'already_released' from re05)::text, (select r -> 'released' from re05)::text,
                (select count(*)::text from arena.released_evidence where trial_id = (select trial from ret) and record_id = 'rec-01')],
          array['["rec-01"]', '[]', '1'], 'RE-05 re-requesting a released record returns it in already_released; no new row');

-- ---------------------------------------------------------------------------- RE-06
select is(array[
    tests.error(format('select arena.release_evidence(%L, %L, %L)', (select trial from ret),
      (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 3, 'release', 'unknown'))
        ->> 'work_item_id'), array['rec-99'])),
    tests.error(format('select arena.release_evidence(%L, %L, %L)', (select trial from ret),
      (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 3, 'release', 'nonreq'))
        ->> 'work_item_id'), array['rec-02']))],
  array['AR005: requested id is not on the case''s requestable list',
        'AR005: requested id is not on the case''s requestable list'],
  'RE-06 an unknown id and a non-requestable id are each refused (AR005)');

-- ---------------------------------------------------------------------------- RE-07
create temp table re07 on commit drop as
  select arena.release_evidence((select trial from ret),
           (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 3, 'release', 'clar'))
             ->> 'work_item_id')::uuid, array['rec-03']) as r;
select is(array[(select r -> 'released' from re07)::text,
                (select count(*)::text from arena.trial_events where trial_id = (select trial from ret) and kind = 'clarification'
                   and payload ->> 'record_id' = 'rec-03'),
                (select count(*)::text from arena.trial_events where trial_id = (select trial from ret) and kind = 'evidence_released'
                   and payload ->> 'record_id' = 'rec-01')],
          array['[{"kind": "clarification", "doc_kind": "clarification", "record_id": "rec-03"}]', '1', '1'],
  'RE-07 a clarification artifact emits a clarification event; rec-01 (a record) emitted evidence_released');

-- ---------------------------------------------------------------------------- RE-08, RE-09
create temp table reother on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table retb on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from reother), 4)))) ->> 'trial_id')::uuid as trial;
create temp table re08wi on commit drop as
  select (arena.open_work_item((select trial from retb), 'release', tests.k((select trial from retb), 0, 'release', 'xtrial'))
          ->> 'work_item_id')::uuid as wi;
select tests.throws(
  format('select arena.release_evidence(%L, %L, %L)', (select trial from ret), (select wi from re08wi), '{}'::text[]),
  'AR003', 'another trial', 'RE-08 a work item of another trial is refused (AR003)');
create temp table re09wi on commit drop as
  select (arena.open_work_item((select trial from ret), 'coaching', tests.k((select trial from ret), 3, 'coaching', 'notrelease'))
          ->> 'work_item_id')::uuid as wi;
select tests.throws(
  format('select arena.release_evidence(%L, %L, %L)', (select trial from ret), (select wi from re09wi), '{}'::text[]),
  'AR003', 'cannot be used for', 'RE-09 a work item of kind coaching is refused (AR003)');

-- ---------------------------------------------------------------------------- RE-10, RE-11
create temp table re07wi on commit drop as
  select (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 3, 'release', 'clar'))
          ->> 'work_item_id')::uuid as wi;
select is(
  arena.release_evidence((select trial from ret), (select wi from re07wi), array['rec-03']),
  (select r from re07), 'RE-10 the same work item, same list, returns the original result');
select tests.throws(
  format('select arena.release_evidence(%L, %L, %L)', (select trial from ret),
         (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 3, 'release', 'clar'))
           ->> 'work_item_id'), '{}'::text[]),
  'AR003', 'reused with different input', 'RE-11 the same work item, a different list, is refused (AR003)');

-- ---------------------------------------------------------------------------- RE-12
create temp table re12wi on commit drop as
  select (arena.open_work_item((select trial from ret), 'release', tests.k((select trial from ret), 3, 'release', 'laterver'))
          ->> 'work_item_id')::uuid as wi;
select arena.submit_question((select trial from ret), (select transcript_version from arena.trials where id = (select trial from ret)),
                             'Another question', tests.k((select trial from ret), 3, 'question', 'harness_fixed'), 'harness_fixed');
select tests.throws(
  format('select arena.release_evidence(%L, %L, %L)', (select trial from ret), (select wi from re12wi), '{}'::text[]),
  'AR002', 'stale transcript version', 'RE-12 a work item opened before a later version change is refused (AR002)');

-- ---------------------------------------------------------------------------- RE-13
create temp table recorpus on commit drop as select tests.tournament('dev', array['replay_corpus', 'replay']) as tour;
create temp table rerep on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from recorpus), 1)))) ->> 'trial_id')::uuid as corpus_trial;
select arena.submit_question((select corpus_trial from rerep), 0, 'Question 1',
         tests.k((select corpus_trial from rerep), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select corpus_trial from rerep),
         (arena.open_work_item((select corpus_trial from rerep), 'subject_answer',
            tests.k((select corpus_trial from rerep), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
select arena.finalize_trial((select corpus_trial from rerep),
         (arena.open_work_item((select corpus_trial from rerep), 'finalize', tests.k((select corpus_trial from rerep), 1, 'finalize', 'done'))
           ->> 'work_item_id')::uuid, null);
insert into sealed.judgments (trial_id, kind, payload, idempotency_key)
  values ((select corpus_trial from rerep), 'fidelity_detail', jsonb_build_object('summary', 'no evasions found'), 're13-r1-0001');
select ledger.adjudicate_validity((select corpus_trial from rerep), 'valid', 'no deception found', null, 'auto_rule', 're13-adj-0001');
select ledger.seal_replay_corpus((select tour from recorpus));
create temp table rerepb on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from recorpus), 2)))) ->> 'trial_id')::uuid as replay_trial;
select is(array[
    -- open_work_item itself refuses a 'release' kind on a replay trial (release_evidence's own identical check,
    -- just below, is unreachable through the API for the same reason: no replay trial ever holds a release item).
    tests.error(format('select arena.open_work_item(%L, %L, %L)', (select replay_trial from rerepb), 'release',
      tests.k((select replay_trial from rerepb), 0, 'release', 're13'))),
    tests.error(format('select arena.release_evidence(%L, %L, %L)', (select trial from ret), gen_random_uuid(), '{}'::text[]))],
  array['AR001: release does not apply to a replay trial', 'AR003: unknown work item'],
  'RE-13 release is refused on a replay trial (AR001, caught at open_work_item, the only path that ever reaches '
  || 'release_evidence) and finds no work item on a finalized trial (AR003)');

-- ---------------------------------------------------------------------------- RE-14
-- A dedicated variant with all 6 allowed artifacts (rec-01..06), all releasable at 0 exchanges, so one call
-- releases all 6 (v_n_old 0, v_n_new 6: at the cap, not over it); record_id's own check (rec-0[1-6]) makes a
-- 7th distinct artifact impossible to ingest, so the owner adds it directly, after lifting that one check,
-- to reach the case _apply_releases itself guards (v_n_old + v_n_new > 6).
create temp table re14file on commit drop as
  select jsonb_set(jsonb_set(f, '{variants,truthful,evaluator_packet,evidence_artifacts}',
           (select jsonb_agg(jsonb_build_object('artifact_id', 'rec-0' || g, 'kind', 'work_order', 'title', 'Record ' || g,
                                                 'content', jsonb_build_object('text', 'x' || g),
                                                 'release', jsonb_build_object('type', 'on_request', 'after_exchanges', 0)))
              from generate_series(1, 6) g)),
           '{variants,truthful,public_packet,requestable_records}',
           (select jsonb_agg(jsonb_build_object('record_id', 'rec-0' || g, 'kind', 'work_order', 'title', 'Record ' || g,
                                                'requestable_after_exchanges', 0))
              from generate_series(1, 6) g)) as f
    from (select tests.family_file('RE14DEV', 'dev') as f) x;
create temp table re14bundle on commit drop as select tests.bundle_of((select f from re14file)) as b;
create temp table re14 on commit drop as select sealed.ingest_case_family((select b from re14bundle)) as id;
create temp table re14t on commit drop as select pg_temp.re_trial(tests.variant('RE14DEV', 'truthful')) as trial;
select arena.submit_question((select trial from re14t), 0, 'Question 1',
         tests.k((select trial from re14t), 1, 'question', 'harness_fixed'), 'harness_fixed');
create temp table re14r on commit drop as
  select arena.release_evidence((select trial from re14t),
           (arena.open_work_item((select trial from re14t), 'release', tests.k((select trial from re14t), 1, 'release', 'six'))
             ->> 'work_item_id')::uuid, array['rec-01', 'rec-02', 'rec-03', 'rec-04', 'rec-05', 'rec-06']) as r;
select is((select jsonb_array_length(r -> 'released') from re14r), 6, 'RE-14 setup: all 6 allowed artifacts release in one call');
do $$
declare v_variant uuid := (select tests.variant('RE14DEV', 'truthful'));
begin
  alter table sealed.evidence_artifacts drop constraint evidence_artifacts_record_id_check;
  insert into sealed.evidence_artifacts (variant_id, record_id, kind, doc_kind, title, content, requestable,
                                         scheduled_turn, request_after_turn)
    values (v_variant, 'rec-07', 'record', 'work_order', 'Seventh', jsonb_build_object('text', 'x7'), true, null, 0);
  alter table sealed.evidence_artifacts add constraint evidence_artifacts_record_id_check
    check (record_id ~ '^rec-0[1-7]$');   -- widened only so the owner's own probe row satisfies it; never used by any real ingest
end $$;
select tests.throws(
  format('select arena.release_evidence(%L, %L, %L)', (select trial from re14t),
         (arena.open_work_item((select trial from re14t), 'release', tests.k((select trial from re14t), 1, 'release', 'seven'))
           ->> 'work_item_id'), array['rec-07']),
  'AR006', 'release limit', 'RE-14 a seventh release on a case (the owner inserted the seventh artifact directly) is refused (AR006)');

-- ---------------------------------------------------------------------------- RE-15
create temp table reh on commit drop as select tests.tournament('hidden', array['interactive']) as tour;
create temp table reht on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from reh), 3)))) ->> 'trial_id')::uuid as trial;
select is((select count(*) from arena.v_released_evidence where trial_id = (select trial from reht)), 0::bigint,
  'RE-15 arena.v_released_evidence for a hidden running trial, read as arena_public, is empty');

-- ---------------------------------------------------------------------------- RE-16
select tests.exchange((select trial from reht), 'Question 1', '{}', 'Answer 1');   -- rec-01 is requestable only after this
select arena.submit_question((select trial from reht),
         (select transcript_version from arena.trials where id = (select trial from reht)), 'Question 2',
         tests.k((select trial from reht), 2, 'question', 'harness_fixed'), 'harness_fixed');
select arena.release_evidence((select trial from reht),
         (arena.open_work_item((select trial from reht), 'release', tests.k((select trial from reht), 2, 'release', 'turn'))
           ->> 'work_item_id')::uuid, array['rec-01']);
create temp table re16ctx on commit drop as
  select tests.as_role('arena_subject', format('select subject.turn_context(%L, %L)', (select trial from reht),
           (arena.open_work_item((select trial from reht), 'subject_answer',
              tests.k((select trial from reht), 2, 'subject_answer', 'subject.answer')) ->> 'work_item_id'))) as ctx;
select is((select (ctx -> 'released_evidence') @> jsonb_build_array(jsonb_build_object('record_id', 'rec-01')) from re16ctx),
          true, 'RE-16 the subject''s turn_context for the open question includes evidence released for that question');

-- ---------------------------------------------------------------------------- RE-17
-- SG1-15: a dedicated variant with rec-01 scheduled after 1 exchange and rec-02 on-request after 5 (premature at
-- 1 exchange), requested together in one call.
create temp table re17file on commit drop as
  select jsonb_set(jsonb_set(f, '{variants,truthful,evaluator_packet,evidence_artifacts}',
           jsonb_build_array(jsonb_build_object('artifact_id', 'rec-01', 'kind', 'work_order', 'title', 'Scheduled',
                                                'content', jsonb_build_object('text', 's'),
                                                'release', jsonb_build_object('type', 'scheduled', 'after_exchanges', 1)),
                             jsonb_build_object('artifact_id', 'rec-02', 'kind', 'badge_log', 'title', 'Badge log',
                                                'content', jsonb_build_object('text', 'b'),
                                                'release', jsonb_build_object('type', 'on_request', 'after_exchanges', 5)))),
           '{variants,truthful,public_packet,requestable_records}',
           jsonb_build_array(jsonb_build_object('record_id', 'rec-02', 'kind', 'badge_log', 'title', 'Badge log',
                                                'requestable_after_exchanges', 5))) as f
    from (select tests.family_file('RE17DEV', 'dev') as f) x;
create temp table re17bundle on commit drop as select tests.bundle_of((select f from re17file)) as b;
create temp table re17 on commit drop as select sealed.ingest_case_family((select b from re17bundle)) as id;
create temp table re17t on commit drop as select pg_temp.re_trial(tests.variant('RE17DEV', 'truthful')) as trial;
select tests.exchange((select trial from re17t), 'Question 1', '{}', 'Answer 1');
create temp table re17r on commit drop as
  select arena.release_evidence((select trial from re17t),
           (arena.open_work_item((select trial from re17t), 'release', tests.k((select trial from re17t), 2, 'release', 'sg115'))
             ->> 'work_item_id')::uuid, array['rec-02']) as r;
select is(array[(select r -> 'released' from re17r)::text, (select r -> 'denied' from re17r)::text,
                ((select r -> 'released' -> 0 from re17r) - 'title' - 'content'
                 = (select r -> 'released' -> 0 from re17r))::text],
          array['[{"kind": "record", "doc_kind": "work_order", "record_id": "rec-01"}]', '["rec-02"]', 'true'],
  'RE-17 SG1-15: one call with an empty-list scheduled release due and a known record requested too early returns '
  || 'the scheduled record in released and the early one in denied; released entries carry only record_id, kind '
  || 'and doc_kind (no title or content)');

select * from finish();
rollback;
