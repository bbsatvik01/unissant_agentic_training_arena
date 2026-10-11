-- 023_candidate_hash_lock.sql (S2 3.2; WP-10; migration 1100; renumbered from 018_candidate_hash_lock.sql in WP-04
-- to free the TESTS.md section-18 name 018_keepalive_and_misc.sql for its own file). Two real sessions through
-- dblink. This file does not
-- load harness/fixtures.psql: creating its SQL functions takes share locks on the arena tables for the rest of the
-- test transaction, which would block session A's ACCESS EXCLUSIVE locks.
begin;
select plan(1);

-- CH-08: the migration guard's locks serialize it with a freeze. Session A runs the guard and stays open; session
-- B's freeze must wait on A's lock, and runs only once A ends (it then finds no such draft tournament: AR001).
create temp table ch08 (step integer, val text) on commit drop;
select dblink_connect('ch08a', current_setting('arena_test.dblink_dsn'));
select dblink_connect('ch08b', current_setting('arena_test.dblink_dsn'));
select dblink_exec('ch08a', 'begin');
select dblink_exec('ch08a', $q$set local lock_timeout = '10s'$q$);
select dblink_exec('ch08a', 'do $d$ begin perform arena.candidate_hash_migration_guard(); end $d$');
create temp table ch08_pid on commit drop as
  select pid from dblink('ch08b', 'select pg_backend_pid()') as t(pid integer);
select dblink_exec('ch08b', $q$set lock_timeout = '20s'$q$);
select dblink_send_query('ch08b', 'select arena.freeze_tournament(gen_random_uuid())');
do $$
begin
  for i in 1..200 loop
    if exists (select 1 from pg_stat_activity a join ch08_pid b on b.pid = a.pid where a.wait_event_type = 'Lock') then
      insert into ch08 values (1, 'blocked');
      return;
    end if;
    perform pg_sleep(0.05);
  end loop;
  insert into ch08 values (1, 'not blocked');
end $$;
select dblink_exec('ch08a', 'rollback');
insert into ch08 select 2, coalesce((select r from dblink_get_result('ch08b', false) as t(r text)),
                                    dblink_error_message('ch08b'));
select count(*) from dblink_get_result('ch08b', false) as t(r text);
select dblink_disconnect('ch08a');
select dblink_disconnect('ch08b');
select is(array[(select val from ch08 where step = 1), split_part((select val from ch08 where step = 2), E'\n', 1)],
          array['blocked', 'ERROR:  only a draft tournament can be frozen'],
  'CH-08 a freeze waits on the migration guard''s locks and runs only after its transaction ends');

select * from finish();
rollback;
