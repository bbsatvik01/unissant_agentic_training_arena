-- 006_record_subject_turn.sql (sql/TESTS.md section 6; SUB-7, SUB-8, SCN-6; WP-04a).
begin;
\ir harness/fixtures.psql
select plan(18);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

create temp table st on commit drop as select tests.family('STDEV', 'dev') as id;
create temp table sttour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table stt on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from sttour), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from stt), 0, 'Why did you enter room 4?',
                             tests.k((select trial from stt), 1, 'question', 'harness_fixed'), 'harness_fixed');
create temp table stwi1 on commit drop as
  select (arena.open_work_item((select trial from stt), 'subject_answer',
            tests.k((select trial from stt), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid as wi;

-- ---------------------------------------------------------------------------- ST-01
create temp table st01 on commit drop as
  select arena.record_subject_turn((select trial from stt), (select wi from stwi1), 'A busy shift.',
           jsonb_build_object('disclosed', jsonb_build_array('F1'), 'gates_opened', '[]'::jsonb),
           '{"passed": true}'::jsonb) as r;
select is(array[(select r ->> 'outcome' from st01),
                (select answer from arena.turns where trial_id = (select trial from stt) and turn_no = 1),
                (select exchanges::text from arena.trials where id = (select trial from stt)),
                (select count(*)::text from sealed.subject_tag_proposals where trial_id = (select trial from stt) and turn_no = 1),
                (select count(*)::text from arena.trial_events where trial_id = (select trial from stt) and kind = 'subject_turn')],
          array['recorded', 'A busy shift.', '1', '1', '1'],
  'ST-01 a valid answer to the open question is recorded, stored, bumps exchanges, stores the tag proposal and '
  || 'emits subject_turn');

-- ---------------------------------------------------------------------------- ST-02, ST-03
select arena.record_coaching_event((select trial from stt),
         (arena.open_work_item((select trial from stt), 'coaching', tests.k((select trial from stt), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
select arena.submit_question((select trial from stt), (select transcript_version from arena.trials where id = (select trial from stt)),
         'Which task needed entry?', tests.k((select trial from stt), 2, 'question', 'harness_fixed'), 'harness_fixed');
create temp table strelwi on commit drop as
  select (arena.open_work_item((select trial from stt), 'release', tests.k((select trial from stt), 2, 'release', 'turn'))
          ->> 'work_item_id')::uuid as wi;
select arena.release_evidence((select trial from stt), (select wi from strelwi), '{}');
create temp table stcoachwi on commit drop as
  select (arena.open_work_item((select trial from stt), 'coaching', tests.k((select trial from stt), 2, 'coaching', 'forge'))
          ->> 'work_item_id')::uuid as wi;
select is(array[
    tests.error(format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stt),
      (select wi from stcoachwi), 'Forged', '{"passed": true}'::jsonb)),
    tests.error(format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stt),
      (select wi from strelwi), 'Forged', '{"passed": true}'::jsonb)),
    tests.error(format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stt),
      gen_random_uuid(), 'Forged', '{"passed": true}'::jsonb))],
  array['AR003: work item kind coaching cannot be used for subject_answer',
        'AR003: work item kind release cannot be used for subject_answer', 'AR003: unknown work item'],
  'ST-02, ST-03 a coaching item, a release item, and a random uuid are each refused as a forged subject turn (AR003)');

-- ---------------------------------------------------------------------------- ST-04, ST-05
-- The stored request hash covers utterance, tag proposal and guard_result together. ST-01's call used a
-- non-null tag proposal; passing null here would change the hash on that alone, masking whether utterance
-- is actually part of it. Keep the tag proposal identical to ST-01's so only the utterance differs.
select tests.throws(
  format('select arena.record_subject_turn(%L, %L, %L, %L, %L)', (select trial from stt), (select wi from stwi1),
         'A different answer.',
         jsonb_build_object('disclosed', jsonb_build_array('F1'), 'gates_opened', '[]'::jsonb),
         '{"passed": true}'::jsonb),
  'AR003', 'reused with different input', 'ST-04 the done item of turn 1 presented with a different utterance is refused (AR003)');
select is(
  arena.record_subject_turn((select trial from stt), (select wi from stwi1), 'A busy shift.',
    jsonb_build_object('disclosed', jsonb_build_array('F1'), 'gates_opened', '[]'::jsonb), '{"passed": true}'::jsonb),
  (select r from st01), 'ST-05 a replay of the done item with identical input returns the original result');

-- ---------------------------------------------------------------------------- ST-06
create temp table stb on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from sttour), 4)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from stb), 0, 'Question A',
         tests.k((select trial from stb), 1, 'question', 'harness_fixed'), 'harness_fixed');
create temp table stbwi on commit drop as
  select (arena.open_work_item((select trial from stb), 'subject_answer',
            tests.k((select trial from stb), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid as wi;
select tests.throws(
  format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stt), (select wi from stbwi),
         'Cross-trial', '{"passed": true}'::jsonb),
  'AR003', 'belongs to another trial', 'ST-06 trial B''s open item presented on trial A is refused (AR003)');

-- ---------------------------------------------------------------------------- ST-07, ST-08
select arena.record_subject_turn((select trial from stb), (select wi from stbwi), 'Answer A', null, '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from stb),
         (arena.open_work_item((select trial from stb), 'coaching', tests.k((select trial from stb), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
select arena.submit_question((select trial from stb), (select transcript_version from arena.trials where id = (select trial from stb)),
         'Question B', tests.k((select trial from stb), 2, 'question', 'harness_fixed'), 'harness_fixed');
create temp table stb2wi on commit drop as
  select (arena.open_work_item((select trial from stb), 'subject_answer',
            tests.k((select trial from stb), 2, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid as wi;
do $$
begin
  update arena.trials set transcript_version = transcript_version + 1 where id = (select trial from stb);
end $$;
select tests.throws(
  format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stb), (select wi from stb2wi),
         'Stale answer', '{"passed": true}'::jsonb),
  'AR002', 'stale transcript version', 'ST-07 an item opened before a later version change is refused (AR002)');
do $$
begin
  update arena.trials set transcript_version = transcript_version - 1 where id = (select trial from stb);
end $$;
create temp table stb2wi_old on commit drop as
  select (arena.open_work_item((select trial from stb), 'subject_answer',
            tests.k((select trial from stb), 2, 'subject_answer', 'subject.answer2')) ->> 'work_item_id')::uuid as wi;
select arena.record_subject_turn((select trial from stb), (select wi from stb2wi_old), 'Answer B', null, '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from stb),
         (arena.open_work_item((select trial from stb), 'coaching', tests.k((select trial from stb), 2, 'coaching', 'card2'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 2));
select arena.submit_question((select trial from stb), (select transcript_version from arena.trials where id = (select trial from stb)),
         'Question C', tests.k((select trial from stb), 3, 'question', 'harness_fixed'), 'harness_fixed');

-- ST-08: record_subject_turn's "no open question for this work item" guard ORs two things: this item's bound
-- turn is not (still) the open/unanswered one, or a later turn already exists. Through the API, the second
-- can never be true while the first is false (submit_question refuses a new question while the previous is
-- unanswered, as stb's own flow above shows): any item bound to an older turn on stb is always already
-- answered by the time a later turn exists, so testing it there would raise AR004 from "not open at this
-- turn" alone, leaving "a later turn exists" unexercised. A fresh trial with a manufactured (direct insert,
-- bypassing submit_question) later turn, while the bound turn's own answer column is left untouched, isolates
-- that second clause on its own.
create temp table stctour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table stc on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from stctour), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from stc), 0, 'Question 1',
         tests.k((select trial from stc), 1, 'question', 'harness_fixed'), 'harness_fixed');
create temp table stcwi on commit drop as
  select (arena.open_work_item((select trial from stc), 'subject_answer',
            tests.k((select trial from stc), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid as wi;
insert into arena.turns (trial_id, turn_no, question, question_source, channel, question_version, idempotency_key)
  select (select trial from stc), 2, 'Question 2', 'harness_fixed', 'text',
         (select transcript_version from arena.trials where id = (select trial from stc)), 'st08-manufactured-turn2';
select tests.throws(
  format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stc), (select wi from stcwi),
         'Late', '{"passed": true}'::jsonb),
  'AR004', 'no open question',
  'ST-08 an item bound to an older, still-unanswered turn is refused once a later turn exists (AR004)');

-- ---------------------------------------------------------------------------- ST-09 (turn 3's question already
-- exists from ST-08's set-up above)
select is(array[
    tests.error(format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stb),
      (arena.open_work_item((select trial from stb), 'subject_answer', tests.k((select trial from stb), 3, 'subject_answer', 'p1'))
        ->> 'work_item_id'), 'An answer', '{}'::jsonb)),
    tests.error(format('select arena.record_subject_turn(%L, %L, %L, %L, %L)', (select trial from stb),
      (arena.open_work_item((select trial from stb), 'subject_answer', tests.k((select trial from stb), 3, 'subject_answer', 'p2'))
        ->> 'work_item_id'), 'An answer', '"not an object"', '{"passed": true}'::jsonb)),
    tests.error(format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stb),
      (arena.open_work_item((select trial from stb), 'subject_answer', tests.k((select trial from stb), 3, 'subject_answer', 'p3'))
        ->> 'work_item_id'), '', '{"passed": true}'::jsonb)),
    tests.error(format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stb),
      (arena.open_work_item((select trial from stb), 'subject_answer', tests.k((select trial from stb), 3, 'subject_answer', 'p4'))
        ->> 'work_item_id'), '', jsonb_build_object('passed', false, 'rule', 'G3_nonneutral')))],
  array['AR007: utterance, tag proposal object and guard_result.passed are required',
        'AR007: utterance, tag proposal object and guard_result.passed are required',
        'AR007: utterance, tag proposal object and guard_result.passed are required',
        'AR007: utterance, tag proposal object and guard_result.passed are required'],
  'ST-09 a missing guard_result.passed, a non-object tag, an empty utterance on an accepted answer, and an empty '
  || 'utterance with a non-G0 rule are each refused (AR007)');

-- ---------------------------------------------------------------------------- ST-10, ST-11
create temp table st10wi on commit drop as
  select (arena.open_work_item((select trial from stb), 'subject_answer', tests.k((select trial from stb), 3, 'subject_answer', 'reject'))
          ->> 'work_item_id')::uuid as wi;
create temp table st10 on commit drop as
  select arena.record_subject_turn((select trial from stb), (select wi from st10wi), 'An unsafe utterance',
           jsonb_build_object('disclosed', '[]'::jsonb), jsonb_build_object('passed', false, 'rule', 'G3_nonneutral')) as r;
select is(array[(select r ->> 'outcome' from st10),
                (select count(*)::text from sealed.quarantined_artifacts where trial_id = (select trial from stb)
                   and utterance = 'An unsafe utterance'),
                (select answer is null from arena.turns where trial_id = (select trial from stb) and turn_no = 3)::text,
                (select status from arena.trials where id = (select trial from stb)),
                (select state from ledger.terminal_records where trial_id = (select trial from stb)),
                (select payload from arena.trial_events where trial_id = (select trial from stb) and kind = 'trial_ended')::text],
          array['quarantined', '1', 'true', 'terminated', 'subject_quarantined', '{"reason": "subject_invalid"}'],
  'ST-10 a guard rejection quarantines the utterance, leaves the answer null, terminates the trial with terminal '
  || 'subject_quarantined and a trial_ended event carrying only its reason');
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L, %L)', (select trial from stb),
         (select transcript_version from arena.trials where id = (select trial from stb)), 'later',
         tests.k((select trial from stb), 4, 'question', 'harness_fixed'), 'harness_fixed'),
  'AR001', 'running interview', 'ST-11 any later write (a new question) on the quarantined trial is refused (AR001)');

-- ---------------------------------------------------------------------------- ST-12
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public',
         format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from stt), gen_random_uuid(),
                'x', '{"passed": true}'::jsonb)),
  '42501', 'permission denied', 'ST-12 arena_public cannot call record_subject_turn');

-- ---------------------------------------------------------------------------- ST-13
create temp table stinj on commit drop as
  select tests.as_role('arena_public', format('select arena.trial_context(%L, %L)', (select trial from stt),
           (arena.open_work_item((select trial from stt), 'coaching', tests.k((select trial from stt), 1, 'coaching', 'inj'))
             ->> 'work_item_id'))) as ctx;
select is((select ctx #>> '{transcript,0,answer}' from stinj), 'A busy shift.',
  'ST-13 a stored subject answer (would-be attack text that passed the guard) reaches trial_context only inside '
  || 'the transcript field, as plain data; no function parses or interprets it');

-- ---------------------------------------------------------------------------- ST-14
select is(array[
    (select bool_and(channel = 'text') from arena.turns where trial_id in ((select trial from stt), (select trial from stb))),
    (select bool_and(not answer_partial) from arena.turns where trial_id in ((select trial from stt), (select trial from stb)))],
          array[true, true], 'ST-14 SG3-46: every turn is a text turn (channel = text, answer_partial = false)');

-- ---------------------------------------------------------------------------- ST-15 (its own fresh trial, so no
-- earlier section's open items or turns interfere)
create temp table st15 on commit drop as select tests.family('ST15DEV', 'dev') as id;
create temp table st15tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table st15t on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from st15tour), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from st15t), 0, 'Why did you enter room 4?',
         tests.k((select trial from st15t), 1, 'question', 'harness_fixed'), 'harness_fixed');
create temp table st15wi1 on commit drop as
  select (arena.open_work_item((select trial from st15t), 'subject_answer',
            tests.k((select trial from st15t), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid as wi;
create temp table st15ctx1 on commit drop as
  select tests.as_role('arena_subject', format('select subject.turn_context(%L, %L)', (select trial from st15t), (select wi from st15wi1))) as ctx;
select is((select ctx -> 'disclosure_state' from st15ctx1), '{"disclosed": [], "gates_opened": []}'::jsonb,
  'ST-15 SG1-02: disclosure_state is empty at turn 1 (read before that turn''s own tag is stored)');
select arena.record_subject_turn((select trial from st15t), (select wi from st15wi1), 'A busy shift.',
         jsonb_build_object('disclosed', jsonb_build_array('F1'), 'gates_opened', '[]'::jsonb), '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from st15t),
         (arena.open_work_item((select trial from st15t), 'coaching', tests.k((select trial from st15t), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
select arena.submit_question((select trial from st15t), (select transcript_version from arena.trials where id = (select trial from st15t)),
         'Which task needed entry?', tests.k((select trial from st15t), 2, 'question', 'harness_fixed'), 'harness_fixed');
create temp table st15ctx2 on commit drop as
  select tests.as_role('arena_subject', format('select subject.turn_context(%L, %L)', (select trial from st15t),
           (arena.open_work_item((select trial from st15t), 'subject_answer', tests.k((select trial from st15t), 2, 'subject_answer', 'subject.answer2'))
             ->> 'work_item_id'))) as ctx;
select is(array[(select ctx #> '{disclosure_state,disclosed,0}' from st15ctx2)::text,
                (select ctx #>> '{disclosure_state,disclosed,0,first_turn}' from st15ctx2)],
          array['{"fact_id": "F1", "first_turn": 1}', '1'],
  'ST-15 at turn 2, the facts disclosed in turn 1''s stored tag appear with their turn (ST-10''s quarantined '
  || 'attempt on trial B stored no tag, so it never surfaces here)');

-- ---------------------------------------------------------------------------- ST-16
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'arena' and p.proname = 'record_subject_turn'
                         and pg_get_function_arguments(p.oid) like '%partial%'),
  'ST-16 D-016: record_subject_turn takes no partial argument (every turn''s channel is text)');

-- ---------------------------------------------------------------------------- ST-17
create temp table stg0 on commit drop as select tests.family('STG0', 'dev') as id;
create temp table stg0tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table stg0t on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from stg0tour), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from stg0t), 0, 'Question 1',
         tests.k((select trial from stg0t), 1, 'question', 'harness_fixed'), 'harness_fixed');
create temp table stg0wi on commit drop as
  select (arena.open_work_item((select trial from stg0t), 'subject_answer',
            tests.k((select trial from stg0t), 1, 'subject_answer', 'g0')) ->> 'work_item_id')::uuid as wi;
create temp table stg0r on commit drop as
  select arena.record_subject_turn((select trial from stg0t), (select wi from stg0wi), '', null,
           jsonb_build_object('passed', false, 'rule', 'G0_schema')) as r;
select is(array[(select r ->> 'outcome' from stg0r),
                ((select r from stg0r) = (select arena.record_subject_turn((select trial from stg0t), (select wi from stg0wi),
                                                                           '', null, jsonb_build_object('passed', false, 'rule', 'G0_schema'))))::text,
                (select utterance is null from sealed.quarantined_artifacts where trial_id = (select trial from stg0t))::text,
                (select status from arena.trials where id = (select trial from stg0t)),
                (select state from ledger.terminal_records where trial_id = (select trial from stg0t)),
                (select count(*)::text from arena.trial_events where trial_id = (select trial from stg0t) and kind = 'subject_turn')],
          array['quarantined', 'true', 'true', 'terminated', 'subject_quarantined', '0'],
  'ST-17 SG2-39: an empty response after the repair (G0_schema) is quarantined with a null utterance, the repeat '
  || 'call is idempotent, the trial terminates subject_quarantined, and no subject_turn event is ever emitted');
create temp table stg0b on commit drop as select tests.family('STG0B', 'dev') as id;
create temp table stg0btour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table stg0bt on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from stg0btour), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from stg0bt), 0, 'Question 1',
         tests.k((select trial from stg0bt), 1, 'question', 'harness_fixed'), 'harness_fixed');
select is(
  (arena.record_subject_turn((select trial from stg0bt),
     (arena.open_work_item((select trial from stg0bt), 'subject_answer', tests.k((select trial from stg0bt), 1, 'subject_answer', 'g0b'))
       ->> 'work_item_id')::uuid, '', null, jsonb_build_object('passed', false, 'rule', 'G0_blocked')) ->> 'outcome'),
  'quarantined', 'ST-17 a textless block (G0_blocked) with an empty utterance is quarantined the same way');

select * from finish();
rollback;
