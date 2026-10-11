-- 007_coaching_events_caller.sql (sql/TESTS.md section 7; AST-1..8, SOL-6, KPI-4, F07; S5 section 6; WP-04a).
begin;
\ir harness/fixtures.psql
select plan(29);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

create temp table cc on commit drop as select tests.family('CCDEV', 'dev') as id;
create temp table cctour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table cct on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from cctour), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from cct), 0, 'Why did you enter room 4?',
                             tests.k((select trial from cct), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select trial from cct),
         (arena.open_work_item((select trial from cct), 'subject_answer',
            tests.k((select trial from cct), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'A busy shift.', null, '{"passed": true}'::jsonb);

-- ---------------------------------------------------------------------------- CC-01
create temp table cc01wi on commit drop as
  select (arena.open_work_item((select trial from cct), 'coaching', tests.k((select trial from cct), 1, 'coaching', 'card'))
          ->> 'work_item_id')::uuid as wi;
create temp table cc01 on commit drop as
  select arena.record_coaching_event((select trial from cct), (select wi from cc01wi), jsonb_build_object('card', 'fixture', 'turn_no', 1)) as r;
select is(array[(select (r ->> 'seq')::int from cc01)::text,
                (select candidate_id::text from arena.trial_events where trial_id = (select trial from cct) and kind = 'coach_card')],
          array['3', (select assistant_candidate_id::text from arena.trials where id = (select trial from cct))],
  'CC-01 coach_card gets the next per-trial seq and carries the trial''s assistant candidate id');

-- ---------------------------------------------------------------------------- CC-02
select arena.submit_question((select trial from cct), (select transcript_version from arena.trials where id = (select trial from cct)),
         'Which task needed entry?', tests.k((select trial from cct), 2, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select trial from cct),
         (arena.open_work_item((select trial from cct), 'subject_answer',
            tests.k((select trial from cct), 2, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'The HVAC ticket.', null, '{"passed": true}'::jsonb);
create temp table cc02wi on commit drop as
  select (arena.open_work_item((select trial from cct), 'coaching', tests.k((select trial from cct), 2, 'coaching', 'stale'))
          ->> 'work_item_id')::uuid as wi;
-- The version is bumped directly (the owner): a real later question cannot land while turn 2 is unanswered,
-- but any version-changing step (a release, say) would do the same to this work item.
do $$ begin update arena.trials set transcript_version = transcript_version + 1 where id = (select trial from cct); end $$;
select tests.throws(
  format('select arena.record_coaching_event(%L, %L, %L::jsonb)', (select trial from cct), (select wi from cc02wi),
         jsonb_build_object('card', 'fixture', 'turn_no', 2)),
  'AR002', 'discard this card', 'CC-02 a coaching item opened before a later version change is refused (AR002)');
do $$ begin update arena.trials set transcript_version = transcript_version - 1 where id = (select trial from cct); end $$;

-- ---------------------------------------------------------------------------- CC-03
create temp table cc03 on commit drop as
  select arena.record_coaching_event((select trial from cct),
           (arena.open_work_item((select trial from cct), 'coaching', tests.k((select trial from cct), 2, 'coaching', 'card'))
             ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 2)) as r;
select is(
  arena.record_coaching_event((select trial from cct),
    (arena.open_work_item((select trial from cct), 'coaching', tests.k((select trial from cct), 2, 'coaching', 'card'))
      ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 2)),
  (select r from cc03), 'CC-03 a duplicate work item with the same card and kind returns the same seq');

-- ---------------------------------------------------------------------------- CC-04
select tests.throws(
  format('select arena.record_coaching_event(%L, %L, %L::jsonb)', (select trial from cct),
         (arena.open_work_item((select trial from cct), 'coaching', tests.k((select trial from cct), 2, 'coaching', 'huge'))
           ->> 'work_item_id'), jsonb_build_object('card', repeat('x', 14337))),
  '23514', 'trial_events_payload_check', 'CC-04 a coaching payload over 14,336 bytes is refused (SG1-14, D9)');

-- ---------------------------------------------------------------------------- CC-05
create temp table cccorpus on commit drop as select tests.tournament('dev', array['replay_corpus']) as tour;
create temp table ccct on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from cccorpus), 1)))) ->> 'trial_id')::uuid as trial;
select is(array[
    tests.error(format('select arena.open_work_item(%L, %L, %L)', (select trial from ccct), 'coaching',
      tests.k((select trial from ccct), 0, 'coaching', 'corpus'))),
    tests.error(format('select arena.record_coaching_event(%L, %L, %L::jsonb, %L)', (select trial from cct),
      (arena.open_work_item((select trial from cct), 'coaching', tests.k((select trial from cct), 2, 'coaching', 'unkind'))
        ->> 'work_item_id'), jsonb_build_object('card', 'x'), 'coach_bogus'))],
  array['AR001: coaching does not apply to a replay_corpus trial',
        'AR007: kind must be coach_card, coach_deep or coach_unavailable'],
  'CC-05 coaching on a replay_corpus trial (AR001) and an unknown kind (AR007) are each refused');

-- ---------------------------------------------------------------------------- CC-06
select is(array[
    (select array_agg(seq order by seq) from arena.trial_events where trial_id = (select trial from cct)) =
    (select array_agg(g) from generate_series(1, (select max(seq) from arena.trial_events where trial_id = (select trial from cct))) g),
    (select min(seq) from arena.trial_events where trial_id = (select trial from cct)) = 1],
          array[true, true], 'CC-06 the per-trial event seq is gap-free and starts at 1 across all kinds');

-- ---------------------------------------------------------------------------- CC-07
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table ccprac on commit drop as select tests.family('CCPRAC', 'dev') as id;
create temp table ccpracs on commit drop as
  select (training.start_session(tests.variant('CCPRAC', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), false, 'cc07-practice') ->> 'trial_id')::uuid as trial;
create temp table ccassess on commit drop as
  select (training.start_session(tests.variant('CCPRAC', 'deceptive'), 'assessment', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), false, 'cc07-assessment') ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from ccpracs), 0, 'Q1', tests.k((select trial from ccpracs), 1, 'question', 'investigator'));
select arena.record_subject_turn((select trial from ccpracs),
         (arena.open_work_item((select trial from ccpracs), 'subject_answer',
            tests.k((select trial from ccpracs), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from ccpracs),
         (arena.open_work_item((select trial from ccpracs), 'coaching', tests.k((select trial from ccpracs), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
select arena.submit_question((select trial from ccassess), 0, 'Q1', tests.k((select trial from ccassess), 1, 'question', 'investigator'));
select arena.record_subject_turn((select trial from ccassess),
         (arena.open_work_item((select trial from ccassess), 'subject_answer',
            tests.k((select trial from ccassess), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from ccassess),
         (arena.open_work_item((select trial from ccassess), 'coaching', tests.k((select trial from ccassess), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
select set_config('arena.actor_id', '', true);
select is(array[
    (select visibility from arena.trial_events where trial_id = (select trial from ccpracs) and kind = 'coach_card'),
    (select visibility from arena.trial_events where trial_id = (select trial from ccassess) and kind = 'coach_card'),
    (select bool_and(visibility = 'internal') from arena.trial_events where trial_id = (select trial from cct))::text],
          array['live', 'debrief', 'true'],
  'CC-07 practice coach events are live, assessment coach events are debrief, every tournament event is internal');

-- ---------------------------------------------------------------------------- CC-08, CC-09
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table cc08 on commit drop as
  select * from arena.events_after((select trial from ccassess), 0, 200);
select is(array[(select bool_or(kind = 'coach_card') from cc08)::text,
                (select count(*) from arena.v_trial_events where trial_id = (select trial from ccassess) and kind = 'coach_card')::text],
          array['false', '0'],
  'CC-08 events_after withholds the debrief coach_card from the owner while the assessment trial runs; '
  || 'CC-09 v_trial_events hides it too');
select arena.finalize_trial((select trial from ccassess),
         (arena.open_work_item((select trial from ccassess), 'finalize', tests.k((select trial from ccassess), 1, 'finalize', 'done'))
           ->> 'work_item_id')::uuid,
         jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
                            'rationale', 'not established', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', '[]'::jsonb,
                            'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
select is(array[
    (select bool_or(kind = 'coach_card') from arena.events_after((select trial from ccassess), 0, 200))::text,
    (select count(*) from arena.v_trial_events where trial_id = (select trial from ccassess) and kind = 'coach_card')::text],
          array['true', '1'],
  'CC-08 events_after gives the owner the debrief coach_card once the trial has ended; CC-09 v_trial_events too');
select set_config('arena.actor_id', tests.uid('B')::text, true);
create temp table cc08b on commit drop as
  select * from arena.events_after((select trial from ccpracs), 0, 200);
select set_config('arena.actor_id', '', true);
create temp table cc08c on commit drop as
  select * from arena.events_after((select trial from ccpracs), 0, 200);
select is(array[(select count(*) from cc08b)::text, (select count(*) from cc08c)::text],
          array['0', '0'], 'CC-08 another actor and no actor each get nothing from events_after');

-- ---------------------------------------------------------------------------- CC-10
select set_config('arena.actor_id', tests.uid('A')::text, true);
select is((select count(*) from arena.events_after((select trial from ccpracs), 0, 500)) <= 200, true,
  'CC-10 events_after page size is capped at 200 even when a larger limit is requested');
select set_config('arena.actor_id', '', true);

-- ---------------------------------------------------------------------------- CC-11
select is(array[
    (select card_outcome from ops.latency_samples where trial_id = (select trial from cct) and turn_no = 1),
    (select subject_commit_at = (select created_at from arena.trial_events where trial_id = (select trial from cct)
                                   and kind = 'subject_turn' and turn_no = 1)
       from ops.latency_samples where trial_id = (select trial from cct) and turn_no = 1)::text,
    (select population from ops.latency_samples where trial_id = (select trial from cct) and turn_no = 1)],
          array['delivered', 'true', 'harness'],
  'CC-11 a text subject commit opens a pending KPI-4 sample at the subject_turn event''s created_at, with the '
  || 'population derived from the trial, completed delivered by CC-01''s coach_card');
select set_config('arena.actor_id', tests.uid('A')::text, true);
select is(array[
    (select card_outcome from ops.latency_samples where trial_id = (select trial from ccpracs) and turn_no = 1),
    (select unmeasured from ops.latency_samples where trial_id = (select trial from ccpracs) and turn_no = 1)::text,
    (select miss from ops.latency_samples where trial_id = (select trial from ccpracs) and turn_no = 1)::text],
          array['delivered', 'true', 'false'],
  'CC-11 a delivered practice card without an acknowledgement is unmeasured and not a miss');
select set_config('arena.actor_id', '', true);

-- ---------------------------------------------------------------------------- CC-11b (partial: the permission
-- split and the referee's cross-actor read, over the ccpracs/cct samples already on hand; the voice-session-
-- opens-no-sample and the precise 120 s in_flight/unmeasured_timeout boundary are D7/voice-file concerns,
-- covered by 015_voice.sql's own fixtures rather than duplicated here)
select is(array[
    tests.error(format('select tests.as_role(%L, %L)', 'arena_public', 'select 1 from ops.v_latency_report limit 1')),
    tests.error(format('select tests.as_role(%L, %L)', 'arena_referee', 'select 1 from ops.v_latency limit 1')),
    (select bool_or(trial_id = (select trial from cct)) from ops.v_latency_report)::text],
          array['42501: permission denied for view v_latency_report', '42501: permission denied for view v_latency',
                'true'],
  'CC-11b arena_public cannot read ops.v_latency_report; arena_referee cannot read ops.v_latency (the actor-scoped '
  || 'projection); the referee''s own ops.v_latency_report carries every owner''s samples with no actor filter');
select set_config('arena.actor_id', tests.uid('A')::text, true);
select is((select bool_and(trial_id in ((select trial from ccpracs), (select trial from ccassess)))
             from ops.v_latency where trial_id in ((select trial from ccpracs), (select trial from ccassess))),
          true, 'CC-11b arena_public''s ops.v_latency returns the actor''s own training rows (dev tournament '
                 || 'rows are visible to arena_public regardless of actor, SCN-12; only hidden/training rows are gated)');
select set_config('arena.actor_id', '', true);

-- ---------------------------------------------------------------------------- CC-12
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table cc12 on commit drop as select ops.ack_card((select trial from ccpracs), 1::smallint, true) as ok;
select is(array[(select ok from cc12)::text, (select ops.ack_card((select trial from ccpracs), 1::smallint, true))::text,
                (select kpi4_ms >= server_ms from ops.latency_samples where trial_id = (select trial from ccpracs) and turn_no = 1)::text],
          array['true', 'false', 'true'],
  'CC-12 ack_card stamps client_ack_at once (true, then false) and kpi4_ms is at least server_ms');
create temp table ccprac2 on commit drop as select tests.family('CCPRAC2', 'dev') as id;
create temp table ccpracs2 on commit drop as
  select (training.start_session(tests.variant('CCPRAC2', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), false, 'cc12-practice2') ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from ccpracs2), 0, 'Q1', tests.k((select trial from ccpracs2), 1, 'question', 'investigator'));
select arena.record_subject_turn((select trial from ccpracs2),
         (arena.open_work_item((select trial from ccpracs2), 'subject_answer',
            tests.k((select trial from ccpracs2), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
select arena.record_coaching_event((select trial from ccpracs2),
         (arena.open_work_item((select trial from ccpracs2), 'coaching', tests.k((select trial from ccpracs2), 1, 'coaching', 'card'))
           ->> 'work_item_id')::uuid, jsonb_build_object('card', 'fixture', 'turn_no', 1));
create temp table cc12b on commit drop as select ops.ack_card((select trial from ccpracs2), 1::smallint, false) as ok;
select is(array[(select ok from cc12b)::text,
                (select card_outcome from ops.latency_samples where trial_id = (select trial from ccpracs2) and turn_no = 1),
                (select miss from ops.latency_samples where trial_id = (select trial from ccpracs2) and turn_no = 1)::text,
                ((select kpi4_ms from ops.latency_samples where trial_id = (select trial from ccpracs2) and turn_no = 1) is null)::text],
          array['true', 'client_invalid', 'true', 'true'],
  'CC-12 ack_card(..., false) records client_invalid, a miss, and no kpi4_ms');
select set_config('arena.actor_id', '', true);

-- ---------------------------------------------------------------------------- CC-13
select is(array[
    tests.error(format('select arena.trial_context(%L, %L)', (select trial from cct), (select wi from cc01wi))),
    tests.error(format('select arena.trial_context(%L, %L)', (select trial from cct), gen_random_uuid())),
    tests.error(format('select arena.trial_context(%L, %L)', (select trial from cct),
      (arena.open_work_item((select trial from cct), 'failure', tests.k((select trial from cct), 2, 'failure', 'cc13'))
        ->> 'work_item_id')))],
  array['AR003: context needs an open coaching, finalize or release work item on a running trial',
        'AR003: context needs an open coaching, finalize or release work item on a running trial',
        'AR003: context needs an open coaching, finalize or release work item on a running trial'],
  'CC-13 trial_context refuses a closed (done) item, a wrong/unknown item, and a failure-kind item (AR003 each)');

-- ---------------------------------------------------------------------------- CC-14, CC-15, CC-16, CC-17
select set_config('arena.actor_id', tests.uid('A')::text, true);
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L)', (select trial from cct),
         (select transcript_version from arena.trials where id = (select trial from cct)), 'x',
         tests.k((select trial from cct), 99, 'question', 'actor-on-tournament')),
  'AR040', 'may not act on this trial', 'CC-14 an actor set on a tournament trial is refused (AR040)');
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_subject', format('select arena.record_subject_turn(%L, %L, %L, null, %L)',
         (select trial from ccpracs), gen_random_uuid(), 'x', '{"passed": true}'::jsonb)),
  'AR003', 'unknown work item', 'CC-15 setup: actor A owns ccpracs (checked by work item lookup, not caller, for an unknown item)');
select set_config('arena.actor_id', tests.uid('B')::text, true);
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L)', (select trial from ccpracs),
         (select transcript_version from arena.trials where id = (select trial from ccpracs)), 'x',
         tests.k((select trial from ccpracs), 99, 'question', 'actor-b-on-a')),
  'AR040', 'may not act on this trial', 'CC-15 actor B on actor A''s training trial is refused (AR040)');
select set_config('arena.actor_id', '', true);
select tests.throws(
  format('select arena.submit_question(%L, %L, %L, %L)', (select trial from ccpracs),
         (select transcript_version from arena.trials where id = (select trial from ccpracs)), 'x',
         tests.k((select trial from ccpracs), 99, 'question', 'no-actor-on-training')),
  'AR040', 'may not act on this trial', 'CC-16 no actor on a training trial is refused (AR040)');
select tests.throws(
  format('select training.start_session(%L, %L, %L, %L, false, %L)', tests.variant('CCPRAC', 'truthful'), 'practice',
         tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), 'cc17-no-actor'),
  'AR040', 'no investigator identity', 'CC-17 start_session with no actor is refused (AR040)');

-- ---------------------------------------------------------------------------- CC-18
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table cc18a on commit drop as select ops.ack_card((select trial from ccassess), 1::smallint, true) as ok;
select set_config('arena.actor_id', '', true);
create temp table cc18b on commit drop as select ops.ack_card((select trial from cct), 1::smallint, true) as ok;
select is(array[(select ok from cc18a)::text, (select ok from cc18b)::text,
    (select kpi4_ms = server_ms from ops.latency_samples where trial_id = (select trial from ccassess) and turn_no = 1)::text,
    (select kpi4_ms = server_ms from ops.latency_samples where trial_id = (select trial from cct) and turn_no = 1)::text],
          array['false', 'false', 'true', 'true'],
  'CC-18 ack_card on an assessment turn and a harness turn each return false with no change; their kpi4_ms '
  || 'already equals server_ms');

-- ---------------------------------------------------------------------------- CC-19
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table cc19 on commit drop as
  select training.publish_debrief((select id from training.sessions where trial_id = (select trial from ccassess)),
           jsonb_build_object('schema_version', 'debrief.v1', 'session_id',
             (select id::text from training.sessions where trial_id = (select trial from ccassess)), 'scored', true,
             'outcome', jsonb_build_object('role', 'truthful', 'correct_finding', false, 'committed_label', 'insufficient_evidence',
                                           'resolution', 'not yet resolved'),
             'rubric', '{}'::jsonb, 'scorecards', '{}'::jsonb, 'provenance', '{}'::jsonb)) as r;
select is(array[
    ((select array_agg(seq order by seq) from arena.trial_events where trial_id = (select trial from ccassess)) =
     (select array_agg(g) from generate_series(1, (select max(seq) from arena.trial_events where trial_id = (select trial from ccassess))) g))::text,
    (select kind from arena.trial_events where trial_id = (select trial from ccassess)
      order by seq desc limit 1),
    (select visibility from arena.trial_events where trial_id = (select trial from ccassess) and kind = 'debrief_ready')],
          array['true', 'debrief_ready', 'live'],
  'CC-19 after publish_debrief the event seq is still gap-free, debrief_ready is the last row, and it is live');
select set_config('arena.actor_id', '', true);

-- ---------------------------------------------------------------------------- CC-20, CC-21
create temp table cc20 on commit drop as select tests.family('CC20DEV', 'dev') as id;
create temp table cc20tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table cc20t on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from cc20tour), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from cc20t), 0, 'Question 1',
         tests.k((select trial from cc20t), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select trial from cc20t),
         (arena.open_work_item((select trial from cc20t), 'subject_answer',
            tests.k((select trial from cc20t), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
-- D4 crash: no coaching is ever recorded; the owner backdates the answer so the turn-in-progress hold has
-- expired (arena._turn_in_progress reads arena.turns.answered_at). ops._close_pending_latency, called when the
-- next question is recorded, closes any still-pending sample unconditionally (no elapsed-time check of its own).
do $$
begin
  alter table arena.turns disable trigger turns_answer_once;
  update arena.turns set answered_at = now() - interval '121 seconds'
   where trial_id = (select trial from cc20t) and turn_no = 1;
  alter table arena.turns enable trigger turns_answer_once;
end $$;
select arena.submit_question((select trial from cc20t), (select transcript_version from arena.trials where id = (select trial from cc20t)),
         'Question 2', tests.k((select trial from cc20t), 2, 'question', 'harness_fixed'), 'harness_fixed');
select is(array[(select card_outcome from ops.latency_samples where trial_id = (select trial from cc20t) and turn_no = 1),
                (select miss from ops.latency_samples where trial_id = (select trial from cc20t) and turn_no = 1)::text,
                (select unmeasured from ops.latency_samples where trial_id = (select trial from cc20t) and turn_no = 1)::text],
          array['unmeasured_timeout', 'true', 'true'],
  'CC-20 D4: a subject answer with no coaching recorded, after the 120 s hold expires and the next question is '
  || 'recorded, becomes unmeasured_timeout (a miss and unmeasured)');
select arena.record_subject_turn((select trial from cc20t),
         (arena.open_work_item((select trial from cc20t), 'subject_answer',
            tests.k((select trial from cc20t), 2, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 2', null, '{"passed": true}'::jsonb);
do $$
begin
  update ops.latency_samples set subject_commit_at = subject_commit_at - interval '121 seconds'
   where trial_id = (select trial from cc20t) and turn_no = 2;
end $$;
select arena.record_execution_failure((select trial from cc20t),
         (arena.open_work_item((select trial from cc20t), 'failure', tests.k((select trial from cc20t), 2, 'failure', 'cc21'))
           ->> 'work_item_id')::uuid, 'assistant_failed', 'assistant crashed');
select is((select card_outcome from ops.latency_samples where trial_id = (select trial from cc20t) and turn_no = 2),
          'unmeasured_timeout', 'CC-21 D4: a sample still pending when the trial fails becomes unmeasured_timeout');

-- ---------------------------------------------------------------------------- CC-22
create temp table cc22 on commit drop as select tests.family('CC22DEV', 'dev') as id;
create temp table cc22tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table cc22t on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from cc22tour), 3)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from cc22t), 0, 'Question 1',
         tests.k((select trial from cc22t), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select trial from cc22t),
         (arena.open_work_item((select trial from cc22t), 'subject_answer',
            tests.k((select trial from cc22t), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
create temp table cc22c on commit drop as
  select (arena.open_work_item((select trial from cc22t), 'coaching', tests.k((select trial from cc22t), 1, 'coaching', 'card'))
          ->> 'work_item_id')::uuid as wi;
create temp table cc22cr on commit drop as
  select arena.record_coaching_event((select trial from cc22t), (select wi from cc22c), jsonb_build_object('card', 'fixture', 'turn_no', 1)) as r;
create temp table cc22d on commit drop as
  select (arena.open_work_item((select trial from cc22t), 'coaching', tests.k((select trial from cc22t), 1, 'coaching', 'deep'),
            (select transcript_version from arena.trials where id = (select trial from cc22t))) ->> 'work_item_id')::uuid as wi;
create temp table cc22dr on commit drop as
  select arena.record_coaching_event((select trial from cc22t), (select wi from cc22d),
           jsonb_build_object('insight', 'fixture'), 'coach_deep') as r;
select is(array[
    (arena.record_coaching_event((select trial from cc22t), (select wi from cc22c), jsonb_build_object('card', 'fixture', 'turn_no', 1))
       ->> 'seq') = ((select r from cc22cr) ->> 'seq'),
    (arena.record_coaching_event((select trial from cc22t), (select wi from cc22d), jsonb_build_object('insight', 'fixture'), 'coach_deep')
       ->> 'seq') = ((select r from cc22dr) ->> 'seq')],
          array[true, true],
  'CC-22 SG3-04: card C and the A1 deep update D on their own coaching items each return their stored seq when retried');
-- A new deep item opened now (bound to the current version), then a later question overtakes it; using it
-- afterward is refused as stale (AR002), the discard path record_coaching_event itself guards.
create temp table cc22e on commit drop as
  select (arena.open_work_item((select trial from cc22t), 'coaching', tests.k((select trial from cc22t), 1, 'coaching', 'deep-after-q'))
          ->> 'work_item_id')::uuid as wi;
select arena.submit_question((select trial from cc22t), (select transcript_version from arena.trials where id = (select trial from cc22t)),
         'Question 2', tests.k((select trial from cc22t), 2, 'question', 'harness_fixed'), 'harness_fixed');
select tests.throws(
  format('select arena.record_coaching_event(%L, %L, %L::jsonb, %L)', (select trial from cc22t), (select wi from cc22e),
         jsonb_build_object('insight', 'late'), 'coach_deep'),
  'AR002', 'discard this card', 'CC-22 a deep item opened before a later question is refused as stale (AR002, discarded)');

select * from finish();
rollback;
