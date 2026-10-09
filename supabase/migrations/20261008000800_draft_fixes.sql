-- 0008 draft fixes (S4 sections 8.3, 8.4 and the voice path of 6.3; WP-03). Not a draft port: six defects the WP-03
-- Codex gates found in the v2.7 drafts (docs/spec/sql/0005_training.sql, 0006_ops_budget_traces.sql), fixed here so
-- 0001-0006 stay the drafts unchanged in substance; proposed for the spec's next revision. Each function is the
-- draft's body with the marked changes; `create or replace` keeps its grants (capability fixture unchanged).
--   Fix 1: the model-call worst case is attempts x ceil(per-attempt worst case) micro-dollars. The draft rounded
--          once after multiplying, while ops.record_usage rounds each receipt up, so four permitted receipts of a
--          6,001-byte card on gemini-3.5-flash-lite ($0.005801 each, $0.023204) exceeded the $0.023202 reservation
--          and turned the global kill switch on. Round inputs (BU-02, BU-03, BU-32) keep their amounts.
--   Fix 2: a transaction-level advisory lock on the reservation key serializes calls with the same key, so a
--          concurrent retry returns the first reservation (`exists`) instead of 23505 or a cap refusal.
--   Fix 3: the purpose is part of a reservation's identity: a key reused with another purpose is AR003.
--   Fix 4: ops.record_usage: a repeated report number with different usage is AR003 (the draft returned `exists`
--          and dropped the conflicting usage), and a repeat returns spend, reservation and shutoff as they stand,
--          so a voice caller whose first response was lost still learns to stop (S4 8.4, 8.6).
--   Fix 5: training.record_voice_exchange: a repeated exchange answered `released: []` even when its original
--          commit released scheduled evidence; it now answers that release (from the release rows and their event).
--   Fix 6: training.open_voice_session rechecks the per-user daily voice quota under a per-actor lock; the draft
--          checked it only at ticket issue, so pre-issued tickets could exceed it. Quota values are unchanged.
-- Gates: supabase/tests/014_budget.sql BU-38..BU-41; supabase/tests/015_voice.sql VB-21..VB-23.

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
  -- Fix 2: one reservation key at a time. Two calls with the same key both missed the lookup under READ COMMITTED
  -- and the second then hit the unique key (23505) or a cap refusal instead of returning the first reservation.
  perform pg_advisory_xact_lock(hashtextextended('ops.budget_reservations:' || p_idempotency_key, 0));
  select * into v_ex from ops.budget_reservations where idempotency_key = p_idempotency_key;
  if found then
    -- Fix 3: the purpose is part of the reservation's identity.
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
  -- Fix 1: attempts x the per-attempt worst case rounded up to the micro-dollar, the way ops.record_usage rounds
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
  -- Fix 2: one reservation key at a time. Two calls with the same key both missed the lookup under READ COMMITTED
  -- and the second then hit the unique key (23505) or a cap refusal instead of returning the first reservation.
  perform pg_advisory_xact_lock(hashtextextended('ops.budget_reservations:' || p_idempotency_key, 0));
  select * into v_ex from ops.budget_reservations where idempotency_key = p_idempotency_key;
  if found then
    -- Fix 3: the purpose is part of the reservation's identity.
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
    -- Fix 4: a repeated report must be the same report (else AR003), and it returns the full metering answer as it
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

create or replace function training.record_voice_exchange(p_voice_session uuid, p_exchange_no smallint,
                                                          p_lines jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v     arena.trials;
  v_x   training.voice_exchanges;
  v_rel jsonb;
begin
  perform ledger.require_read_committed();
  select t.* into v from training.voice_sessions vs join training.sessions s on s.id = vs.session_id
    join arena.trials t on t.id = s.trial_id where vs.id = p_voice_session;
  if v.id is null then
    raise exception using errcode = 'AR040', message = 'voice exchange refused';
  end if;
  v := arena._lock_trial(v.id);
  select * into v_x from training.voice_exchanges where trial_id = v.id and exchange_no = p_exchange_no;
  if found then
    if (v_x.voice_session_id, v_x.lines) is distinct from (p_voice_session, p_lines) then
      raise exception using errcode = 'AR003', message = 'exchange number reused with different content';
    end if;
    -- Fix 5: a repeat answers what the original call released (the scheduled releases its commit applied: no work
    -- item, after this exchange), so a caller whose first response was lost still updates Live's context.
    return jsonb_build_object('exchange_no', p_exchange_no, 'outcome', 'exists',
      'released', (select coalesce(jsonb_agg(jsonb_build_object('record_id', r.record_id, 'kind', r.kind)
                                             order by r.record_id collate "C"), '[]'::jsonb)
                     from arena.released_evidence r join ledger.events e on e.seq = r.event_seq
                    where r.trial_id = v.id and e.payload ->> 'work_item_id' is null
                      and (e.payload ->> 'after_exchanges')::integer = v.exchanges + p_exchange_no));
  end if;
  if v.status <> 'running' or not exists (select 1 from training.voice_sessions
                                           where id = p_voice_session and status = 'open') then
    raise exception using errcode = 'AR040', message = 'voice exchange refused';
  end if;
  if p_exchange_no is distinct from
     ((select count(*) from training.voice_exchanges where trial_id = v.id) + 1)::smallint then
    raise exception using errcode = 'AR004', message = 'voice exchanges are stored in order, at most 12';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_lines) l
                 where jsonb_typeof(l) <> 'object' or coalesce(l ->> 'role', '') not in ('investigator', 'subject')
                    or jsonb_typeof(l -> 'text') is distinct from 'string' or length(l ->> 'text') not between 1 and 900
                    or jsonb_typeof(l -> 'partial') is distinct from 'boolean'
                    or exists (select 1 from jsonb_object_keys(l) k where k not in ('role', 'text', 'partial'))) then
    raise exception using errcode = 'AR007', message = 'lines are [{role, text, partial}]';
  end if;
  insert into training.voice_exchanges (trial_id, exchange_no, voice_session_id, lines)
    values (v.id, p_exchange_no, p_voice_session, p_lines);
  v_rel := arena._apply_releases(v.id, '{}'::text[], null);
  return jsonb_build_object('exchange_no', p_exchange_no, 'outcome', 'recorded',
    'released', (select coalesce(jsonb_agg(jsonb_build_object('record_id', e ->> 'record_id', 'kind', e ->> 'kind')),
                                 '[]'::jsonb) from jsonb_array_elements(v_rel) e));
end $$;

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
  -- Fix 6: the daily voice quota counts opened sessions, but issue_access_ticket checked it only when a ticket was
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
