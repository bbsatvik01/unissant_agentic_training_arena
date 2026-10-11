-- 015_voice.sql (S4 sections 4.4 and 8.4; sql/TESTS.md section 15; D-016). WP-03 rows for the voice fixes in
-- migration 0800 (proposed for the spec): VB-21 a repeated exchange answers its original release, VB-22 tickets
-- issued before the daily voice quota was reached cannot open sessions beyond it, VB-23 one actor's session
-- openings serialize on the quota, VB-24 a 13th exchange is AR004. WP-04 adds the TESTS.md section 15 rows (VB-01..VB-20) to this file.
-- Quota and cap values are the seeded ones (voice_sessions_per_user_day 2); reservations name no actor, so the
-- per-user dollar cap ($5.00, D-017) does not apply.
begin;
\ir harness/fixtures.psql
select plan(24);  -- VB-01..VB-24

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

-- ------------------------------------------------------------------ WP-04 additions (VB-01..VB-20)
-- The seeded daily voice (2) and text (5) session quotas would block the many fresh training sessions these
-- rows need; both are raised here and restored to the seed right before the existing VB-23 block, which
-- depends on the seeded voice quota of 2. Every voice reservation and session this block opens is released,
-- settled or closed before the block ends, so it leaves training.voice_sessions and ops.budget_reservations
-- exactly as it found them in every respect the existing rows below depend on (open concurrency slots,
-- voice_sessions_total/voice_probes_total counts are the one exception: VB-04 runs last and accounts for
-- whatever this block already contributed to them).
create temp table vbseed on commit drop as
  select voice_sessions_per_user_day, text_sessions_per_user_day from ops.config;
update ops.config set voice_sessions_per_user_day = 1000, text_sessions_per_user_day = 1000 where id;

create or replace function pg_temp.v2_trial(p_actor text, p_key text) returns uuid
language plpgsql as $$
declare
  v_trial uuid;
  v_prev  text := coalesce(current_setting('arena.actor_id', true), '');
begin
  perform set_config('arena.actor_id', tests.uid(p_actor)::text, true);
  v_trial := (tests.as_role('arena_public', format('select training.start_session(%L, %L, %L, %L, true, %L)',
    tests.variant('VDEV', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
    tests.candidate('subject', 'S1'), p_key)) ->> 'trial_id')::uuid;
  perform set_config('arena.actor_id', v_prev, true);
  return v_trial;
end $$;
create or replace function pg_temp.v2_ticket(p_actor text, p_trial uuid) returns uuid
language plpgsql as $$
declare
  v_token  text;
  v_ticket uuid;
  v_prev   text := coalesce(current_setting('arena.actor_id', true), '');
begin
  perform set_config('arena.actor_id', tests.uid(p_actor)::text, true);
  v_token := tests.as_role('arena_public',
    format('select to_jsonb(training.issue_access_ticket(%L, %L))', 'voice', p_trial)) #>> '{}';
  v_ticket := (tests.as_role('arena_public', format('select training.redeem_access_ticket(%L, %L)', v_token, 'voice'))
               ->> 'ticket_id')::uuid;
  perform set_config('arena.actor_id', v_prev, true);
  perform tests.as_role('arena_subject', format('select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))',
                                                v_ticket, tests.uid(p_actor), p_trial, 'practice'));
  return v_ticket;
end $$;
create or replace function pg_temp.v2_reserve(p_trial uuid, p_key text, p_actor text default null) returns jsonb
language sql as $$
  select tests.as_role('arena_subject', format('select ops.reserve_voice(%L, %L, %L, %L, %L, %L)',
    p_key, 'global', 'voice_session', 'voice.session', p_trial,
    case when p_actor is null then null else tests.uid(p_actor) end))
$$;
create or replace function pg_temp.v2_open(p_ticket uuid, p_res uuid) returns uuid
language sql as $$
  select (tests.as_role('arena_subject', format('select to_jsonb(training.open_voice_session(%L, %L))', p_ticket, p_res))
          #>> '{}')::uuid
$$;
create or replace function pg_temp.v2_release(p_res_json jsonb) returns void
language sql as $$
  select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', p_res_json ->> 'id', 'released'))
$$;

-- ---------------------------------------------------------------------------- VB-01, VB-02
create temp table vb01a on commit drop as select pg_temp.v2_reserve(null, 'vb01-voice-001', 'B') as r;
create temp table vb01b on commit drop as select pg_temp.v2_reserve(null, 'vb01-voice-002', 'B') as r;
select is(array[(select r ->> 'reserved_usd' from vb01a), (select r ->> 'shutoff_usd' from vb01a),
                (select r ->> 'outcome' from vb01b), (select r ->> 'reason' from vb01b)],
  array['3.392520', '2.261680', 'refused', 'per_user_cap'],
  'VB-01 reserve_voice(voice_session) reserves the seeded VOICE_RESERVATION (3.392520) and returns shutoff = '
  || 'round(reservation x 2 / 3, 6) = 2.261680 (cost_model.VOICE_SHUTOFF, X-17, SG3-35); with the seeded 5.00 '
  || 'per-user cap (D-017) an actor''s second voice reservation is refused (per_user_cap) while the first is '
  || 'still reserved');
select pg_temp.v2_release((select r from vb01a));

create temp table vb02r on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, null, null)', 'vb02-probe-001', 'global', 'voice_probe', 'voice.probe')) as r;
select is((select r ->> 'reserved_usd' from vb02r), '0.424940',
  'VB-02 reserve_voice(voice_probe) reserves the seeded PROBE_RESERVATION (0.424940)');
select pg_temp.v2_release((select r from vb02r));

-- ---------------------------------------------------------------------------- VB-03
create temp table vb03a on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, null, null)', 'vb03-res-001', 'global', 'voice_session', 'voice.session')) as r;
create temp table vb03b on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, null, null)', 'vb03-res-002', 'global', 'voice_probe', 'voice.probe')) as r;
create temp table vb03c on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, null, null)', 'vb03-res-003', 'global', 'voice_session', 'voice.session')) as r;
select is(array[(select r ->> 'outcome' from vb03a), (select r ->> 'outcome' from vb03b),
                concat_ws('/', (select r ->> 'outcome' from vb03c), (select r ->> 'reason' from vb03c))],
  array['reserved', 'reserved', 'refused/voice_concurrency'],
  'VB-03 a third open voice reservation, with max_open_voice_sessions = 2 already held, is refused '
  || '(voice_concurrency)');
select pg_temp.v2_release((select r from vb03a));
select pg_temp.v2_release((select r from vb03b));

-- ---------------------------------------------------------------------------- VB-05..VB-09 (one reservation,
-- one open session, carried through receipts, a sibling card reservation, shutoff and settlement)
create temp table vb0509trial on commit drop as select pg_temp.v2_trial('C', 'vb0509-session') as trial;
create temp table vb0509ticket on commit drop as select pg_temp.v2_ticket('C', (select trial from vb0509trial)) as ticket;
create temp table vb0509res on commit drop as select pg_temp.v2_reserve((select trial from vb0509trial), 'vb0509-voice-res') as r;
create temp table vb0509open on commit drop as
  select pg_temp.v2_open((select ticket from vb0509ticket), (select (r ->> 'id')::uuid from vb0509res)) as session;
select tests.as_role('arena_subject', format('select ops.mark_dispatched(%L)', (select (r ->> 'id')::uuid from vb0509res)));

create temp table vb05use on commit drop as select tests.as_role('arena_subject', format(
  'select ops.record_usage(%L, 1, %L, 0, 0, 0, %L, 0, %L, 100, null, null)', (select (r ->> 'id')::uuid from vb0509res),
  'gemini-3.8-live', 100000, 'usage')) as r;
create temp table vb05ctx on commit drop as select tests.as_role('arena_subject', format(
  'select subject.voice_context(%L)', (select session from vb0509open))) as r;
select is(array[(select r ->> 'spend_usd' from vb05use), (select r ->> 'spend_usd' from vb05ctx)],
  array['0.450000', '0.450000'],
  'VB-05 spend_usd returned by record_usage and by subject.voice_context both equal the sum of the voice '
  || 'reservation''s own receipts (no child term, D7)');

create temp table vb06before on commit drop as select tests.as_role('arena_subject', format(
  'select subject.voice_context(%L)', (select session from vb0509open))) as r;
create temp table vb06card on commit drop as select tests.as_role('arena_public', format(
  'select ops.reserve_model_call(%L, %L, %L, %L, %L, %L, null, 1000)', 'vb06-card-001', 'global',
  'gemini-3.5-flash-lite', 'card', 'coach.card', (select trial from vb0509trial))) as r;
create temp table vb06after on commit drop as select tests.as_role('arena_subject', format(
  'select subject.voice_context(%L)', (select session from vb0509open))) as r;
select is(array[(select r ->> 'outcome' from vb06card),
                ((select r ->> 'spend_usd' from vb06before) = (select r ->> 'spend_usd' from vb06after))::text,
                ((select r ->> 'shutoff_usd' from vb06before) = (select r ->> 'shutoff_usd' from vb06after))::text],
  array['reserved', 'true', 'true'],
  'VB-06 a card reservation for the voice session''s trial leaves the voice reservation''s spend and shutoff '
  || 'unchanged');

create temp table vb07use on commit drop as select tests.as_role('arena_subject', format(
  'select ops.record_usage(%L, 2, %L, 0, 0, 0, %L, 0, %L, 100, null, null)', (select (r ->> 'id')::uuid from vb0509res),
  'gemini-3.8-live', 450000, 'usage')) as r;
select is(array[(select r ->> 'outcome' from vb07use), (select r ->> 'shutoff' from vb07use)],
  array['recorded', 'true'],
  'VB-07 a usage report answers shutoff = true once the receipts reach two thirds of the reservation (here: '
  || '0.450000 + 2.025000 = 2.475000 >= 2.261680)');

select is(tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject', format(
    'select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb0509res), 'usage_unknown'))),
  'AR001',
  'VB-08 settle_voice_reservation while the reservation''s voice session is still open is refused (AR001)');

select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)',
  (select session from vb0509open), 'vb09-done'));
create temp table vb09 on commit drop as select tests.as_role('arena_subject', format(
  'select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb0509res), 'committed')) as r;
create temp table vb09probe on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, null, null)', 'vb09-probe-001', 'global', 'voice_probe', 'voice.probe')) as r;
select tests.as_role('arena_subject', format('select ops.mark_dispatched(%L)', (select (r ->> 'id')::uuid from vb09probe)));
create temp table vb09probeuse on commit drop as select tests.as_role('arena_subject', format(
  'select ops.record_usage(%L, 1, %L, 0, 0, 0, %L, 0, %L, 100, null, null)', (select (r ->> 'id')::uuid from vb09probe),
  'gemini-3.8-live', 10000, 'usage')) as r;
create temp table vb09probesettle on commit drop as select tests.as_role('arena_subject', format(
  'select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb09probe), 'committed')) as r;
select is(array[(select r ->> 'settled_usd' from vb09), (select r ->> 'settled_usd' from vb09probesettle)],
  array['2.475000', (select r ->> 'cost_usd' from vb09probeuse)],
  'VB-09 settle_voice_reservation committed after close (or, with no session at all, a probe) sets '
  || 'settled_usd to the usage receipts');

-- ---------------------------------------------------------------------------- VB-10
select is(array[
    tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_public',
      $q$ select ops.reserve_voice('vb10-probe-001', 'global', 'voice_probe', 'voice.probe', null, null) $q$)),
    tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_public', format(
      'select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb09probe), 'released')))],
  array['42501', '42501'],
  'VB-10 arena_public calling reserve_voice or settle_voice_reservation is refused (42501)');

-- ---------------------------------------------------------------------------- VB-11
create temp table vb11trial on commit drop as select pg_temp.v2_trial('B', 'vb11-session') as trial;
select set_config('arena.actor_id', tests.uid('B')::text, true);
create temp table vb11tok on commit drop as select
  (tests.as_role('arena_public', format('select to_jsonb(training.issue_access_ticket(%L, %L))', 'voice',
     (select trial from vb11trial))) #>> '{}') as tok;
create temp table vb11ticket on commit drop as select
  (tests.as_role('arena_public', format('select training.redeem_access_ticket(%L, %L)', (select tok from vb11tok),
     'voice')) ->> 'ticket_id')::uuid as ticket;
select set_config('arena.actor_id', '', true);
create temp table vb11res on commit drop as select pg_temp.v2_reserve((select trial from vb11trial), 'vb11-voice-res') as r;
-- (a) the ticket was never claimed by arena_subject
create temp table vb11a on commit drop as select tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject',
  format('select training.open_voice_session(%L, %L)', (select ticket from vb11ticket),
    (select (r ->> 'id')::uuid from vb11res)))) as v;
select tests.as_role('arena_subject', format('select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))',
  (select ticket from vb11ticket), tests.uid('B'), (select trial from vb11trial), 'practice'));
-- (b) a probe reservation where open_voice_session needs a voice_session one
create temp table vb11probe on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, %L, null)', 'vb11-probe-res', 'global', 'voice_probe', 'voice.probe',
  (select trial from vb11trial))) as r;
create temp table vb11b on commit drop as select tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject',
  format('select training.open_voice_session(%L, %L)', (select ticket from vb11ticket),
    (select (r ->> 'id')::uuid from vb11probe)))) as v;
select pg_temp.v2_release((select r from vb11probe));  -- frees its concurrency slot (max_open_voice_sessions = 2)
-- (c) another trial's reservation
create temp table vb11trial2 on commit drop as select pg_temp.v2_trial('D', 'vb11-session-2') as trial;
create temp table vb11res2 on commit drop as select pg_temp.v2_reserve((select trial from vb11trial2), 'vb11-voice-res-2') as r;
create temp table vb11c on commit drop as select tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject',
  format('select training.open_voice_session(%L, %L)', (select ticket from vb11ticket),
    (select (r ->> 'id')::uuid from vb11res2)))) as v;
select pg_temp.v2_release((select r from vb11res2));
-- (d) a reservation the owner made directly (caller_role is not arena_subject)
create temp table vb11owner on commit drop as select ops.reserve_voice('vb11-owner-res', 'global', 'voice_session',
  'voice.session', (select trial from vb11trial), null) as r;
create temp table vb11d on commit drop as select tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject',
  format('select training.open_voice_session(%L, %L)', (select ticket from vb11ticket),
    (select (r ->> 'id')::uuid from vb11owner)))) as v;
select is(array[(select v from vb11a), (select v from vb11b), (select v from vb11c), (select v from vb11d)],
  array['AR040', 'AR040', 'AR040', 'AR040'],
  'VB-11 open_voice_session with an unclaimed ticket, a probe reservation, another trial''s reservation, or a '
  || 'reservation another role made, is refused (AR040) each time');
select pg_temp.v2_release((select r from vb11res));
select ops.settle_voice_reservation((select (r ->> 'id')::uuid from vb11owner), 'released');  -- made as owner, settled as owner

-- ---------------------------------------------------------------------------- VB-12
create temp table vb12trial on commit drop as select pg_temp.v2_trial('B', 'vb12-session') as trial;
create temp table vb12t1 on commit drop as select pg_temp.v2_ticket('B', (select trial from vb12trial)) as ticket;
create temp table vb12t2 on commit drop as select pg_temp.v2_ticket('B', (select trial from vb12trial)) as ticket;
create temp table vb12r1 on commit drop as select pg_temp.v2_reserve((select trial from vb12trial), 'vb12-res-1') as r;
create temp table vb12r2 on commit drop as select pg_temp.v2_reserve((select trial from vb12trial), 'vb12-res-2') as r;
create temp table vb12open1 on commit drop as
  select pg_temp.v2_open((select ticket from vb12t1), (select (r ->> 'id')::uuid from vb12r1)) as session;
select is(tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject', format(
    'select training.open_voice_session(%L, %L)', (select ticket from vb12t2), (select (r ->> 'id')::uuid from vb12r2)))),
  '23505',
  'VB-12 a second open voice session on one training session is refused (23505, the partial unique index on '
  || 'an open session per training session)');
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)', (select session from vb12open1), 'vb12-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb12r1), 'released'));
select pg_temp.v2_release((select r from vb12r2));

-- ---------------------------------------------------------------------------- VB-13
create temp table vb13trial on commit drop as select pg_temp.v2_trial('C', 'vb13-session') as trial;
create temp table vb13ticket1 on commit drop as select pg_temp.v2_ticket('C', (select trial from vb13trial)) as ticket;
create temp table vb13res1 on commit drop as select pg_temp.v2_reserve((select trial from vb13trial), 'vb13-res-1') as r;
create temp table vb13session1 on commit drop as
  select pg_temp.v2_open((select ticket from vb13ticket1), (select (r ->> 'id')::uuid from vb13res1)) as session;
select pg_temp.exchange(jsonb_build_object('voice_session', (select session from vb13session1)), 1);
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)', (select session from vb13session1), 'vb13-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb13res1), 'released'));
create temp table vb13closed on commit drop as select tests.sqlstate(format('select pg_temp.exchange(%L, 2)',
  jsonb_build_object('voice_session', (select session from vb13session1)))) as v;

-- a second, unrelated trial: voice_exchanges counting is trial-scoped, so reusing vb13trial here (already at
-- exchange 1 from session1) would make exchange 2 the correct next number, not an out-of-order one.
create temp table vb13trial2 on commit drop as select pg_temp.v2_trial('C', 'vb13-session-2') as trial;
create temp table vb13ticket2 on commit drop as select pg_temp.v2_ticket('C', (select trial from vb13trial2)) as ticket;
create temp table vb13res2 on commit drop as select pg_temp.v2_reserve((select trial from vb13trial2), 'vb13-res-2') as r;
create temp table vb13session2 on commit drop as
  select pg_temp.v2_open((select ticket from vb13ticket2), (select (r ->> 'id')::uuid from vb13res2)) as session;
create temp table vb13unrelated on commit drop as select tests.sqlstate(format('select pg_temp.exchange(%L, 1)',
  jsonb_build_object('voice_session', gen_random_uuid()))) as v;
create temp table vb13order on commit drop as select tests.sqlstate(format('select pg_temp.exchange(%L, 2)',
  jsonb_build_object('voice_session', (select session from vb13session2)))) as v;
create temp table vb13thirteen on commit drop as select tests.sqlstate(format('select pg_temp.exchange(%L, 13)',
  jsonb_build_object('voice_session', (select session from vb13session2)))) as v;
create temp table vb13role on commit drop as select tests.sqlstate(format(
  'select training.record_voice_exchange(%L, 1::smallint, %L)', (select session from vb13session2),
  jsonb_build_array(jsonb_build_object('role', 'narrator', 'text', 'x', 'partial', false)))) as v;
create temp table vb13extra on commit drop as select tests.sqlstate(format(
  'select training.record_voice_exchange(%L, 1::smallint, %L)', (select session from vb13session2),
  jsonb_build_array(jsonb_build_object('role', 'investigator', 'text', 'x', 'partial', false, 'extra', 1)))) as v;
create temp table vb13empty on commit drop as select tests.sqlstate(format(
  'select training.record_voice_exchange(%L, 1::smallint, %L)', (select session from vb13session2),
  jsonb_build_array(jsonb_build_object('role', 'investigator', 'text', '', 'partial', false)))) as v;
select is(array[(select v from vb13closed), (select v from vb13unrelated), (select v from vb13order),
                (select v from vb13thirteen), (select v from vb13role), (select v from vb13extra), (select v from vb13empty)],
  array['AR040', 'AR040', 'AR004', 'AR004', 'AR007', 'AR007', 'AR007'],
  'VB-13 record_voice_exchange on a closed voice session, on an unrelated session id, out of order, and '
  || 'numbered 13 are refused (AR040; AR040; AR004; AR004); lines with a role other than investigator or '
  || 'subject, an extra key, or an empty text are each refused (AR007)');

-- ---------------------------------------------------------------------------- VB-14
create temp table vb14ctx on commit drop as select tests.as_role('arena_subject', format(
  'select subject.voice_context(%L)', (select session from vb13session2))) as r;
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)', (select session from vb13session2), 'vb14-done'));
create temp table vb14err on commit drop as select tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_subject',
  format('select subject.voice_context(%L)', (select session from vb13session2)))) as v;
select is(array[(select (r ? 'voice_exchanges')::text from vb14ctx), (select (r ? 'reservation_id')::text from vb14ctx),
                (select (r ? 'spend_usd')::text from vb14ctx), (select (r ? 'shutoff_usd')::text from vb14ctx),
                (select v from vb14err)],
  array['true', 'true', 'true', 'true', 'AR003'],
  'VB-14 SG3-05: subject.voice_context on an open session returns voice_exchanges, reservation_id, spend_usd '
  || 'and shutoff_usd; on a closed session it is refused (AR003)');
select pg_temp.v2_release((select r from vb13res2));

-- ---------------------------------------------------------------------------- VB-15
create temp table vb15ticket on commit drop as select pg_temp.v2_ticket('C', (select trial from vb13trial)) as ticket;
create temp table vb15res on commit drop as select pg_temp.v2_reserve((select trial from vb13trial), 'vb15-voice-res') as r;
create temp table vb15open on commit drop as
  select pg_temp.v2_open((select ticket from vb15ticket), (select (r ->> 'id')::uuid from vb15res)) as session;
select pg_temp.exchange(jsonb_build_object('voice_session', (select session from vb15open)), 2);
create temp table vb15ctx on commit drop as select tests.as_role('arena_subject', format(
  'select subject.voice_context(%L)', (select session from vb15open))) as r;
select set_config('arena.actor_id', tests.uid('C')::text, true);
create temp table vb15c on commit drop as select tests.as_role('arena_public',
  $$ select jsonb_agg(exchange_no order by exchange_no) from training.v_my_voice_exchanges $$) as r;
select set_config('arena.actor_id', tests.uid('D')::text, true);
create temp table vb15d on commit drop as select tests.as_role('arena_public',
  $$ select jsonb_agg(exchange_no order by exchange_no) from training.v_my_voice_exchanges $$) as r;
select set_config('arena.actor_id', '', true);
select is(array[(select jsonb_array_length(r -> 'voice_exchanges')::text from vb15ctx),
                (select r::text from vb15c), (select (r is null)::text from vb15d)],
  array['2', '[1, 2]', 'true'],
  'VB-15 D-016: a reconnect (a second voice session on the same trial after the first closed) gets its own '
  || 'ticket, reservation and receipts, and its context carries the first session''s exchange too (voice_context '
  || 'is trial-scoped); training.v_my_voice_exchanges returns the owner''s exchanges and none to another actor');
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)', (select session from vb15open), 'vb15-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb15res), 'released'));

-- ---------------------------------------------------------------------------- VB-16
create temp table vb16trial on commit drop as select pg_temp.v2_trial('D', 'vb16-session') as trial;
create temp table vb16ticket on commit drop as select pg_temp.v2_ticket('D', (select trial from vb16trial)) as ticket;
create temp table vb16res on commit drop as select pg_temp.v2_reserve((select trial from vb16trial), 'vb16-voice-res') as r;
create temp table vb16open on commit drop as
  select pg_temp.v2_open((select ticket from vb16ticket), (select (r ->> 'id')::uuid from vb16res)) as session;
-- open_work_item, submit_question and finalize_trial all check _check_caller, which for a training trial
-- needs the request's actor to equal the trial's own owner.
select set_config('arena.actor_id', tests.uid('D')::text, true);
create temp table vb16finwi0 on commit drop as select (arena.open_work_item((select trial from vb16trial), 'finalize',
  tests.k((select trial from vb16trial), 0, 'finalize', 'vb16-0')) ->> 'work_item_id')::uuid as wi;
create temp table vb16fin0 on commit drop as select tests.error(format('select arena.finalize_trial(%L, %L, null)',
  (select trial from vb16trial), (select wi from vb16finwi0))) as v;
-- a training trial's own investigator question carries no p_source (tests.exchange's own convention); a
-- non-null source here would trip the EARLIER, unrelated origin check first (AR007 "investigator questions
-- carry no origin"), never reaching the voice-specific refusal this assertion exists to prove.
create temp table vb16sq on commit drop as select tests.error(format('select arena.submit_question(%L, 0, %L, %L, null)',
  (select trial from vb16trial), 'text question', tests.k((select trial from vb16trial), 1, 'question', 'vb16'))) as v;
create temp table vb16lines1 on commit drop as select jsonb_build_array(
  jsonb_build_object('role', 'subject', 'text', '...late tail of the previous answer', 'partial', false),
  jsonb_build_object('role', 'investigator', 'text', 'Next question', 'partial', false)) as lines;
select tests.as_role('arena_subject', format('select training.record_voice_exchange(%L, 1::smallint, %L)',
  (select session from vb16open), (select lines from vb16lines1)));
create temp table vb16ex2 on commit drop as select pg_temp.exchange(jsonb_build_object('voice_session', (select session from vb16open)), 2) as r;
create temp table vb16ex2again on commit drop as select pg_temp.exchange(jsonb_build_object('voice_session', (select session from vb16open)), 2) as r;
create temp table vb16ex2other on commit drop as select tests.error(format(
  'select training.record_voice_exchange(%L, 2::smallint, %L)', (select session from vb16open),
  jsonb_build_array(jsonb_build_object('role', 'investigator', 'text', 'different content', 'partial', false)))) as v;
create temp table vb16checks on commit drop as select
  (select count(*) from arena.turns where trial_id = (select trial from vb16trial)) as turns,
  (select count(*) from arena.work_items where trial_id = (select trial from vb16trial)
     and kind in ('subject_answer', 'release')) as other_wi,
  (select lines from training.voice_exchanges where trial_id = (select trial from vb16trial) and exchange_no = 1) as stored_lines;
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)', (select session from vb16open), 'vb16-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb16res), 'released'));
create temp table vb16finwi1 on commit drop as select (arena.open_work_item((select trial from vb16trial), 'finalize',
  tests.k((select trial from vb16trial), 0, 'finalize', 'vb16-1')) ->> 'work_item_id')::uuid as wi;
select arena.finalize_trial((select trial from vb16trial), (select wi from vb16finwi1),
  jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
    'rationale', 'vb16', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', '[]'::jsonb,
    'cited_records', jsonb_build_array('rec-02'), 'corroboration_needed', '[]'::jsonb));
select set_config('arena.actor_id', '', true);
select is(array[(select v from vb16fin0), (select v from vb16sq),
                ((select r ->> 'released' from vb16ex2) like '%rec-02%')::text,
                (select r ->> 'outcome' from vb16ex2again), (select v from vb16ex2other),
                (select (stored_lines = (select lines from vb16lines1))::text from vb16checks),
                (select turns::text from vb16checks), (select other_wi::text from vb16checks),
                (select state from ledger.terminal_records where trial_id = (select trial from vb16trial))],
  array['AR001: nothing to finalize: the transcript is empty',
        'AR007: a voice session is spoken; commit the finding in text',
        'true', 'exists', 'AR003: exchange number reused with different content', 'true', '0', '0', 'completed'],
  'VB-16 D-016, SG3-27: a spoken exchange writes no arena.turns row and no subject_answer or release work '
  || 'item; submit_question on the trial is refused (AR007); record_voice_exchange returns a scheduled record '
  || 'due after that exchange in released (committed in the same transaction); the same exchange again '
  || 'answers exists; other content under the same number is AR003; SG3-41: a window whose lines hold the '
  || 'late tail of the previous question beside the next question is stored role-tagged in arrival order; '
  || 'finalize_trial with no exchange is AR001, then with one exchange and a finding citing records only '
  || 'reaches completed');

-- ---------------------------------------------------------------------------- VB-17
create temp table vb17trial on commit drop as select pg_temp.v2_trial('D', 'vb17-session') as trial;
create temp table vb17ticket on commit drop as select pg_temp.v2_ticket('D', (select trial from vb17trial)) as ticket;
create temp table vb17res on commit drop as select pg_temp.v2_reserve((select trial from vb17trial), 'vb17-voice-res') as r;
create temp table vb17open on commit drop as
  select pg_temp.v2_open((select ticket from vb17ticket), (select (r ->> 'id')::uuid from vb17res)) as session;
create temp table vb17close on commit drop as select tests.as_role('arena_subject',
  'select to_jsonb(training.close_orphan_voice_sessions())') as r;
select is(array[(select r::text from vb17close),
    (select status from training.voice_sessions where id = (select session from vb17open)),
    (select close_code from training.voice_sessions where id = (select session from vb17open)),
    (select state from ops.budget_reservations where id = (select (r ->> 'id')::uuid from vb17res)),
    (select settled_usd::text from ops.budget_reservations where id = (select (r ->> 'id')::uuid from vb17res))],
  array['1', 'closed', 'orphaned', 'usage_unknown', (select r ->> 'reserved_usd' from vb17res)],
  'VB-17 SG3-36: with a voice session left open by a dead process, close_orphan_voice_sessions() returns 1; '
  || 'the session becomes closed/orphaned; its reservation becomes usage_unknown with the full hold');

-- ---------------------------------------------------------------------------- VB-18
create temp table vb18trial on commit drop as select pg_temp.v2_trial('D', 'vb18-session') as trial;
create temp table vb18ticket on commit drop as select pg_temp.v2_ticket('D', (select trial from vb18trial)) as ticket;
create temp table vb18res on commit drop as select pg_temp.v2_reserve((select trial from vb18trial), 'vb18-voice-res') as r;
create temp table vb18open on commit drop as
  select pg_temp.v2_open((select ticket from vb18ticket), (select (r ->> 'id')::uuid from vb18res)) as session;
select pg_temp.exchange(jsonb_build_object('voice_session', (select session from vb18open)), 1);  -- rec-01 is due after 1 exchange
select set_config('arena.actor_id', tests.uid('D')::text, true);
create temp table vb18wi on commit drop as select (arena.open_work_item((select trial from vb18trial), 'release',
  tests.k((select trial from vb18trial), 0, 'release', 'vb18')) ->> 'work_item_id')::uuid as wi;
create temp table vb18rel on commit drop as select arena.release_evidence((select trial from vb18trial),
  (select wi from vb18wi), array['rec-01']) as r;
select set_config('arena.actor_id', '', true);
create temp table vb18ctx on commit drop as select tests.as_role('arena_subject', format(
  'select subject.voice_context(%L)', (select session from vb18open))) as r;
select is(array[(select r -> 'released' from vb18rel)::text, (select (r::text ~ 'rec-01') from vb18ctx)::text],
  array['[{"kind": "record", "doc_kind": "work_order", "record_id": "rec-01"}]', 'true'],
  'VB-18 SG3-07, SG3-37: in a voice session, arena_public releases a requested record through release_evidence '
  || 'at any time (no turn exists to block it); subject.voice_context then lists it');
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)', (select session from vb18open), 'vb18-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb18res), 'released'));

-- ---------------------------------------------------------------------------- VB-19
create temp table vb19trial on commit drop as select pg_temp.v2_trial('D', 'vb19-session') as trial;
create temp table vb19ticket on commit drop as select pg_temp.v2_ticket('D', (select trial from vb19trial)) as ticket;
create temp table vb19res on commit drop as select pg_temp.v2_reserve((select trial from vb19trial), 'vb19-voice-res') as r;
create temp table vb19open on commit drop as
  select pg_temp.v2_open((select ticket from vb19ticket), (select (r ->> 'id')::uuid from vb19res)) as session;
do $$
begin
  alter table ops.budget_reservations disable trigger budget_reservations_settle_once;
  update ops.budget_reservations set created_at = now() - interval '61 minutes'
   where id = (select (r ->> 'id')::uuid from pg_temp.vb19res);
  alter table ops.budget_reservations enable trigger budget_reservations_settle_once;
end $$;
create temp table vb19new on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, null, null)', 'vb19-voice-new', 'global', 'voice_probe', 'voice.probe')) as r;
select is(array[
    (select state from ops.budget_reservations where id = (select (r ->> 'id')::uuid from vb19res)),
    (select settled_usd::text from ops.budget_reservations where id = (select (r ->> 'id')::uuid from vb19res)),
    (select status from training.voice_sessions where id = (select session from vb19open)),
    (select close_code from training.voice_sessions where id = (select session from vb19open)),
    (select r ->> 'outcome' from vb19new)],
  array['usage_unknown', (select r ->> 'reserved_usd' from vb19res), 'closed', 'expired', 'reserved'],
  'VB-19 D7 reaping: a voice reservation open for 61 minutes (owner backdates created_at), then any '
  || 'reserve_voice call: the old reservation becomes usage_unknown with its full hold, its session closes '
  || 'expired, and the new reservation is admitted');
select pg_temp.v2_release((select r from vb19new));

-- ---------------------------------------------------------------------------- VB-20 (SG1-32)
-- Local throughout, like VB-01..VB-19 (not dblink): ledger.append_event locks the single chain_head row for
-- the rest of the CALLING transaction, and this file's own earlier local calls (VB-05..VB-19) already hold
-- that lock for the rest of this file's one transaction, so a dblink connection trying to append anything
-- (family ingest, start_session, a ticket, a reservation -- all of them, eventually) would wait on it
-- forever (discovered the hard way: an attempt to route this fixture over dblink, mirroring
-- 010_concurrency.sql's pattern, hung indefinitely). dblink only works for a concurrency race when nothing
-- in the local session has touched the ledger first, which no longer holds this late in this file.
create temp table vb20trial on commit drop as select pg_temp.v2_trial('D', 'vb20-session') as trial;
create temp table vb20ticket on commit drop as select pg_temp.v2_ticket('D', (select trial from vb20trial)) as ticket;
create temp table vb20res on commit drop as select pg_temp.v2_reserve((select trial from vb20trial), 'vb20-voice-res') as r;
create temp table vb20open on commit drop as
  select pg_temp.v2_open((select ticket from vb20ticket), (select (r ->> 'id')::uuid from vb20res)) as session;
select pg_temp.exchange(jsonb_build_object('voice_session', (select session from vb20open)), 1);
-- open_work_item and release_evidence check _check_caller, which for a training trial needs the request's
-- actor to equal the trial's own owner; set for the rest of this block, restored just before VB-04.
select set_config('arena.actor_id', tests.uid('D')::text, true);
-- a release item opened in its own step (capturing the current version), then a voice exchange that stores
-- a scheduled release (bumping the version): the item is now stale.
create temp table vb20stalewi on commit drop as select (arena.open_work_item((select trial from vb20trial), 'release',
  tests.k((select trial from vb20trial), 0, 'release', 'vb20-stale')) ->> 'work_item_id')::uuid as wi;
select pg_temp.exchange(jsonb_build_object('voice_session', (select session from vb20open)), 2);
create temp table vb20stale on commit drop as select tests.error(format('select arena.release_evidence(%L, %L, %L)',
  (select trial from vb20trial), (select wi from vb20stalewi), array['rec-01'])) as v;

-- the v2.6 route: a fresh item and release_evidence together (no step between them that could change the
-- version) succeeds. (The spec's further demonstration -- a concurrent record_voice_exchange over dblink
-- waiting on release_evidence's trial lock and timing out at 55P03 -- is scoped out for the reason noted
-- above; the underlying "the trial row lock serializes concurrent writers" behavior is already proven
-- directly, repeatedly, in 002_cases_and_seal.sql, 009_execution_failures.sql and 010_concurrency.sql.)
create temp table vb20freshwi on commit drop as select (arena.open_work_item((select trial from vb20trial), 'release',
  tests.k((select trial from vb20trial), 0, 'release', 'vb20-fresh')) ->> 'work_item_id')::uuid as wi;
create temp table vb20rel on commit drop as select arena.release_evidence((select trial from vb20trial),
  (select wi from vb20freshwi), array['rec-01']) as r;

-- a rolled-back attempt (local savepoint), the real exchange 3, then a retry with the same key gets a fresh
-- item and succeeds; repeating that call returns the stored result.
savepoint vb20_sp;
select arena.open_work_item((select trial from vb20trial), 'release',
  tests.k((select trial from vb20trial), 0, 'release', 'vb20-retry'));
rollback to savepoint vb20_sp;
select pg_temp.exchange(jsonb_build_object('voice_session', (select session from vb20open)), 3);
create temp table vb20retrywi on commit drop as select (arena.open_work_item((select trial from vb20trial), 'release',
  tests.k((select trial from vb20trial), 0, 'release', 'vb20-retry')) ->> 'work_item_id')::uuid as wi;
create temp table vb20retry on commit drop as select arena.release_evidence((select trial from vb20trial),
  (select wi from vb20retrywi), array['rec-01']) as r;
create temp table vb20repeat on commit drop as select arena.release_evidence((select trial from vb20trial),
  (select wi from vb20retrywi), array['rec-01']) as r;

select is(array[(select v from vb20stale), (select (r is not null)::text from vb20rel),
                (select count(*)::text from arena.work_items where trial_id = (select trial from vb20trial)
                   and idempotency_key = tests.k((select trial from vb20trial), 0, 'release', 'vb20-retry')),
                ((select r from vb20retry) = (select r from vb20repeat))::text],
  array['AR002: stale transcript version', 'true', '1', 'true'],
  'VB-20 SG1-32: a release item opened separately from a voice exchange that fires a scheduled release goes '
  || 'stale (AR002, why the real route opens both in one transaction); the v2.6 route (a fresh item and '
  || 'release_evidence together) succeeds; a rolled-back attempt''s item never persisted (one row for the key, '
  || 'not two), so a retry with the same key gets a fresh one and succeeds; repeating the call returns the '
  || 'stored result');
select set_config('arena.actor_id', '', true);
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)', (select session from vb20open), 'vb20-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from vb20res), 'released'));

-- ---------------------------------------------------------------------------- VB-04 (last: it permanently
-- contributes to voice_sessions_total / voice_probes_total for the rest of this transaction, so it accounts
-- for whatever the rows above already added instead of assuming a fixed starting count).
create or replace function pg_temp.vb04_fill(p_kind text, p_cap integer) returns text
language plpgsql as $$
declare
  v_have integer;
  v_need integer;
  i       integer;
  v_id    uuid;
  v_out   jsonb;
begin
  select count(*) into v_have from ops.budget_reservations where kind = p_kind and state <> 'released';
  v_need := p_cap - v_have + 1;
  for i in 1..v_need loop
    v_out := tests.as_role('arena_subject', format('select ops.reserve_voice(%L, %L, %L, %L, null, null)',
      'vb04-' || p_kind || '-' || lpad(i::text, 3, '0'), 'global', p_kind, 'voice.' || p_kind));
    if i < v_need then
      v_id := (v_out ->> 'id')::uuid;
      perform tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', v_id, 'usage_unknown'));
    end if;
  end loop;
  return concat_ws('/', v_out ->> 'outcome', v_out ->> 'reason');
end $$;
select is(array[pg_temp.vb04_fill('voice_session', 8), pg_temp.vb04_fill('voice_probe', 30)],
  array['refused/voice_total_cap', 'refused/voice_total_cap'],
  'VB-04 the 9th voice session (voice_sessions_total = 8) and the 31st probe (voice_probes_total = 30) are '
  || 'each refused (voice_total_cap)');
-- vb04_fill's settled rows count toward voice_sessions_total/voice_probes_total forever (state <> 'released'
-- counts them even settled); left in place they would also exhaust the cap for the rest of this file's one
-- transaction, including the existing VB-21..24 rows below, which still need to open real voice sessions.
do $$
begin
  alter table ops.budget_reservations disable trigger budget_reservations_settle_once;
  delete from ops.budget_reservations where idempotency_key like 'vb04-%';
  alter table ops.budget_reservations enable trigger budget_reservations_settle_once;
end $$;

update ops.config set voice_sessions_per_user_day = (select voice_sessions_per_user_day from vbseed),
                      text_sessions_per_user_day = (select text_sessions_per_user_day from vbseed) where id;
-- the rows above restore arena.actor_id to '' after each of their own uses; the rest of this file (below)
-- assumes it is still set to actor A, as the top of this file left it.
select set_config('arena.actor_id', tests.uid('A')::text, true);

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
-- VB-24: exchanges 3..12 are stored; a 13th is refused with AR004 (TESTS.md VB-13), not the table's 23514.
select count(*) from generate_series(3, 12) n, lateral pg_temp.exchange((select val from vb21 where step = 0), n) x
 where x ->> 'outcome' = 'recorded';
select is(array[(select count(*) from training.voice_exchanges where trial_id = (select trial from vt))::text,
                tests.error(format('select pg_temp.exchange(%L, 13)', (select val from vb21 where step = 0)))],
          array['12', 'AR004: voice exchanges are stored in order, at most 12'],
  'VB-24 a 13th voice exchange is refused with AR004');
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
