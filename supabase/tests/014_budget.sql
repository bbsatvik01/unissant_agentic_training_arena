-- 014_budget.sql (S4 section 8; sql/TESTS.md section 14; D-009, D-012, D-013, D-014; WI-S4-08)
-- WP-03 rows: the $0 seed of the one global bucket and its fail-closed behavior (BU-01, BU-27), the operator's
-- plan application and its gate-proof (BU-28, BU-29), the tree rules kept for a later per-phase split (BU-21,
-- BU-22, BU-24), and the D-014 and D7 refusals with the referee worst case (BU-03). BU-38..BU-41 are WP-03 additions
-- for the fixes in migration 0800 (proposed for the spec): receipts never overrun a reservation through rounding,
-- the purpose is part of a reservation's identity, same-key calls are serialized, and a repeated usage report is the
-- same report and returns the full metering answer. WP-04b adds the remaining rows of
-- TESTS.md section 14 to this file. No ceiling is typed here: every expected ceiling comes from the psql
-- variable plan, the stdout of `python3 -I -B docs/research/synthesis/cost_model.py --plan-json` (run_pgtap.sh).
-- Numeric parity of the seeds with cost_model.py (prices, limits, voice amounts) is tools/check_cost_parity.py.
begin;
\ir harness/fixtures.psql
select plan(13);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

-- ------------------------------------------------------------------ BU-40: a same-key race (dblink, committed)
-- Runs first: this transaction must hold no lock on the bucket or reservation rows yet. Session A raises the
-- committed ceiling by $1, reserves key K and stays open; session B asks for K meanwhile and must wait on the key,
-- then see A's reservation (`exists`, same id) rather than miss it and fail on the unique key (23505). A then removes
-- what it committed: the reservation row (its settle-once trigger off for that one statement) and the $1, so the
-- ceiling is the migrated seed again, whatever that seed is (BU-01 and BU-27 below still judge the seed).
create temp table bu40 (step integer, val text) on commit drop;
insert into bu40 select 0, ceiling_usd::text from ops.budget_buckets where name = 'global';
select dblink_connect('bu40a', current_setting('arena_test.dblink_dsn'));
select dblink_connect('bu40b', current_setting('arena_test.dblink_dsn'));
select dblink_exec('bu40a', 'begin');
select dblink_exec('bu40a', $q$update ops.budget_buckets set ceiling_usd = ceiling_usd + 1 where name = 'global'$q$);
insert into bu40 select 1, r from dblink('bu40a',
  $q$select ops.reserve_model_call('bu40-race-key-0001', 'global', 'gemini-3.5-flash-lite', 'card', 'coach.card',
                                   null, null, 1000)::text$q$) as t(r text);
create temp table bu40_pid on commit drop as
  select pid from dblink('bu40b', 'select pg_backend_pid()') as t(pid integer);
select dblink_send_query('bu40b',
  $q$select ops.reserve_model_call('bu40-race-key-0001', 'global', 'gemini-3.5-flash-lite', 'card', 'coach.card',
                                   null, null, 1000)::text$q$);
-- A commits only once B is waiting on a lock A holds (bounded at 10 s), so B's lookup cannot run after the commit.
do $$
begin
  for i in 1..200 loop
    if exists (select 1 from pg_stat_activity a join bu40_pid b on b.pid = a.pid where a.wait_event_type = 'Lock') then
      insert into bu40 values (2, 'blocked');
      return;
    end if;
    perform pg_sleep(0.05);
  end loop;
  insert into bu40 values (2, 'not blocked');
end $$;
select dblink_exec('bu40a', 'commit');
insert into bu40 select 3, coalesce((select r from dblink_get_result('bu40b', false) as t(r text)),
                                    'error: ' || dblink_error_message('bu40b'));
select count(*) from dblink_get_result('bu40b', false) as t(r text);
select dblink_exec('bu40a', 'alter table ops.budget_reservations disable trigger budget_reservations_settle_once');
select dblink_exec('bu40a', $q$delete from ops.budget_reservations where idempotency_key = 'bu40-race-key-0001'$q$);
select dblink_exec('bu40a', 'alter table ops.budget_reservations enable trigger budget_reservations_settle_once');
select dblink_exec('bu40a', $q$update ops.budget_buckets set ceiling_usd = ceiling_usd - 1 where name = 'global'$q$);
select dblink_disconnect('bu40a');
select dblink_disconnect('bu40b');
select is(array[(select val::jsonb ->> 'outcome' from bu40 where step = 1),
                (select val from bu40 where step = 2),
                (select case when val like 'error: %' then val else val::jsonb ->> 'outcome' end from bu40 where step = 3),
                ((select val::jsonb ->> 'id' from bu40 where step = 1)
                   = (select case when val not like 'error: %' then val::jsonb ->> 'id' end from bu40 where step = 3))::text,
                (select count(*) from ops.budget_reservations)::text,
                ((select ceiling_usd from ops.budget_buckets where name = 'global')::text
                   = (select val from bu40 where step = 0))::text],
          array['reserved', 'blocked', 'exists', 'true', '0', 'true'],
  'BU-40 a same-key reservation made while the first is uncommitted waits on the key and returns the first '
  || 'reservation (exists, same id); the committed rows are removed again');

-- ------------------------------------------------------------------ before the plan: the $0 seed
select is(
  array[(select coalesce(string_agg(m, '; '), 'equal') from tests.plan_mismatches((select plan from t_plan), true) m),
        (select string_agg(call_kind, ',' order by call_kind) from ops.call_limits),
        (select count(*) from ops.model_prices where model = 'gemini-3.1-pro-preview')::text,
        (select kill_switch from ops.config)::text],
  array['equal', 'card,deep,final,portrait,referee,subject', '0', 'false'],
  'BU-01 seed: exactly the buckets of --plan-json (the one global bucket, no parent) at $0; the five runtime call '
  || 'kinds plus portrait (no generate or validate, D-014; no retranscribe, D7); no gemini-3.1-pro-preview price');

select tests.throws($$ select ops.set_bucket_ceiling('demo', 'global', 1.00, 'bu21') $$, 'AR007',
  'child bucket ceilings exceed their parent',
  'BU-21 a child above its $0 parent is refused before the plan (tree rule kept for a later split, D-013)');

-- BU-27: every reservation path, for every runtime role that holds it, against every seeded call kind and price,
-- each at its call kind's full input limit (D11: the reservation is sized on bytes).
create function pg_temp.fail_closed_probe() returns table (who text, what text, outcome text)
language plpgsql as $$
declare
  r text;
  c record;
  k text;
  v jsonb;
begin
  foreach r in array array['arena_public', 'arena_subject', 'arena_referee'] loop
    for c in select distinct l.call_kind, l.input_limit, p.model from ops.call_limits l cross join ops.model_prices p
              order by l.call_kind, p.model loop
      v := tests.as_role(r, format('select ops.reserve_model_call(%L, %L, %L, %L, %L, null, %L, %s)',
                                   'bu27-' || r || '-' || c.call_kind || '-' || c.model, 'global', c.model, c.call_kind,
                                   case c.call_kind when 'referee' then 'referee_subject' else c.call_kind || '.probe' end,
                                   tests.uid('A'), c.input_limit));
      who := r; what := 'model_call ' || c.call_kind || ' ' || c.model;
      outcome := concat_ws('/', v ->> 'outcome', v ->> 'reason', v ->> 'bucket');
      return next;
    end loop;
  end loop;
  foreach k in array array['voice_session', 'voice_probe'] loop
    v := tests.as_role('arena_subject', format('select ops.reserve_voice(%L, %L, %L, %L, null, %L)',
                                               'bu27-voice-' || k, 'global', k, 'voice.session', tests.uid('A')));
    who := 'arena_subject'; what := 'voice ' || k; outcome := concat_ws('/', v ->> 'outcome', v ->> 'reason', v ->> 'bucket');
    return next;
  end loop;
  foreach r in array array['arena_public', 'arena_referee'] loop
    v := tests.as_role(r, $q$ select ops.admit_unit('global', 0.01) $q$);
    who := r; what := 'admit_unit global 0.01'; outcome := v ->> 'decision';
    return next;
  end loop;
end $$;
create temp table bu27 on commit drop as select * from pg_temp.fail_closed_probe();
select is_empty($$
  select who || ' ' || what || ' -> ' || coalesce(outcome, 'null') from bu27
   where outcome is distinct from case when what like 'admit_unit %' then 'skip' else 'refused/cap/global' end
  union all
  select 'reservation rows written: ' || count(*) from ops.budget_reservations having count(*) > 0
  union all
  select 'model-call probes: ' || count(*) || ' of ' || 3 * (select count(*) from ops.call_limits l
                                                             cross join (select distinct model from ops.model_prices) p)
    from bu27 where what like 'model_call %'
  having count(*) <> 3 * (select count(*) from ops.call_limits l cross join (select distinct model from ops.model_prices) p)
      or count(distinct split_part(what, ' ', 2)) <> (select count(*) from ops.call_limits)
  union all
  select 'voice and admission probes: ' || count(*) from bu27 where what not like 'model_call %' having count(*) <> 4 $$,
  'BU-27 fail-closed before the plan (D-012): every model-call and voice reservation of every runtime role is '
  || 'refused (cap, global) without writing a row, and admit_unit declines the unit');

-- ------------------------------------------------------------------ the operator applies the plan
create temp table bu28 (step integer, label text, val text) on commit drop;
select tests.apply_plan(plan) from t_plan;
insert into bu28 select 1, 'applied', coalesce(string_agg(m, '; '), 'equal')
  from t_plan, tests.plan_mismatches(t_plan.plan, false) m;
select tests.apply_plan(plan) from t_plan;
insert into bu28 select 2, 're-applied', coalesce(string_agg(m, '; '), 'equal')
  from t_plan, tests.plan_mismatches(t_plan.plan, false) m;
insert into bu28 select 3, 'card into global', tests.as_role('arena_public',
  $$ select ops.reserve_model_call('bu28-card-0001', 'global', 'gemini-3.5-flash-lite', 'card', 'coach.card',
                                   null, null, 128000) $$) ->> 'outcome';
-- gate-proof: a one-cent change to the applied ceiling fails the comparison; then the plan value is restored
select ops.set_bucket_ceiling(e.key, e.value ->> 'parent', (e.value ->> 'ceiling_usd')::numeric + 0.01, 'bu28 gateproof')
  from t_plan, jsonb_each(t_plan.plan) e where e.value ->> 'parent' is null;
insert into bu28 select 4, 'one cent above the plan', count(*)::text
  from t_plan, tests.plan_mismatches(t_plan.plan, false) m;
select tests.apply_plan(plan) from t_plan;
select is((select array_agg(label || ': ' || val order by step) from bu28),
          array['applied: equal', 're-applied: equal', 'card into global: reserved', 'one cent above the plan: 1'],
  'BU-28 the applied ceilings equal --plan-json exactly (names, parents, ceilings); re-applying changes nothing; '
  || 'global then admits a card; gate-proof: a one-cent change makes the comparison fail');

select is(array[(tests.as_role('arena_referee',
                   $$ select ops.reserve_model_call('bu03-ref-00001', 'global', 'gemini-3.5-flash-lite', 'referee',
                                                    'referee_assistant', null, null, 12000) $$) ->> 'reserved_usd'),
                tests.error($$ select ops.reserve_model_call('bu03-gen-00001', 'global', 'gemini-3.5-flash-lite',
                                                             'generate', 'generate.family', null, null, 1000) $$),
                tests.error($$ select ops.reserve_model_call('bu03-val-00001', 'global', 'gemini-3.5-flash-lite',
                                                             'validate', 'validate.family', null, null, 1000) $$),
                tests.error($$ select ops.reserve_model_call('bu03-pro-00001', 'global', 'gemini-3.1-pro-preview',
                                                             'card', 'coach.card', null, null, 1000) $$),
                tests.error($$ select ops.reserve_model_call('bu03-rtr-00001', 'global', 'gemini-3.5-flash-lite',
                                                             'retranscribe', 'voice.retranscribe', null, null, 1000) $$)],
          array['0.054400',
                'AR007: unknown model price or call kind: the call is refused',
                'AR007: unknown model price or call kind: the call is refused',
                'AR007: unknown model price or call kind: the call is refused',
                'AR007: unknown model price or call kind: the call is refused'],
  'BU-03 a referee_assistant call on 3.5-flash-lite at 12,000 bytes reserves 4 x (12000 x 0.30 + 4000 x 2.50) / 1e6; '
  || 'generate, validate, retranscribe and gemini-3.1-pro-preview are refused (D-014, D7)');

set local role arena_public;
select tests.throws($$ select ops.reserve_model_call('bu22-demo-0001', 'demo', 'gemini-3.5-flash-lite', 'card',
                                                     'coach.card', null, null, 1000) $$,
  'AR007', 'unknown or non-leaf bucket demo', 'BU-22 a reservation into a bucket outside the plan is refused');
reset role;

select is(array[tests.error(format('select ops.set_bucket_ceiling(%L, null, %s, %L)', 'global',
                                   (select liability_usd - 0.01 from ops.budget_status() where bucket = 'global'), 'bu24')),
                tests.error($$ select ops.set_bucket_ceiling('global', 'demo', 1.00, 'bu24') $$),
                tests.error($$ select ops.set_bucket_ceiling('later_leaf', 'global', 0, 'bu24') $$)],
          array['AR007: ceiling below the bucket''s current liability',
                'AR007: a bucket keeps its parent',
                'AR007: a bucket holding reservations cannot become a parent'],
  'BU-24 set_bucket_ceiling refuses a ceiling below liability, a parent for global, and a child under global once '
  || 'it holds reservations');

-- BU-42 (D-017): the per-user daily cap is $5.00, against the actor's whole daily liability (holds reserved or
-- usage_unknown at their amount, settled holds at their receipts). Actor D: one voice hold ($3.392520) fits; a second
-- is refused per_user_cap while the first is reserved; a 6,000-byte card ($0.023200) still fits; after the first
-- hold settles committed at $1.800000 of receipts, a second voice hold is still refused (1.80 + 0.0232 + 3.392520 >
-- 5.00). Actor C: a hold settled committed at $0.315000 leaves room for a second (0.315 + 3.392520 <= 5.00). Runs
-- before the other voice rows (the open-voice concurrency count is 2); every hold it leaves open is released.
create temp table bu42 (step integer, val text) on commit drop;
create function pg_temp.bu42_voice(p_key text, p_actor text) returns text
language sql as $$
  select concat_ws('/', r ->> 'outcome', coalesce(r ->> 'reserved_usd', r ->> 'reason'), r ->> 'id')
    from tests.as_role('arena_subject', format('select ops.reserve_voice(%L, %L, %L, %L, null, %L)',
           p_key, 'global', 'voice_session', 'voice.session', tests.uid(p_actor))) r
$$;
-- dispatch a voice hold, record one usage report of p_audio audio-input tokens on the Live model, settle committed
create function pg_temp.bu42_use(p_step integer, p_audio bigint) returns jsonb
language plpgsql as $$
declare
  v_id text := split_part((select val from bu42 where step = p_step), '/', 3);
begin
  perform tests.as_role('arena_subject', format('select ops.mark_dispatched(%L)', v_id));
  perform tests.as_role('arena_subject', format('select ops.record_usage(%L, 1, %L, 0, 0, 0, %s, 0, %L, 100, null, null)',
                                                v_id, 'gemini-3.8-live', p_audio, 'usage'));
  return tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', v_id, 'committed'));
end $$;
create function pg_temp.bu42_release(p_step integer) returns jsonb
language sql as $$
  select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)',
                                               split_part((select val from bu42 where step = p_step), '/', 3), 'released'))
$$;
insert into bu42 select 0, (select per_user_daily_usd from ops.config)::text;
insert into bu42 select 1, pg_temp.bu42_voice('bu42-voice-key-1', 'D');
insert into bu42 select 2, pg_temp.bu42_voice('bu42-voice-key-2', 'D');
insert into bu42 select 3, concat_ws('/', r ->> 'outcome', r ->> 'reserved_usd')
  from tests.as_role('arena_public', format('select ops.reserve_model_call(%L, %L, %L, %L, %L, null, %L, 6000)',
         'bu42-card-key-1', 'global', 'gemini-3.5-flash-lite', 'card', 'coach.card', tests.uid('D'))) r;
insert into bu42 select 4, pg_temp.bu42_use(1, 400000) ->> 'settled_usd';
insert into bu42 select 5, pg_temp.bu42_voice('bu42-voice-key-3', 'D');
insert into bu42 select 6, pg_temp.bu42_voice('bu42-voice-key-4', 'C');
insert into bu42 select 7, pg_temp.bu42_use(6, 70000) ->> 'settled_usd';
insert into bu42 select 8, pg_temp.bu42_voice('bu42-voice-key-5', 'C');
select pg_temp.bu42_release(8);
select is((select array_agg(case when step in (1, 5, 6, 8) then split_part(val, '/', 1) || '/' || split_part(val, '/', 2)
                                 else val end order by step) from bu42),
          array['5.000000', 'reserved/3.392520', 'refused/per_user_cap', 'reserved/0.023200', '1.800000',
                'refused/per_user_cap', 'reserved/3.392520', '0.315000', 'reserved/3.392520'],
  'BU-42 D-017: the $5.00 per-user cap admits one voice hold, refuses a second while the first is reserved and while '
  || 'settled spend plus other liability leaves no room for $3.392520, admits a text card, and admits a second hold '
  || 'when settled spend leaves room');

-- BU-38: four receipts at the reservation's maximum (6,001 input tokens, 1,600 output on a 6,001-byte card) are
-- within the reservation: no overrun, kill switch off. The draft's single rounding reserved $0.023202 for $0.023204.
create temp table bu38 (step integer, val text) on commit drop;
insert into bu38 select 1, tests.as_role('arena_public',
  $$ select ops.reserve_model_call('bu38-card-6001', 'global', 'gemini-3.5-flash-lite', 'card', 'coach.card',
                                   null, null, 6001) $$)::text;
select tests.as_role('arena_public', format('select to_jsonb(ops.mark_dispatched(%L))',
                                              (select val::jsonb ->> 'id' from bu38 where step = 1)));
insert into bu38 select 1 + s, tests.as_role('arena_public', format(
  'select ops.record_usage(%L, %s, %L, 6001, 1600, 0, 0, 0, %L, 100, null, null)',
  (select val::jsonb ->> 'id' from bu38 where step = 1), s, 'gemini-3.5-flash-lite', 'ok')) ->> 'outcome'
  from generate_series(1, 4) s;
select is(array[(select val::jsonb ->> 'reserved_usd' from bu38 where step = 1),
                (select string_agg(val, ',' order by step) from bu38 where step > 1),
                (select kill_switch from ops.config)::text],
          array['0.023204', 'recorded,recorded,recorded,recorded', 'false'],
  'BU-38 a 6,001-byte card reserves 4 x ceil(per attempt) = 0.023204, and four receipts at its maximum record '
  || 'no overrun (kill switch stays off)');

create temp table bu39 (step integer, val text) on commit drop;
insert into bu39 select 1, tests.as_role('arena_public',
  $$ select ops.reserve_model_call('bu39-card-key-1', 'global', 'gemini-3.5-flash-lite', 'card', 'coach.card',
                                   null, null, 1000) $$) ->> 'outcome';
insert into bu39 select 2, tests.error($$ select tests.as_role('arena_public',
  'select ops.reserve_model_call(''bu39-card-key-1'', ''global'', ''gemini-3.5-flash-lite'', ''card'', ''coach.deep'',
                                 null, null, 1000)') $$);
insert into bu39 select 3, tests.as_role('arena_subject',
  $$ select ops.reserve_voice('bu39-voice-key-1', 'global', 'voice_probe', 'voice.probe', null, null) $$) ->> 'outcome';
insert into bu39 select 4, tests.error($$ select tests.as_role('arena_subject',
  'select ops.reserve_voice(''bu39-voice-key-1'', ''global'', ''voice_probe'', ''voice.other'', null, null)') $$);
select is((select array_agg(val order by step) from bu39),
          array['reserved', 'AR003: reservation key reused with different inputs',
                'reserved', 'AR003: reservation key reused with different inputs'],
  'BU-39 a reservation key reused with another purpose is refused (model call and voice), not returned as exists');

-- BU-41: a voice usage report past two thirds of its hold answers shutoff; the same report repeated (its first
-- response lost) answers exists with the same spend and shutoff; the same report number with other usage is AR003.
create temp table bu41 (step integer, val text) on commit drop;
insert into bu41 select 1, tests.as_role('arena_subject',
  $$ select ops.reserve_voice('bu41-probe-key-1', 'global', 'voice_probe', 'voice.probe', null, null) $$) ->> 'id';
select tests.as_role('arena_subject', format('select ops.mark_dispatched(%L)', (select val from bu41 where step = 1)));
create function pg_temp.bu41_report(p_input_audio bigint) returns text
language sql as $$
  select format('select ops.record_usage(%L, 1, %L, 0, 0, 0, %s, 0, %L, 100, null, null)',
                (select val from bu41 where step = 1), 'gemini-3.8-live', p_input_audio, 'usage')
$$;
insert into bu41 select 2, (select concat_ws('/', r ->> 'outcome', r ->> 'spend_usd', r ->> 'shutoff')
                              from tests.as_role('arena_subject', pg_temp.bu41_report(70000)) r);
insert into bu41 select 3, (select concat_ws('/', r ->> 'outcome', r ->> 'spend_usd', r ->> 'shutoff')
                              from tests.as_role('arena_subject', pg_temp.bu41_report(70000)) r);
insert into bu41 select 4, tests.error(format('select tests.as_role(%L, %L)', 'arena_subject',
                                              pg_temp.bu41_report(70001)));
select is((select array_agg(val order by step) from bu41 where step > 1),
          array['recorded/0.315000/true', 'exists/0.315000/true',
                'AR003: usage report number reused with different usage'],
  'BU-41 a repeated usage report returns the same spend and shutoff (exists); other usage under its number is AR003');

select is_empty($$ select * from tests.plan_mismatches((select plan from t_plan), false) $$,
  'BU-29 at the end of the file the bucket table still equals --plan-json (the gate-proof change was restored)');

select * from finish();
rollback;
