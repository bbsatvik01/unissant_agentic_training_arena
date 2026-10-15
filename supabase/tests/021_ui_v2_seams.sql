-- 021_ui_v2_seams.sql (UI v2 seams, migration 20261015000100; owner D-034..D-036): the world telemetry batches
-- (recording v2) on the owner's own training trial only.
begin;
\ir harness/fixtures.psql
select plan(7);

select tests.users();
select tests.family('UIV2', 'dev');
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table ui on commit drop as
  select (tests.as_role('arena_public', format('select training.start_session(%L, %L, %L, %L, false, %L)',
            tests.variant('UIV2', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), 'ui-v2-session-a')) ->> 'trial_id')::uuid as trial;

create function pg_temp.post(p_events jsonb) returns text
language sql as $$
  select tests.as_role('arena_public', format('select to_jsonb(training.record_world_events(%L, %L))',
                                              (select trial from ui), p_events)) #>> '{}'
$$;

-- ---------------------------------------------------------------------------- WE-01
create temp table we01 on commit drop as select
  pg_temp.post('[{"t_ms": 900, "kind": "pose", "data": {"actor": "subject"}}, {"t_ms": 100, "kind": "ui", "data": {}}]')
    as first;
alter table we01 add column second text;
update we01 set second = pg_temp.post('[{"t_ms": 500, "kind": "camera", "data": {"fov": 50}}]');
select is(array[(select first from we01), (select second from we01),
    (select jsonb_agg(jsonb_array_length(events) order by batch_no)::text from training.world_event_batches
      where trial_id = (select trial from ui))],
  array['1', '2', '[2, 1]'],
  'WE-01 the owner posts batches; each is stored whole and numbered in order');

-- ---------------------------------------------------------------------------- WE-02
select is(tests.as_role('arena_public', format(
    'select jsonb_agg(batch_no order by batch_no) from training.v_my_world_events where trial_id = %L',
    (select trial from ui)))::text, '[1, 2]',
  'WE-02 the owner reads the trial''s batches through training.v_my_world_events');

-- ---------------------------------------------------------------------------- WE-03
select set_config('arena.actor_id', tests.uid('B')::text, true);
select is(array[
    tests.sqlstate(format('select pg_temp.post(%L)', '[{"t_ms": 1, "kind": "pose", "data": {}}]')),
    tests.as_role('arena_public', format('select count(*) from training.v_my_world_events where trial_id = %L',
                                         (select trial from ui)))::text],
  array['AR040', '0'],
  'WE-03 another actor can neither post to the trial (AR040, as for an unknown id) nor read its batches');
select set_config('arena.actor_id', '', true);
select is(tests.sqlstate(format('select pg_temp.post(%L)', '[{"t_ms": 1, "kind": "pose", "data": {}}]')), 'AR040',
  'WE-04 a request with no actor is refused (AR040)');
select set_config('arena.actor_id', tests.uid('A')::text, true);

-- ---------------------------------------------------------------------------- WE-05
select is(array[
    tests.sqlstate($$ select pg_temp.post('[]') $$),
    tests.sqlstate($$ select pg_temp.post('{"t_ms": 1}') $$),
    tests.sqlstate($$ select pg_temp.post('[1]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": 1, "kind": "pose"}]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": 1, "kind": "pose", "data": {}, "x": 1}]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": "1", "kind": "pose", "data": {}}]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": 1.5, "kind": "pose", "data": {}}]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": -1, "kind": "pose", "data": {}}]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": 86400001, "kind": "pose", "data": {}}]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": 1, "kind": "smell", "data": {}}]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": 1, "kind": 3, "data": {}}]') $$),
    tests.sqlstate($$ select pg_temp.post('[{"t_ms": 1, "kind": "pose", "data": []}]') $$),
    tests.sqlstate(format('select pg_temp.post(%L)', jsonb_build_array(jsonb_build_object(
      't_ms', 1, 'kind', 'input', 'data', jsonb_build_object('k', repeat('x', 140000))))))],
  array['AR007', 'AR007', 'AR007', 'AR007', 'AR007', 'AR007', 'AR007', 'AR007', 'AR007', 'AR007', 'AR007', 'AR007',
        'AR007'],
  'WE-05 a malformed batch is refused whole (AR007): not a 1..2000 list, an event not exactly {t_ms, kind, data}, '
  || 't_ms not an integer in 0..86400000, an unknown kind, data not an object, over the batch size');

-- ---------------------------------------------------------------------------- WE-06
select is(tests.sqlstate(format('update training.world_event_batches set bytes = 1 where trial_id = %L',
                                (select trial from ui))), 'AR010',
  'WE-06 the batches are append-only');

-- ---------------------------------------------------------------------------- WE-07
-- The 16 MiB per trial: fill the trial to just under it directly (as the owner of the table would), then the next
-- batch that would pass it is refused.
insert into training.world_event_batches (trial_id, batch_no, events, bytes)
  select (select trial from ui), n, '[{"t_ms": 0, "kind": "ui", "data": {}}]', 131072 from generate_series(3, 130) n;
select is(tests.error($$ select pg_temp.post('[{"t_ms": 1, "kind": "ui", "data": {}}]') $$),
  'AR007: the trial holds its 16 MiB of world events',
  'WE-07 a batch that would take the trial past 16 MiB is refused');

select * from finish();
rollback;
