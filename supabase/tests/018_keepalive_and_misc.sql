-- 018_keepalive_and_misc.sql (sql/TESTS.md section 18; WP-04b). KA-02 needs its own SERIALIZABLE
-- transaction (SET TRANSACTION ISOLATION LEVEL must precede any query in the current transaction, and this
-- file's own harness setup already ran several), so it alone runs over one dblink connection; every other
-- row here is a single local-session sequence.
begin;
\ir harness/fixtures.psql
select plan(6);
select tests.users();

-- a draft tournament on a fresh dev family with one planned interactive trial, candidates included.
create or replace function pg_temp.ka_draft(p_code text) returns uuid
language plpgsql as $$
declare v_t uuid;
begin
  perform tests.family(p_code, 'dev');
  v_t := arena.create_tournament('ka-' || lower(p_code) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
                                  'dev', 42, 'global');
  perform arena.add_planned_trials(v_t, jsonb_build_array(jsonb_build_object('position', 1, 'track', 'interactive',
    'block_no', 1, 'variant_id', tests.variant(p_code, 'truthful'), 'assistant_candidate_id', tests.candidate('assistant', 'A1'),
    'subject_candidate_id', tests.candidate('subject', 'S1'))));
  return v_t;
end $$;

-- ---------------------------------------------------------------------------- KA-01
insert into ops.keepalive_pings (source, at) values ('ka01-old', now() - interval '20 days');
select ops.keepalive('ka01-test');
select is(array[
    (select count(*)::text from ops.keepalive_pings where source = 'ka01-old'),
    (select count(*)::text from ops.keepalive_pings where source = 'ka01-test' and at >= now() - interval '1 minute')],
  array['0', '1'],
  'KA-01 ops.keepalive(''scheduler'') inserts one ping and prunes pings older than 14 days');

-- ---------------------------------------------------------------------------- KA-02
-- a separate dblink connection, its own SERIALIZABLE transaction: require_read_committed() is the first
-- statement of every write function below, so each raises AR001 before touching any row (no fixture needed;
-- the arguments are otherwise-plausible garbage). schema tests lives only in THIS session's own uncommitted
-- transaction (fixtures.psql), invisible to a fresh dblink connection, so the remote side gets its own
-- throwaway copy of tests.error (public.ka02_error), defined before the SERIALIZABLE transaction opens
-- (autocommitting DDL) and dropped after.
select dblink_connect('ka', current_setting('arena_test.dblink_dsn'));
select dblink_exec('ka', $ddl$
  create or replace function public.ka02_error(p_sql text) returns text
  language plpgsql as $f$
  declare v text;
  begin
    begin
      execute p_sql;
      raise exception using errcode = 'TS000', message = 'ka02: undo a statement that succeeded';
    exception
      when sqlstate 'TS000' then v := '00000';
      when others then v := sqlstate || ': ' || sqlerrm;
    end;
    return v;
  end $f$
$ddl$);
select dblink_exec('ka', 'begin isolation level serializable');
create temp table ka02 on commit drop as select
  (select r from dblink('ka', format('select public.ka02_error(%L)',
     format('select arena.submit_question(%L, 0, %L, %L, null)', gen_random_uuid(), 'Q', 'ka02-trial-01'))) as t(r text)) as trial_write,
  (select r from dblink('ka', format('select public.ka02_error(%L)',
     format('select ledger.adjudicate_validity(%L, %L, %L, null, %L, %L)', gen_random_uuid(), 'valid', 'x', 'reviewer',
       'ka02-adj-01'))) as t(r text)) as ledger_write,
  (select r from dblink('ka', format('select public.ka02_error(%L)',
     format('select training.start_session(%L, %L, %L, %L, false, %L)', gen_random_uuid(), 'practice', gen_random_uuid(),
       gen_random_uuid(), 'ka02-sess-01'))) as t(r text)) as session_write,
  (select r from dblink('ka', format('select public.ka02_error(%L)',
     format('select ops.reserve_model_call(%L, %L, %L, %L, %L, null, null, 100)', 'ka02-budget-01', 'global',
       'gemini-3.5-flash-lite', 'referee', 'referee_assistant'))) as t(r text)) as budget_write;
select dblink_exec('ka', 'rollback');
select dblink_exec('ka', 'drop function if exists public.ka02_error(text)');
select dblink_disconnect('ka');
select is(array[(select trial_write from ka02), (select ledger_write from ka02), (select session_write from ka02),
                (select budget_write from ka02)],
  array['AR001: arena writes require READ COMMITTED, not serializable',
        'AR001: arena writes require READ COMMITTED, not serializable',
        'AR001: arena writes require READ COMMITTED, not serializable',
        'AR001: arena writes require READ COMMITTED, not serializable'],
  'KA-02 S4 sections 6-8: a trial, a ledger, a training-session and a budget write function each refuse a '
  || 'SERIALIZABLE transaction (AR001)');

-- ---------------------------------------------------------------------------- KA-03
create temp table ka03 on commit drop as select pg_temp.ka_draft('KA03DEV') as tour;
select arena.freeze_tournament((select tour from ka03));
create temp table ka03trial on commit drop as select tests.trial((select tour from ka03), 1) as trial;
select is(array[
    tests.error(format('delete from arena.tournaments where id = %L', (select tour from ka03))),
    tests.error(format('delete from arena.trials where id = %L', (select trial from ka03trial))),
    tests.error($$ delete from ops.budget_buckets where name = 'global' $$)],
  array['AR010: arena.tournaments is append-only (DELETE refused)',
        'AR010: arena.trials is append-only (DELETE refused)',
        'AR010: ops.budget_buckets is append-only (DELETE refused)'],
  'KA-03 delete from arena.tournaments, arena.trials and ops.budget_buckets is each refused (AR010)');

-- ---------------------------------------------------------------------------- KA-04
select tests.family('KA04HID', 'hidden');
create temp table ka04 on commit drop as select arena.create_tournament(
  'ka04-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), 'hidden', 42, 'global') as tour;
select arena.add_planned_trials((select tour from ka04), jsonb_build_array(jsonb_build_object('position', 1,
  'track', 'interactive', 'block_no', 1, 'variant_id', tests.variant('KA04HID', 'truthful'),
  'assistant_candidate_id', tests.candidate('assistant', 'A1'), 'subject_candidate_id', tests.candidate('subject', 'S1'))));
select is(tests.error(format('select arena.freeze_tournament(%L)', (select tour from ka04))),
  'AR021: the hidden split must be sealed and verify before freeze',
  'KA-04 freezing a hidden tournament before the split is sealed is refused (AR021)');

-- ---------------------------------------------------------------------------- KA-05
create temp table ka05 on commit drop as select pg_temp.ka_draft('KA05DEV') as tour;
select arena.freeze_tournament((select tour from ka05));
select is(tests.error(format('select arena.add_planned_trials(%L, %L)', (select tour from ka05),
    jsonb_build_array(jsonb_build_object('position', 2, 'track', 'interactive', 'block_no', 2,
      'variant_id', tests.variant('KA05DEV', 'deceptive'), 'assistant_candidate_id', tests.candidate('assistant', 'A1'),
      'subject_candidate_id', tests.candidate('subject', 'S1')))::text)),
  'AR001: planned trials are added to a draft tournament only',
  'KA-05 add_planned_trials on a frozen tournament is refused (AR001)');

-- ---------------------------------------------------------------------------- KA-06
select tests.family('KA06DEVA', 'dev');
select tests.family('KA06DEVB', 'dev');
create temp table ka06 on commit drop as select arena.create_tournament(
  'ka06-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), 'dev', 42, 'global') as tour;
select is(tests.error(format('select arena.add_planned_trials(%L, %L)', (select tour from ka06), jsonb_build_array(
    jsonb_build_object('position', 1, 'track', 'replay_corpus', 'variant_id', tests.variant('KA06DEVA', 'truthful'),
      'subject_candidate_id', tests.candidate('subject', 'S1')),
    jsonb_build_object('position', 2, 'track', 'replay', 'source_position', 1,
      'variant_id', tests.variant('KA06DEVB', 'truthful'), 'assistant_candidate_id', tests.candidate('assistant', 'A1')))::text)),
  'AR007: replay rows must reference a corpus row of the same variant',
  'KA-06 a replay row referencing a corpus row of another variant is refused (AR007)');

select * from finish();
rollback;
