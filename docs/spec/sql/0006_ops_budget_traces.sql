-- =============================================================================
-- 0006_ops_budget_traces.sql  (DRAFT v2.8, spec S4; applied only to throwaway local PostgreSQL 17.11 containers)
-- Spend guard (D-009, D-013): one global ceiling (the root of a bucket tree that stays available for
-- per-phase limits later), liability prices, per-call-type
-- request limits, reservations held before any model call or voice session and settled from usage,
-- unit admission, the single cost ledger (ops.model_calls), kill switch with history, KPI-4 latency
-- samples, the trace mirror and its summaries, keep-alive.
-- Requirements: BKO-1 (equal budgets), BKO-8 (volume set by approved spend), BKO-9 and EVL-5
-- (cost and latency disclosed), KPI-4, D-008, D-009.
--
-- Adapted from TechnoMile supabase/migrations/20260927000300_budget_cost_tables.sql lines 13-104
-- and 148-179 (immutable prices, settle-once trigger, receipts never exceed the reservation),
-- 20260927000600_run_ledger_rpcs.sql lines 746-760 and 806-833 (key reuse refused; cap check
-- counts open and unknown at reserved, committed at settled, released at 0; refusal RETURNED so it
-- commits), 20261003000100_model_call_receipts.sql lines 33-34 (round cost up to 6 dp), and
-- 20260927001000_trace_mirror.sql lines 57-115 (span rows, trace summaries with derived
-- telemetry_incomplete).
--
-- Bucket ceilings (D-012, D-013): this migration seeds one bucket, `global`, at $0, so nothing can
-- reserve until the operator applies cost_model.budget_plan() (printed by
-- `python3 -I -B docs/research/synthesis/cost_model.py --plan-json`, which is {"global": ...})
-- through ops.set_bucket_ceiling. No ceiling is typed here; a test asserts the applied ceiling equals
-- the --plan-json output. Every reservation names bucket 'global'. Per-phase buckets are deferred
-- (D-013); the tree functions below stay so they can be added later without a schema change.
-- Other seeds come from docs/research/synthesis/cost_model.py (`python3 -I -B cost_model.py`, run
-- 2026-10-09; SG3-35): voice whole-session reservation VOICE_RESERVATION = 3.39252 (seeded 3.392520; the
-- shutoff is two thirds of the reservation, VOICE_SHUTOFF = 2.26168, computed as round(reserved * 2 / 3, 6));
-- probe PROBE_RESERVATION = 0.42494 (seeded 0.424940);
--   VOICE_SESSIONS 8, LIVE_PROBE[0] 30, LIMITS per runtime call type, ATTEMPTS 4, LIABILITY_PRICES (3.8 Flash
--   undiscounted; Live = VOICE rates x 1.5). VOICE_RESERVATION still includes 12 card and one
--   retranscription allowance; cards now reserve on their own against global and retranscription is gone
--   (D7), so the voice hold over-reserves until cost tuning resumes (D-013); over-reserving is safe.
-- D-014: case families are authored offline (Claude agents, Codex review), so no runtime call generates or
-- validates a case: the 'generate' and 'validate' LIMITS rows and the gemini-3.1-pro-preview price are not
-- seeded, and a reservation for them is refused (AR007, unknown call kind or model).
-- One call_limits row is not in cost_model.LIMITS: 'portrait' carries initial values, tuned in the dev
-- pilot (S5 3.3); its price arrives as a new ops.model_prices row. Voice is unscored (D7), so there is no
-- retranscription call. Input limits bound the UTF-8 byte length of the largest request a call may send
-- (tokens never exceed bytes; D11), and every reservation prices that byte length, not an estimate.
-- S5's tools/check_cost_parity.py asserts these seeds equal cost_model.py (and S5 3.3 for the initial-value
-- row). Change them with a new migration, never by hand.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Configuration (one row). Kill switch is read on every reservation, dispatch and admission.
-- -----------------------------------------------------------------------------
create table ops.config (
  id                            boolean primary key default true check (id),
  kill_switch                   boolean not null default false,
  kill_reason                   text,
  attempts_per_call             smallint not null check (attempts_per_call between 1 and 10),
  voice_session_reservation_usd ops.usd not null,
  voice_probe_reservation_usd   ops.usd not null,
  voice_sessions_total          smallint not null check (voice_sessions_total >= 0),
  voice_probes_total            smallint not null check (voice_probes_total >= 0),
  max_open_voice_sessions       smallint not null check (max_open_voice_sessions >= 1),
  -- S4-D3 (rate-limit class; global gate requires owner approval). per_user_daily_usd is the owner's $5.00
  -- (D-017): one voice session's hold (VOICE_RESERVATION = 3.39) fits per user per day with room for text; a
  -- further voice hold is admitted only while the actor's daily liability (open and usage_unknown holds at
  -- their amount, settled ones at their receipts) plus 3.39 stays within 5.00, so a second is refused
  -- per_user_cap while the first hold is open (5.00 - 3.39 < 3.39). The quotas are initial values, tuned in
  -- the dev pilot; null disables a check.
  per_user_daily_usd            ops.usd,
  text_sessions_per_user_day    smallint check (text_sessions_per_user_day >= 1),
  voice_sessions_per_user_day   smallint check (voice_sessions_per_user_day >= 1),
  updated_at                    timestamptz not null default now()
);
insert into ops.config (attempts_per_call, voice_session_reservation_usd, voice_probe_reservation_usd,
                        voice_sessions_total, voice_probes_total, max_open_voice_sessions,
                        per_user_daily_usd, text_sessions_per_user_day, voice_sessions_per_user_day)
  values (4, 3.392520, 0.424940, 8, 30, 2, 5.00, 5, 2);

create table ops.kill_switch_events (
  id         bigint generated always as identity primary key,
  turned_on  boolean not null,
  reason     text not null check (length(reason) between 1 and 500),
  actor      text not null default session_user,
  created_at timestamptz not null default now()
);
create trigger kill_switch_events_append_only before update or delete on ops.kill_switch_events
  for each row execute function arena.tg_forbid_mutation();

-- -----------------------------------------------------------------------------
-- Buckets (D-012, D-013). The seed is the root alone: `global`, the shape of cost_model.budget_plan().
-- Reservations go to leaf buckets only; with the root alone, `global` is the leaf every reservation
-- names. A reservation is admitted when it fits the leaf and every ancestor (subtree liability +
-- amount <= ceiling). If per-phase limits are wanted later, ops.set_bucket_ceiling adds children
-- (children's ceilings never sum above their parent; a bucket holding reservations cannot become a
-- parent). The ceiling starts at $0 (fail-closed); the operator applies the plan.
-- -----------------------------------------------------------------------------
create table ops.budget_buckets (
  name        text primary key check (name ~ '^[a-z][a-z0-9_]{0,31}$'),
  parent      text references ops.budget_buckets(name) on delete restrict,
  ceiling_usd ops.usd not null,
  note        text not null,
  constraint bucket_root_shape check ((name = 'global') = (parent is null))
);
create or replace function ops.tg_bucket_sum() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from ops.budget_buckets p
              where p.ceiling_usd < (select coalesce(sum(c.ceiling_usd), 0) from ops.budget_buckets c where c.parent = p.name)) then
    raise exception using errcode = 'AR007', message = 'child bucket ceilings exceed their parent';
  end if;
  return null;
end $$;
create constraint trigger budget_buckets_sum after insert or update on ops.budget_buckets
  for each row execute function ops.tg_bucket_sum();
create trigger budget_buckets_no_delete before delete on ops.budget_buckets
  for each row execute function arena.tg_forbid_mutation();
insert into ops.budget_buckets (name, parent, ceiling_usd, note) values
  ('global', null, 0, 'budget_plan()["global"]: CAP minus the non-model allowance of the hosting mode');

alter table arena.tournaments
  add constraint tournaments_bucket_fk foreign key (budget_bucket) references ops.budget_buckets(name) on delete restrict;

-- Liability prices per 1M tokens (undiscounted list; Live = list x 1.5 until the Vertex Live price is confirmed).
create table ops.model_prices (
  model           text not null check (length(model) between 1 and 100),
  effective_from  date not null,
  text_in         ops.usd not null,
  text_out        ops.usd not null,     -- thinking bills as output
  audio_in        ops.usd,
  audio_out       ops.usd,
  source          text not null,
  primary key (model, effective_from)
);
create trigger model_prices_immutable before update or delete on ops.model_prices
  for each row execute function arena.tg_forbid_mutation();
insert into ops.model_prices (model, effective_from, text_in, text_out, audio_in, audio_out, source) values
  ('gemini-3.1-flash-lite', '2026-10-08', 0.25, 1.50, null, null, 'cost_model.py LIABILITY_PRICES'),
  ('gemini-3.5-flash-lite', '2026-10-08', 0.30, 2.50, null, null, 'cost_model.py LIABILITY_PRICES'),
  ('gemini-3.8-flash', '2026-10-08', 1.50, 7.50, null, null, 'cost_model.py LIABILITY_PRICES (undiscounted)'),
  ('gemini-3.8-live', '2026-10-08', 1.125, 6.75, 4.50, 18.00, 'cost_model.py VOICE x 1.5 (Vertex price unconfirmed)'),
  ('gemini-live-2.5-flash-native-audio', '2026-10-08', 1.125, 6.75, 4.50, 18.00, 'cost_model.py VOICE x 1.5 (unconfirmed)');

-- Request limits per call type: input_limit bounds the UTF-8 byte length of the largest request a call
-- may send, including the one repair re-prompt (D11; a token covers at least one byte, so bytes bound
-- tokens), and max_output_tokens = output_limit (bounds thinking plus visible output). The first five rows
-- equal cost_model.LIMITS exactly (its 'generate' and 'validate' rows are not runtime calls, D-014).
-- 'portrait' (C-31, X-09) holds initial values, tuned in the dev pilot (S5 3.3): input 2000 (prompt),
-- output 2000 (one image's output tokens); it cannot reserve until its model has an ops.model_prices row.
create table ops.call_limits (
  call_kind    text primary key check (call_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  input_limit  integer not null check (input_limit > 0),
  output_limit integer not null check (output_limit > 0)
);
create trigger call_limits_immutable before update or delete on ops.call_limits
  for each row execute function arena.tg_forbid_mutation();
insert into ops.call_limits (call_kind, input_limit, output_limit) values
  ('subject', 80000, 1600), ('card', 128000, 1600), ('deep', 128000, 3000), ('final', 128000, 3000),
  ('referee', 160000, 4000), ('portrait', 2000, 2000);

-- -----------------------------------------------------------------------------
-- Reservations
-- kind model_call: one logical call, all attempts (first try, one repair, two transient retries).
-- kind voice_session / voice_probe: the whole-session worst case, reserved before the Live session
-- opens. A coaching card during a voice session reserves on its own against global like any other card
-- (no parent reservation; D7 removed retranscription).
-- caller_role is the runtime role that made the reservation; only that role dispatches, records usage
-- for and settles it (SG3-11). A voice reservation settles only through ops.settle_voice_reservation,
-- after its voice session closed.
-- -----------------------------------------------------------------------------
create table ops.budget_reservations (
  id              uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 200),
  bucket          text not null references ops.budget_buckets(name) on delete restrict,
  kind            text not null check (kind in ('model_call', 'voice_session', 'voice_probe')),
  model           text,
  call_kind       text references ops.call_limits(call_kind) on delete restrict,
  input_bytes     integer check (input_bytes > 0),      -- D11: UTF-8 bytes of the largest request
  purpose         text not null check (length(purpose) between 1 and 200),
  trial_id        uuid references arena.trials(id) on delete restrict,
  actor_user_id   uuid references auth.users(id) on delete restrict,
  caller_role     text not null,
  reserved_usd    ops.usd not null,
  state           text not null default 'reserved' check (state in ('reserved', 'committed', 'released', 'usage_unknown')),
  settled_usd     ops.usd,
  overrun         boolean not null default false,
  created_at      timestamptz not null default now(),
  dispatched_at   timestamptz,
  settled_at      timestamptz,
  constraint reservation_kind_shape check ((kind = 'model_call') = (model is not null and call_kind is not null
                                                                   and input_bytes is not null)),
  constraint reservation_settled_shape check ((state = 'reserved') = (settled_usd is null and settled_at is null)),
  constraint reservation_released_shape check (state <> 'released' or (settled_usd = 0 and dispatched_at is null)),
  constraint reservation_unknown_full check (state <> 'usage_unknown' or settled_usd = reserved_usd)
);
create index budget_reservations_bucket_idx on ops.budget_reservations (bucket);
create index budget_reservations_open_voice_idx on ops.budget_reservations (created_at)
  where kind <> 'model_call' and state = 'reserved';
create index budget_reservations_actor_idx on ops.budget_reservations (actor_user_id, created_at) where actor_user_id is not null;

-- Settle-once and immutable identity (TechnoMile 20260927000300 lines 85-106).
create or replace function ops.tg_reservation_settle_once() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'AR010', message = 'reservations are never deleted';
  end if;
  if old.state <> 'reserved' then
    raise exception using errcode = 'AR010', message = format('reservation %s already settled (%s)', old.id, old.state);
  end if;
  if (new.id, new.idempotency_key, new.bucket, new.kind, new.model, new.call_kind, new.input_bytes, new.purpose,
      new.trial_id, new.actor_user_id, new.caller_role, new.reserved_usd, new.created_at)
     is distinct from
     (old.id, old.idempotency_key, old.bucket, old.kind, old.model, old.call_kind, old.input_bytes, old.purpose,
      old.trial_id, old.actor_user_id, old.caller_role, old.reserved_usd, old.created_at) then
    raise exception using errcode = 'AR010', message = 'reservation identity is immutable';
  end if;
  if old.dispatched_at is not null and new.dispatched_at is distinct from old.dispatched_at then
    raise exception using errcode = 'AR010', message = 'dispatch time is written once';
  end if;
  return new;
end $$;
create trigger budget_reservations_settle_once before update or delete on ops.budget_reservations
  for each row execute function ops.tg_reservation_settle_once();

-- The single cost source: one row per model-call attempt (seq = attempt) or per voice usage
-- report (seq = report number). Cost is computed here from the price row, never supplied by callers.
create table ops.model_calls (
  id                  uuid primary key default gen_random_uuid(),
  reservation_id      uuid not null references ops.budget_reservations(id) on delete restrict,
  seq                 integer not null check (seq >= 1),
  model               text not null,
  price_from          date not null,
  input_tokens        bigint not null default 0 check (input_tokens >= 0),
  output_tokens       bigint not null default 0 check (output_tokens >= 0),   -- includes thinking
  thinking_tokens     bigint not null default 0 check (thinking_tokens >= 0 and thinking_tokens <= output_tokens),
  audio_input_tokens  bigint not null default 0 check (audio_input_tokens >= 0),
  audio_output_tokens bigint not null default 0 check (audio_output_tokens >= 0),
  cost_usd            ops.usd not null,
  status              text not null check (status in ('ok', 'error', 'timeout', 'refused', 'usage')),
  latency_ms          integer check (latency_ms >= 0),
  trace_id            text check (trace_id ~ '^[0-9a-f]{32}$'),
  span_id             text check (span_id ~ '^[0-9a-f]{16}$'),
  created_at          timestamptz not null default clock_timestamp(),
  unique (reservation_id, seq),
  foreign key (model, price_from) references ops.model_prices(model, effective_from) on delete restrict
);
create trigger model_calls_append_only before update or delete on ops.model_calls
  for each row execute function arena.tg_forbid_mutation();

-- Liability of a reservation: open and unknown at reserved, committed at settled, released at 0.
create or replace function ops.liability(p_state text, p_reserved numeric, p_settled numeric)
returns numeric
language sql immutable set search_path = '' as $$
  select case p_state when 'reserved' then p_reserved when 'usage_unknown' then p_reserved
                      when 'committed' then p_settled else 0 end
$$;

-- Liability of a bucket subtree (reservations in the bucket or any descendant).
create or replace function ops.subtree_liability(p_bucket text)
returns numeric
language sql stable set search_path = '' as $$
  with recursive d as (
    select name from ops.budget_buckets where name = p_bucket
    union all
    select b.name from ops.budget_buckets b join d on b.parent = d.name
  )
  select coalesce(sum(ops.liability(r.state, r.reserved_usd, r.settled_usd)), 0)
    from ops.budget_reservations r where r.bucket in (select name from d)
$$;

-- Spend recorded on a reservation: the sum of its usage receipts.
create or replace function ops.receipts_usd(p_reservation uuid)
returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(cost_usd), 0) from ops.model_calls where reservation_id = p_reservation
$$;

-- The runtime role that made this call (SG3-11). Inside a SECURITY DEFINER function current_user is the
-- owner, so the caller is the session's SET ROLE target when one is set (the test harness), else the
-- login role (a runtime process). Runtime roles are NOINHERIT members of nothing, so neither can be forged.
create or replace function ops.invoker_role()
returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('role', true), 'none'), session_user::text)
$$;

create or replace function ops.price_row(p_model text)
returns ops.model_prices
language sql stable set search_path = '' as $$
  select * from ops.model_prices where model = p_model and effective_from <= current_date
   order by effective_from desc limit 1
$$;

-- Bucket admission (internal). Locks the leaf and every ancestor, root first (lock order), then
-- checks each subtree, then the actor's daily cap.
create or replace function ops._admit(p_bucket text, p_amount numeric, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_cfg   ops.config;
  a       record;
  v_used  numeric;
  v_aused numeric;
begin
  select * into v_cfg from ops.config where id;
  if v_cfg.kill_switch then
    return jsonb_build_object('outcome', 'refused', 'reason', 'kill_switch');
  end if;
  if not exists (select 1 from ops.budget_buckets where name = p_bucket)
     or exists (select 1 from ops.budget_buckets where parent = p_bucket) then
    raise exception using errcode = 'AR007', message = format('unknown or non-leaf bucket %s', p_bucket);
  end if;
  for a in
    with recursive anc as (
      select name, parent, ceiling_usd, 0 as depth from ops.budget_buckets where name = p_bucket
      union all
      select b.name, b.parent, b.ceiling_usd, anc.depth + 1 from ops.budget_buckets b join anc on b.name = anc.parent
    )
    select b.name, b.ceiling_usd from ops.budget_buckets b join anc on anc.name = b.name
     order by anc.depth desc
       for update of b
  loop
    v_used := ops.subtree_liability(a.name);
    if v_used + p_amount > a.ceiling_usd then
      return jsonb_build_object('outcome', 'refused', 'reason', 'cap', 'bucket', a.name, 'used_usd', v_used,
                                'ceiling_usd', a.ceiling_usd, 'requested_usd', p_amount);
    end if;
  end loop;
  if p_actor is not null and v_cfg.per_user_daily_usd is not null then
    select coalesce(sum(ops.liability(state, reserved_usd, settled_usd)), 0) into v_aused
      from ops.budget_reservations
     where actor_user_id = p_actor and created_at >= date_trunc('day', now());
    if v_aused + p_amount > v_cfg.per_user_daily_usd then
      return jsonb_build_object('outcome', 'refused', 'reason', 'per_user_cap', 'used_usd', v_aused,
                                'requested_usd', p_amount);
    end if;
  end if;
  return jsonb_build_object('outcome', 'admitted');
end $$;

-- -----------------------------------------------------------------------------
-- reserve_model_call (all runtime roles; S5 "reserve_spend"). The worst case is derived here:
-- attempts x (input_bytes x text_in + output_limit x text_out) / 1e6, rounded up to 6 dp. input_bytes is
-- the UTF-8 byte length of the largest request the call may send, its one repair re-prompt included
-- (D11, SG3-10): a size the port measures, bounded here by the call kind's input_limit; the amount is
-- still computed only in the database. The port refuses to dispatch any request longer than the bytes
-- it reserved. A refusal is returned (not raised). Idempotent per key: a repeat returns the reservation
-- with its state and whether it was dispatched, so a restarted caller can settle an uncertain dispatch
-- as usage_unknown before it reserves again (S5 5.1).
-- -----------------------------------------------------------------------------
create or replace function ops.reserve_model_call(p_idempotency_key text, p_bucket text, p_model text, p_call_kind text,
                                                  p_purpose text, p_trial uuid, p_actor uuid, p_input_bytes integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ex     ops.budget_reservations;
  v_price  ops.model_prices;
  v_lim    ops.call_limits;
  v_worst  numeric;
  v_adm    jsonb;
  v_id     uuid;
begin
  perform ledger.require_read_committed();
  -- WP-03 fix 2: one reservation key at a time. Two calls with the same key both missed the lookup under READ COMMITTED
  -- and the second then hit the unique key (23505) or a cap refusal instead of returning the first reservation.
  perform pg_advisory_xact_lock(hashtextextended('ops.budget_reservations:' || p_idempotency_key, 0));
  select * into v_ex from ops.budget_reservations where idempotency_key = p_idempotency_key;
  if found then
    -- WP-03 fix 3: the purpose is part of the reservation's identity.
    if (v_ex.kind, v_ex.bucket, v_ex.model, v_ex.call_kind, v_ex.purpose, v_ex.trial_id, v_ex.actor_user_id, v_ex.input_bytes,
        v_ex.caller_role)
       is distinct from ('model_call', p_bucket, p_model, p_call_kind, p_purpose, p_trial, p_actor, p_input_bytes,
                         ops.invoker_role()) then
      raise exception using errcode = 'AR003', message = 'reservation key reused with different inputs';
    end if;
    return jsonb_build_object('outcome', 'exists', 'id', v_ex.id, 'state', v_ex.state, 'reserved_usd', v_ex.reserved_usd,
                              'dispatched', v_ex.dispatched_at is not null);
  end if;
  v_price := ops.price_row(p_model);
  select * into v_lim from ops.call_limits where call_kind = p_call_kind;
  if v_price.model is null or v_lim.call_kind is null then
    raise exception using errcode = 'AR007', message = 'unknown model price or call kind: the call is refused';
  end if;
  -- C-31, X-02: the four referee calls are purpose labels on call kind referee (S2 section 2).
  if p_call_kind = 'referee'
     and p_purpose not in ('referee_subject', 'referee_assistant', 'r3_subject', 'r3_investigator') then
    raise exception using errcode = 'AR007',
      message = 'a referee call has purpose referee_subject, referee_assistant, r3_subject or r3_investigator';
  end if;
  if p_input_bytes is null or p_input_bytes < 1 or p_input_bytes > v_lim.input_limit then
    raise exception using errcode = 'AR007', message = format('input of %s bytes is outside the %s call''s limit of %s',
                                                               p_input_bytes, p_call_kind, v_lim.input_limit);
  end if;
  -- WP-03 fix 1: attempts x the per-attempt worst case rounded up to the micro-dollar, the way ops.record_usage rounds
  -- each receipt, so the receipts of every permitted attempt never exceed the reservation.
  v_worst := ((select attempts_per_call from ops.config where id)
              * ceil(p_input_bytes * v_price.text_in + v_lim.output_limit * v_price.text_out) / 1000000)::numeric(14, 6);
  v_adm := ops._admit(p_bucket, v_worst, p_actor);
  if v_adm ->> 'outcome' <> 'admitted' then
    return v_adm;
  end if;
  insert into ops.budget_reservations (idempotency_key, bucket, kind, model, call_kind, input_bytes, purpose, trial_id,
                                       actor_user_id, caller_role, reserved_usd)
    values (p_idempotency_key, p_bucket, 'model_call', p_model, p_call_kind, p_input_bytes, p_purpose, p_trial, p_actor,
            ops.invoker_role(), v_worst)
    returning id into v_id;
  return jsonb_build_object('outcome', 'reserved', 'id', v_id, 'reserved_usd', v_worst);
end $$;

-- Lock a reservation for a state change by the role that made it (SG3-11); AR040 for any other role.
create or replace function ops._own_reservation(p_reservation uuid)
returns ops.budget_reservations
language plpgsql security definer set search_path = '' as $$
declare
  v ops.budget_reservations;
begin
  select * into v from ops.budget_reservations where id = p_reservation for update;
  if v.id is null then
    raise exception using errcode = 'AR001', message = 'reservation not found';
  end if;
  if v.caller_role is distinct from ops.invoker_role() then
    raise exception using errcode = 'AR040', message = 'only the role that made a reservation may use it';
  end if;
  return v;
end $$;

-- mark_dispatched: recorded before the provider call; the kill switch is read again here.
create or replace function ops.mark_dispatched(p_reservation uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ops.budget_reservations;
begin
  perform ledger.require_read_committed();
  v := ops._own_reservation(p_reservation);
  if v.state <> 'reserved' then
    return jsonb_build_object('outcome', 'already_settled', 'state', v.state);
  end if;
  if (select kill_switch from ops.config where id) then
    return jsonb_build_object('outcome', 'refused', 'reason', 'kill_switch');
  end if;
  if v.dispatched_at is not null then
    return jsonb_build_object('outcome', 'already_dispatched');
  end if;
  update ops.budget_reservations set dispatched_at = now() where id = p_reservation;
  return jsonb_build_object('outcome', 'dispatched');
end $$;

-- record_usage (S5 "record_model_call" and "meter_voice"): one receipt per attempt (model_call) or
-- usage report (voice), by the reservation's own role. Cost computed from the price row. Receipts beyond
-- the reservation are still recorded (the money is spent), the reservation is flagged overrun and the
-- kill switch engages: an overrun means a limit or price assumption is wrong, so all spending stops
-- until the owner looks. For voice reservations the result carries shutoff = spend >= two thirds of the
-- reservation (cost_model.VOICE_SHUTOFF = VOICE_RESERVATION * 2 / 3), or the kill switch is on.
create or replace function ops.record_usage(p_reservation uuid, p_seq integer, p_model text, p_input_tokens bigint,
                                            p_output_tokens bigint, p_thinking_tokens bigint, p_audio_input_tokens bigint,
                                            p_audio_output_tokens bigint, p_status text, p_latency_ms integer,
                                            p_trace_id text, p_span_id text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v       ops.budget_reservations;
  v_cfg   ops.config;
  v_price ops.model_prices;
  v_cost  numeric;
  v_spend numeric;
  v_ex    ops.model_calls;
begin
  perform ledger.require_read_committed();
  v := ops._own_reservation(p_reservation);
  if v.dispatched_at is null then
    raise exception using errcode = 'AR001', message = 'usage for a reservation that was never dispatched';
  end if;
  select * into v_ex from ops.model_calls where reservation_id = p_reservation and seq = p_seq;
  if found then
    -- WP-03 fix 4: a repeated report must be the same report (else AR003), and it returns the full metering answer as it
    -- stands now (spend, reservation, shutoff), so a caller whose first response was lost still learns to stop.
    if (v_ex.model, v_ex.input_tokens, v_ex.output_tokens, v_ex.thinking_tokens, v_ex.audio_input_tokens,
        v_ex.audio_output_tokens)
       is distinct from (p_model, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), coalesce(p_thinking_tokens, 0),
                         coalesce(p_audio_input_tokens, 0), coalesce(p_audio_output_tokens, 0)) then
      raise exception using errcode = 'AR003', message = 'usage report number reused with different usage';
    end if;
    select * into v_cfg from ops.config where id;
    v_spend := ops.receipts_usd(p_reservation);
    return jsonb_build_object('outcome', 'exists', 'cost_usd', v_ex.cost_usd, 'spend_usd', v_spend,
                              'reserved_usd', v.reserved_usd,
                              'shutoff', v.overrun or (v.kind <> 'model_call'
                                                       and (v_spend >= v.reserved_usd * 2 / 3 or v_cfg.kill_switch)));
  end if;
  if v.state <> 'reserved' then
    raise exception using errcode = 'AR001', message = 'reservation already settled: receipts are sealed';
  end if;
  select * into v_cfg from ops.config where id;
  if v.kind = 'model_call' and (p_seq > v_cfg.attempts_per_call or p_model <> v.model) then
    raise exception using errcode = 'AR007', message = 'attempt beyond the allowed count, or a different model';
  end if;
  v_price := ops.price_row(p_model);
  if v_price.model is null then
    raise exception using errcode = 'AR007', message = 'unknown model price';
  end if;
  v_cost := (ceil(coalesce(p_input_tokens, 0) * v_price.text_in + coalesce(p_output_tokens, 0) * v_price.text_out
                  + coalesce(p_audio_input_tokens, 0) * coalesce(v_price.audio_in, v_price.text_in)
                  + coalesce(p_audio_output_tokens, 0) * coalesce(v_price.audio_out, v_price.text_out)) / 1000000)::numeric(14, 6);
  insert into ops.model_calls (reservation_id, seq, model, price_from, input_tokens, output_tokens, thinking_tokens,
                               audio_input_tokens, audio_output_tokens, cost_usd, status, latency_ms, trace_id, span_id)
    values (p_reservation, p_seq, p_model, v_price.effective_from, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0),
            coalesce(p_thinking_tokens, 0), coalesce(p_audio_input_tokens, 0), coalesce(p_audio_output_tokens, 0), v_cost,
            p_status, greatest(p_latency_ms, 0),
            case when p_trace_id ~ '^[0-9a-f]{32}$' then p_trace_id end,
            case when p_span_id ~ '^[0-9a-f]{16}$' then p_span_id end);
  v_spend := ops.receipts_usd(p_reservation);
  if v_spend > v.reserved_usd then
    update ops.budget_reservations set overrun = true where id = p_reservation and not overrun;
    update ops.config set kill_switch = true, kill_reason = format('reservation %s overrun', p_reservation),
                          updated_at = now() where id;
    insert into ops.kill_switch_events (turned_on, reason) values (true, format('reservation %s overrun', p_reservation));
    return jsonb_build_object('outcome', 'overrun', 'cost_usd', v_cost, 'spend_usd', v_spend,
                              'reserved_usd', v.reserved_usd, 'shutoff', true);
  end if;
  return jsonb_build_object('outcome', 'recorded', 'cost_usd', v_cost, 'spend_usd', v_spend, 'reserved_usd', v.reserved_usd,
                            'shutoff', v.kind <> 'model_call'
                                       and (v_spend >= v.reserved_usd * 2 / 3 or v_cfg.kill_switch));
end $$;

-- Settlement (internal): committed = receipts; usage_unknown keeps the full reservation (or the receipts,
-- if they are larger: then it is committed at the receipts); released only if never dispatched and
-- without receipts. Settles once.
create or replace function ops._settle(v ops.budget_reservations, p_outcome text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_n      integer;
  v_settle numeric;
begin
  if v.state <> 'reserved' then
    return jsonb_build_object('outcome', 'already_settled', 'state', v.state, 'settled_usd', v.settled_usd);
  end if;
  if p_outcome is null or p_outcome not in ('committed', 'released', 'usage_unknown') then
    raise exception using errcode = 'AR007', message = 'settle as committed, released or usage_unknown';
  end if;
  select count(*) into v_n from ops.model_calls where reservation_id = v.id;
  if p_outcome = 'released' and (v.dispatched_at is not null or v_n > 0) then
    raise exception using errcode = 'AR001', message = 'a started reservation is not releasable';
  end if;
  if p_outcome = 'committed' and v_n = 0 and v.kind = 'model_call' then
    raise exception using errcode = 'AR007', message = 'a committed call needs its usage receipts';
  end if;
  v_settle := case p_outcome
                when 'released' then 0
                when 'usage_unknown' then greatest(v.reserved_usd, ops.receipts_usd(v.id))
                else ops.receipts_usd(v.id)
              end;
  if p_outcome = 'usage_unknown' and v_settle > v.reserved_usd then
    p_outcome := 'committed';
  end if;
  update ops.budget_reservations set state = p_outcome, settled_usd = v_settle, settled_at = now() where id = v.id;
  return jsonb_build_object('outcome', p_outcome, 'settled_usd', v_settle);
end $$;

-- settle_reservation (all runtime roles; S5 "settle_spend"): a model-call reservation, by its own role.
create or replace function ops.settle_reservation(p_reservation uuid, p_outcome text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ops.budget_reservations;
begin
  perform ledger.require_read_committed();
  v := ops._own_reservation(p_reservation);
  if v.kind <> 'model_call' then
    raise exception using errcode = 'AR001', message = 'a voice reservation settles through settle_voice_reservation';
  end if;
  return ops._settle(v, p_outcome);
end $$;

-- admit_unit (arena_public, arena_referee): soft completeness rule, direction 8.3. Admit a unit
-- (block, replay chunk, family) only if every bucket on its path has at least 1.5 x the unit's high
-- cost free. Holds nothing: each call inside the unit still reserves its own worst case.
create or replace function ops.admit_unit(p_bucket text, p_high_cost_usd numeric)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_free numeric;
begin
  if (select kill_switch from ops.config where id) then
    return jsonb_build_object('decision', 'skip', 'reason', 'kill_switch');
  end if;
  with recursive anc as (
    select name, parent, ceiling_usd from ops.budget_buckets where name = p_bucket
    union all
    select b.name, b.parent, b.ceiling_usd from ops.budget_buckets b join anc on b.name = anc.parent
  )
  select min(ceiling_usd - ops.subtree_liability(name)) into v_free from anc;
  if v_free is null then
    raise exception using errcode = 'AR007', message = format('unknown bucket %s', p_bucket);
  end if;
  return jsonb_build_object('decision', case when v_free >= 1.5 * p_high_cost_usd then 'admit' else 'skip' end,
                            'free_usd', v_free, 'needed_usd', 1.5 * p_high_cost_usd);
end $$;

-- -----------------------------------------------------------------------------
-- Voice (arena_subject): reserve the whole-session worst case before the Live session opens.
-- Totals from cost_model.py (VOICE_SESSIONS, LIVE_PROBE) and the open-session cap. A voice reservation
-- still open 60 minutes after it was made belongs to a process that died (no session runs that long:
-- 480 s of audio, a 90 s idle close); the next reserve_voice closes its session ('expired') and settles
-- it usage_unknown, which keeps its full hold, so a crash never blocks a concurrency slot for good.
-- -----------------------------------------------------------------------------
create or replace function ops.reserve_voice(p_idempotency_key text, p_bucket text, p_kind text, p_purpose text,
                                             p_trial uuid, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_ex  ops.budget_reservations;
  v_cfg ops.config;
  v_amt numeric;
  v_adm jsonb;
  v_id  uuid;
  r     ops.budget_reservations;
begin
  perform ledger.require_read_committed();
  -- WP-03 fix 2: one reservation key at a time. Two calls with the same key both missed the lookup under READ COMMITTED
  -- and the second then hit the unique key (23505) or a cap refusal instead of returning the first reservation.
  perform pg_advisory_xact_lock(hashtextextended('ops.budget_reservations:' || p_idempotency_key, 0));
  select * into v_ex from ops.budget_reservations where idempotency_key = p_idempotency_key;
  if found then
    -- WP-03 fix 3: the purpose is part of the reservation's identity.
    if (v_ex.kind, v_ex.bucket, v_ex.purpose, v_ex.trial_id, v_ex.actor_user_id, v_ex.caller_role)
       is distinct from (p_kind, p_bucket, p_purpose, p_trial, p_actor, ops.invoker_role()) then
      raise exception using errcode = 'AR003', message = 'reservation key reused with different inputs';
    end if;
    return jsonb_build_object('outcome', 'exists', 'id', v_ex.id, 'state', v_ex.state, 'reserved_usd', v_ex.reserved_usd);
  end if;
  if p_kind is null or p_kind not in ('voice_session', 'voice_probe') then
    raise exception using errcode = 'AR007', message = 'kind must be voice_session or voice_probe';
  end if;
  for r in select * from ops.budget_reservations
            where kind <> 'model_call' and state = 'reserved' and created_at < now() - interval '60 minutes'
            for update loop
    update training.voice_sessions set status = 'closed', close_code = 'expired', closed_at = now()
     where reservation_id = r.id and status = 'open';
    perform ops._settle(r, 'usage_unknown');
  end loop;
  select * into v_cfg from ops.config where id;
  v_amt := case p_kind when 'voice_session' then v_cfg.voice_session_reservation_usd else v_cfg.voice_probe_reservation_usd end;
  v_adm := ops._admit(p_bucket, v_amt, p_actor);      -- locks the bucket path: serializes the counts below
  if v_adm ->> 'outcome' <> 'admitted' then
    return v_adm;
  end if;
  if (select count(*) from ops.budget_reservations where kind in ('voice_session', 'voice_probe') and state = 'reserved')
     >= v_cfg.max_open_voice_sessions then
    return jsonb_build_object('outcome', 'refused', 'reason', 'voice_concurrency');
  end if;
  if (select count(*) from ops.budget_reservations where kind = p_kind and state <> 'released')
     >= (case p_kind when 'voice_session' then v_cfg.voice_sessions_total else v_cfg.voice_probes_total end) then
    return jsonb_build_object('outcome', 'refused', 'reason', 'voice_total_cap');
  end if;
  insert into ops.budget_reservations (idempotency_key, bucket, kind, purpose, trial_id, actor_user_id, caller_role, reserved_usd)
    values (p_idempotency_key, p_bucket, p_kind, p_purpose, p_trial, p_actor, ops.invoker_role(), v_amt) returning id into v_id;
  return jsonb_build_object('outcome', 'reserved', 'id', v_id, 'reserved_usd', v_amt,
                            'shutoff_usd', round(v_amt * 2 / 3, 6));
end $$;

-- open_voice_session (arena_subject): after claim_voice_ticket and reserve_voice succeed, in the
-- same transaction (S5 7.2 step 3).
create or replace function training.open_voice_session(p_ticket_id uuid, p_reservation uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_t   training.access_tickets;
  v_s   uuid;
  v_r   ops.budget_reservations;
  v_id  uuid;
begin
  select * into v_t from training.access_tickets where id = p_ticket_id;
  select * into v_r from ops.budget_reservations where id = p_reservation;
  select id into v_s from training.sessions where trial_id = v_t.trial_id and voice;
  if v_t.subject_checked_at is null or v_s is null or v_r.kind is distinct from 'voice_session'
     or v_r.state <> 'reserved' or v_r.trial_id is distinct from v_t.trial_id
     or v_r.caller_role is distinct from ops.invoker_role() then
    raise exception using errcode = 'AR040', message = 'voice session refused';
  end if;
  -- WP-03 fix 6: the daily voice quota counts opened sessions, but issue_access_ticket checked it only when a ticket was
  -- issued, so tickets issued before the quota was reached could open sessions beyond it. One actor's openings
  -- serialize here and the quota is checked again, against every session already opened today.
  perform pg_advisory_xact_lock(hashtextextended('training.voice_quota:' || v_t.user_id::text, 0));
  if (select voice_sessions_per_user_day from ops.config where id) <=
     (select count(*) from training.voice_sessions vs join training.sessions s on s.id = vs.session_id
       where s.user_id = v_t.user_id and vs.opened_at >= date_trunc('day', now())) then
    raise exception using errcode = 'AR040', message = 'daily voice session quota reached';
  end if;
  insert into training.voice_sessions (session_id, ticket_id, reservation_id) values (v_s, p_ticket_id, p_reservation)
    returning id into v_id;
  return v_id;
end $$;

create or replace function training.close_voice_session(p_voice_session uuid, p_close_code text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update training.voice_sessions set status = 'closed', close_code = p_close_code, closed_at = now()
   where id = p_voice_session and status = 'open';
end $$;

-- close_orphan_voice_sessions (arena_subject; D-016, SG3-36): the local stack runs one arena-subject, so at
-- its start every voice session still open belongs to a process that died. Each is closed 'orphaned' and
-- its reservation settled usage_unknown (the full hold stays as spend). Nothing else needs cleaning: a
-- voice session writes no turns, so no open question survives it. Returns the number closed.
create or replace function training.close_orphan_voice_sessions()
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r   ops.budget_reservations;
  v_n integer := 0;
begin
  perform ledger.require_read_committed();
  for r in select b.* from ops.budget_reservations b join training.voice_sessions vs on vs.reservation_id = b.id
            where vs.status = 'open' order by b.id for update of b loop
    update training.voice_sessions set status = 'closed', close_code = 'orphaned', closed_at = now()
     where reservation_id = r.id and status = 'open';
    perform ops._settle(r, 'usage_unknown');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- settle_voice_reservation (arena_subject; D7, SG3-11): the subject's own voice reservation, after its
-- voice session closed (a probe has no session). committed = the Live usage receipts.
create or replace function ops.settle_voice_reservation(p_reservation uuid, p_outcome text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ops.budget_reservations;
begin
  perform ledger.require_read_committed();
  v := ops._own_reservation(p_reservation);
  if v.kind = 'model_call' then
    raise exception using errcode = 'AR001', message = 'a model call settles through settle_reservation';
  end if;
  if exists (select 1 from training.voice_sessions where reservation_id = p_reservation and status = 'open') then
    raise exception using errcode = 'AR001', message = 'close the voice session before settling its reservation';
  end if;
  return ops._settle(v, p_outcome);
end $$;

-- voice_context (arena_subject; D7, SG3-05, D-016): the subject's view for an open voice session on a running
-- trial, with no work item: the packets and released evidence of subject.turn_context, the trial's stored
-- voice exchanges (the spoken transcript so far, including earlier voice sessions of the trial), plus the
-- session's reservation, its recorded spend and its shutoff point. Read when Live opens (the initial
-- instruction renders LOCKED gates from the released records) and after every context_changed relay
-- frame (S5 7.4).
create or replace function subject.voice_context(p_voice_session uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  vs training.voice_sessions;
  v  arena.trials;
  r  ops.budget_reservations;
begin
  select * into vs from training.voice_sessions where id = p_voice_session;
  select t.* into v from training.sessions s join arena.trials t on t.id = s.trial_id where s.id = vs.session_id;
  select * into r from ops.budget_reservations where id = vs.reservation_id;
  if vs.id is null or vs.status <> 'open' or v.id is null or v.status <> 'running' then
    raise exception using errcode = 'AR003', message = 'voice context needs an open voice session on a running trial';
  end if;
  return subject._view(v) || jsonb_build_object(
    'voice_exchanges', coalesce((select jsonb_agg(jsonb_build_object('exchange_no', x.exchange_no, 'lines', x.lines)
                                                  order by x.exchange_no)
                                   from training.voice_exchanges x where x.trial_id = v.id), '[]'::jsonb),
    'voice_session_id', vs.id, 'reservation_id', r.id, 'reserved_usd', r.reserved_usd,
    'spend_usd', ops.receipts_usd(r.id), 'shutoff_usd', round(r.reserved_usd * 2 / 3, 6),
    'kill_switch', (select kill_switch from ops.config where id));
end $$;

alter table training.voice_sessions
  add constraint voice_sessions_reservation_fk foreign key (reservation_id) references ops.budget_reservations(id)
  on delete restrict;

-- -----------------------------------------------------------------------------
-- Owner-only controls (no runtime role holds EXECUTE; the owner runs them as postgres)
-- -----------------------------------------------------------------------------
create or replace function ops.set_kill_switch(p_on boolean, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update ops.config set kill_switch = p_on, kill_reason = p_reason, updated_at = now() where id;
  insert into ops.kill_switch_events (turned_on, reason) values (p_on, p_reason);
end $$;

-- Create or change a bucket (owner only). Applying budget_plan() from the $0 seed sets the one
-- `global` ceiling (D-013). If children are added later, raises go top-down and lowering bottom-up.
-- Refuses a ceiling below the subtree's current liability, a change of parent, and making a bucket
-- that holds reservations into a parent; the constraint trigger refuses children above their parent.
create or replace function ops.set_bucket_ceiling(p_name text, p_parent text, p_ceiling numeric, p_note text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from ops.budget_buckets where name = 'global' for update;
  if exists (select 1 from ops.budget_buckets where name = p_name) and ops.subtree_liability(p_name) > p_ceiling then
    raise exception using errcode = 'AR007', message = 'ceiling below the bucket''s current liability';
  end if;
  if exists (select 1 from ops.budget_buckets where name = p_name and parent is distinct from p_parent) then
    raise exception using errcode = 'AR007', message = 'a bucket keeps its parent';
  end if;
  if exists (select 1 from ops.budget_reservations where bucket = p_parent) then
    raise exception using errcode = 'AR007', message = 'a bucket holding reservations cannot become a parent';
  end if;
  insert into ops.budget_buckets (name, parent, ceiling_usd, note) values (p_name, p_parent, p_ceiling, p_note)
    on conflict (name) do update set ceiling_usd = excluded.ceiling_usd, note = excluded.note
    where ops.budget_buckets.parent is not distinct from excluded.parent;
end $$;

create or replace function ops.budget_status()
returns table (bucket text, parent text, ceiling_usd numeric, liability_usd numeric, open_usd numeric, headroom_usd numeric,
               kill_switch boolean)
language sql stable security definer set search_path = '' as $$
  select b.name, b.parent, b.ceiling_usd, ops.subtree_liability(b.name),
         (select coalesce(sum(r.reserved_usd), 0) from ops.budget_reservations r
           where r.state = 'reserved' and r.bucket = b.name),
         b.ceiling_usd - ops.subtree_liability(b.name),
         (select kill_switch from ops.config where id)
    from ops.budget_buckets b
$$;

-- -----------------------------------------------------------------------------
-- KPI-4 latency samples (S3 6.4 canonical, C-28, D4). arena.record_subject_turn opens one row per text turn
-- of a trial with an assistant (not replay) as 'pending' when the subject turn commits; the turn's
-- coach_card or coach_unavailable completes it; a row still pending when the next question is recorded or
-- the trial ends becomes 'unmeasured_timeout', a miss that is also counted as unmeasured, so a turn whose
-- coaching died with its process stays in the metric population (SG3-16, SG2-12). ops.ack_card stamps
-- client_ack_at when the browser acknowledges a complete, schema-valid card. KPI-4 = client_ack_at -
-- subject_commit_at, both Postgres server clock (includes one uplink, so conservative). server_ms stays as a
-- diagnostic and is the harness population's latency. A delivered practice card without an acknowledgement
-- is unmeasured, not a miss (S5 8.7).
-- -----------------------------------------------------------------------------
create table ops.latency_samples (
  trial_id                 uuid not null references arena.trials(id) on delete restrict,
  turn_no                  smallint not null,
  subject_commit_at        timestamptz not null,   -- subject_turn event commit (clock_timestamp())
  card_validated_server_at timestamptz,            -- coach_card / coach_unavailable event commit
  client_ack_at            timestamptz,            -- ops.ack_card, practice turns only
  card_outcome             text not null check (card_outcome in ('pending', 'delivered', 'timeout', 'repair_failed',
                                                                 'client_invalid', 'unmeasured_timeout')),
  population               text not null check (population in ('practice_client', 'harness', 'assessment')),
  instance_cold            boolean not null default false,
  server_ms                integer generated always as
                             ((extract(epoch from (card_validated_server_at - subject_commit_at)) * 1000)::integer) stored,
  kpi4_ms                  integer generated always as (case
                             when card_outcome <> 'delivered' then null
                             when population = 'practice_client'
                               then (extract(epoch from (client_ack_at - subject_commit_at)) * 1000)::integer
                             else (extract(epoch from (card_validated_server_at - subject_commit_at)) * 1000)::integer
                           end) stored,
  miss                     boolean generated always as
                             (card_outcome in ('timeout', 'repair_failed', 'client_invalid', 'unmeasured_timeout')) stored,
  unmeasured               boolean generated always as
                             (card_outcome = 'unmeasured_timeout'
                              or (population = 'practice_client' and card_outcome = 'delivered' and client_ack_at is null)) stored,
  created_at               timestamptz not null default now(),
  primary key (trial_id, turn_no),
  constraint latency_validated_shape check ((card_validated_server_at is null) = (card_outcome in ('pending', 'unmeasured_timeout'))),
  constraint latency_order check ((card_validated_server_at is null or card_validated_server_at >= subject_commit_at)
                                  and (client_ack_at is null or client_ack_at >= card_validated_server_at)),
  constraint latency_ack_population check (client_ack_at is null or population = 'practice_client')
);

-- Pending samples of a trial become unmeasured_timeout (internal; called when the next question is
-- recorded and when the trial ends).
create or replace function ops._close_pending_latency(p_trial uuid)
returns void
language sql security definer set search_path = '' as $$
  update ops.latency_samples set card_outcome = 'unmeasured_timeout' where trial_id = p_trial and card_outcome = 'pending'
$$;

-- ack_card (arena_public; S5 acknowledgement route): the client posts immediately after it has the
-- complete card and has validated it against the shared JSON schema. Stamps clock_timestamp() once,
-- on a practice turn whose card was delivered; p_client_valid = false records client_invalid (a miss).
-- Returns true when this call stamped the acknowledgement.
create or replace function ops.ack_card(p_trial uuid, p_turn_no smallint, p_client_valid boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v   arena.trials;
  v_n integer;
begin
  select * into v from arena.trials where id = p_trial;
  if v.id is null then
    raise exception using errcode = 'AR001', message = 'trial not found';
  end if;
  perform arena._check_caller(v.kind, v.owner_user_id);
  update ops.latency_samples
     set client_ack_at = clock_timestamp(),
         card_outcome = case when coalesce(p_client_valid, false) then 'delivered' else 'client_invalid' end
   where trial_id = p_trial and turn_no = p_turn_no and client_ack_at is null
     and population = 'practice_client' and card_outcome = 'delivered';
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- -----------------------------------------------------------------------------
-- Trace mirror (direction 10, F11; S5 8.4): a span is durable once its row commits here. Rows hold
-- the sanitized span (redacted before export) so Phoenix can be re-fed from the mirror. Spans of an
-- unrevealed hidden tournament are 'held' and never exportable before reveal (R3-03). SG3-12: the
-- producer's classification (ExportGate's split, the request's tournament binding) is kept; the database
-- only raises it. A span bound to a trial takes that trial's tournament; a span bound to a tournament
-- without a trial (block scoring, the tournament job) takes that tournament's split; a span the producer
-- marked hidden stays hidden whatever else it carries, and a hidden span with no tournament stays held for
-- good (fail closed). Nothing of a trace is exportable while any span of it is held.
-- -----------------------------------------------------------------------------
create table ops.trace_mirror (
  trace_id       text not null check (trace_id ~ '^[0-9a-f]{32}$'),
  span_id        text not null check (span_id ~ '^[0-9a-f]{16}$'),
  parent_span_id text check (parent_span_id ~ '^[0-9a-f]{16}$'),
  service        text not null check (service in ('arena-api', 'arena-subject', 'arena-referee', 'arena-tournament')),
  trial_id       uuid references arena.trials(id) on delete restrict,
  tournament_id  uuid references arena.tournaments(id) on delete restrict,   -- from trial_id, else the span's binding
  split          text not null check (split in ('dev', 'hidden', 'none')),  -- the producer's, raised by the bindings
  name           text not null check (length(name) between 1 and 200),
  kind           text not null check (kind in ('CHAIN', 'AGENT', 'LLM', 'TOOL', 'RETRIEVER', 'EMBEDDING', 'RERANKER',
                                               'GUARDRAIL', 'EVALUATOR', 'PROMPT', 'UNKNOWN')),
  status         text not null check (status in ('UNSET', 'OK', 'ERROR')),
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  otlp           jsonb not null check (jsonb_typeof(otlp) = 'object' and pg_column_size(otlp) <= 32768),
  export_state   text not null check (export_state in ('pending', 'held', 'exported', 'verified')),
  created_at     timestamptz not null default now(),
  exported_at    timestamptz,
  verified_at    timestamptz,
  primary key (trace_id, span_id),
  constraint trace_mirror_times check (ended_at >= started_at)
);
create index trace_mirror_state_idx on ops.trace_mirror (export_state, created_at);

create or replace function ops.tg_trace_mirror() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_tid    uuid;
  v_split  text;
  v_status text;
begin
  if tg_op = 'DELETE' then
    if old.export_state <> 'verified' or old.split = 'hidden' then
      raise exception using errcode = 'AR010', message = 'only verified non-hidden spans are pruned';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.trial_id is not null then
      select t.tournament_id, coalesce(tr.split, 'dev') into v_tid, v_split
        from arena.trials t left join arena.tournaments tr on tr.id = t.tournament_id where t.id = new.trial_id;
      if new.tournament_id is not null and new.tournament_id is distinct from v_tid then
        raise exception using errcode = 'AR007', message = 'span tournament binding disagrees with its trial';
      end if;
      new.tournament_id := v_tid;
    elsif new.tournament_id is not null then
      select tr.split into v_split from arena.tournaments tr where tr.id = new.tournament_id;
    end if;
    new.split := case when 'hidden' in (new.split, v_split) then 'hidden' else coalesce(v_split, new.split) end;
    select tr.status into v_status from arena.tournaments tr where tr.id = new.tournament_id;
    new.export_state := case when new.split = 'hidden' and v_status is distinct from 'revealed' then 'held' else 'pending' end;
    new.exported_at := null;
    new.verified_at := null;
    return new;
  end if;
  if (to_jsonb(new) - array['export_state', 'exported_at', 'verified_at'])
     is distinct from (to_jsonb(old) - array['export_state', 'exported_at', 'verified_at']) then
    raise exception using errcode = 'AR010', message = 'a mirrored span changes only its export state';
  end if;
  return new;
end $$;
create trigger trace_mirror_guard before insert or update or delete on ops.trace_mirror
  for each row execute function ops.tg_trace_mirror();

-- mirror_spans (all runtime roles): idempotent batch insert, called before a request or job task ends.
-- Each span carries trial_id and tournament_id when the request is bound to one, and split as ExportGate
-- classified it (dev, hidden or none).
create or replace function ops.mirror_spans(p_service text, p_spans jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if jsonb_typeof(p_spans) <> 'array' or jsonb_array_length(p_spans) > 500 then
    raise exception using errcode = 'AR007', message = 'spans must be an array of at most 500';
  end if;
  insert into ops.trace_mirror (trace_id, span_id, parent_span_id, service, trial_id, tournament_id, split, name, kind,
                                status, started_at, ended_at, otlp, export_state)
    select s ->> 'trace_id', s ->> 'span_id', s ->> 'parent_span_id', p_service, (s ->> 'trial_id')::uuid,
           (s ->> 'tournament_id')::uuid, coalesce(s ->> 'split', 'none'),
           s ->> 'name', s ->> 'kind', s ->> 'status', (s ->> 'started_at')::timestamptz, (s ->> 'ended_at')::timestamptz,
           coalesce(s -> 'otlp', '{}'::jsonb), 'pending'
      from jsonb_array_elements(p_spans) s
    on conflict (trace_id, span_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Exportable now: pending rows, and held rows of a tournament revealed since they were mirrored, of traces
-- with no span still held for an unrevealed (or unknown) tournament.
create view ops.v_exportable_spans with (security_barrier = true) as
  select m.trace_id, m.span_id, m.parent_span_id, m.service, m.trial_id, m.name, m.kind, m.status, m.started_at,
         m.ended_at, m.otlp, m.export_state
    from ops.trace_mirror m left join arena.tournaments t on t.id = m.tournament_id
   where (m.export_state = 'pending' or (m.export_state = 'held' and t.status = 'revealed'))
     and not exists (select 1 from ops.trace_mirror h left join arena.tournaments ht on ht.id = h.tournament_id
                      where h.trace_id = m.trace_id and h.export_state = 'held' and ht.status is distinct from 'revealed');

-- set_export_state (arena_public, arena_referee): pending|held -> exported -> verified. Only a span listed
-- in ops.v_exportable_spans moves to exported (a held span after its tournament is revealed, and never
-- while its trace has a span still held).
create or replace function ops.set_export_state(p_keys jsonb, p_state text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if p_state not in ('exported', 'verified') then
    raise exception using errcode = 'AR007', message = 'export state moves to exported or verified';
  end if;
  update ops.trace_mirror m
     set export_state = p_state,
         exported_at = case when p_state = 'exported' then now() else m.exported_at end,
         verified_at = case when p_state = 'verified' then now() else m.verified_at end
    from jsonb_array_elements(p_keys) k
   where m.trace_id = k ->> 'trace_id' and m.span_id = k ->> 'span_id'
     and ((p_state = 'exported' and exists (select 1 from ops.v_exportable_spans x
                                              where x.trace_id = m.trace_id and x.span_id = m.span_id))
          or (p_state = 'verified' and m.export_state = 'exported'));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- prune_trace_mirror (arena_referee): drop verified, non-hidden spans older than p_days (>= 7).
create or replace function ops.prune_trace_mirror(p_days integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if p_days < 7 then
    raise exception using errcode = 'AR007', message = 'keep at least 7 days';
  end if;
  delete from ops.trace_mirror where export_state = 'verified' and split <> 'hidden'
     and verified_at < now() - make_interval(days => p_days);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Per request or job task: spans expected vs mirrored (TechnoMile trace summaries pattern).
create table ops.trace_summaries (
  trace_id             text not null check (trace_id ~ '^[0-9a-f]{32}$'),
  scope                text not null check (length(scope) between 1 and 200),
  trial_id             uuid references arena.trials(id) on delete restrict,
  spans_expected       integer not null check (spans_expected >= 0),
  spans_mirrored       integer not null check (spans_mirrored >= 0 and spans_mirrored <= spans_expected),
  export_failures      integer not null default 0 check (export_failures >= 0),
  telemetry_incomplete boolean generated always as (spans_expected = 0 or spans_mirrored < spans_expected
                                                    or export_failures > 0) stored,
  checked_at           timestamptz not null default now(),
  primary key (trace_id, scope)
);
create trigger trace_summaries_append_only before update or delete on ops.trace_summaries
  for each row execute function arena.tg_forbid_mutation();

create or replace function ops.record_trace_summary(p_trace_id text, p_scope text, p_trial uuid, p_expected integer,
                                                    p_mirrored integer, p_failures integer)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into ops.trace_summaries (trace_id, scope, trial_id, spans_expected, spans_mirrored, export_failures)
    values (p_trace_id, p_scope, p_trial, p_expected, least(p_mirrored, p_expected), coalesce(p_failures, 0))
    on conflict (trace_id, scope) do nothing;
end $$;

-- -----------------------------------------------------------------------------
-- Keep-alive (free plan): several user queries a day keep a project active (Supabase docs,
-- "Project Pausing", fetched 2026-10-08).
-- -----------------------------------------------------------------------------
create table ops.keepalive_pings (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  source text not null check (length(source) between 1 and 64)
);
create or replace function ops.keepalive(p_source text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_n integer;
begin
  insert into ops.keepalive_pings (source) values (left(p_source, 64));
  delete from ops.keepalive_pings where at < now() - interval '14 days';
  select count(*) into v_n from ops.keepalive_pings;
  return v_n;
end $$;

-- -----------------------------------------------------------------------------
-- Projections for arena_public
-- -----------------------------------------------------------------------------
create view ops.v_budget_status with (security_barrier = true) as
  select * from ops.budget_status();

-- KPI-4, cost per candidate and per trial come from these rows (direction 10: numbers from Postgres).
create view ops.v_call_costs with (security_barrier = true) as
  select r.id as reservation_id, r.bucket, r.kind, r.purpose, r.trial_id, r.call_kind, r.state, r.reserved_usd,
         r.settled_usd, c.seq, c.model, c.input_tokens, c.output_tokens, c.thinking_tokens, c.cost_usd, c.status,
         c.latency_ms, c.created_at
    from ops.budget_reservations r join ops.model_calls c on c.reservation_id = r.id
   where r.trial_id is null or arena.trial_visible(r.trial_id);

-- SG2-23, SG3-30: the reporting projection needs no later request. ops.v_latency_report holds it over every
-- row (the referee's scorer reads it; arena_referee already reads ops.latency_samples, SG2-31, SG3-38);
-- ops.v_latency is the same projection filtered to the actor's visible trials, for arena_public. A row still pending after the coaching
-- deadline (120 s after the subject commit, the same deadline that ends the coaching hold, S5 5.1) reads as
-- unmeasured_timeout, a miss, whether or not the session ever returns; a pending row inside the deadline
-- reads as in_flight and stays out of the share until it resolves. report_outcome, miss and unmeasured
-- are what S3 6.4 reads.
create view ops.v_latency_report with (security_barrier = true) as
  select x.*,
         x.report_outcome in ('timeout', 'repair_failed', 'client_invalid', 'unmeasured_timeout') as miss,
         (x.report_outcome = 'unmeasured_timeout'
          or (x.population = 'practice_client' and x.report_outcome = 'delivered' and x.client_ack_at is null)) as unmeasured,
         x.report_outcome = 'pending' as in_flight
    from (select l.trial_id, l.turn_no, l.subject_commit_at, l.card_validated_server_at, l.client_ack_at, l.card_outcome,
                 case when l.card_outcome = 'pending' and l.subject_commit_at < now() - interval '120 seconds'
                      then 'unmeasured_timeout' else l.card_outcome end as report_outcome,
                 l.population, l.instance_cold, l.server_ms, l.kpi4_ms, l.created_at
            from ops.latency_samples l) x;
create view ops.v_latency with (security_barrier = true) as
  select r.* from ops.v_latency_report r where arena.trial_visible(r.trial_id);

-- Public configuration for GET /api/config (SG3-13): the paused flag and the per-user quotas only.
create view ops.v_public_config with (security_barrier = true) as
  select c.kill_switch as paused, c.text_sessions_per_user_day, c.voice_sessions_per_user_day from ops.config c;

-- -----------------------------------------------------------------------------
-- RLS and privileges
-- -----------------------------------------------------------------------------
alter table ops.config enable row level security;
alter table ops.kill_switch_events enable row level security;
alter table ops.budget_buckets enable row level security;
alter table ops.model_prices enable row level security;
alter table ops.call_limits enable row level security;
alter table ops.budget_reservations enable row level security;
alter table ops.model_calls enable row level security;
alter table ops.latency_samples enable row level security;
alter table ops.trace_mirror enable row level security;
alter table ops.trace_summaries enable row level security;
alter table ops.keepalive_pings enable row level security;

revoke all on all tables in schema ops from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
revoke all on all sequences in schema ops from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
revoke all on all functions in schema ops from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
revoke all on function training.open_voice_session(uuid, uuid), training.close_voice_session(uuid, text),
  subject.voice_context(uuid), training.close_orphan_voice_sessions()
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;

grant usage on schema ops to arena_public, arena_subject, arena_referee;

-- metered calls and tracing: every runtime service calls Vertex and emits spans, so these go to the
-- three runtime roles (the one deliberate exception to "one grantee per function", S4 section 8.7)
grant execute on function
  ops.reserve_model_call(text, text, text, text, text, uuid, uuid, integer),
  ops.mark_dispatched(uuid),
  ops.record_usage(uuid, integer, text, bigint, bigint, bigint, bigint, bigint, text, integer, text, text),
  ops.settle_reservation(uuid, text),
  ops.budget_status(),
  ops.mirror_spans(text, jsonb),
  ops.record_trace_summary(text, text, uuid, integer, integer, integer)
  to arena_public, arena_subject, arena_referee;

grant execute on function ops.keepalive(text), ops.ack_card(uuid, smallint, boolean)
  to arena_public;
grant execute on function ops.admit_unit(text, numeric), ops.set_export_state(jsonb, text) to arena_public, arena_referee;
grant select on ops.v_exportable_spans, ops.v_budget_status, ops.v_call_costs, ops.v_latency, ops.v_public_config
  to arena_public;

grant execute on function ops.reserve_voice(text, text, text, text, uuid, uuid),
  ops.settle_voice_reservation(uuid, text), subject.voice_context(uuid),
  training.open_voice_session(uuid, uuid), training.close_voice_session(uuid, text),
  training.close_orphan_voice_sessions()
  to arena_subject;

grant execute on function ops.prune_trace_mirror(integer) to arena_referee;
grant select on all tables in schema ops to arena_referee;
revoke select on ops.v_call_costs, ops.v_latency from arena_referee;   -- actor-scoped (SG3-38); v_latency_report instead
create policy config_referee on ops.config for select to arena_referee using (true);
create policy kill_switch_events_referee on ops.kill_switch_events for select to arena_referee using (true);
create policy budget_buckets_referee on ops.budget_buckets for select to arena_referee using (true);
create policy model_prices_referee on ops.model_prices for select to arena_referee using (true);
create policy call_limits_referee on ops.call_limits for select to arena_referee using (true);
create policy budget_reservations_referee on ops.budget_reservations for select to arena_referee using (true);
create policy model_calls_referee on ops.model_calls for select to arena_referee using (true);
create policy latency_samples_referee on ops.latency_samples for select to arena_referee using (true);
create policy trace_mirror_referee on ops.trace_mirror for select to arena_referee using (true);
create policy trace_summaries_referee on ops.trace_summaries for select to arena_referee using (true);
create policy keepalive_pings_referee on ops.keepalive_pings for select to arena_referee using (true);
