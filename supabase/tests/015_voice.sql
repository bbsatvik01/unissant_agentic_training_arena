-- 015_voice.sql (S4 sections 4.4 and 8.4; sql/TESTS.md section 15; D-016). WP-03 rows for the voice fixes in
-- migration 0800 (proposed for the spec): VB-21 a repeated exchange answers its original release, VB-22 tickets
-- issued before the daily voice quota was reached cannot open sessions beyond it, VB-23 one actor's session
-- openings serialize on the quota. WP-04 adds the TESTS.md section 15 rows (VB-01..VB-20) to this file.
-- Quota and cap values are the seeded ones (voice_sessions_per_user_day 2); reservations name no actor, so the
-- seeded per-user dollar cap (owner decision pending, S4-D3) does not apply.
begin;
\ir harness/fixtures.psql
select plan(3);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();
select tests.apply_plan(plan) from t_plan;
select tests.family('VDEV', 'dev');
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table vt on commit drop as
  select (tests.as_role('arena_public', format('select training.start_session(%L, %L, %L, %L, true, %L)',
            tests.variant('VDEV', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), 'vb-voice-session-1')) ->> 'trial_id')::uuid as trial;

-- A voice ticket for the trial: issued and redeemed by the investigator, checked by arena-subject (S5 7.2).
create function pg_temp.voice_ticket() returns uuid
language plpgsql as $$
declare
  v_trial uuid := (select trial from vt);
  v_token text;
  v_ticket uuid;
begin
  v_token := tests.as_role('arena_public', format('select to_jsonb(training.issue_access_ticket(%L, %L))', 'voice', v_trial))
             #>> '{}';
  v_ticket := (tests.as_role('arena_public', format('select training.redeem_access_ticket(%L, %L)', v_token, 'voice'))
               ->> 'ticket_id')::uuid;
  perform tests.as_role('arena_subject', format('select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))',
                                                v_ticket, tests.uid('A'), v_trial, 'practice'));
  return v_ticket;
end $$;
-- Reserve and open a voice session on a checked ticket; returns {voice_session, reservation}.
create function pg_temp.voice_open(p_ticket uuid) returns jsonb
language plpgsql as $$
declare
  v_res uuid;
begin
  v_res := (tests.as_role('arena_subject', format('select ops.reserve_voice(%L, %L, %L, %L, %L, null)',
              'vb-res-' || p_ticket, 'global', 'voice_session', 'voice.session', (select trial from vt))) ->> 'id')::uuid;
  return jsonb_build_object('reservation', v_res, 'voice_session',
    tests.as_role('arena_subject', format('select to_jsonb(training.open_voice_session(%L, %L))', p_ticket, v_res)) #>> '{}');
end $$;
create function pg_temp.voice_close(p_open jsonb) returns void
language plpgsql as $$
begin
  perform tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)',
                                                p_open ->> 'voice_session', '1000'));
  perform tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)',
                                                p_open ->> 'reservation', 'committed'));
end $$;
create function pg_temp.exchange(p_open jsonb, p_no integer) returns jsonb
language sql as $$
  select tests.as_role('arena_subject', format('select training.record_voice_exchange(%L, %s::smallint, %L)',
    p_open ->> 'voice_session', p_no,
    jsonb_build_array(jsonb_build_object('role', 'investigator', 'text', 'Question ' || p_no, 'partial', false),
                      jsonb_build_object('role', 'subject', 'text', 'Answer ' || p_no, 'partial', false))))
$$;

-- VB-23 (first: this transaction must not hold the actor's quota lock yet): while another transaction holds actor A's
-- voice-quota lock (an opening in progress), this opening waits for it (lock_timeout 300 ms: 55P03) instead of
-- checking the quota beside it.
create temp table vb22 (step integer, val text) on commit drop;
insert into vb22 select 0, pg_temp.voice_ticket()::text;
select dblink_connect('vb23', current_setting('arena_test.dblink_dsn'));
select dblink_exec('vb23', 'begin');
select dblink_exec('vb23', $q$set local lock_timeout = '5s'$q$);  -- never a silent hang
select * from dblink('vb23', format('select pg_advisory_xact_lock(hashtextextended(%L, 0))::text',
                                    'training.voice_quota:' || tests.uid('A'))) as t(r text);
set local lock_timeout = '300ms';
insert into vb22 select 3, tests.error(format('select pg_temp.voice_open(%L)', (select val from vb22 where step = 0)));
set local lock_timeout = 0;
select dblink_exec('vb23', 'rollback');
select dblink_disconnect('vb23');
select is((select split_part(val, ':', 1) from vb22 where step = 3), '55P03',
  'VB-23 a voice session opening waits on the actor''s quota lock held by another opening');


-- VB-21: exchange 2 releases the scheduled rec-02 (after 2 exchanges) in its commit; the same exchange again
-- (its first response lost) answers the same release, and nothing is stored twice.
create temp table vb21 (step integer, val jsonb) on commit drop;
insert into vb21 select 0, pg_temp.voice_open((select val::uuid from vb22 where step = 0));
insert into vb21 select 1, pg_temp.exchange((select val from vb21 where step = 0), 1);
insert into vb21 select 2, pg_temp.exchange((select val from vb21 where step = 0), 2);
insert into vb21 select 3, pg_temp.exchange((select val from vb21 where step = 0), 2);
select is(array[(select val ->> 'outcome' from vb21 where step = 2), (select val -> 'released' from vb21 where step = 2)::text,
                (select val ->> 'outcome' from vb21 where step = 3), (select val -> 'released' from vb21 where step = 3)::text,
                (select count(*) from arena.released_evidence where trial_id = (select trial from vt))::text,
                (select count(*) from training.voice_exchanges where trial_id = (select trial from vt))::text],
          array['recorded', '[{"kind": "record", "record_id": "rec-02"}]',
                'exists', '[{"kind": "record", "record_id": "rec-02"}]', '1', '2'],
  'VB-21 a repeated voice exchange answers the scheduled release its original commit applied, with no duplicate rows');
select pg_temp.voice_close((select val from vb21 where step = 0));

-- One voice session opened today; the quota is 2. Two tickets are issued now, while both pass the issue check.
insert into vb22 select 1, pg_temp.voice_ticket()::text;
insert into vb22 select 2, pg_temp.voice_ticket()::text;

-- VB-22: the first pre-issued ticket opens the second session of the day; the second pre-issued ticket is refused.
insert into vb22 select 4, pg_temp.voice_open((select val::uuid from vb22 where step = 1))::text;
select pg_temp.voice_close((select val::jsonb from vb22 where step = 4));
insert into vb22 select 5, tests.error(format('select pg_temp.voice_open(%L)', (select val from vb22 where step = 2)));
select is(array[(select (val::jsonb ->> 'voice_session') is not null from vb22 where step = 4)::text,
                (select val from vb22 where step = 5),
                (select count(*) from training.voice_sessions vs join training.sessions s on s.id = vs.session_id
                  where s.user_id = tests.uid('A'))::text],
          array['true', 'AR040: daily voice session quota reached', '2'],
  'VB-22 tickets issued before the daily voice quota was reached open no session beyond it');

select * from finish();
rollback;
