-- 019_referee.sql (WP-14): sealed.record_independent_labels, sealed.record_judgment and the blinded trainer
-- review queue (training.review_items and its four functions). Idempotency and refusal paths only: the
-- derived label and trigger values these functions store are proved in packages/core's pure-function tests
-- (arena_core.referee), which this part does not re-derive in SQL.
begin;
\ir harness/fixtures.psql
select plan(21);

select tests.users();
create temp table tt (tour uuid, trial uuid, trial2 uuid) on commit drop;
insert into tt (tour) select tests.tournament('dev', array['interactive']);
update tt set trial = tests.trial(tour, 3), trial2 = tests.trial(tour, 4);
grant select on tt to arena_referee;   -- read under `set local role` below (a temp table grants nothing by default)

-- ------------------------------------------------------------------ sealed.record_independent_labels
select is(
  tests.as_role('arena_referee', format(
    $q$select sealed.record_independent_labels(%L, 'model',
       '[{"turn_no": 1, "label": "responsive", "compliant": true, "rationale": "no quote given"},
         {"turn_no": 2, "label": "evasion", "compliant": false, "rationale": "left it vague"}]'::jsonb, %L)$q$,
    (select trial from tt), tests.h('r1-prompt'))),
  '{"outcome": "recorded", "count": 2}'::jsonb,
  'first call inserts both rows');

select is((select count(*)::int from sealed.independent_labels where trial_id = (select trial from tt)
            and labeler = 'model'), 2, 'two rows stored');

select is(
  tests.as_role('arena_referee', format(
    $q$select sealed.record_independent_labels(%L, 'model',
       '[{"turn_no": 1, "label": "responsive", "compliant": true, "rationale": "no quote given"},
         {"turn_no": 2, "label": "evasion", "compliant": false, "rationale": "left it vague"}]'::jsonb, %L)$q$,
    (select trial from tt), tests.h('r1-prompt'))),
  '{"outcome": "exists", "count": 2}'::jsonb,
  'a retry with the exact same rows returns exists, inserts nothing twice');

select is((select count(*)::int from sealed.independent_labels where trial_id = (select trial from tt)
            and labeler = 'model'), 2, 'still two rows after the retry');

set local role arena_referee;
select tests.throws(
  format($q$select sealed.record_independent_labels(%L, 'model',
     '[{"turn_no": 1, "label": "evasion", "compliant": false, "rationale": "x"}]'::jsonb, %L)$q$,
    (select trial from tt), tests.h('r1-prompt-2')),
  'AR003', 'different content', 'a different label set for the same (trial, labeler) is refused');
reset role;

select is(
  tests.as_role('arena_referee', format(
    $q$select sealed.record_independent_labels(%L, 'model', '[]'::jsonb, %L)$q$,
    (select trial2 from tt), tests.h('other-prompt'))),
  '{"outcome": "recorded", "count": 0}'::jsonb,
  'an empty row set is valid (S2 6.10: nothing to label)');

-- ------------------------------------------------------------------ sealed.record_judgment
select is(
  (tests.as_role('arena_referee', format(
    $q$select sealed.record_judgment(%L, 'fidelity_detail', null, '{"turns": []}'::jsonb, null, %L)$q$,
    (select trial from tt), (select trial from tt)::text || ':r1')) ->> 'outcome'),
  'recorded', 'R1''s full report is stored once under its stage key');

select is(
  (tests.as_role('arena_referee', format(
    $q$select sealed.record_judgment(%L, 'fidelity_detail', null, '{"turns": []}'::jsonb, null, %L)$q$,
    (select trial from tt), (select trial from tt)::text || ':r1')) ->> 'outcome'),
  'exists', 'a retried stage with the same payload resumes without a second row');

set local role arena_referee;
select tests.throws(
  format($q$select sealed.record_judgment(%L, 'fidelity_detail', null, '{"turns": [1]}'::jsonb, null, %L)$q$,
         (select trial from tt), (select trial from tt)::text || ':r1'),
  'AR003', 'different judgment', 'the same stage key with a different payload is refused');
reset role;

select is((select count(*)::int from sealed.judgments where trial_id = (select trial from tt)), 1,
  'one judgment row for the r1 stage key');

-- ------------------------------------------------------------------ training.review_items
create temp table ri on commit drop as
  select (tests.as_role('arena_referee', format(
    $q$select to_jsonb(training.create_review_item('T-LAB', null, %L, %L, null,
       '{"task": "T-LAB", "transcript": []}'::jsonb))$q$,
    tests.uid('A'), (select trial from tt))) #>> '{}')::uuid as item;
grant select on ri to arena_referee;

select is(
  tests.as_role('arena_referee', format($q$select training.list_review_items(%L)$q$, tests.uid('A'))),
  jsonb_build_array(jsonb_build_object('item_id', (select item from ri), 'task', 'T-LAB', 'submitted', false)),
  'the rater''s list shows the one unsubmitted item');

select is(
  tests.as_role('arena_referee', format($q$select training.list_review_items(%L)$q$, tests.uid('B'))),
  '[]'::jsonb, 'a different rater sees no items (blinded, scoped to the assignee)');

select ok(
  tests.as_role('arena_referee', format($q$select training.get_review_item(%L, %L)$q$,
                                        (select item from ri), tests.uid('A'))) is not null,
  'the assigned rater reads the task payload');

select is(
  tests.as_role('arena_referee', format($q$select training.get_review_item(%L, %L)$q$,
                                        (select item from ri), tests.uid('B'))),
  null, 'the wrong rater gets no payload (no existence oracle for someone else''s item)');

select is(
  (tests.as_role('arena_referee', format(
    $q$select training.submit_review_item(%L, %L, '{"task": "T-LAB", "turns": []}'::jsonb)$q$,
    (select item from ri), tests.uid('A'))) ->> 'outcome'),
  'recorded', 'the assigned rater''s first submission is recorded');

select is(
  tests.as_role('arena_referee', format($q$select training.list_review_items(%L)$q$, tests.uid('A'))),
  jsonb_build_array(jsonb_build_object('item_id', (select item from ri), 'task', 'T-LAB', 'submitted', true)),
  'the item now shows submitted');

select is(
  (tests.as_role('arena_referee', format(
    $q$select training.submit_review_item(%L, %L, '{"task": "T-LAB", "turns": []}'::jsonb)$q$,
    (select item from ri), tests.uid('A'))) ->> 'outcome'),
  'exists', 'resubmitting the same content is idempotent');

set local role arena_referee;
select tests.throws(
  format($q$select training.submit_review_item(%L, %L, '{"task": "T-LAB", "turns": [1]}'::jsonb)$q$,
         (select item from ri), tests.uid('A')),
  'AR003', 'already submitted', 'resubmitting different content is refused');

select tests.throws(
  format($q$select training.submit_review_item(%L, %L, '{"task": "T-LAB", "turns": []}'::jsonb)$q$,
         (select item from ri), tests.uid('B')),
  'AR040', 'review item refused', 'a rater who was never assigned this item cannot submit to it');
reset role;

select is((select count(*)::int from sealed.judgments where kind = 'calibration'
            and trial_id = (select trial from tt) and rater_id = tests.uid('A')::text), 1,
  'the submission also wrote one calibration judgment row, keyed by the item and the rater');

select is((select r.submission ->> 'turns' from training.review_items r where r.id = (select item from ri)),
  '[]', 'the stored submission is exactly what was sent');

select * from finish();
rollback;
