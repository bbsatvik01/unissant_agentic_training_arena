-- 010_concurrency.sql (sql/TESTS.md section 10; dblink; WP-04b).
-- arena._lock_trial, the tournament status lock and ops._admit's bucket lock are all held until the
-- CALLING transaction ends, not the statement, and a dblink connection is a separate session that sees only
-- COMMITTED rows. So every scenario that touches arena.trials, arena.tournaments or ops.budget_buckets runs
-- its whole setup over dblink (never locally): a trial or reservation created by a plain local call would be
-- invisible to the sessions racing on it, and a lock this session held on the same row would deadlock
-- against them. Local calls are used only for pure, side-effect-free lookups (tests.bundle, tests.manifest,
-- tests.k, tests.variant) and, once a dblink call has committed, for plain reads of the now-visible state.
begin;
\ir harness/fixtures.psql
select plan(9);

-- No local tests.users() here: it would insert auth.users rows in this (uncommitted) transaction, and
-- CO-06's dblink insert of the same id would then wait forever on this transaction's own xid to finish
-- (not a lock pattern the deadlock detector can see, since this session's own wait is inside dblink, not
-- a native lock) -- so that row is inserted only over dblink, in CO-06 itself.
select dblink_connect('coa', current_setting('arena_test.dblink_dsn'));
select dblink_connect('cob', current_setting('arena_test.dblink_dsn'));
select dblink_connect('coc', current_setting('arena_test.dblink_dsn'));
select dblink_connect('cod', current_setting('arena_test.dblink_dsn'));

-- pg_temp.dl(conn, sql): run one autocommitting statement whose query text already casts its result to
-- text, and return that text. Used only when the caller needs the value back.
create or replace function pg_temp.dl(p_conn text, p_sql text) returns text
language sql as $$ select r from dblink(p_conn, p_sql) as t(r text) $$;
-- pg_temp.dv(conn, sql): run one autocommitting "select <call>(...)" statement and discard its result
-- (dblink_exec refuses any statement that returns rows, including a bare select of a void function).
create or replace function pg_temp.dv(p_conn text, p_sql text) returns void
language plpgsql as $$
declare x text;
begin
  select r into x from dblink(p_conn, p_sql) as t(r text);
end $$;
create or replace function pg_temp.dl_pid(p_conn text) returns integer
language sql as $$ select pid from dblink(p_conn, 'select pg_backend_pid()') as t(pid integer) $$;
create or replace function pg_temp.wait_blocked(p_pid integer) returns text
language plpgsql as $$
declare i integer;
begin
  for i in 1..200 loop
    if exists (select 1 from pg_stat_activity where pid = p_pid and wait_event_type = 'Lock') then return 'blocked'; end if;
    perform pg_sleep(0.05);
  end loop;
  return 'not blocked';
end $$;
-- the work_item_id of an open_work_item call made over dblink (committed)
create or replace function pg_temp.wid(p_conn text, p_trial uuid, p_kind text, p_key text) returns uuid
language sql as $$
  select ((pg_temp.dl(p_conn, format('select (arena.open_work_item(%L, %L, %L))::text', p_trial, p_kind, p_key)))::jsonb
          ->> 'work_item_id')::uuid
$$;

-- pg_temp.co_trial(conn, code): ingest a one-variant dev family, register the shared A1/S1 candidates, and
-- build a one-position interactive tournament, all over the given dblink connection (each step its own
-- autocommitting statement, so a later connection sees it immediately). Returns the started trial id.
create or replace function pg_temp.co_trial(p_conn text, p_code text) returns uuid
language plpgsql as $$
declare
  v_bundle text := tests.bundle(p_code, 'dev')::text;
  v_man_a  text := tests.manifest('assistant', 'A1', 'v1', 'gemini-3.5-flash-lite')::text;
  v_man_s  text := tests.manifest('subject', 'S1', 'v1', 'gemini-3.1-flash-lite')::text;
  v_tour   uuid;
  v_vt     uuid;
  v_a      uuid;
  v_s      uuid;
  v_trial  uuid;
begin
  perform pg_temp.dv(p_conn, format('select sealed.ingest_case_family(%L::jsonb)', v_bundle));
  v_a := (pg_temp.dl(p_conn, format('select (arena.register_candidate(%L,%L,%L,%L::jsonb))::text',
            'assistant', 'A1', 'v1', v_man_a)))::uuid;
  v_s := (pg_temp.dl(p_conn, format('select (arena.register_candidate(%L,%L,%L,%L::jsonb))::text',
            'subject', 'S1', 'v1', v_man_s)))::uuid;
  v_vt := tests.variant(p_code, 'truthful');
  v_tour := (pg_temp.dl(p_conn, format('select (arena.create_tournament(%L,%L,42,%L))::text',
              'co-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), 'dev', 'global')))::uuid;
  perform pg_temp.dv(p_conn, format('select arena.add_planned_trials(%L, %L::jsonb)', v_tour,
    jsonb_build_array(jsonb_build_object('position', 1, 'track', 'interactive', 'block_no', 1,
      'variant_id', v_vt, 'assistant_candidate_id', v_a, 'subject_candidate_id', v_s))::text));
  perform pg_temp.dv(p_conn, format('select arena.freeze_tournament(%L)', v_tour));
  perform pg_temp.dv(p_conn, format('select arena.open_tournament(%L)', v_tour));
  perform pg_temp.dv(p_conn, format('select arena.start_trial((select t.id from arena.trials t '
    || 'join arena.planned_trials p on p.id = t.planned_trial_id where p.tournament_id = %L and p.position = 1))', v_tour));
  select t.id into v_trial from arena.trials t join arena.planned_trials p on p.id = t.planned_trial_id
   where p.tournament_id = v_tour and p.position = 1;
  return v_trial;
end $$;

-- one question (turn 1, expected version 0) asked and answered, over dblink, committed.
create or replace function pg_temp.co_answered(p_conn text, p_trial uuid) returns void
language plpgsql as $$
declare v_wi uuid;
begin
  perform pg_temp.dv(p_conn, format('select arena.submit_question(%L, 0, %L, %L, %L)', p_trial, 'Question 1',
    tests.k(p_trial, 1, 'question', 'q1'), 'harness_fixed'));
  v_wi := pg_temp.wid(p_conn, p_trial, 'subject_answer', tests.k(p_trial, 1, 'subject_answer', 'a1'));
  perform pg_temp.dv(p_conn, format('select arena.record_subject_turn(%L, %L, %L, null, %L)', p_trial, v_wi,
    'Answer 1', '{"passed": true}'));
end $$;

-- ============================================================================ CO-01, CO-02
create temp table cot1 on commit drop as select pg_temp.co_trial('coa', 'CO1DEV') as trial;
select pg_temp.co_answered('coa', (select trial from cot1));
create temp table co01x on commit drop as
  select pg_temp.wid('coa', (select trial from cot1), 'finalize', tests.k((select trial from cot1), 1, 'finalize', 'x')) as wi;
create temp table co01y on commit drop as
  select pg_temp.wid('coa', (select trial from cot1), 'finalize', tests.k((select trial from cot1), 1, 'finalize', 'y')) as wi;
create temp table co01 (step integer, val text) on commit drop;
select dblink_exec('coa', 'begin');
insert into co01 select 1, dl from (
  select pg_temp.dl('coa', format('select (arena.finalize_trial(%L, %L, %L))::text', (select trial from cot1), (select wi from co01x),
    jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
      'rationale', 'x', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb,
      'corroboration_needed', '[]'::jsonb)::text)) as dl) s;
create temp table co01pid on commit drop as select pg_temp.dl_pid('cob') as pid;
select dblink_send_query('cob', format('select (arena.finalize_trial(%L, %L, %L))::text', (select trial from cot1), (select wi from co01y),
    jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
      'rationale', 'y', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb,
      'corroboration_needed', '[]'::jsonb)::text));
insert into co01 select 2, pg_temp.wait_blocked((select pid from co01pid));
select dblink_exec('coa', 'commit');
insert into co01 select 3, coalesce((select r from dblink_get_result('cob', false) as t(r text)), dblink_error_message('cob'));
select count(*) from dblink_get_result('cob', false) as t(r text);
select is(array[(select val from co01 where step = 2), (select (val ~ 'trial is') from co01 where step = 3)::text,
                (select count(*)::text from ledger.terminal_records where trial_id = (select trial from cot1)),
                (select count(*)::text from ledger.finding_commitments where trial_id = (select trial from cot1))],
          array['blocked', 'true', '1', '1'],
  'CO-01 concurrent finalize, different items X (A) and Y (B): B blocks until A commits, then AR001 '
  || '(the trial is no longer running); one terminal record, one commitment');

create temp table cot2 on commit drop as select pg_temp.co_trial('coa', 'CO2DEV') as trial;
select pg_temp.co_answered('coa', (select trial from cot2));
create temp table co02key on commit drop as select tests.k((select trial from cot2), 1, 'finalize', 'same') as key;
create temp table co02 (step integer, val text) on commit drop;
select dblink_exec('coa', 'begin');
create temp table co02x on commit drop as select pg_temp.wid('coa', (select trial from cot2), 'finalize', (select key from co02key)) as wi;
insert into co02 select 1, dl from (
  select pg_temp.dl('coa', format('select (arena.finalize_trial(%L, %L, %L))::text', (select trial from cot2), (select wi from co02x),
    jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
      'rationale', 'same', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb,
      'corroboration_needed', '[]'::jsonb)::text)) as dl) s;
create temp table co02pid on commit drop as select pg_temp.dl_pid('cob') as pid;
select dblink_send_query('cob', format(
  'select (arena.finalize_trial(%L, (arena.open_work_item(%L, %L, %L) ->> %L)::uuid, %L))::text',
  (select trial from cot2), (select trial from cot2), 'finalize', (select key from co02key), 'work_item_id',
  jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
    'rationale', 'same', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb,
    'corroboration_needed', '[]'::jsonb)::text));
insert into co02 select 2, pg_temp.wait_blocked((select pid from co02pid));
select dblink_exec('coa', 'commit');
insert into co02 select 3, coalesce((select r from dblink_get_result('cob', false) as t(r text)), dblink_error_message('cob'));
select count(*) from dblink_get_result('cob', false) as t(r text);
select is(array[(select val from co02 where step = 2),
                ((select val from co02 where step = 1) = (select val from co02 where step = 3))::text,
                (select count(*)::text from ledger.finding_commitments where trial_id = (select trial from cot2))],
          array['blocked', 'true', '1'],
  'CO-02 concurrent finalize with the same item X in both: B blocks on A''s hold of X, then replays A''s '
  || 'own cached result (X is already done); one commitment row');

-- ============================================================================ CO-03, CO-04
create temp table cot3 on commit drop as select pg_temp.co_trial('coa', 'CO3DEV') as trial;
create temp table co03 (step integer, val text) on commit drop;
select dblink_exec('coa', 'begin');
insert into co03 select 1, dl from (
  select pg_temp.dl('coa', format('select (arena.submit_question(%L, 0, %L, %L, %L))::text', (select trial from cot3),
    'From A', tests.k((select trial from cot3), 1, 'question', 'from-a'), 'harness_fixed')) as dl) s;
create temp table co03pid on commit drop as select pg_temp.dl_pid('cob') as pid;
select dblink_send_query('cob', format('select (arena.submit_question(%L, 0, %L, %L, %L))::text', (select trial from cot3),
    'From B', tests.k((select trial from cot3), 1, 'question', 'from-b'), 'harness_fixed'));
insert into co03 select 2, pg_temp.wait_blocked((select pid from co03pid));
select dblink_exec('coa', 'commit');
insert into co03 select 3, coalesce((select r from dblink_get_result('cob', false) as t(r text)), dblink_error_message('cob'));
select count(*) from dblink_get_result('cob', false) as t(r text);
select is(array[(select val from co03 where step = 2), (select (val ~ 'stale transcript version') from co03 where step = 3)::text,
                (select count(*)::text from arena.turns where trial_id = (select trial from cot3))],
          array['blocked', 'true', '1'],
  'CO-03 concurrent submit_question, different keys, same expected version 0: A wins, B is refused (AR002) '
  || 'after waiting on the trial lock');

create temp table co04wi on commit drop as
  select pg_temp.wid('coa', (select trial from cot3), 'subject_answer', tests.k((select trial from cot3), 1, 'subject_answer', 'ans')) as wi;
create temp table co04 (step integer, val text) on commit drop;
select dblink_exec('coa', 'begin');
insert into co04 select 1, dl from (
  select pg_temp.dl('coa', format('select (arena.record_subject_turn(%L, %L, %L, null, %L))::text', (select trial from cot3),
    (select wi from co04wi), 'Answer from A', '{"passed": true}')) as dl) s;
create temp table co04pid on commit drop as select pg_temp.dl_pid('cob') as pid;
select dblink_send_query('cob', format('select (arena.record_subject_turn(%L, %L, %L, null, %L))::text', (select trial from cot3),
    (select wi from co04wi), 'Answer from B', '{"passed": true}'));
insert into co04 select 2, pg_temp.wait_blocked((select pid from co04pid));
select dblink_exec('coa', 'commit');
insert into co04 select 3, coalesce((select r from dblink_get_result('cob', false) as t(r text)), dblink_error_message('cob'));
select count(*) from dblink_get_result('cob', false) as t(r text);
select is(array[(select val from co04 where step = 2), (select (val ~ 'reused with different input') from co04 where step = 3)::text,
                (select answer from arena.turns where trial_id = (select trial from cot3) and turn_no = 1)],
          array['blocked', 'true', 'Answer from A'],
  'CO-04 concurrent record_subject_turn, same item, different utterances: A''s answer wins (recorded), B is '
  || 'refused (AR003) after waiting on the trial lock');

-- ============================================================================ CO-05
-- "lowered by the owner to its liability + 0.08" (TESTS.md): room for one referee worst case (0.054400 on
-- 3.5-flash-lite, 12000 bytes), not two (0.1088). Everything here runs over dblink, committed, because the
-- race itself is on the bucket row; cleanup restores the ceiling and removes the one reservation this test
-- adds, so later files still see the migrated ($0) seed (matching 014_budget.sql's BU-40 convention).
create temp table co05o on commit drop as select ceiling_usd from ops.budget_buckets where name = 'global';
select dblink_exec('coa', format('update ops.budget_buckets set ceiling_usd = (select ops.subtree_liability(%L)) + 0.08 '
  || 'where name = %L', 'global', 'global'));
create temp table co05 (step integer, val text) on commit drop;
select dblink_exec('coa', 'begin');
insert into co05 select 1, dl from (
  select pg_temp.dl('coa', format('select (ops.reserve_model_call(%L,%L,%L,%L,%L,null,null,12000))::text',
    'co05-r1-0000', 'global', 'gemini-3.5-flash-lite', 'referee', 'referee_assistant')) as dl) s;
create temp table co05pid on commit drop as select pg_temp.dl_pid('cob') as pid;
select dblink_send_query('cob', format('select (ops.reserve_model_call(%L,%L,%L,%L,%L,null,null,12000))::text',
    'co05-r2-0000', 'global', 'gemini-3.5-flash-lite', 'referee', 'referee_assistant'));
insert into co05 select 2, pg_temp.wait_blocked((select pid from co05pid));
select dblink_exec('coa', 'commit');
insert into co05 select 3, coalesce((select r from dblink_get_result('cob', false) as t(r text)), dblink_error_message('cob'));
select count(*) from dblink_get_result('cob', false) as t(r text);
select is(array[(select (val ~ '"outcome" *: *"reserved"') from co05 where step = 1)::text, (select val from co05 where step = 2),
                (select (val ~ '"outcome" *: *"refused"' and val ~ '"reason" *: *"cap"') from co05 where step = 3)::text,
                ((select liability_usd <= ceiling_usd from ops.budget_status() where bucket = 'global'))::text],
          array['true', 'blocked', 'true', 'true'],
  'CO-05 a reservation race on global lowered to liability + 0.08 (room for one referee worst case, not two): '
  || 'the first reserves, the second waits on the bucket lock and is then refused (cap); liability stays within '
  || 'the ceiling');
select dblink_exec('coa', 'alter table ops.budget_reservations disable trigger budget_reservations_settle_once');
select dblink_exec('coa', $q$delete from ops.budget_reservations where idempotency_key like 'co05-%'$q$);
select dblink_exec('coa', 'alter table ops.budget_reservations enable trigger budget_reservations_settle_once');
select dblink_exec('coa', format('update ops.budget_buckets set ceiling_usd = %L where name = %L',
  (select ceiling_usd from co05o), 'global'));

-- ============================================================================ CO-06
-- 20 reservations (4 connections x 5 rounds, so 4 genuinely concurrent at a time) for one actor against the
-- per-user cap, temporarily lowered to admit exactly 2 of the 0.054400 calls (floor(0.12 / 0.0544) = 2).
select dblink_exec('coa', format('insert into auth.users (id, email) values (%L, %L) on conflict (id) do nothing',
  tests.uid('A'), 'a@example.test'));
select dblink_exec('coa', 'update ops.budget_buckets set ceiling_usd = ceiling_usd + 10 where name = ''global''');
select dblink_exec('coa', 'update ops.config set per_user_daily_usd = 0.12 where id');
create temp table co06 (round integer, conn text, result text) on commit drop;
create or replace function pg_temp.co06_run(p_actor uuid) returns void
language plpgsql as $$
declare
  conns text[] := array['coa', 'cob', 'coc', 'cod'];
  i integer;
  c text;
  r text;
begin
  for i in 1..5 loop
    foreach c in array conns loop
      perform dblink_send_query(c, format('select (ops.reserve_model_call(%L,%L,%L,%L,%L,null,%L,12000))::text',
        'co06-' || c || '-' || i, 'global', 'gemini-3.5-flash-lite', 'referee', 'referee_assistant', p_actor));
    end loop;
    foreach c in array conns loop
      select t.r into r from dblink_get_result(c, false) as t(r text);
      insert into pg_temp.co06 values (i, c, r);
      perform x from dblink_get_result(c, false) as t(x text);
    end loop;
  end loop;
end $$;
select pg_temp.co06_run(tests.uid('A'));
-- bool_and/coalesce(sum(...), 0) <= 0.12 would hold even if every one of the 20 calls came back as an
-- unrecognized/error result (nothing matches "reserved", sum defaults to 0): check every row is a
-- well-formed reserved-or-per_user_cap-refused result, and that exactly floor(0.12 / 0.0544) = 2 are
-- admitted, so a broken cap (or a broken connection) actually fails this. bool_and skips NULL inputs
-- rather than failing on them, so a NULL result (a suppressed error swallowed by co06_run) would not
-- trip the well-formedness check above on its own: require "result is not null" explicitly, as its own
-- conjunct, so every one of the 20 rows must be non-null AND well-formed, not merely "no row is false".
select is(array[
    (select count(*) from co06)::text,
    (select bool_and(result is not null and (result ~ '"outcome" *: *"reserved"'
                      or (result ~ '"outcome" *: *"refused"' and result ~ '"reason" *: *"per_user_cap"'))) from co06)::text,
    (select count(*) from co06 where result ~ '"outcome" *: *"reserved"')::text,
    (select coalesce(sum((result::jsonb ->> 'reserved_usd')::numeric), 0) <= 0.12 from co06 where result ~ '"outcome" *: *"reserved"')::text],
  array['20', 'true', '2', 'true'],
  'CO-06 20 reservations over 4 concurrent dblink connections (5 rounds) for one actor against a per-user '
  || 'cap of 0.12: every call reserves or is refused per_user_cap (no suppressed error), exactly 2 of the '
  || '0.054400 calls are admitted, and the sum reserved for that actor never exceeds the cap');
select dblink_exec('coa', 'alter table ops.budget_reservations disable trigger budget_reservations_settle_once');
select dblink_exec('coa', $q$delete from ops.budget_reservations where idempotency_key like 'co06-%'$q$);
select dblink_exec('coa', 'alter table ops.budget_reservations enable trigger budget_reservations_settle_once');
select dblink_exec('coa', 'update ops.config set per_user_daily_usd = 5.00 where id');
select dblink_exec('coa', 'update ops.budget_buckets set ceiling_usd = ceiling_usd - 10 where name = ''global''');

-- ============================================================================ CO-07
-- max_open_voice_sessions is seeded at 2: one room filled first (committed), then two sessions race for the
-- one remaining room.
select dblink_exec('coa', 'update ops.budget_buckets set ceiling_usd = ceiling_usd + 15 where name = ''global''');
select pg_temp.dv('coa', format('select (ops.reserve_voice(%L,%L,%L,%L,null,null))::text',
  'co07-fill-000', 'global', 'voice_session', 'training'));
create temp table co07 (conn text, result text) on commit drop;
select dblink_send_query('coa', format('select (ops.reserve_voice(%L,%L,%L,%L,null,null))::text',
  'co07-a-00000', 'global', 'voice_session', 'training'));
select dblink_send_query('cob', format('select (ops.reserve_voice(%L,%L,%L,%L,null,null))::text',
  'co07-b-00000', 'global', 'voice_session', 'training'));
insert into co07 select 'coa', r from dblink_get_result('coa', false) as t(r text);
select x from dblink_get_result('coa', false) as t(x text);
insert into co07 select 'cob', r from dblink_get_result('cob', false) as t(r text);
select x from dblink_get_result('cob', false) as t(x text);
select is(array[
    (select count(*)::text from co07 where result ~ '"outcome" *: *"reserved"'),
    (select count(*)::text from co07
       where result ~ '"outcome" *: *"refused"' and result ~ '"reason" *: *"voice_concurrency"'),
    ((select liability_usd <= ceiling_usd from ops.budget_status() where bucket = 'global'))::text],
  array['1', '1', 'true'],
  'CO-07 two reserve_voice calls racing for the one remaining room (max_open_voice_sessions = 2, one room '
  || 'already filled): exactly one is admitted, the other refused (voice_concurrency); liability stays '
  || 'within the ceiling');
select dblink_exec('coa', 'alter table ops.budget_reservations disable trigger budget_reservations_settle_once');
select dblink_exec('coa', $q$delete from ops.budget_reservations where idempotency_key like 'co07-%'$q$);
select dblink_exec('coa', 'alter table ops.budget_reservations enable trigger budget_reservations_settle_once');
select dblink_exec('coa', 'update ops.budget_buckets set ceiling_usd = ceiling_usd - 15 where name = ''global''');

-- ============================================================================ CO-08
-- A whole tournament pipeline to 'scoring', built over dblink so both racing sessions see it; A holds the
-- tournament's FOR SHARE lock inside adjudicate_validity, B's reveal (FOR UPDATE) waits, then reads A's
-- committed adjudication.
create temp table cot8 on commit drop as select pg_temp.co_trial('coa', 'CO8DEV') as trial;
select pg_temp.co_answered('coa', (select trial from cot8));
create temp table co08fin on commit drop as
  select pg_temp.wid('coa', (select trial from cot8), 'finalize', tests.k((select trial from cot8), 1, 'finalize', 'co8')) as wi;
select pg_temp.dv('coa', format('select arena.finalize_trial(%L, %L, %L)', (select trial from cot8), (select wi from co08fin),
  jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
    'rationale', 'co08', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb,
    'corroboration_needed', '[]'::jsonb)::text));
create temp table cot8tour on commit drop as
  select tournament_id as tour from arena.trials where id = (select trial from cot8);
select pg_temp.dv('coa', format('select arena.close_tournament_run(%L)', (select tour from cot8tour)));
select pg_temp.dv('coa', format('select arena.begin_scoring(%L)', (select tour from cot8tour)));
create temp table co08 (step integer, val text) on commit drop;
select dblink_exec('coa', 'begin');
create temp table co08adj on commit drop as
  select dl from (select pg_temp.dl('coa', format('select (ledger.adjudicate_validity(%L,%L,%L,null,%L,%L))::text',
    (select trial from cot8), 'valid', 'co08 adjudication', 'co08reviewer', 'co08-adj-001')) as dl) s;
create temp table co08pid on commit drop as select pg_temp.dl_pid('cob') as pid;
select dblink_send_query('cob', format('select (ledger.reveal(%L))::text', (select tour from cot8tour)));
insert into co08 select 1, pg_temp.wait_blocked((select pid from co08pid));
select dblink_exec('coa', 'commit');
insert into co08 select 2, coalesce((select r from dblink_get_result('cob', false) as t(r text)), dblink_error_message('cob'));
select count(*) from dblink_get_result('cob', false) as t(r text);
create temp table co08manifest on commit drop as select manifest from ledger.inclusion_manifests
 where tournament_id = (select tour from cot8tour) and version = 1;
select is(array[(select val from co08 where step = 1), (select (val ~ 'manifest_sha256') from co08 where step = 2)::text,
                (select (manifest ~ (select dl from co08adj)) from co08manifest)::text],
          array['blocked', 'true', 'true'],
  'CO-08 adjudicate_validity in A holds the tournament''s share lock; reveal in B waits, then succeeds once '
  || 'A commits, and its manifest contains A''s committed adjudication id');

-- ============================================================================ CO-09
select is((select max(seq) = count(*) from ledger.events)::text, 'true',
  'CO-09 after CO-01..CO-08 the hash chain has no gap: max(seq) = count(*)');

select * from finish();
rollback;
