-- 004_turns_and_versions.sql (sql/TESTS.md section 4; SCN-10, BKO-7, BKO-8, F07; WP-04a).
begin;
\ir harness/fixtures.psql
select plan(26);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

create temp table sv on commit drop as select tests.family('SVDEV', 'dev') as id;
create temp table svtour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table svt on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from svtour), 3)))) ->> 'trial_id')::uuid as trial;

-- ---------------------------------------------------------------------------- SV-01, SV-02, SV-03, SV-04
create temp table sv01 on commit drop as
  select arena.submit_question((select trial from svt), 0, 'Why did you enter room 4?',
                               tests.k((select trial from svt), 1, 'question', 'harness_fixed'), 'harness_fixed') as r;
select is(array[(select r ->> 'turn_no' from sv01), (select r ->> 'transcript_version' from sv01),
                (select count(*)::text from arena.trial_events where trial_id = (select trial from svt) and kind = 'question_recorded'),
                (select count(*)::text from ledger.events where trial_id = (select trial from svt) and event_type = 'question_asked'
                   and payload ->> 'question_sha256' = ledger.hash_text('Why did you enter room 4?'))],
          array['1', '1', '1', '1'],
  'SV-01 submit_question at version 0 returns turn 1, version 1, and emits question_recorded plus a ledger '
  || 'question_asked carrying the question hash');
select is(
  (select arena.submit_question((select trial from svt), 0, 'Why did you enter room 4?',
                                tests.k((select trial from svt), 1, 'question', 'harness_fixed'), 'harness_fixed')),
  (select r from sv01),
  'SV-02 the same key and question again returns the same jsonb');
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L, %L)', (select trial from svt), 0, 'A different question?',
         tests.k((select trial from svt), 1, 'question', 'harness_fixed'), 'harness_fixed'),
  'AR003', 'different question', 'SV-03 the same key with a different question is refused');
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L, %L)', (select trial from svt), 0, 'Another question',
         tests.k((select trial from svt), 2, 'question', 'harness_fixed'), 'harness_fixed'),
  'AR002', 'stale transcript version', 'SV-04 a new key with expected version 0 after SV-01 is refused (AR002)');

-- ---------------------------------------------------------------------------- SV-05, SV-06
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L, %L)', (select trial from svt), 1, 'A second question',
         tests.k((select trial from svt), 2, 'question', 'harness_fixed'), 'harness_fixed'),
  'AR004', 'unanswered', 'SV-05 a second question while turn 1 is still unanswered is refused (AR004)');
select arena.release_evidence((select trial from svt),
         (arena.open_work_item((select trial from svt), 'release', tests.k((select trial from svt), 1, 'release', 'turn'))
           ->> 'work_item_id')::uuid, '{}');
select arena.record_subject_turn((select trial from svt),
         (arena.open_work_item((select trial from svt), 'subject_answer',
            tests.k((select trial from svt), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'A busy shift.', null, '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from svt),
         (arena.open_work_item((select trial from svt), 'coaching', tests.k((select trial from svt), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
-- 11 more exchanges (turns 2-12) with no release and no coaching delay, to reach the 12-exchange cap.
do $$
declare
  n integer;
  v_wi uuid;
begin
  for n in 2..12 loop
    perform arena.submit_question((select trial from svt), (select transcript_version from arena.trials where id = (select trial from svt)),
      'Question ' || n, tests.k((select trial from svt), n, 'question', 'harness_fixed'), 'harness_fixed');
    v_wi := (arena.open_work_item((select trial from svt), 'release', tests.k((select trial from svt), n, 'release', 'turn'))
             ->> 'work_item_id')::uuid;
    perform arena.release_evidence((select trial from svt), v_wi, '{}');
    v_wi := (arena.open_work_item((select trial from svt), 'subject_answer',
               tests.k((select trial from svt), n, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid;
    perform arena.record_subject_turn((select trial from svt), v_wi, 'Answer ' || n, null, '{"passed": true}'::jsonb);
    v_wi := (arena.open_work_item((select trial from svt), 'coaching', tests.k((select trial from svt), n, 'coaching', 'card'))
             ->> 'work_item_id')::uuid;
    perform arena.record_coaching_event((select trial from svt), v_wi, jsonb_build_object('card', 'fixture', 'turn_no', n));
  end loop;
end $$;
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L, %L)', (select trial from svt),
         (select transcript_version from arena.trials where id = (select trial from svt)), 'Question 13',
         tests.k((select trial from svt), 13, 'question', 'harness_fixed'), 'harness_fixed'),
  'AR001', 'exchange cap', 'SV-06 a 13th question after 12 exchanges is refused (AR001, BKO-8)');

-- ---------------------------------------------------------------------------- SV-07
create temp table svtrain on commit drop as select tests.family('SVTRN', 'dev') as id;
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table svtsess on commit drop as
  select (training.start_session(tests.variant('SVTRN', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), false, 'sv07-session-1') ->> 'trial_id')::uuid as trial;
select is(array[
    tests.error(format('select arena.submit_question(%L, %L, %L, %L, %L)', (select trial from svtsess), 0, 'A question',
                       tests.k((select trial from svtsess), 1, 'question', 'investigator'), 'harness_fixed')),
    tests.error(format('select arena.submit_question(%L, %L, %L, %L)', (select trial from svtsess), 0, 'A question',
                       tests.k((select trial from svtsess), 1, 'question', 'q')))],
  array['AR007: investigator questions carry no origin; harness questions name theirs', '00000'],
  'SV-07 a training question with an origin is refused (AR007); one with none (the investigator default) is accepted');
select set_config('arena.actor_id', '', true);
create temp table svtour2 on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table svt2 on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from svtour2), 3)))) ->> 'trial_id')::uuid as trial;
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L)', (select trial from svt2), 0, 'A question',
         tests.k((select trial from svt2), 1, 'question', 'q')),
  'AR007', 'investigator questions carry no origin', 'SV-07 a tournament question with no origin is refused (AR007)');

-- ---------------------------------------------------------------------------- SV-08
select tests.throws(
  format('select arena.open_work_item(%L, %L, %L)', (select trial from svt2), 'subject_answer',
         tests.k((select trial from svt2), 0, 'subject_answer', 'none')),
  'AR004', 'no open question', 'SV-08 open_work_item(subject_answer) with no open question is refused (AR004)');

-- ---------------------------------------------------------------------------- SV-09
-- One unmeasured exchange first (no release), so rec-01 (on-request after 1 exchange) is releasable by the time
-- the measured turn 2 asks for it.
select tests.exchange((select trial from svt2), 'Question 1', '{}', 'Answer 1');
create temp table sv09v0 on commit drop as select transcript_version as v from arena.trials where id = (select trial from svt2);
select arena.submit_question((select trial from svt2), (select v from sv09v0), 'Why did you enter room 4?',
                             tests.k((select trial from svt2), 2, 'question', 'harness_fixed'), 'harness_fixed');
create temp table sv09v1 on commit drop as select transcript_version as v from arena.trials where id = (select trial from svt2);
select arena.release_evidence((select trial from svt2),
         (arena.open_work_item((select trial from svt2), 'release', tests.k((select trial from svt2), 2, 'release', 'turn'))
           ->> 'work_item_id')::uuid, array['rec-01']);
create temp table sv09v2 on commit drop as select transcript_version as v from arena.trials where id = (select trial from svt2);
select arena.record_subject_turn((select trial from svt2),
         (arena.open_work_item((select trial from svt2), 'subject_answer',
            tests.k((select trial from svt2), 2, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'A busy shift.', null, '{"passed": true}'::jsonb);
create temp table sv09v3 on commit drop as select transcript_version as v from arena.trials where id = (select trial from svt2);
select arena.record_coaching_event((select trial from svt2),
         (arena.open_work_item((select trial from svt2), 'coaching', tests.k((select trial from svt2), 2, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 2));
create temp table sv09v4 on commit drop as select transcript_version as v from arena.trials where id = (select trial from svt2);
select arena.finalize_trial((select trial from svt2),
         (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from svt2),
                                               'finalize', tests.k((select trial from svt2), 2, 'finalize', 'done')))
            ->> 'work_item_id')::uuid,
         jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
                            'rationale', 'not yet established', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', '[]'::jsonb,
                            'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
create temp table sv09v5 on commit drop as select transcript_version as v from arena.trials where id = (select trial from svt2);
select is(array[(select v from sv09v1) - (select v from sv09v0), (select v from sv09v2) - (select v from sv09v1),
                (select v from sv09v3) - (select v from sv09v2), (select v from sv09v4) - (select v from sv09v3),
                (select v from sv09v5) - (select v from sv09v4)],
          array[1, 1, 1, 0, 1],
  'SV-09 version arithmetic over one exchange: question +1, release +1 (something released), answer +1, '
  || 'coaching +0, finalize +1');

-- ---------------------------------------------------------------------------- SV-10, SV-11, SV-12
-- tg_turn_answer_once's guard is one OR: old.answer is not null, OR any other column differs from old. Turn 1
-- on svt2 is already answered (SV-09's setup), so editing its question there would raise AR010 from the
-- first disjunct alone, even if question immutability (the second disjunct) were removed entirely. Use a
-- fresh trial whose one question is still unanswered, isolating the immutability check on its own.
create temp table svtour10 on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table svt10 on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from svtour10), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from svt10), 0, 'Why did you enter room 4?',
                             tests.k((select trial from svt10), 1, 'question', 'harness_fixed'), 'harness_fixed');
select tests.throws(
  format('update arena.turns set question = %L where trial_id = %L and turn_no = 1', 'edited', (select trial from svt10)),
  'AR010', 'immutable', 'SV-10 the owner updating a turn''s still-unanswered question is refused (AR010)');
select tests.throws(
  format('update arena.turns set answer = %L where trial_id = %L and turn_no = 1', 'second answer', (select trial from svt2)),
  'AR010', 'written once', 'SV-11 the owner''s second write of an answer is refused (AR010)');
select tests.throws(
  format('insert into arena.turns (trial_id, turn_no, question, question_source, channel, question_version, idempotency_key) '
        || 'values (%L, 2, %L, %L, %L, 1, %L)', (select trial from svt2), 'x', 'harness_fixed', 'text', 'sv12-key-00001'),
  'AR001', 'trial is not running', 'SV-12 the owner inserting into arena.turns of a finalized trial is refused (AR001)');

-- ---------------------------------------------------------------------------- SV-13, SV-14, SV-15, SV-16
create temp table svtour3 on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table svt3 on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from svtour3), 3)))) ->> 'trial_id')::uuid as trial;
create or replace function pg_temp.sv_turn_start(p_trial uuid, p_n integer, p_q text) returns void
language sql as $$
  select arena.submit_question(p_trial, (select transcript_version from arena.trials where id = p_trial), p_q,
                               tests.k(p_trial, p_n, 'question', 'harness_fixed'), 'harness_fixed')
$$;
create or replace function pg_temp.sv_answer(p_trial uuid, p_n integer, p_a text) returns void
language plpgsql as $$
declare v_wi uuid;
begin
  v_wi := (arena.open_work_item(p_trial, 'release', tests.k(p_trial, p_n, 'release', 'turn')) ->> 'work_item_id')::uuid;
  perform arena.release_evidence(p_trial, v_wi, '{}');
  v_wi := (arena.open_work_item(p_trial, 'subject_answer', tests.k(p_trial, p_n, 'subject_answer', 'subject.answer'))
           ->> 'work_item_id')::uuid;
  perform arena.record_subject_turn(p_trial, v_wi, p_a, null, '{"passed": true}'::jsonb);
end $$;
select pg_temp.sv_turn_start((select trial from svt3), 1, 'Question 1');
select pg_temp.sv_answer((select trial from svt3), 1, 'Answer 1');
select is(array[
    tests.error(format('select pg_temp.sv_turn_start(%L, %L, %L)', (select trial from svt3), 2, 'Question 2')),
    tests.error(format('select arena.release_evidence(%L, %L, %L)', (select trial from svt3),
      (arena.open_work_item((select trial from svt3), 'release', tests.k((select trial from svt3), 2, 'release', 'sv13probe'))
        ->> 'work_item_id'), '{}'::text[]))],
  array['AR004: turn in progress: the coaching for the last answer is pending',
        'AR004: turn in progress: release with the next question'],
  'SV-13 after the subject answers on a trial with an assistant, submit_question and release_evidence are each '
  || 'refused (AR004, turn in progress)');
select arena.record_coaching_event((select trial from svt3),
         (arena.open_work_item((select trial from svt3), 'coaching', tests.k((select trial from svt3), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
select pg_temp.sv_turn_start((select trial from svt3), 2, 'Question 2');
select is((select count(*) from arena.turns where trial_id = (select trial from svt3) and turn_no = 2), 1::bigint,
  'SV-14 the next question is accepted once the turn''s coach_card event is recorded');
select pg_temp.sv_answer((select trial from svt3), 2, 'Answer 2');
select arena.record_coaching_event((select trial from svt3),
         (arena.open_work_item((select trial from svt3), 'coaching', tests.k((select trial from svt3), 2, 'coaching', 'deep'))
           ->> 'work_item_id')::uuid, jsonb_build_object('reason', 'timeout'), 'coach_deep');
select tests.throws(
  format('select pg_temp.sv_turn_start(%L, %L, %L)', (select trial from svt3), 3, 'Question 3'),
  'AR004', 'turn in progress', 'SV-16 a coach_deep event does not end the turn in progress (AR004 still)');
do $$
begin
  alter table arena.turns disable trigger turns_answer_once;
  update arena.turns set answered_at = now() - interval '121 seconds'
   where trial_id = (select trial from svt3) and turn_no = 2;
  alter table arena.turns enable trigger turns_answer_once;
end $$;
select ok(tests.error(format('select pg_temp.sv_turn_start(%L, %L, %L)', (select trial from svt3), 3, 'Question 3')) = '00000',
  'SV-15 121 s after the answer with no coach event, the next question is accepted (turn-in-progress expiry)');

-- ---------------------------------------------------------------------------- SV-17
create temp table svcorpus on commit drop as select tests.tournament('dev', array['replay_corpus']) as tour;
create temp table svct on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from svcorpus), 1)))) ->> 'trial_id')::uuid as trial;
select pg_temp.sv_turn_start((select trial from svct), 1, 'Question 1');
select arena.record_subject_turn((select trial from svct),
         (arena.open_work_item((select trial from svct), 'subject_answer',
            tests.k((select trial from svct), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'A busy shift.', null, '{"passed": true}'::jsonb);
select is((select coaching_pending from arena.trials where id = (select trial from svct)), false,
  'SV-17 a corpus trial (no assistant) never sets coaching_pending');

-- ---------------------------------------------------------------------------- SV-18
create temp table svtour4 on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table svt4 on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from svtour4), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from svt4), 0, 'Question 1',
         tests.k((select trial from svt4), 1, 'question', 'harness_fixed'), 'harness_fixed');
select pg_temp.sv_answer((select trial from svt4), 1, 'Answer 1');
create temp table svcard1 on commit drop as
  select (arena.record_coaching_event((select trial from svt4),
            (arena.open_work_item((select trial from svt4), 'coaching', tests.k((select trial from svt4), 1, 'coaching', 'card'))
              ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1)) ->> 'seq')::integer as seq;
select is(
  (select arena.submit_question((select trial from svt4),
         (select transcript_version from arena.trials where id = (select trial from svt4)), 'Question 2',
         tests.k((select trial from svt4), 2, 'question', 'assistant_relay'), 'assistant_relay', 'relayed',
         (select seq from svcard1)) ->> 'turn_no'),
  '2', 'SV-18 assistant_relay with relayed and the previous turn''s coach_card seq is stored as given');
select pg_temp.sv_answer((select trial from svt4), 2, 'Answer 2');
create temp table svcard2 on commit drop as
  select (arena.record_coaching_event((select trial from svt4),
            (arena.open_work_item((select trial from svt4), 'coaching', tests.k((select trial from svt4), 2, 'coaching', 'card'))
              ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 2)) ->> 'seq')::integer as seq;
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L, %L, %L, %L)', (select trial from svt4),
         (select transcript_version from arena.trials where id = (select trial from svt4)), 'A different question',
         tests.k((select trial from svt4), 3, 'question', 'bad-relay'), 'assistant_relay', 'relayed', (select seq from svcard1)),
  'AR007', 'coach card for the previous turn',
  'SV-18 assistant_relay naming a seq that is not that card (turn 2''s, not turn 3''s) is refused (AR007)');
select is(
  (select arena.submit_question((select trial from svt4),
     (select transcript_version from arena.trials where id = (select trial from svt4)), 'Question 3',
     tests.k((select trial from svt4), 3, 'question', 'harness_fallback'), 'harness_fallback', 'fallback_no_card')
   ->> 'turn_no'),
  '3', 'SV-18 harness_fallback with fallback_no_card (no proposal) is stored');
select pg_temp.sv_answer((select trial from svt4), 3, 'Answer 3');
create temp table svcard3 on commit drop as
  select (arena.record_coaching_event((select trial from svt4),
            (arena.open_work_item((select trial from svt4), 'coaching', tests.k((select trial from svt4), 3, 'coaching', 'card'))
              ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 3)) ->> 'seq')::integer as seq;
select is(
  (select arena.submit_question((select trial from svt4),
     (select transcript_version from arena.trials where id = (select trial from svt4)), 'Question 4',
     tests.k((select trial from svt4), 4, 'question', 'harness_fallback'), 'harness_fallback',
     'fallback_failed_test:too_short', (select seq from svcard3))
   ->> 'turn_no'),
  '4', 'SV-18 harness_fallback with fallback_failed_test:<reason> and the rejected card''s seq is stored');
-- The reused-key comparison is one tuple: (question, origin, relay_outcome, proposal_seq) is distinct from
-- the call's. Omitting relay_outcome/proposal_seq here (both default null) would mismatch against the
-- stored turn's 'fallback_failed_test:too_short' / svcard3.seq on its own, masking whether origin is really
-- part of the comparison. Keep those two identical to the original call so only origin differs.
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L, %L, %L, %L)', (select trial from svt4),
         (select transcript_version from arena.trials where id = (select trial from svt4)), 'Question 4',
         tests.k((select trial from svt4), 4, 'question', 'harness_fallback'), 'harness_fixed',
         'fallback_failed_test:too_short', (select seq from svcard3)),
  'AR003', 'different question', 'SV-18 the same key with another origin is refused (AR003)');
select pg_temp.sv_answer((select trial from svt4), 4, 'Answer 4');
select arena.record_coaching_event((select trial from svt4),
         (arena.open_work_item((select trial from svt4), 'coaching', tests.k((select trial from svt4), 4, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 4));

-- ---------------------------------------------------------------------------- SV-19
select tests.throws(
  format('select pg_temp.sv_turn_start(%L, %L, %L)', (select trial from svt4), 5, repeat('q', 601)),
  '23514', 'turns_question_check', 'SV-19 D11: a question of 601 characters is refused (23514)');
select pg_temp.sv_turn_start((select trial from svt4), 5, repeat('q', 600));
select is((select count(*) from arena.turns where trial_id = (select trial from svt4) and turn_no = 5), 1::bigint,
  'SV-19 a question of 600 characters is accepted');
select tests.throws(
  format('select arena.record_subject_turn(%L, %L, %L, null, %L)', (select trial from svt4),
         (arena.open_work_item((select trial from svt4), 'subject_answer',
            tests.k((select trial from svt4), 5, 'subject_answer', 'subject.answer')) ->> 'work_item_id'),
         repeat('a', 901), '{"passed": true}'::jsonb),
  '23514', 'turns_answer_check', 'SV-19 S2 V1: an answer of 901 characters is refused (23514)');

select * from finish();
rollback;
