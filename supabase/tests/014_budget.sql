-- 014_budget.sql (S4 section 8; sql/TESTS.md section 14; D-009, D-012, D-013, D-014; WI-S4-08)
-- WP-03 rows: the $0 seed of the one global bucket and its fail-closed behavior (BU-01, BU-27), the operator's
-- plan application and its gate-proof (BU-28, BU-29), the tree rules kept for a later per-phase split (BU-21,
-- BU-22, BU-24), and the D-014 and D7 refusals with the referee worst case (BU-03). WP-04b adds the remaining rows of
-- TESTS.md section 14 to this file. No ceiling is typed here: every expected ceiling comes from the psql
-- variable plan, the stdout of `python3 -I -B docs/research/synthesis/cost_model.py --plan-json` (run_pgtap.sh).
-- Numeric parity of the seeds with cost_model.py (prices, limits, voice amounts) is tools/check_cost_parity.py.
begin;
\ir harness/fixtures.psql
select plan(8);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

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

select is_empty($$ select * from tests.plan_mismatches((select plan from t_plan), false) $$,
  'BU-29 at the end of the file the bucket table still equals --plan-json (the gate-proof change was restored)');

select * from finish();
rollback;
