-- 017_trace_mirror.sql (sql/TESTS.md section 17; EVL-5, KPI-4, direction 10, R3-03; S5 section 8). No dblink:
-- every scenario here is a single-session sequence.
begin;
\ir harness/fixtures.psql
select plan(13);  -- TM-04/TM-05 and TM-11/TM-12 are each one bundled check; TM-15 extends TM-04's own
select tests.users();

-- a fresh hex string of the given length, for trace/span ids.
create or replace function pg_temp.hex(p_len integer) returns text
language sql as $$ select substr(md5(gen_random_uuid()::text || clock_timestamp()::text), 1, p_len) $$;
-- one span jsonb object (mirror_spans' input shape), overridden as needed.
create or replace function pg_temp.span(p_trace text, p_span text, p_overrides jsonb default '{}'::jsonb) returns jsonb
language sql as $$
  select jsonb_build_object('trace_id', p_trace, 'span_id', p_span, 'parent_span_id', null, 'name', 'tm span',
    'kind', 'LLM', 'status', 'OK', 'started_at', (now() - interval '1 second')::text, 'ended_at', now()::text,
    'otlp', '{"k": "v"}'::jsonb) || p_overrides
$$;
-- a draft tournament on a fresh family (any split) with one interactive position, candidates included.
create or replace function pg_temp.tm_draft(p_code text, p_split text) returns uuid
language plpgsql as $$
declare v_t uuid;
begin
  perform tests.family(p_code, p_split);
  v_t := arena.create_tournament('tm-' || lower(p_code) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
                                  p_split, 42, 'global');
  perform arena.add_planned_trials(v_t, jsonb_build_array(jsonb_build_object('position', 1, 'track', 'interactive',
    'block_no', 1, 'variant_id', tests.variant(p_code, 'truthful'), 'assistant_candidate_id', tests.candidate('assistant', 'A1'),
    'subject_candidate_id', tests.candidate('subject', 'S1'))));
  return v_t;
end $$;
create or replace function pg_temp.tm_complete(p_trial uuid, p_key text) returns void
language plpgsql as $$
declare v_wi uuid;
begin
  perform tests.exchange(p_trial, 'Question 1', '{}'::text[], 'Answer 1');
  v_wi := (arena.open_work_item(p_trial, 'finalize', tests.k(p_trial, 1, 'finalize', p_key)) ->> 'work_item_id')::uuid;
  perform arena.finalize_trial(p_trial, v_wi, jsonb_build_object('label', 'insufficient_evidence', 'likelihood',
    'roughly_even_chance', 'confidence', 'low', 'rationale', 'tm', 'basis_flag_refs', '[]'::jsonb,
    'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------- TM-01
create temp table tm01trace on commit drop as select pg_temp.hex(32) as t;
create temp table tm01batch on commit drop as select jsonb_build_array(
  pg_temp.span((select t from tm01trace), pg_temp.hex(16))) as spans;
select is(array[
    tests.as_role('arena_public', format('select ops.mirror_spans(%L, %L::jsonb)', 'arena-api', (select spans from tm01batch)))::text,
    tests.as_role('arena_public', format('select ops.mirror_spans(%L, %L::jsonb)', 'arena-api', (select spans from tm01batch)))::text],
  array['1', '0'],
  'TM-01 mirror_spans inserts a new batch; the identical batch again inserts 0 (trace_id, span_id is the key)');

-- ---------------------------------------------------------------------------- TM-02
create temp table tm02tour on commit drop as select pg_temp.tm_draft('TM02DEV', 'dev') as tour;
select arena.freeze_tournament((select tour from tm02tour));
select arena.open_tournament((select tour from tm02tour));
create temp table tm02trial on commit drop as select tests.trial((select tour from tm02tour), 1) as trial;
create temp table tm02trace on commit drop as select pg_temp.hex(32) as t;
select ops.mirror_spans('arena-api', jsonb_build_array(pg_temp.span((select t from tm02trace), pg_temp.hex(16),
  jsonb_build_object('trial_id', (select trial from tm02trial)::text))));
select is(array[
    (select tournament_id::text from ops.trace_mirror where trace_id = (select t from tm02trace)),
    (select split from ops.trace_mirror where trace_id = (select t from tm02trace)),
    (select export_state from ops.trace_mirror where trace_id = (select t from tm02trace))],
  array[(select tour from tm02tour)::text, 'dev', 'pending'],
  'TM-02 given only trial_id, tournament_id and split are derived from the trial''s tournament, and '
  || 'export_state is pending (a dev split is never held)');

-- ---------------------------------------------------------------------------- TM-03
create temp table tm03trace on commit drop as select pg_temp.hex(32) as t;
select is(tests.sqlstate(format('select ops.mirror_spans(%L, %L::jsonb)', 'arena-api', jsonb_build_array(
    pg_temp.span((select t from tm03trace), pg_temp.hex(16),
      jsonb_build_object('otlp', jsonb_build_object('pad', repeat('x', 33000))))))),
  '23514',
  'TM-03 an otlp payload over 32 KiB is refused (23514, the trace_mirror_otlp_check column check)');

-- ---------------------------------------------------------------------------- hidden pipeline (TM-04, TM-05, TM-11..TM-15)
select tests.family('TM04HID', 'hidden');
select sealed.seal_hidden_split(tests.sampler());
create temp table tmh on commit drop as select arena.create_tournament(
  'tm-hid-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), 'hidden', 42, 'global') as tour;
select arena.add_planned_trials((select tour from tmh), jsonb_build_array(jsonb_build_object('position', 1,
  'track', 'interactive', 'block_no', 1, 'variant_id', tests.variant('TM04HID', 'truthful'),
  'assistant_candidate_id', tests.candidate('assistant', 'A1'), 'subject_candidate_id', tests.candidate('subject', 'S1'))));
select arena.freeze_tournament((select tour from tmh));
select arena.open_tournament((select tour from tmh));
create temp table tmhtrial on commit drop as select tests.trial((select tour from tmh), 1) as trial;
create temp table tm14other on commit drop as select pg_temp.tm_draft('TM14DEV', 'dev') as tour2;  -- for TM-14

-- ---------------------------------------------------------------------------- TM-04, TM-05
create temp table tm04trace on commit drop as select pg_temp.hex(32) as t;
select ops.mirror_spans('arena-api', jsonb_build_array(pg_temp.span((select t from tm04trace), pg_temp.hex(16),
  jsonb_build_object('trial_id', (select trial from tmhtrial)::text))));
create temp table tm05 on commit drop as select ops.set_export_state(
  jsonb_build_array(jsonb_build_object('trace_id', (select t from tm04trace), 'span_id',
    (select span_id from ops.trace_mirror where trace_id = (select t from tm04trace)))), 'exported') as n;
select is(array[
    (select export_state from ops.trace_mirror where trace_id = (select t from tm04trace)),
    (select count(*)::text from ops.v_exportable_spans where trace_id = (select t from tm04trace)),
    (select n::text from tm05)],
  array['held', '0', '0'],
  'TM-04, TM-05 a span of a running hidden tournament is held and absent from ops.v_exportable_spans; '
  || 'set_export_state(..., exported) on it before reveal affects 0 rows');

-- ---------------------------------------------------------------------------- TM-11, TM-12
create temp table tm11trace on commit drop as select pg_temp.hex(32) as t;
select ops.mirror_spans('arena-api', jsonb_build_array(
  pg_temp.span((select t from tm11trace), pg_temp.hex(16),
    jsonb_build_object('tournament_id', (select tour from tmh)::text, 'split', 'hidden')),
  pg_temp.span((select t from tm11trace), pg_temp.hex(16), '{}'::jsonb)));
create temp table tm11spans on commit drop as select span_id, export_state from ops.trace_mirror
  where trace_id = (select t from tm11trace) order by created_at;
create temp table tm12 on commit drop as select ops.set_export_state(
  jsonb_build_array(jsonb_build_object('trace_id', (select t from tm11trace), 'span_id',
    (select span_id from tm11spans order by export_state limit 1))), 'exported') as n;
select is(array[
    (select export_state from tm11spans where export_state = 'held' limit 1),
    (select export_state from tm11spans where export_state <> 'held' limit 1),
    (select count(*)::text from ops.v_exportable_spans where trace_id = (select t from tm11trace)),
    (select n::text from tm12)],
  array['held', 'pending', '0', '0'],
  'TM-11, TM-12 a trial-less span marked hidden and bound to a hidden tournament is held; its unclassified '
  || 'sibling in the same trace is pending but absent from ops.v_exportable_spans (the trace holds a held '
  || 'span); set_export_state(..., exported) on the sibling before reveal affects 0 rows');

-- ---------------------------------------------------------------------------- TM-13
create temp table tm13trace on commit drop as select pg_temp.hex(32) as t;
select tests.family('TM13DEV', 'dev');
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table tm13trial on commit drop as
  select (training.start_session(tests.variant('TM13DEV', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
    tests.candidate('subject', 'S1'), false, 'tm13-session-01') ->> 'trial_id')::uuid as trial;
select set_config('arena.actor_id', '', true);
select ops.mirror_spans('arena-api', jsonb_build_array(
  pg_temp.span((select t from tm13trace), pg_temp.hex(16), jsonb_build_object('split', 'hidden')),
  pg_temp.span((select t from tm13trace), pg_temp.hex(16),
    jsonb_build_object('trial_id', (select trial from tm13trial)::text, 'split', 'hidden'))));
select is((select bool_and(export_state = 'held') from ops.trace_mirror where trace_id = (select t from tm13trace))::text,
  'true',
  'TM-13 a span marked hidden with no tournament, and a span marked hidden bound to a development (training) '
  || 'trial, are each held: fail closed with no tournament ever to reveal');

-- ---------------------------------------------------------------------------- TM-14
create temp table tm14trace on commit drop as select pg_temp.hex(32) as t;
select is(tests.error(format('select ops.mirror_spans(%L, %L::jsonb)', 'arena-api', jsonb_build_array(
    pg_temp.span((select t from tm14trace), pg_temp.hex(16), jsonb_build_object('trial_id',
      (select trial from tmhtrial)::text, 'tournament_id', (select tour2 from tm14other)::text))))),
  'AR007: span tournament binding disagrees with its trial',
  'TM-14 a span whose tournament binding disagrees with its trial''s own tournament is refused (AR007)');

-- ---------------------------------------------------------------------------- reveal the hidden tournament
select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from tmhtrial)));
select pg_temp.tm_complete((select trial from tmhtrial), 'tmh-fin');
select ledger.adjudicate_validity((select trial from tmhtrial), 'valid', 'tm fixture', null, 'tmreviewer', 'tmh-adj-001');
select arena.close_tournament_run((select tour from tmh));
select arena.begin_scoring((select tour from tmh));
select ledger.reveal((select tour from tmh));

-- ---------------------------------------------------------------------------- TM-04 (after), TM-15
create temp table tm15before on commit drop as select
  (select count(*) from ops.v_exportable_spans where trace_id = (select t from tm04trace)) as tm04n,
  (select count(*) from ops.v_exportable_spans where trace_id = (select t from tm11trace)) as tm11n;
create temp table tm15moved on commit drop as select sum(n) as total from (
  select ops.set_export_state(jsonb_build_array(jsonb_build_object('trace_id', (select t from tm11trace),
    'span_id', span_id)), 'exported') as n from tm11spans) z;
create temp table tm15after on commit drop as select
  bool_and(export_state = 'exported') as all_exported from ops.trace_mirror where trace_id = (select t from tm11trace);
select is(array[(select tm04n::text from tm15before), (select tm11n::text from tm15before),
                (select total::text from tm15moved), (select all_exported::text from tm15after)],
  array['1', '2', '2', 'true'],
  'TM-15 once the hidden tournament is revealed, TM-04''s span and both of TM-11''s trace''s spans appear in '
  || 'ops.v_exportable_spans and each moves to exported');

-- ---------------------------------------------------------------------------- TM-06
create temp table tm06trace on commit drop as select pg_temp.hex(32) as t;
create temp table tm06span on commit drop as select pg_temp.hex(16) as s;
select ops.mirror_spans('arena-api', jsonb_build_array(pg_temp.span((select t from tm06trace), (select s from tm06span))));
create temp table tm06keys on commit drop as select jsonb_build_array(jsonb_build_object('trace_id',
  (select t from tm06trace), 'span_id', (select s from tm06span))) as k;
create temp table tm06s0 on commit drop as select export_state from ops.trace_mirror where trace_id = (select t from tm06trace);
create temp table tm06n1 on commit drop as select ops.set_export_state((select k from tm06keys), 'exported') as n;
create temp table tm06s1 on commit drop as select export_state from ops.trace_mirror where trace_id = (select t from tm06trace);
create temp table tm06n2 on commit drop as select ops.set_export_state((select k from tm06keys), 'verified') as n;
create temp table tm06s2 on commit drop as select export_state from ops.trace_mirror where trace_id = (select t from tm06trace);
create temp table tm06n3 on commit drop as select ops.set_export_state((select k from tm06keys), 'exported') as n;
select is(array[(select export_state from tm06s0), (select n::text from tm06n1), (select export_state from tm06s1),
                (select n::text from tm06n2), (select export_state from tm06s2), (select n::text from tm06n3)],
  array['pending', '1', 'exported', '1', 'verified', '0'],
  'TM-06 a span moves pending to exported to verified; a second attempt to export the now-verified span '
  || 'affects 0 rows (it is no longer in ops.v_exportable_spans)');

-- ---------------------------------------------------------------------------- TM-07
select is(tests.error(format('update ops.trace_mirror set name = %L where trace_id = %L and span_id = %L',
    'renamed', (select t from tm06trace), (select s from tm06span))),
  'AR010: a mirrored span changes only its export state',
  'TM-07 any change to a mirrored span other than its export state is refused (AR010)');

-- ---------------------------------------------------------------------------- TM-08
create temp table tm08trace on commit drop as select pg_temp.hex(32) as t;
select is(tests.error(format('select ops.mirror_spans(%L, %L::jsonb)', 'arena-api', (
    select jsonb_agg(pg_temp.span((select t from tm08trace), pg_temp.hex(16))) from generate_series(1, 501)))),
  'AR007: spans must be an array of at most 500',
  'TM-08 a batch of 501 spans is refused (AR007)');

-- ---------------------------------------------------------------------------- TM-09
create temp table tm09old on commit drop as select pg_temp.hex(32) as t, pg_temp.hex(16) as s;
create temp table tm09hid on commit drop as select pg_temp.hex(32) as t, pg_temp.hex(16) as s;
create temp table tm09pending on commit drop as select pg_temp.hex(32) as t, pg_temp.hex(16) as s;
select ops.mirror_spans('arena-api', jsonb_build_array(pg_temp.span((select t from tm09old), (select s from tm09old))));
select ops.mirror_spans('arena-api', jsonb_build_array(pg_temp.span((select t from tm09hid), (select s from tm09hid),
  jsonb_build_object('split', 'hidden'))));
select ops.mirror_spans('arena-api', jsonb_build_array(pg_temp.span((select t from tm09pending), (select s from tm09pending))));
select ops.set_export_state(jsonb_build_array(jsonb_build_object('trace_id', (select t from tm09old), 'span_id', (select s from tm09old))), 'exported');
select ops.set_export_state(jsonb_build_array(jsonb_build_object('trace_id', (select t from tm09old), 'span_id', (select s from tm09old))), 'verified');
-- the hidden span can never pass through v_exportable_spans (its tournament_id is null, held forever), so
-- disable the guard to force it to verified for this fixture, matching an already-verified hidden span found
-- in the wild (it is still never pruned: split = 'hidden').
do $$
begin
  alter table ops.trace_mirror disable trigger trace_mirror_guard;
  update ops.trace_mirror set export_state = 'verified', verified_at = now() - interval '10 days',
         created_at = now() - interval '10 days'
   where trace_id = (select t from pg_temp.tm09hid);
  update ops.trace_mirror set verified_at = now() - interval '10 days', created_at = now() - interval '10 days'
   where trace_id = (select t from pg_temp.tm09old);
  alter table ops.trace_mirror enable trigger trace_mirror_guard;
end $$;
create temp table tm09 on commit drop as select
  tests.error('select ops.prune_trace_mirror(6)') as six,
  ops.prune_trace_mirror(7) as pruned;
select is(array[(select six from tm09), (select pruned::text from tm09),
                (select count(*)::text from ops.trace_mirror where trace_id = (select t from tm09old)),
                (select count(*)::text from ops.trace_mirror where trace_id = (select t from tm09hid)),
                (select count(*)::text from ops.trace_mirror where trace_id = (select t from tm09pending)),
                tests.error(format('delete from ops.trace_mirror where trace_id = %L', (select t from tm09hid)))],
  array['AR007: keep at least 7 days', '1', '0', '1', '1', 'AR010: only verified non-hidden spans are pruned'],
  'TM-09 prune_trace_mirror(6) is refused (AR007); prune_trace_mirror(7) drops the old verified non-hidden '
  || 'span but leaves the hidden and the unverified span; an owner delete of the remaining hidden span is '
  || 'refused (AR010)');

-- ---------------------------------------------------------------------------- TM-10
create temp table tm10 on commit drop as select
  (ops.record_trace_summary('d0' || pg_temp.hex(30), 'tm10-a', null, 10, 5, 0) is null) as ok1,
  (ops.record_trace_summary('d0' || pg_temp.hex(30), 'tm10-b', null, 10, 10, 1) is null) as ok2,
  (ops.record_trace_summary('d0' || pg_temp.hex(30), 'tm10-c', null, 0, 0, 0) is null) as ok3,
  (ops.record_trace_summary('d0' || pg_temp.hex(30), 'tm10-d', null, 10, 10, 0) is null) as ok4;
select is(array[
    (select telemetry_incomplete::text from ops.trace_summaries where scope = 'tm10-a'),
    (select telemetry_incomplete::text from ops.trace_summaries where scope = 'tm10-b'),
    (select telemetry_incomplete::text from ops.trace_summaries where scope = 'tm10-c'),
    (select telemetry_incomplete::text from ops.trace_summaries where scope = 'tm10-d')],
  array['true', 'true', 'true', 'false'],
  'TM-10 telemetry_incomplete is true when mirrored < expected, or failures > 0, or expected = 0; false '
  || 'when mirrored = expected, failures = 0 and expected > 0');

select * from finish();
rollback;
