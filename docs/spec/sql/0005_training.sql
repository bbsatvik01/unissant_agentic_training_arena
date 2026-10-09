-- =============================================================================
-- 0005_training.sql  (DRAFT v2.1, spec S4; applied only to throwaway local PostgreSQL 16 clusters)
-- Investigator sessions (practice and assessment, development cases only), KPI-1 participants and
-- matched case sets, blinded rubric scores, single-use access tickets for SSE and voice, voice
-- sessions, transcript fragments, utterance playback counts and resume credentials.
-- Requirements: CH-1, SOL-6, EVL-2, EVL-7, KPI-1, PRB-1, SCN-12, EX-4; voice: D-006, direction 4.3, 9.
--
-- A training session is an arena.trials row of kind 'training', so it runs through the same
-- functions as the bake-off (submit_question, release_evidence, record_subject_turn,
-- record_coaching_event, finalize_trial). Practice shows coaching live; assessment holds it until
-- the trial ends (event visibility 'debrief').
-- Ticket pattern: TechnoMile supabase/migrations/20261001000100_api_live.sql lines 24-110 (sha256-only
-- storage, 60 s life, single conditional update), per S5 lift row T18.
-- =============================================================================

create table training.participants (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references auth.users(id) on delete restrict,
  code           text not null unique check (code ~ '^P[0-9]{2,3}$'),     -- pseudonym used in reports
  counterbalance text not null check (counterbalance in ('AB', 'BA')),     -- pre set, post set
  consented_at   timestamptz not null,
  created_at     timestamptz not null default now()
);

-- Two matched development case sets for KPI-1 pre and post tests (each one truthful and one deceptive
-- variant from different families). Families holding a member are excluded from the C-37 seeded draw
-- for every user and never run in practice (X-08); a participant meets them only as a whole set.
create table training.case_set_members (
  set_code   text not null check (set_code in ('A', 'B')),
  variant_id uuid not null references arena.case_variants(id) on delete restrict,
  primary key (set_code, variant_id)
);

create table training.sessions (
  id              uuid primary key default gen_random_uuid(),
  trial_id        uuid not null unique references arena.trials(id) on delete restrict,
  user_id         uuid not null references auth.users(id) on delete restrict,
  participant_id  uuid references training.participants(id) on delete restrict,
  phase           text not null check (phase in ('practice', 'pre', 'post')),   -- S3 phase 'free' maps to 'practice' (C-44)
  voice           boolean not null default false,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  created_at      timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index sessions_user_idx on training.sessions (user_id, created_at desc);
create trigger sessions_immutable before update or delete on training.sessions
  for each row execute function arena.tg_forbid_mutation();

-- User acknowledgements (X-15): the EX-4 statement, recorded once per user by POST /api/me/ack-ex4.
create table training.acknowledgements (
  user_id         uuid not null references auth.users(id) on delete restrict,
  kind            text not null check (kind in ('ex4')),
  acknowledged_at timestamptz not null default now(),
  primary key (user_id, kind)
);
create trigger acknowledgements_append_only before update or delete on training.acknowledgements
  for each row execute function arena.tg_forbid_mutation();

-- EVL-7: five dimensions 0-4, total = 5 x sum (0-100). Proxy (calibrated model) or human rater,
-- blinded to participant, phase and candidate.
create table training.rubric_scores (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid not null references training.sessions(id) on delete restrict,
  scorer               text not null check (scorer in ('proxy', 'human')),
  scorer_ref           text not null check (length(scorer_ref) between 1 and 100),   -- prompt sha256 or rater code
  clarity_neutrality   smallint not null check (clarity_neutrality between 0 and 4),
  response_relevance   smallint not null check (response_relevance between 0 and 4),
  evidence_follow_up   smallint not null check (evidence_follow_up between 0 and 4),
  alternative_testing  smallint not null check (alternative_testing between 0 and 4),
  supported_closure    smallint not null check (supported_closure between 0 and 4),
  total                smallint generated always as (5 * (clarity_neutrality + response_relevance + evidence_follow_up
                                                          + alternative_testing + supported_closure)) stored,
  rationale            jsonb not null check (jsonb_typeof(rationale) = 'object'),
  created_at           timestamptz not null default now(),
  unique (session_id, scorer, scorer_ref)
);
create trigger rubric_scores_append_only before update or delete on training.rubric_scores
  for each row execute function arena.tg_forbid_mutation();

-- Single-use tickets (direction 4.3): bound to user, trial, split (dev by construction) and mode.
-- Only the sha256 of the token is stored.
create table training.access_tickets (
  id                 uuid primary key default gen_random_uuid(),
  ticket_sha256      text not null unique check (ticket_sha256 ~ '^[0-9a-f]{64}$'),
  kind               text not null check (kind in ('sse', 'voice')),
  user_id            uuid not null references auth.users(id) on delete restrict,
  trial_id           uuid not null references arena.trials(id) on delete restrict,
  mode               text not null check (mode in ('practice', 'assessment')),
  expires_at         timestamptz not null,
  redeemed_at        timestamptz,            -- by arena-api at the edge
  subject_checked_at timestamptz,            -- by arena-subject behind the relay (voice only)
  created_at         timestamptz not null default now()
);
create index access_tickets_user_idx on training.access_tickets (user_id, kind, created_at);

create table training.voice_sessions (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references training.sessions(id) on delete restrict,
  ticket_id      uuid not null unique references training.access_tickets(id) on delete restrict,
  reservation_id uuid not null,              -- FK to ops.budget_reservations added in 0006
  status         text not null default 'open' check (status in ('open', 'closed')),
  -- false until the playback-grounding tests pass (direction 9); a later migration flips the default
  scored         boolean not null default false,
  close_code     text check (length(close_code) between 1 and 64),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  constraint voice_close_shape check ((status = 'closed') = (closed_at is not null and close_code is not null))
);
create unique index voice_sessions_one_open on training.voice_sessions (session_id) where status = 'open';

-- Live transcription fragments, persisted as written (S5 lift G5).
create table training.voice_fragments (
  voice_session_id uuid not null references training.voice_sessions(id) on delete restrict,
  seq              integer not null check (seq >= 1),
  speaker          text not null check (speaker in ('investigator', 'subject')),
  text             text not null check (length(text) between 1 and 8000),
  partial          boolean not null default false,
  created_at       timestamptz not null default now(),
  primary key (voice_session_id, seq)
);
create trigger voice_fragments_append_only before update or delete on training.voice_fragments
  for each row execute function arena.tg_forbid_mutation();

-- Playback acknowledgement per subject utterance (F10). An utterance that ended with fewer played
-- than received samples is partial and never cited in scoring.
create table training.voice_utterances (
  voice_session_id uuid not null references training.voice_sessions(id) on delete restrict,
  utterance_no     integer not null check (utterance_no >= 1),
  received_samples integer not null default 0 check (received_samples >= 0),
  played_samples   integer not null default 0 check (played_samples >= 0),
  ended            boolean not null default false,
  partial          boolean generated always as (ended and played_samples < received_samples) stored,
  primary key (voice_session_id, utterance_no)
);

-- Resume credentials (S5 7.2 step 4): token sha256 only; the Live resumption handle never leaves
-- arena-subject (take_voice_handle is granted to arena_subject alone). At most 3 per session.
create table training.voice_resumes (
  id               uuid primary key default gen_random_uuid(),
  voice_session_id uuid not null references training.voice_sessions(id) on delete restrict,
  token_sha256     text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  live_handle      text not null check (length(live_handle) between 1 and 4096),
  expires_at       timestamptz not null,
  redeemed_at      timestamptz,
  taken_at         timestamptz,
  created_at       timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- start_session (arena_public): the actor (arena.actor_id, set by arena-api's identity layer:
-- the dev identity middleware locally, the IAP mapping in the hosted variant) opens a practice or
-- assessment interview on a development variant. Idempotent per (actor, key). Daily session
-- quota from ops.config (OWNER DECISION PENDING value). The coach must be an assistant candidate
-- and the subject a subject candidate (referee and negative_control kinds never run sessions).
-- -----------------------------------------------------------------------------
create or replace function training.start_session(p_variant uuid, p_mode text, p_phase text, p_coach_candidate uuid,
                                                  p_subject_candidate uuid, p_voice boolean, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := arena.actor_id();
  v_s     training.sessions;
  v_trial uuid;
  v_part  uuid;
  v_quota smallint;
  v_t     arena.trials;
begin
  perform ledger.require_read_committed();
  if v_actor is null then
    raise exception using errcode = 'AR040', message = 'no investigator identity on this request';
  end if;
  select * into v_s from training.sessions where user_id = v_actor and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('session_id', v_s.id, 'trial_id', v_s.trial_id);
  end if;
  select text_sessions_per_user_day into v_quota from ops.config where id;
  if v_quota is not null and (select count(*) from training.sessions
                               where user_id = v_actor and created_at >= date_trunc('day', now())) >= v_quota then
    raise exception using errcode = 'AR040', message = 'daily session quota reached';
  end if;
  if (select kind from arena.candidates where id = p_coach_candidate) is distinct from 'assistant'
     or (select kind from arena.candidates where id = p_subject_candidate) is distinct from 'subject' then
    raise exception using errcode = 'AR007', message = 'coach must be an assistant candidate and subject a subject candidate';
  end if;
  select id into v_part from training.participants where user_id = v_actor;
  if p_phase in ('pre', 'post') and (v_part is null or not exists (
       select 1 from training.case_set_members m join training.participants p on p.id = v_part
        where m.variant_id = p_variant
          and m.set_code = case when p_phase = 'pre' then left(p.counterbalance, 1) else right(p.counterbalance, 1) end)) then
    raise exception using errcode = 'AR007', message = 'pre and post sessions use the participant''s counterbalanced case set';
  end if;
  if p_phase in ('pre', 'post') and p_mode <> 'assessment' then
    raise exception using errcode = 'AR007', message = 'pre and post tests run in assessment mode';
  end if;
  if p_phase = 'practice' and exists (
       select 1 from training.case_set_members m join arena.case_variants cv on cv.id = m.variant_id
        where cv.family_id = (select family_id from arena.case_variants where id = p_variant)) then
    raise exception using errcode = 'AR007', message = 'KPI-1 case-set families are used only for pre and post tests';
  end if;
  insert into arena.trials (kind, variant_id, assistant_candidate_id, subject_candidate_id, mode, owner_user_id,
                            status, started_at)
    values ('training', p_variant, p_coach_candidate, p_subject_candidate, p_mode, v_actor, 'running', now())
    returning * into v_t;
  v_trial := v_t.id;
  insert into training.sessions (trial_id, user_id, participant_id, phase, voice, idempotency_key)
    values (v_trial, v_actor, v_part, p_phase, coalesce(p_voice, false), p_idempotency_key)
    returning * into v_s;
  perform ledger.append_event('training_started', null, v_trial, jsonb_build_object('session_id', v_s.id, 'mode', p_mode));
  return jsonb_build_object('session_id', v_s.id, 'trial_id', v_trial);
end $$;

-- issue_access_ticket (arena_public): a 60-second single-use token for the actor's own running
-- training trial. Voice also needs a voice session flag, no open voice session on the trial, and
-- the per-user daily voice quota (OWNER DECISION PENDING value in ops.config).
create or replace function training.issue_access_ticket(p_kind text, p_trial uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := arena.actor_id();
  v_t     arena.trials;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_quota smallint;
begin
  select * into v_t from arena.trials where id = p_trial;
  if v_actor is null or v_t.id is null or v_t.kind <> 'training' or v_t.owner_user_id <> v_actor
     or v_t.status <> 'running' or p_kind not in ('sse', 'voice') then
    raise exception using errcode = 'AR040', message = 'ticket refused';
  end if;
  if p_kind = 'voice' then
    select voice_sessions_per_user_day into v_quota from ops.config where id;
    if not exists (select 1 from training.sessions s where s.trial_id = p_trial and s.voice)
       or exists (select 1 from training.voice_sessions vs join training.sessions s on s.id = vs.session_id
                   where s.trial_id = p_trial and vs.status = 'open')
       or (v_quota is not null and (select count(*) from training.voice_sessions vs join training.sessions s on s.id = vs.session_id
                                     where s.user_id = v_actor and vs.opened_at >= date_trunc('day', now())) >= v_quota) then
      raise exception using errcode = 'AR040', message = 'ticket refused';
    end if;
  end if;
  insert into training.access_tickets (ticket_sha256, kind, user_id, trial_id, mode, expires_at)
    values (ledger.hash_text(v_token), p_kind, v_actor, p_trial, v_t.mode, now() + interval '60 seconds');
  return v_token;
end $$;

-- redeem_access_ticket (arena_public): once, before expiry, by the same actor. Returns the binding.
create or replace function training.redeem_access_ticket(p_token text, p_kind text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v training.access_tickets;
begin
  select * into v from training.access_tickets where ticket_sha256 = ledger.hash_text(p_token) for update;
  if v.id is null or v.kind <> p_kind or v.redeemed_at is not null or v.expires_at < now()
     or v.user_id is distinct from arena.actor_id() then
    raise exception using errcode = 'AR040', message = 'ticket refused';
  end if;
  update training.access_tickets set redeemed_at = now() where id = v.id;
  return jsonb_build_object('ticket_id', v.id, 'user_id', v.user_id, 'trial_id', v.trial_id, 'mode', v.mode,
                            'split', 'dev');
end $$;

-- claim_voice_ticket (arena_subject): arena-subject re-checks the binding the relay presents, once.
create or replace function training.claim_voice_ticket(p_ticket_id uuid, p_user uuid, p_trial uuid, p_mode text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v training.access_tickets;
begin
  select * into v from training.access_tickets where id = p_ticket_id for update;
  if v.id is null or v.kind <> 'voice' or v.redeemed_at is null or v.subject_checked_at is not null
     or v.redeemed_at < now() - interval '2 minutes'
     or (v.user_id, v.trial_id, v.mode) is distinct from (p_user, p_trial, p_mode)
     or (select f.split from arena.trials t join arena.case_variants cv on cv.id = t.variant_id
           join arena.case_families f on f.id = cv.family_id where t.id = v.trial_id) <> 'dev' then
    return false;
  end if;
  update training.access_tickets set subject_checked_at = now() where id = v.id;
  return true;
end $$;

-- record_voice_question (arena_subject): the investigator's spoken question exists only as a Live
-- input transcription inside arena-subject (S5 Q8). Records Q(t) on the voice session's own
-- training trial and returns the subject_answer work item for the same turn (no release step
-- mid-utterance; releases are REST actions between turns).
create or replace function training.record_voice_question(p_trial uuid, p_voice_session uuid, p_question text,
                                                          p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v     arena.trials;
  v_t   arena.turns;
  v_res jsonb;
  v_wi  uuid;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  if v.kind <> 'training' or not exists (
       select 1 from training.voice_sessions vs join training.sessions s on s.id = vs.session_id
        where vs.id = p_voice_session and vs.status = 'open' and s.trial_id = p_trial) then
    raise exception using errcode = 'AR040', message = 'voice question refused';
  end if;
  select * into v_t from arena.turns where trial_id = p_trial and idempotency_key = p_idempotency_key;
  if found then
    if v_t.question is distinct from p_question then
      raise exception using errcode = 'AR003', message = 'idempotency key reused with a different question';
    end if;
    select id into v_wi from arena.work_items
     where trial_id = p_trial and kind = 'subject_answer' and turn_no = v_t.turn_no and status = 'open'
     order by created_at desc limit 1;
    return jsonb_build_object('turn_no', v_t.turn_no, 'transcript_version', v_t.question_version, 'work_item_id', v_wi);
  end if;
  v_res := arena._record_question(v, p_question, 'investigator', p_idempotency_key);
  insert into arena.work_items (trial_id, kind, transcript_version, turn_no)
    values (p_trial, 'subject_answer', (v_res ->> 'transcript_version')::integer, (v_res ->> 'turn_no')::smallint)
    returning id into v_wi;
  return v_res || jsonb_build_object('work_item_id', v_wi);
end $$;

-- record_voice_fragment (arena_subject): append one transcript fragment of an open voice session.
create or replace function training.record_voice_fragment(p_voice_session uuid, p_seq integer, p_speaker text, p_text text,
                                                          p_partial boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  select status into v_status from training.voice_sessions where id = p_voice_session for share;
  if v_status is distinct from 'open' then
    raise exception using errcode = 'AR001', message = 'voice session is not open';
  end if;
  insert into training.voice_fragments (voice_session_id, seq, speaker, text, partial)
    values (p_voice_session, p_seq, p_speaker, p_text, coalesce(p_partial, false))
    on conflict (voice_session_id, seq) do nothing;
end $$;

-- record_voice_utterance (arena_subject): monotonic received and played sample counts.
create or replace function training.record_voice_utterance(p_voice_session uuid, p_utterance integer, p_received integer,
                                                           p_played integer, p_ended boolean)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_partial boolean;
begin
  if (select status from training.voice_sessions where id = p_voice_session for share) is distinct from 'open' then
    raise exception using errcode = 'AR001', message = 'voice session is not open';
  end if;
  insert into training.voice_utterances (voice_session_id, utterance_no, received_samples, played_samples, ended)
    values (p_voice_session, p_utterance, greatest(p_received, 0), greatest(p_played, 0), coalesce(p_ended, false))
    on conflict (voice_session_id, utterance_no) do update
      set received_samples = greatest(training.voice_utterances.received_samples, excluded.received_samples),
          played_samples = greatest(training.voice_utterances.played_samples, excluded.played_samples),
          ended = training.voice_utterances.ended or excluded.ended
    returning partial into v_partial;
  return v_partial;
end $$;

-- Resume: arena-subject stores the Live handle and gets a token for the browser; arena-api redeems
-- it for the actor (re-checking ownership); arena-subject takes the handle once.
create or replace function training.issue_voice_resume(p_voice_session uuid, p_live_handle text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if (select status from training.voice_sessions where id = p_voice_session for update) is distinct from 'open'
     or (select count(*) from training.voice_resumes where voice_session_id = p_voice_session) >= 3 then
    raise exception using errcode = 'AR040', message = 'resume refused';
  end if;
  insert into training.voice_resumes (voice_session_id, token_sha256, live_handle, expires_at)
    values (p_voice_session, ledger.hash_text(v_token), p_live_handle, now() + interval '10 minutes');
  return v_token;
end $$;

create or replace function training.redeem_voice_resume(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v   training.voice_resumes;
  v_s training.sessions;
  v_t arena.trials;
begin
  select * into v from training.voice_resumes where token_sha256 = ledger.hash_text(p_token) for update;
  select s.* into v_s from training.voice_sessions vs join training.sessions s on s.id = vs.session_id
   where vs.id = v.voice_session_id and vs.status = 'open';
  select * into v_t from arena.trials where id = v_s.trial_id;
  if v.id is null or v.redeemed_at is not null or v.expires_at < now() or v_s.id is null
     or v_s.user_id is distinct from arena.actor_id() or v_t.status <> 'running' then
    raise exception using errcode = 'AR040', message = 'resume refused';
  end if;
  update training.voice_resumes set redeemed_at = now() where id = v.id;
  return jsonb_build_object('voice_session_id', v.voice_session_id, 'trial_id', v_t.id, 'user_id', v_s.user_id,
                            'mode', v_t.mode, 'split', 'dev');
end $$;

create or replace function training.take_voice_handle(p_voice_session uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v training.voice_resumes;
begin
  select * into v from training.voice_resumes
   where voice_session_id = p_voice_session and redeemed_at is not null and taken_at is null
     and redeemed_at > now() - interval '2 minutes'
   order by redeemed_at desc limit 1 for update;
  if v.id is null then
    raise exception using errcode = 'AR040', message = 'resume refused';
  end if;
  update training.voice_resumes set taken_at = now() where id = v.id;
  return v.live_handle;
end $$;

-- acknowledge (arena_public): records the actor's acknowledgement once and returns its time.
create or replace function training.acknowledge(p_kind text)
returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := arena.actor_id();
  v_at    timestamptz;
begin
  perform ledger.require_read_committed();
  if v_actor is null then
    raise exception using errcode = 'AR040', message = 'no investigator identity on this request';
  end if;
  if p_kind is distinct from 'ex4' then
    raise exception using errcode = 'AR007', message = 'unknown acknowledgement';
  end if;
  insert into training.acknowledgements (user_id, kind) values (v_actor, p_kind) on conflict (user_id, kind) do nothing;
  select acknowledged_at into v_at from training.acknowledgements where user_id = v_actor and kind = p_kind;
  return v_at;
end $$;

-- -----------------------------------------------------------------------------
-- Projections for arena_public (the actor's own rows only)
-- -----------------------------------------------------------------------------
create view training.v_my_acknowledgements with (security_barrier = true) as
  select a.kind, a.acknowledged_at from training.acknowledgements a where a.user_id = arena.actor_id();

create view training.v_my_sessions with (security_barrier = true) as
  select s.id, s.trial_id, s.phase, s.voice, s.created_at, t.mode, t.status, t.exchanges, t.variant_id, t.ended_at
    from training.sessions s join arena.trials t on t.id = s.trial_id
   where s.user_id = arena.actor_id();

-- Scores reach the investigator only after the session ends (blind scoring is unaffected).
create view training.v_my_scores with (security_barrier = true) as
  select r.session_id, r.scorer, r.clarity_neutrality, r.response_relevance, r.evidence_follow_up,
         r.alternative_testing, r.supported_closure, r.total, r.rationale, r.created_at
    from training.rubric_scores r join training.sessions s on s.id = r.session_id
    join arena.trials t on t.id = s.trial_id
   where s.user_id = arena.actor_id() and t.status in ('finalized', 'terminated');

create view training.v_my_voice_fragments with (security_barrier = true) as
  select f.voice_session_id, f.seq, f.speaker, f.text, f.partial, f.created_at
    from training.voice_fragments f join training.voice_sessions v on v.id = f.voice_session_id
    join training.sessions s on s.id = v.session_id
   where s.user_id = arena.actor_id();

-- -----------------------------------------------------------------------------
-- RLS and privileges
-- -----------------------------------------------------------------------------
alter table training.participants enable row level security;
alter table training.case_set_members enable row level security;
alter table training.sessions enable row level security;
alter table training.rubric_scores enable row level security;
alter table training.access_tickets enable row level security;
alter table training.voice_sessions enable row level security;
alter table training.voice_fragments enable row level security;
alter table training.voice_utterances enable row level security;
alter table training.voice_resumes enable row level security;
alter table training.acknowledgements enable row level security;

revoke all on all tables in schema training from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;
revoke all on all functions in schema training from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;

grant usage on schema training to arena_public, arena_subject, arena_referee;

grant execute on function
  training.start_session(uuid, text, text, uuid, uuid, boolean, text),
  training.issue_access_ticket(text, uuid),
  training.redeem_access_ticket(text, text),
  training.redeem_voice_resume(text),
  training.acknowledge(text)
  to arena_public;
grant select on training.v_my_sessions, training.v_my_scores, training.v_my_voice_fragments,
  training.v_my_acknowledgements to arena_public;

grant execute on function
  training.claim_voice_ticket(uuid, uuid, uuid, text),
  training.record_voice_question(uuid, uuid, text, text),
  training.record_voice_fragment(uuid, integer, text, text, boolean),
  training.record_voice_utterance(uuid, integer, integer, integer, boolean),
  training.issue_voice_resume(uuid, text),
  training.take_voice_handle(uuid)
  to arena_subject;

-- arena_referee: reads training rows except resume handles; writes participants, case sets, scores.
grant select on training.participants, training.case_set_members, training.sessions, training.rubric_scores,
  training.access_tickets, training.voice_sessions, training.voice_fragments, training.voice_utterances,
  training.acknowledgements, training.v_my_sessions, training.v_my_scores, training.v_my_voice_fragments,
  training.v_my_acknowledgements
  to arena_referee;
grant insert on training.participants, training.case_set_members, training.rubric_scores to arena_referee;
create policy participants_referee on training.participants for all to arena_referee using (true) with check (true);
create policy case_set_members_referee on training.case_set_members for all to arena_referee using (true) with check (true);
create policy rubric_scores_referee on training.rubric_scores for all to arena_referee using (true) with check (true);
create policy sessions_referee on training.sessions for select to arena_referee using (true);
create policy access_tickets_referee on training.access_tickets for select to arena_referee using (true);
create policy voice_sessions_referee on training.voice_sessions for select to arena_referee using (true);
create policy voice_fragments_referee on training.voice_fragments for select to arena_referee using (true);
create policy voice_utterances_referee on training.voice_utterances for select to arena_referee using (true);
create policy acknowledgements_referee on training.acknowledgements for select to arena_referee using (true);
