-- =============================================================================
-- 0005_training.sql  (DRAFT v2.8, spec S4; applied only to throwaway local PostgreSQL 17.11 containers)
-- Investigator sessions (practice and assessment, development cases only), KPI-1 participants and
-- matched case sets with the session phase derived from committed state, blinded rubric scores, the
-- published debrief, single-use access tickets for SSE and voice, voice sessions (unscored practice,
-- D7). A dropped voice connection ends its voice session; reconnecting opens a new one (D-016).
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
-- SG1-23: a case set names active development variants only, and its members are fixed (append-only);
-- ingest refuses to revise a family that holds a member, so a set never points at a retired revision.
create or replace function training.tg_case_set_member() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op <> 'INSERT' then
    raise exception using errcode = 'AR010', message = 'KPI-1 case sets are fixed (append-only)';
  end if;
  if exists (select 1 from arena.case_variants cv join arena.case_families f on f.id = cv.family_id
              where cv.id = new.variant_id and f.split <> 'dev')
     or exists (select 1 from arena.case_variants cv join arena.family_retirements r on r.family_id = cv.family_id
                 where cv.id = new.variant_id) then
    raise exception using errcode = 'AR007', message = 'a case set names an active development variant (SG1-23)';
  end if;
  return new;
end $$;
create trigger case_set_members_guard before insert or update or delete on training.case_set_members
  for each row execute function training.tg_case_set_member();

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

-- One Live session (D-006). Voice sessions are unscored development practice (D7, D-016): a voice session
-- writes no arena.turns rows and no per-question work items; arena-subject stores each completed exchange
-- in training.voice_exchanges for display only, so closing or losing the connection never leaves an open
-- turn. A session created with voice = true takes no typed questions; its finding is committed in text.
create table training.voice_sessions (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references training.sessions(id) on delete restrict,
  ticket_id      uuid not null unique references training.access_tickets(id) on delete restrict,
  reservation_id uuid not null,              -- FK to ops.budget_reservations added in 0006
  status         text not null default 'open' check (status in ('open', 'closed')),
  close_code     text check (length(close_code) between 1 and 64),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  constraint voice_close_shape check ((status = 'closed') = (closed_at is not null and close_code is not null))
);
create unique index voice_sessions_one_open on training.voice_sessions (session_id) where status = 'open';

-- The spoken transcript of a voice session's trial, display only (D-016, SG3-41): one row per completed
-- exchange (one Live model turn_complete), numbered across the trial's voice sessions, at most 12 (BKO-8).
-- lines are the transcription fragments that arrived since the previous exchange boundary, role-tagged and
-- in arrival order: [{role: investigator | subject, text, partial}]. Live gives transcription no exchange
-- identifier, so the rows claim no question-answer pairing; a late fragment simply sits in the window it
-- arrived in. Nothing scores these rows.
create table training.voice_exchanges (
  trial_id         uuid not null references arena.trials(id) on delete restrict,
  exchange_no      smallint not null check (exchange_no between 1 and 12),
  voice_session_id uuid not null references training.voice_sessions(id) on delete restrict,
  lines            jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) <= 40
                                         and octet_length(lines::text) <= 16384),
  created_at       timestamptz not null default now(),
  primary key (trial_id, exchange_no)
);
create trigger voice_exchanges_append_only before update or delete on training.voice_exchanges
  for each row execute function arena.tg_forbid_mutation();

-- The published debrief (D8, SG3-14): one per session, written only by training.publish_debrief
-- (arena_referee) after the session's trial ended, read by its owner through training.v_my_debrief.
-- payload is S3 5.7's debrief.v1 (S3 owns it; the referee validates the full schema in code). The one
-- envelope check below is used by both the table and publish_debrief (SG3-34): top-level keys only from
-- S3's set; schema_version, session_id, scored and outcome (with role, correct_finding, committed_label and
-- a resolution string) always; scored = true carries rubric, scorecards and provenance; scored = false
-- (a voice session, D7) carries none of the three.
create or replace function training.debrief_envelope_ok(p jsonb)
returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and octet_length(p::text) <= 65536
     and p ->> 'schema_version' = 'debrief.v1'
     and p ?& array['schema_version', 'session_id', 'scored', 'outcome']
     and not exists (select 1 from jsonb_object_keys(p) k
                      where k not in ('schema_version', 'session_id', 'scored', 'outcome', 'rubric', 'scorecards',
                                      'provenance'))
     and jsonb_typeof(p -> 'scored') = 'boolean'
     and jsonb_typeof(p -> 'outcome') = 'object'
     and (p -> 'outcome') ?& array['role', 'correct_finding', 'committed_label', 'resolution']
     and jsonb_typeof(p -> 'outcome' -> 'resolution') = 'string'
     and case when (p ->> 'scored')::boolean
              then p ?& array['rubric', 'scorecards', 'provenance']
                   and jsonb_typeof(p -> 'rubric') = 'object' and jsonb_typeof(p -> 'scorecards') = 'object'
                   and jsonb_typeof(p -> 'provenance') = 'object'
              else not (p ?| array['rubric', 'scorecards', 'provenance']) end
$$;
create table training.debriefs (
  session_id   uuid primary key references training.sessions(id) on delete restrict,
  payload      jsonb not null check (training.debrief_envelope_ok(payload)),
  sha256       text not null generated always as (ledger.hash_jsonb(payload)) stored,
  published_at timestamptz not null default now()
);
create trigger debriefs_append_only before update or delete on training.debriefs
  for each row execute function arena.tg_forbid_mutation();

-- No resume credentials (D-016, SG3-28, SG3-29): a dropped voice connection ends that voice session; the
-- browser reconnects by opening a new voice session on the same trial (new ticket, new reservation), and
-- arena-subject rebuilds Live's context from subject.voice_context, so continuity comes from the database
-- and no Live resumption handle or cross-leg receipt numbering exists.

-- -----------------------------------------------------------------------------
-- start_session (arena_public): the actor (arena.actor_id, set by arena-api's identity layer:
-- the dev identity middleware locally, the IAP mapping in the hosted variant) opens a practice or
-- assessment interview on a development variant. Idempotent per (actor, key). Daily session
-- quota from ops.config (OWNER DECISION PENDING value). The coach must be an assistant candidate
-- and the subject a subject candidate (referee and negative_control kinds never run sessions).
-- The phase is derived from committed state, never sent (SG3-13, SG4-10; S3 6.1 protocol: two pre-tests,
-- three practice sessions, two post-tests): a variant of the participant's pre-test set is phase pre; of
-- the post-test set, phase post once both pre-tests and three practice sessions have ended; anything
-- else is practice, which a participant starts only after both pre-tests ended. Tests run in assessment
-- mode, in text (voice is unscored, D7), each test variant once. A KPI-1 case-set variant runs only as a
-- participant's test (X-08), and a retired family never starts a session (SG1-11).
-- -----------------------------------------------------------------------------
-- SG3-31: the one study predicate, used by start_session and training.v_my_study. A test session counts
-- once it ended (finalized or terminated). A practice session counts toward the protocol only as the
-- KPI-1 intervention S3 6.1 defines: Practice mode (live coaching), text (not voice, D7), and finalized
-- (the investigator committed a finding); assessment-mode, voice and terminated free sessions do not.
create or replace function training.session_counts(p_phase text, p_mode text, p_voice boolean, p_status text)
returns boolean
language sql immutable set search_path = '' as $$
  select case when p_phase in ('pre', 'post') then p_status in ('finalized', 'terminated')
              else p_mode = 'practice' and not p_voice and p_status = 'finalized' end
$$;

create or replace function training._ended_sessions(p_participant uuid, p_phase text)
returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from training.sessions s join arena.trials t on t.id = s.trial_id
   where s.participant_id = p_participant and s.phase = p_phase
     and training.session_counts(s.phase, t.mode, s.voice, t.status)
$$;

create or replace function training.start_session(p_variant uuid, p_mode text, p_coach_candidate uuid,
                                                  p_subject_candidate uuid, p_voice boolean, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := arena.actor_id();
  v_s     training.sessions;
  v_part  training.participants;
  v_set   text;
  v_phase text := 'practice';
  v_quota smallint;
  v_t     arena.trials;
begin
  perform ledger.require_read_committed();
  if v_actor is null then
    raise exception using errcode = 'AR040', message = 'no investigator identity on this request';
  end if;
  -- one actor's starts serialize: the quota and the study state are read, then written
  perform pg_advisory_xact_lock(hashtextextended('training.start_session:' || v_actor::text, 0));
  select * into v_s from training.sessions where user_id = v_actor and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('session_id', v_s.id, 'trial_id', v_s.trial_id, 'phase', v_s.phase);
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
  if p_mode is null or p_mode not in ('practice', 'assessment') then
    raise exception using errcode = 'AR007', message = 'mode is practice or assessment';
  end if;
  if exists (select 1 from arena.case_variants cv join arena.family_retirements r on r.family_id = cv.family_id
              where cv.id = p_variant) then
    raise exception using errcode = 'AR007', message = 'a retired family starts no session (SG1-11)';
  end if;
  select * into v_part from training.participants where user_id = v_actor;
  select m.set_code into v_set from training.case_set_members m where m.variant_id = p_variant;
  if v_set is not null then
    if v_part.id is null then
      raise exception using errcode = 'AR007', message = 'KPI-1 case-set variants are test cases for participants only';
    end if;
    if v_set = left(v_part.counterbalance, 1) then
      v_phase := 'pre';
    else
      v_phase := 'post';
      if training._ended_sessions(v_part.id, 'pre')
           < (select count(*) from training.case_set_members m where m.set_code = left(v_part.counterbalance, 1))
         or training._ended_sessions(v_part.id, 'practice') < 3 then
        raise exception using errcode = 'AR007', message = 'the post-test follows both pre-tests and three practice sessions';
      end if;
    end if;
    if p_mode <> 'assessment' or coalesce(p_voice, false) then
      raise exception using errcode = 'AR007', message = 'pre and post tests run in assessment mode, in text';
    end if;
    if exists (select 1 from training.sessions s join arena.trials t on t.id = s.trial_id
                where s.participant_id = v_part.id and t.variant_id = p_variant) then
      raise exception using errcode = 'AR007', message = 'each test case runs once';
    end if;
  else
    if exists (select 1 from training.case_set_members m join arena.case_variants cv on cv.id = m.variant_id
                where cv.family_id = (select family_id from arena.case_variants where id = p_variant)) then
      raise exception using errcode = 'AR007', message = 'KPI-1 case-set families are used only for pre and post tests';
    end if;
    if v_part.id is not null and training._ended_sessions(v_part.id, 'pre')
         < (select count(*) from training.case_set_members m where m.set_code = left(v_part.counterbalance, 1)) then
      raise exception using errcode = 'AR007', message = 'a participant practises after both pre-tests';
    end if;
  end if;
  insert into arena.trials (kind, variant_id, assistant_candidate_id, subject_candidate_id, mode, owner_user_id,
                            status, started_at)
    values ('training', p_variant, p_coach_candidate, p_subject_candidate, p_mode, v_actor, 'running', now())
    returning * into v_t;
  insert into training.sessions (trial_id, user_id, participant_id, phase, voice, idempotency_key)
    values (v_t.id, v_actor, v_part.id, v_phase, coalesce(p_voice, false), p_idempotency_key)
    returning * into v_s;
  perform ledger.append_event('training_started', null, v_t.id,
    jsonb_build_object('session_id', v_s.id, 'mode', p_mode, 'phase', v_phase));
  return jsonb_build_object('session_id', v_s.id, 'trial_id', v_t.id, 'phase', v_phase);
end $$;

-- issue_access_ticket (arena_public): a 60-second single-use token for the actor's own training trial.
-- SSE: while the trial runs, and after it ended until its debrief is published, so a client that lost its
-- stream just before the end can catch up (D9, SG3-18). Voice: running trials only, with the session's
-- voice flag, no open voice session on the trial, and the per-user daily voice quota (OWNER DECISION
-- PENDING value in ops.config).
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
     or p_kind is null or p_kind not in ('sse', 'voice')
     or (p_kind = 'voice' and v_t.status <> 'running')
     or (p_kind = 'sse' and v_t.status <> 'running'
         and (v_t.status not in ('finalized', 'terminated')
              or exists (select 1 from training.debriefs d join training.sessions s on s.id = d.session_id
                          where s.trial_id = p_trial))) then
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

-- record_voice_exchange (arena_subject; D-016, SG3-41): stores one completed exchange window of an open voice
-- session for display (role-tagged lines in arrival order, each {role, text <= 900, partial}), numbered across
-- the trial (the next number, at most 12), and in the same transaction applies
-- the trial's due scheduled releases (arena._apply_releases counts stored voice exchanges), so the result
-- tells arena-subject what to add to Live's context before it forwards more audio. Idempotent on
-- (trial, exchange_no): the same content returns the stored result, other content is refused (AR003).
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
    -- WP-03 fix 5: a repeat answers what the original call released (the scheduled releases its commit applied: no work
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
  -- WP-03 fix 7: number 13 passed the order check and failed on the table's 1..12 constraint (23514), not AR004.
  if p_exchange_no is distinct from
     ((select count(*) from training.voice_exchanges where trial_id = v.id) + 1)::smallint or p_exchange_no > 12 then
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
-- publish_debrief (arena_referee; D8, SG3-14, C-17): stores a session's debrief once, after its trial
-- ended, and in the same transaction appends the persisted debrief_ready event, so readiness is never
-- visible before the projection commits. A repeat with the same payload returns the stored one; a
-- different payload is refused (one debrief per session). The referee validates the payload in code
-- (debrief.v1) before calling; the table checks its envelope.
-- -----------------------------------------------------------------------------
create or replace function training.publish_debrief(p_session uuid, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_s   training.sessions;
  v     arena.trials;
  v_d   training.debriefs;
  v_seq integer;
begin
  perform ledger.require_read_committed();
  select * into v_s from training.sessions where id = p_session;
  if not found then
    raise exception using errcode = 'AR001', message = 'session not found';
  end if;
  v := arena._lock_trial(v_s.trial_id);
  if v.status not in ('finalized', 'terminated') then
    raise exception using errcode = 'AR001', message = 'a debrief follows the end of the session';
  end if;
  -- Envelope of S3 5.7 debrief.v1, the same check as the table's (SG3-34); a text session is scored and a
  -- voice session is not (D7).
  if not coalesce(training.debrief_envelope_ok(p_payload), false)
     or p_payload ->> 'session_id' is distinct from p_session::text
     or (p_payload ->> 'scored')::boolean = v_s.voice then
    raise exception using errcode = 'AR007', message = 'debrief payload must match the debrief.v1 envelope (S3 5.7)';
  end if;
  select * into v_d from training.debriefs where session_id = p_session;
  if found then
    if v_d.payload = p_payload then
      return jsonb_build_object('outcome', 'exists', 'sha256', v_d.sha256,
                                'seq', (select e.seq from arena.trial_events e where e.trial_id = v.id and e.kind = 'debrief_ready'));
    end if;
    raise exception using errcode = 'AR003', message = 'a session has one debrief';
  end if;
  insert into training.debriefs (session_id, payload) values (p_session, p_payload) returning * into v_d;
  v_seq := arena._emit(v, 'debrief_ready', null, jsonb_build_object('session_id', p_session, 'sha256', v_d.sha256));
  return jsonb_build_object('outcome', 'published', 'sha256', v_d.sha256, 'seq', v_seq);
end $$;

-- -----------------------------------------------------------------------------
-- Projections for arena_public (the actor's own rows only, and the case library)
-- -----------------------------------------------------------------------------
-- The case library: development variants with public packets, no style column (C-22, C-26). Retired
-- families are absent (SG1-11); kpi1_set marks a family that holds a KPI-1 case-set member, which the
-- C-37 draw excludes for every user (X-08).
create view arena.v_dev_cases with (security_barrier = true) as
  select v.id as variant_id, f.family_code, f.domain, v.variant_code, v.difficulty, p.packet as public_packet,
         exists (select 1 from training.case_set_members m join arena.case_variants mv on mv.id = m.variant_id
                  where mv.family_id = f.id) as kpi1_set
    from arena.case_variants v join arena.case_families f on f.id = v.family_id
    join arena.public_packets p on p.variant_id = v.id
   where f.split = 'dev' and not exists (select 1 from arena.family_retirements r where r.family_id = f.id);

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

-- The actor's published debriefs (D8). Publication happens only after the session ended.
-- The actor's voice transcripts (D-016): display only, for the room after a reload and the debrief.
create view training.v_my_voice_exchanges with (security_barrier = true) as
  select x.trial_id, x.exchange_no, x.lines, x.created_at
    from training.voice_exchanges x join training.sessions s on s.trial_id = x.trial_id
   where s.user_id = arena.actor_id();

create view training.v_my_debrief with (security_barrier = true) as
  select d.session_id, d.payload, d.sha256, d.published_at
    from training.debriefs d join training.sessions s on s.id = d.session_id
   where s.user_id = arena.actor_id();

-- The actor's KPI-1 study state (SG3-13): counterbalance, ended sessions per phase, the two test sets
-- and the variants already tested. GET /api/me and GET /api/cases read it; no other participant's row
-- and no participant table is exposed.
create view training.v_my_study with (security_barrier = true) as
  select p.code, p.counterbalance,
         (select count(*)::integer from training.sessions s join arena.trials t on t.id = s.trial_id
           where s.participant_id = p.id and s.phase = 'pre' and t.status in ('finalized', 'terminated')) as pre_ended,
         (select count(*)::integer from training.sessions s join arena.trials t on t.id = s.trial_id
           where s.participant_id = p.id and s.phase = 'practice'
             and training.session_counts(s.phase, t.mode, s.voice, t.status)) as practice_ended,
         (select count(*)::integer from training.sessions s join arena.trials t on t.id = s.trial_id
           where s.participant_id = p.id and s.phase = 'post' and t.status in ('finalized', 'terminated')) as post_ended,
         array(select m.variant_id from training.case_set_members m
                where m.set_code = left(p.counterbalance, 1) order by m.variant_id) as pre_variant_ids,
         array(select m.variant_id from training.case_set_members m
                where m.set_code = right(p.counterbalance, 1) order by m.variant_id) as post_variant_ids,
         array(select t.variant_id from training.sessions s join arena.trials t on t.id = s.trial_id
                where s.participant_id = p.id and s.phase in ('pre', 'post') order by t.variant_id) as tested_variant_ids
    from training.participants p where p.user_id = arena.actor_id();

-- -----------------------------------------------------------------------------
-- RLS and privileges
-- -----------------------------------------------------------------------------
alter table training.participants enable row level security;
alter table training.case_set_members enable row level security;
alter table training.sessions enable row level security;
alter table training.rubric_scores enable row level security;
alter table training.access_tickets enable row level security;
alter table training.voice_sessions enable row level security;
alter table training.voice_exchanges enable row level security;
alter table training.acknowledgements enable row level security;
alter table training.debriefs enable row level security;

revoke all on all tables in schema training from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;
revoke all on all functions in schema training from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;
revoke all on arena.v_dev_cases from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;

grant usage on schema training to arena_public, arena_subject, arena_referee;

grant execute on function training.session_counts(text, text, boolean, text) to arena_public, arena_referee;
grant execute on function
  training.start_session(uuid, text, uuid, uuid, boolean, text),
  training.issue_access_ticket(text, uuid),
  training.redeem_access_ticket(text, text),
  training.acknowledge(text)
  to arena_public;
grant select on arena.v_dev_cases, training.v_my_sessions, training.v_my_scores, training.v_my_debrief,
  training.v_my_study, training.v_my_acknowledgements, training.v_my_voice_exchanges to arena_public;

grant execute on function
  training.claim_voice_ticket(uuid, uuid, uuid, text),
  training.record_voice_exchange(uuid, smallint, jsonb)
  to arena_subject;

-- arena_referee: reads training rows; writes participants, case sets and scores
-- directly, and debriefs only through publish_debrief.
grant select on training.participants, training.case_set_members, training.sessions, training.rubric_scores,
  training.access_tickets, training.voice_sessions, training.voice_exchanges, training.acknowledgements, training.debriefs,
  arena.v_dev_cases
  to arena_referee;   -- not the actor-scoped v_my_* views (SG3-38): the referee reads the tables
grant insert on training.participants, training.case_set_members, training.rubric_scores to arena_referee;
grant execute on function training.publish_debrief(uuid, jsonb) to arena_referee;
create policy participants_referee on training.participants for all to arena_referee using (true) with check (true);
create policy case_set_members_referee on training.case_set_members for all to arena_referee using (true) with check (true);
create policy rubric_scores_referee on training.rubric_scores for all to arena_referee using (true) with check (true);
create policy sessions_referee on training.sessions for select to arena_referee using (true);
create policy access_tickets_referee on training.access_tickets for select to arena_referee using (true);
create policy voice_sessions_referee on training.voice_sessions for select to arena_referee using (true);
create policy voice_exchanges_referee on training.voice_exchanges for select to arena_referee using (true);
create policy acknowledgements_referee on training.acknowledgements for select to arena_referee using (true);
create policy debriefs_referee on training.debriefs for select to arena_referee using (true);
