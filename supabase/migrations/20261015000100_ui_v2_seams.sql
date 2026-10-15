-- =============================================================================
-- 20261015000100_ui_v2_seams.sql  (UI v2 backend seams; owner D-034..D-036, docs/ui-v2/codex-prompt.md
-- "Backend seams"). Forward only; every object below is new except where a section says it replaces one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. World telemetry for exact replay (recording v2, D-021 amendment).
-- The browser posts its 3D world's own moments (actor poses, the camera, inputs, panel changes) in batches of at
-- most 64 KB (arena-api checks the request body), every 250-500 ms, through training.record_world_events. One row per accepted batch, append-only,
-- numbered per trial. Only the trial's owner writes and reads them (training trials only: the same visibility as
-- the trial itself, through training.v_my_world_events). A trial holds at most 16 MiB of batches, so a client
-- that never stops posting cannot grow a trial without bound. The data object of each event is the client's own
-- (S6 owns its shapes); the database checks the envelope only.
-- -----------------------------------------------------------------------------
create table training.world_event_batches (
  trial_id    uuid not null references arena.trials(id) on delete restrict,
  batch_no    integer not null check (batch_no >= 1),
  events      jsonb not null check (jsonb_typeof(events) = 'array' and jsonb_array_length(events) between 1 and 2000),
  bytes       integer not null check (bytes between 1 and 131072),
  received_at timestamptz not null default now(),
  primary key (trial_id, batch_no)
);
create trigger world_event_batches_append_only before update or delete on training.world_event_batches
  for each row execute function arena.tg_forbid_mutation();

-- record_world_events (arena_public): one batch on the actor's own training trial; returns its batch number.
-- AR040 for anything that is not the actor's training trial (no existence oracle); AR007 for a malformed batch or
-- one that would take the trial past its 16 MiB.
create or replace function training.record_world_events(p_trial uuid, p_events jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := arena.actor_id();
  v_t     arena.trials;
  v_bytes integer;
  v_e     jsonb;
  v_no    integer;
begin
  perform ledger.require_read_committed();
  select * into v_t from arena.trials where id = p_trial;
  if v_actor is null or v_t.id is null or v_t.kind <> 'training' or v_t.owner_user_id is distinct from v_actor then
    raise exception using errcode = 'AR040', message = 'trial not found';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) not between 1 and 2000 then
    raise exception using errcode = 'AR007', message = 'a world-event batch is a list of 1 to 2000 events';
  end if;
  -- arena-api refuses a request body over 64 KB before this runs (the batch contract). jsonb's own text form adds a
  -- space after every colon and comma, so the stored size of an accepted batch can exceed the bytes it arrived
  -- in; 128 KB here bounds the row without refusing a batch the route accepted.
  v_bytes := octet_length(p_events::text);
  if v_bytes > 131072 then
    raise exception using errcode = 'AR007', message = 'a world-event batch is at most 64 KB';
  end if;
  -- Checked in steps (SQL does not promise to evaluate an OR left to right): an object first, then its keys and
  -- types, and only then the number's value.
  for v_e in select e from jsonb_array_elements(p_events) e loop
    if jsonb_typeof(v_e) <> 'object' then
      raise exception using errcode = 'AR007', message = 'a world event is an object';
    end if;
    if (select count(*) from jsonb_object_keys(v_e)) <> 3 or not v_e ?& array['t_ms', 'kind', 'data']
       or jsonb_typeof(v_e -> 't_ms') <> 'number' or jsonb_typeof(v_e -> 'kind') <> 'string'
       or jsonb_typeof(v_e -> 'data') <> 'object' then
      raise exception using errcode = 'AR007', message = 'a world event is exactly {t_ms, kind, data}';
    end if;
    if (v_e ->> 't_ms')::numeric <> trunc((v_e ->> 't_ms')::numeric)
       or (v_e ->> 't_ms')::numeric not between 0 and 86400000
       or v_e ->> 'kind' not in ('pose', 'camera', 'input', 'ui') then
      raise exception using errcode = 'AR007',
        message = 'a world event has an integer t_ms in 0..86400000 and kind pose, camera, input or ui';
    end if;
  end loop;
  -- One batch at a time per trial, so the numbering and the size cap never race.
  perform pg_advisory_xact_lock(hashtextextended('training.world_event_batches:' || p_trial::text, 0));
  if coalesce((select sum(w.bytes) from training.world_event_batches w where w.trial_id = p_trial), 0) + v_bytes
     > 16777216 then
    raise exception using errcode = 'AR007', message = 'the trial holds its 16 MiB of world events';
  end if;
  select coalesce(max(w.batch_no), 0) + 1 into v_no from training.world_event_batches w where w.trial_id = p_trial;
  insert into training.world_event_batches (trial_id, batch_no, events, bytes) values (p_trial, v_no, p_events, v_bytes);
  return v_no;
end $$;

create view training.v_my_world_events with (security_barrier = true) as
  select w.trial_id, w.batch_no, w.events, w.received_at
    from training.world_event_batches w join arena.trials t on t.id = w.trial_id
   where t.kind = 'training' and t.owner_user_id = arena.actor_id();

alter table training.world_event_batches enable row level security;
revoke all on training.world_event_batches, training.v_my_world_events
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
revoke all on function training.record_world_events(uuid, jsonb)
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
grant execute on function training.record_world_events(uuid, jsonb) to arena_public;
grant select on training.v_my_world_events to arena_public;
-- arena_referee reads every training table (S4 4.2), these batches too.
grant select on training.world_event_batches to arena_referee;
create policy world_event_batches_referee on training.world_event_batches for select to arena_referee using (true);
