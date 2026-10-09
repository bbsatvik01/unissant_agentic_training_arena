-- 0008 reservation fixes (S4 section 8.3, 8.4; WP-03). Not a draft port: three defects the WP-03 Codex gate found in
-- the v2.7 drafts of ops.reserve_model_call and ops.reserve_voice (docs/spec/sql/0006_ops_budget_traces.sql), fixed
-- here so 0001-0006 stay the drafts unchanged in substance; proposed for the spec's next revision. Each function is
-- the draft's body with the marked changes; `create or replace` keeps its grants (capability fixture unchanged).
--   Fix 1: the model-call worst case is attempts x ceil(per-attempt worst case) micro-dollars. The draft rounded
--          once after multiplying, while ops.record_usage rounds each receipt up, so four permitted receipts of a
--          6,001-byte card on gemini-3.5-flash-lite ($0.005801 each, $0.023204) exceeded the $0.023202 reservation
--          and turned the global kill switch on. Round inputs (BU-02, BU-03, BU-32) keep their amounts.
--   Fix 2: a transaction-level advisory lock on the reservation key serializes calls with the same key, so a
--          concurrent retry returns the first reservation (`exists`) instead of 23505 or a cap refusal.
--   Fix 3: the purpose is part of a reservation's identity: a key reused with another purpose is AR003.
-- Gates: supabase/tests/014_budget.sql BU-38, BU-39, BU-40.

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
