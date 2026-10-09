-- =============================================================================
-- 0003_tournament_ledger.sql  (DRAFT v2.4, spec S4; applied only to throwaway local PostgreSQL 17.11 containers)
-- Hash-chained ledger, tournaments, frozen roster, trials, turns, released evidence, work
-- items, coaching events, findings, execution records, adjudications, corpus seals, inclusion
-- manifests, referee label tables, scores and leaderboards, tournament lifecycle functions.
-- Requirements: SCN-4, SCN-10, BKO-1, BKO-2, BKO-5, BKO-6, BKO-7, BKO-9, BKO-10, EVL-1, EVL-3,
-- EVL-4, EVL-8, EVL-9, EVL-10, EVL-11, SUB-8.
--
-- Lock order, every function in 0003-0006 (prevents deadlock):
--   tournament row -> trial row -> work item row -> ledger.chain_head -> ops budget rows.
-- Append-only trigger: TechnoMile 20260927000100_foundation.sql lines 57-62.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Hash-chained event ledger (SCN-10, BKO-9). One global chain: every append locks the head
-- row, so seq is gap-free and each row's sha256 covers its predecessor. Volume is small
-- (1-2 users; planned hidden cases = cost_model.PLAN["sealed"]), so one serialized chain is cheap.
-- -----------------------------------------------------------------------------
create table ledger.chain_head (
  id          boolean primary key default true check (id),
  seq         bigint not null check (seq >= 0),
  head_sha256 text not null check (head_sha256 ~ '^[0-9a-f]{64}$')
);
insert into ledger.chain_head (id, seq, head_sha256) values (true, 0, repeat('0', 64));

create table ledger.events (
  seq                bigint primary key check (seq >= 1),
  event_type         text not null check (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  tournament_id      uuid,
  trial_id           uuid,
  transcript_version integer,
  -- ids, hashes and states only; never role labels, private or evaluator content
  payload            jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
  created_us         bigint not null,          -- microseconds since epoch (timezone-independent in the hash)
  prev_sha256        text not null check (prev_sha256 ~ '^[0-9a-f]{64}$'),
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$')
);
create index events_trial_idx on ledger.events (trial_id, seq);
create index events_tournament_idx on ledger.events (tournament_id, seq);
create trigger events_append_only before update or delete on ledger.events
  for each row execute function arena.tg_forbid_mutation();

create or replace function ledger.event_digest(
  p_prev text, p_seq bigint, p_type text, p_tournament uuid, p_trial uuid, p_version integer,
  p_payload jsonb, p_created_us bigint)
returns text
language sql immutable set search_path = '' as $$
  select ledger.hash_jsonb(jsonb_build_object(
    'prev', p_prev, 'seq', p_seq, 'type', p_type, 'tournament', p_tournament, 'trial', p_trial,
    'version', p_version, 'payload', p_payload, 'created_us', p_created_us))
$$;

-- Internal: called only by SECURITY DEFINER functions (no role holds EXECUTE).
create or replace function ledger.append_event(p_type text, p_tournament uuid, p_trial uuid, p_payload jsonb)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_head    record;
  v_seq     bigint;
  v_version integer;
  v_us      bigint := (extract(epoch from clock_timestamp()) * 1000000)::bigint;
  v_sha     text;
begin
  if p_trial is not null then
    select transcript_version into v_version from arena.trials where id = p_trial;
  end if;
  select seq, head_sha256 into v_head from ledger.chain_head where id for update;
  v_seq := v_head.seq + 1;
  v_sha := ledger.event_digest(v_head.head_sha256, v_seq, p_type, p_tournament, p_trial, v_version,
                               coalesce(p_payload, '{}'::jsonb), v_us);
  insert into ledger.events (seq, event_type, tournament_id, trial_id, transcript_version, payload, created_us,
                             prev_sha256, sha256)
    values (v_seq, p_type, p_tournament, p_trial, v_version, coalesce(p_payload, '{}'::jsonb), v_us,
            v_head.head_sha256, v_sha);
  update ledger.chain_head set seq = v_seq, head_sha256 = v_sha where id;
  return v_seq;
end $$;

-- Recompute the chain. Returns the first broken seq, or null when intact.
create or replace function ledger.verify_chain()
returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  v_prev text := repeat('0', 64);
  v_next bigint := 1;
  e record;
begin
  for e in select * from ledger.events order by seq loop
    if e.seq <> v_next or e.prev_sha256 <> v_prev
       or e.sha256 <> ledger.event_digest(e.prev_sha256, e.seq, e.event_type, e.tournament_id, e.trial_id,
                                          e.transcript_version, e.payload, e.created_us) then
      return e.seq;
    end if;
    v_prev := e.sha256;
    v_next := v_next + 1;
  end loop;
  if (select head_sha256 from ledger.chain_head where id) <> v_prev then
    return v_next;
  end if;
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- Tournaments and the frozen roster (BKO-1, BKO-5, BKO-7, BKO-10)
-- -----------------------------------------------------------------------------
create table arena.tournaments (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  split          text not null check (split in ('dev', 'hidden')),
  status         text not null default 'draft'
                   check (status in ('draft', 'frozen', 'running', 'sealed', 'scoring', 'revealed')),
  seed           bigint not null,
  budget_bucket  text not null,               -- FK to ops.budget_buckets added in 0006; 'global' under D-013
  max_exchanges  smallint not null default 12 check (max_exchanges between 1 and 12),
  hidden_seal_id uuid references sealed.hidden_split_seals(id) on delete restrict,
  roster_sha256  text check (roster_sha256 ~ '^[0-9a-f]{64}$'),
  created_at     timestamptz not null default now(),
  frozen_at      timestamptz,
  running_at     timestamptz,
  sealed_at      timestamptz,
  scoring_at     timestamptz,
  revealed_at    timestamptz,
  constraint tournament_frozen_shape check ((status = 'draft') = (roster_sha256 is null)),
  constraint tournament_hidden_seal check (split = 'dev' or status = 'draft' or hidden_seal_id is not null)
);
create trigger tournaments_no_delete before delete on arena.tournaments
  for each row execute function arena.tg_forbid_mutation();

create table arena.blocks (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references arena.tournaments(id) on delete restrict,
  block_no      integer not null check (block_no >= 1),
  family_id     uuid not null references arena.case_families(id) on delete restrict,
  unique (tournament_id, block_no)
);
create trigger blocks_immutable before update or delete on arena.blocks
  for each row execute function arena.tg_forbid_mutation();

create table arena.planned_trials (
  id                      uuid primary key default gen_random_uuid(),
  tournament_id           uuid not null references arena.tournaments(id) on delete restrict,
  position                integer not null check (position >= 1),   -- seeded order across the tournament
  track                   text not null check (track in ('replay_corpus', 'replay', 'interactive')),
  block_id                uuid references arena.blocks(id) on delete restrict,
  variant_id              uuid not null references arena.case_variants(id) on delete restrict,
  assistant_candidate_id  uuid references arena.candidates(id) on delete restrict,
  subject_candidate_id    uuid references arena.candidates(id) on delete restrict,
  repeat                  smallint not null default 1 check (repeat >= 1),
  source_planned_trial_id uuid references arena.planned_trials(id) on delete restrict,
  created_at              timestamptz not null default now(),
  unique (tournament_id, position),
  constraint planned_track_shape check (case track
    when 'interactive'   then assistant_candidate_id is not null and subject_candidate_id is not null
                              and source_planned_trial_id is null and block_id is not null
    when 'replay_corpus' then assistant_candidate_id is null and subject_candidate_id is not null
                              and source_planned_trial_id is null
    when 'replay'        then assistant_candidate_id is not null and subject_candidate_id is null
                              and source_planned_trial_id is not null
  end)
);
create index planned_trials_tournament_idx on arena.planned_trials (tournament_id, track);
create trigger planned_trials_immutable before update or delete on arena.planned_trials
  for each row execute function arena.tg_forbid_mutation();

-- -----------------------------------------------------------------------------
-- Trials: one row per execution attempt (tournament) or per practice session (training).
-- Mutable columns change only inside the functions in 0004/0005 (no role has UPDATE).
-- -----------------------------------------------------------------------------
create table arena.trials (
  id                     uuid primary key default gen_random_uuid(),
  kind                   text not null check (kind in ('training', 'interactive', 'replay_corpus', 'replay')),
  tournament_id          uuid references arena.tournaments(id) on delete restrict,
  planned_trial_id       uuid references arena.planned_trials(id) on delete restrict,
  attempt                smallint not null default 1 check (attempt between 1 and 3),
  variant_id             uuid not null references arena.case_variants(id) on delete restrict,
  assistant_candidate_id uuid references arena.candidates(id) on delete restrict,
  subject_candidate_id   uuid references arena.candidates(id) on delete restrict,
  -- replay: the corpus transcript. A replay trial owns its transcript: arena.advance_replay copies source turn n
  -- (question, answer, and the releases made before that answer) into this trial as turn n with the same
  -- record ids, so (source_trial_id, turn_no) and (source_trial_id, record_id) are the source references (D2).
  source_trial_id        uuid references arena.trials(id) on delete restrict,
  mode                   text not null check (mode in ('practice', 'assessment', 'harness')),
  owner_user_id          uuid references auth.users(id) on delete restrict,
  status                 text not null default 'planned'
                           check (status in ('planned', 'running', 'finalized', 'terminated')),
  transcript_version     integer not null default 0 check (transcript_version >= 0),
  exchanges              smallint not null default 0 check (exchanges >= 0),
  -- one open turn per trial: set when a subject turn commits on a trial with an assistant, cleared by
  -- the turn's coach_card or coach_unavailable event; expires 120 s after the answer (S5 5.1)
  coaching_pending       boolean not null default false,
  max_exchanges          smallint not null default 12 check (max_exchanges between 1 and 12),
  created_at             timestamptz not null default now(),
  started_at             timestamptz,
  ended_at               timestamptz,
  unique (planned_trial_id, attempt),
  constraint trial_kind_shape check (case kind
    when 'training' then planned_trial_id is null and tournament_id is null and owner_user_id is not null
                         and mode in ('practice', 'assessment') and assistant_candidate_id is not null
                         and subject_candidate_id is not null
    else planned_trial_id is not null and tournament_id is not null and owner_user_id is null and mode = 'harness'
  end),
  constraint trial_exchange_cap check (exchanges <= max_exchanges),
  constraint trial_replay_source check ((kind = 'replay') or source_trial_id is null)
);
create index trials_tournament_idx on arena.trials (tournament_id, kind);
create index trials_owner_idx on arena.trials (owner_user_id) where owner_user_id is not null;
create trigger trials_no_delete before delete on arena.trials
  for each row execute function arena.tg_forbid_mutation();

-- Training trials use development variants only (SCN-12; voice and practice never touch hidden cases).
create or replace function arena.tg_trial_split() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_split text;
  v_tsplit text;
begin
  select f.split into v_split from arena.case_variants v join arena.case_families f on f.id = v.family_id
   where v.id = new.variant_id;
  if new.kind = 'training' and v_split <> 'dev' then
    raise exception using errcode = 'AR001', message = 'training trials use development cases only';
  end if;
  if new.tournament_id is not null then
    select split into v_tsplit from arena.tournaments where id = new.tournament_id;
    if v_tsplit <> v_split then
      raise exception using errcode = 'AR001', message = 'trial variant split differs from its tournament split';
    end if;
  end if;
  return new;
end $$;
create trigger trials_split before insert on arena.trials
  for each row execute function arena.tg_trial_split();

create table arena.turns (
  trial_id         uuid not null references arena.trials(id) on delete restrict,
  turn_no          smallint not null check (turn_no between 1 and 12),
  question         text not null check (length(question) between 1 and 600),          -- D11: 600 characters
  -- who asked (SG2-09; S3 1.3): the investigator (text or voice), or the harness with its fixed or scripted
  -- question, a fallback question, or an assistant proposal it relayed
  question_source  text not null check (question_source in ('investigator', 'harness_fixed', 'harness_fallback',
                                                             'assistant_relay')),
  -- harness relay outcome (S2 8.2's one vocabulary, SG2-21): relayed, fallback_no_card or
  -- fallback_failed_test:<reason>, where <reason> is a relay-test reason code and non_neutral carries its
  -- lexicon group (non_neutral:accusation); null for other sources
  relay_outcome    text check (relay_outcome ~ '^(relayed|fallback_no_card|fallback_failed_test:(too_short|too_long|not_single_question|markup|identifier|not_addressed_to_subject|compound|leading_tag|repeat|non_neutral:(accusation|leading|demeanor|pressure)))$'),
  -- the coach_card event (same trial, previous turn) whose proposal was relayed or failed the relay test
  proposal_seq     integer,
  channel          text not null default 'text' check (channel in ('text', 'voice')),
  question_version integer not null,
  idempotency_key  text not null check (length(idempotency_key) between 8 and 200),
  asked_at         timestamptz not null default now(),
  answer           text check (length(answer) between 1 and 900),     -- S2 V1 and G7: 900 characters
  answer_partial   boolean not null default false,   -- voice: Live reported the utterance interrupted
  answered_at      timestamptz,
  primary key (trial_id, turn_no),
  unique (trial_id, idempotency_key),
  constraint turn_answer_shape check ((answer is null) = (answered_at is null)),
  constraint turn_origin_shape check (case question_source
    when 'assistant_relay'  then relay_outcome = 'relayed' and proposal_seq is not null
    when 'harness_fallback' then relay_outcome like 'fallback\_%'
                                 and (proposal_seq is not null) = (relay_outcome like 'fallback\_failed\_test:%')
    else relay_outcome is null and proposal_seq is null
  end),
  constraint turn_voice_shape check (channel = 'text' or question_source = 'investigator')
);

-- Turns are append-only except that the answer (with its partial flag and time) is written once; every
-- other column is immutable.
create or replace function arena.tg_turn_answer_once() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'AR010', message = 'arena.turns is append-only (DELETE refused)';
  end if;
  if old.answer is not null
     or (to_jsonb(new) - array['answer', 'answer_partial', 'answered_at'])
        is distinct from (to_jsonb(old) - array['answer', 'answer_partial', 'answered_at']) then
    raise exception using errcode = 'AR010', message = 'a turn''s question is immutable and its answer is written once';
  end if;
  return new;
end $$;
create trigger turns_answer_once before update or delete on arena.turns
  for each row execute function arena.tg_turn_answer_once();

create table arena.released_evidence (
  trial_id                 uuid not null references arena.trials(id) on delete restrict,
  record_id                text not null,
  release_seq              smallint not null check (release_seq between 1 and 6),
  released_after_exchanges smallint not null check (released_after_exchanges between 0 and 12),
  kind                     text not null,
  doc_kind                 text not null,           -- copied from sealed.evidence_artifacts (C-24)
  title                    text not null,
  content                  jsonb not null,
  -- derived, never supplied (SG3-08); commitments recompute it from content anyway
  content_sha256           text not null generated always as (ledger.hash_jsonb(content)) stored,
  released_at              timestamptz not null default now(),
  event_seq                bigint not null references ledger.events(seq) on delete restrict,
  primary key (trial_id, record_id),
  unique (trial_id, release_seq)
);
create trigger released_evidence_append_only before update or delete on arena.released_evidence
  for each row execute function arena.tg_forbid_mutation();

-- Work items (F07, D3): server-created, one per step (release, subject answer, coach card, deep update,
-- final finding, failure, replay turn), bound to the transcript version current at creation. The caller's
-- request key (a hash of trial, turn, step kind and purpose) is idempotency_key: open_work_item with a
-- repeated key returns the same item and its stored result, so a restarted orchestrator resumes.
create table arena.work_items (
  id                 uuid primary key default gen_random_uuid(),
  trial_id           uuid not null references arena.trials(id) on delete restrict,
  kind               text not null check (kind in ('subject_answer', 'release', 'coaching', 'finalize', 'failure',
                                                   'replay_turn')),
  transcript_version integer not null,
  turn_no            smallint not null,
  idempotency_key    text not null check (length(idempotency_key) between 8 and 200),
  request_sha256     text check (request_sha256 ~ '^[0-9a-f]{64}$'),
  status             text not null default 'open' check (status in ('open', 'done')),
  result             jsonb,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz,
  unique (trial_id, idempotency_key),
  constraint work_item_done_shape check ((status = 'done') = (result is not null and completed_at is not null)
                                         and (status = 'open' or request_sha256 is not null))
);
create index work_items_trial_idx on arena.work_items (trial_id, status);

create or replace function arena.tg_work_item_once() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or old.status <> 'open' or new.status <> 'done'
     or (new.id, new.trial_id, new.kind, new.transcript_version, new.turn_no, new.idempotency_key, new.created_at)
        is distinct from (old.id, old.trial_id, old.kind, old.transcript_version, old.turn_no, old.idempotency_key, old.created_at) then
    raise exception using errcode = 'AR010', message = 'a work item moves open -> done once; its identity is immutable';
  end if;
  return new;
end $$;
create trigger work_items_once before update or delete on arena.work_items
  for each row execute function arena.tg_work_item_once();

-- Per-trial event store (S5 section 6): one gap-free sequence per trial, assigned under the trial
-- row lock by the function that commits the change. SSE reads it through arena.events_after.
-- visibility: live (stream now), debrief (stream after the trial ends: assessment coaching),
-- internal (tournament trials: never streamed; readable in projections after reveal or on dev).
-- Persisted kinds only; arena_core/events/projections.py maps them to S6 wire names and synthesizes
-- notice, subject.thinking and coach.working (C-17). debrief_ready is written by training.publish_debrief
-- (arena_referee) in the transaction that stores the debrief (D8). A payload is at most 14,336 bytes
-- serialized, so every SSE delta with its envelope stays under 16 KiB (D9).
create table arena.trial_events (
  trial_id           uuid not null references arena.trials(id) on delete restrict,
  seq                integer not null check (seq >= 1),
  kind               text not null check (kind in ('question_recorded', 'subject_turn', 'evidence_released', 'clarification',
                                                   'coach_card', 'coach_deep', 'coach_unavailable', 'finding_committed',
                                                   'trial_ended', 'debrief_ready')),
  visibility         text not null check (visibility in ('live', 'debrief', 'internal')),
  transcript_version integer not null,
  turn_no            smallint not null,
  work_item_id       uuid unique references arena.work_items(id) on delete restrict,   -- coach events only
  candidate_id       uuid references arena.candidates(id) on delete restrict,
  -- coach events: the complete stored card (direction 6.1; AST-1..8). Other kinds: ids, text and states only.
  payload            jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 14336),
  created_at         timestamptz not null default clock_timestamp(),
  primary key (trial_id, seq)
);
create trigger trial_events_append_only before update or delete on arena.trial_events
  for each row execute function arena.tg_forbid_mutation();
alter table arena.turns add constraint turns_proposal_fk foreign key (trial_id, proposal_seq)
  references arena.trial_events (trial_id, seq) on delete restrict;

-- One Finding object for assistants and investigators (C-27, D5): S2 $defs.Finding (label, likelihood,
-- confidence, basis_flag_refs, corroboration_needed, rationale of at most 600 characters) plus cited_turns
-- and cited_records and optional alternative_explanations. classification holds the Finding's label;
-- likelihood is the ICD 203 term; confidence is the analytic confidence.
create table arena.final_findings (
  trial_id       uuid primary key references arena.trials(id) on delete restrict,
  classification text not null check (classification in ('deceptive', 'truthful', 'insufficient_evidence')),
  likelihood     text not null check (likelihood in ('almost_no_chance', 'very_unlikely', 'unlikely', 'roughly_even_chance',
                                                     'likely', 'very_likely', 'almost_certain')),
  confidence     text not null check (confidence in ('low', 'moderate', 'high')),
  finding        jsonb not null check (jsonb_typeof(finding) = 'object' and octet_length(finding::text) <= 8192),
  committed_at   timestamptz not null default now()
);
create trigger final_findings_append_only before update or delete on arena.final_findings
  for each row execute function arena.tg_forbid_mutation();

-- Writes to transcript artifacts need a running trial (belt and braces under the functions).
create or replace function arena.tg_trial_running() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select status from arena.trials where id = new.trial_id) is distinct from 'running' then
    raise exception using errcode = 'AR001', message = format('%s: trial is not running (frozen or not started)', tg_table_name);
  end if;
  return new;
end $$;
create trigger turns_running before insert or update on arena.turns
  for each row execute function arena.tg_trial_running();
create trigger released_evidence_running before insert on arena.released_evidence
  for each row execute function arena.tg_trial_running();

-- -----------------------------------------------------------------------------
-- Sealed per-turn material
-- -----------------------------------------------------------------------------
create table sealed.subject_tag_proposals (
  trial_id   uuid not null references arena.trials(id) on delete restrict,
  turn_no    smallint not null,
  tag        jsonb not null check (jsonb_typeof(tag) = 'object' and pg_column_size(tag) <= 4096),
  created_at timestamptz not null default now(),
  primary key (trial_id, turn_no)
);
create trigger subject_tag_proposals_append_only before update or delete on sealed.subject_tag_proposals
  for each row execute function arena.tg_forbid_mutation();

create table sealed.quarantined_artifacts (
  trial_id     uuid primary key references arena.trials(id) on delete restrict,
  turn_no      smallint not null,
  utterance    text not null,
  tag          jsonb,
  guard_result jsonb not null,
  created_at   timestamptz not null default now()
);
create trigger quarantined_artifacts_append_only before update or delete on sealed.quarantined_artifacts
  for each row execute function arena.tg_forbid_mutation();

-- Independent per-turn labels (EVL-8, F16) and fidelity (EVL-11): written by arena_referee.
-- One row per turn for the model label (R1) and, where calibrated, one for the human consensus
-- (C-34). R1's full output goes to sealed.judgments (fidelity_detail); each rater's own rating to
-- sealed.judgments (calibration, rater_id). Labels are words; codes are display only (C-09).
create table sealed.independent_labels (
  trial_id      uuid not null references arena.trials(id) on delete restrict,
  turn_no       smallint not null,
  labeler       text not null check (labeler in ('model', 'human_consensus')),
  label         text not null check (label in ('evasion', 'genuine_uncertainty', 'legitimate_non_disclosure',
                                                'poorly_framed_question', 'responsive')),
  compliant     boolean not null,            -- subject fidelity: obeys packet and canonical facts
  -- R1's evidence_quote; empty when the label needs no quote or the quote check failed (SG2-08)
  rationale     text not null check (length(rationale) <= 4000),
  prompt_sha256 text check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  primary key (trial_id, turn_no, labeler)
);
create trigger independent_labels_append_only before update or delete on sealed.independent_labels
  for each row execute function arena.tg_forbid_mutation();

-- Other referee judgments: flag support (EVL-5), questioning quality (EVL-6), R1's full output
-- (fidelity_detail, with F1-F6 detail), and each human rater's calibration rating (C-34).
create table sealed.judgments (
  id            uuid primary key default gen_random_uuid(),
  trial_id      uuid not null references arena.trials(id) on delete restrict,
  kind          text not null check (kind in ('flag_support', 'questioning_quality', 'fidelity_detail', 'calibration')),
  rater_id      text check (rater_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),   -- calibration rows only
  payload       jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  prompt_sha256 text check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  -- referee stage key (D3, D8), for example '<trial or session>:r3_subject': an interrupted R1, R2 or R3
  -- stage re-runs and inserts with ON CONFLICT DO NOTHING, so no stage is stored twice
  idempotency_key text unique check (length(idempotency_key) between 8 and 200),
  created_at    timestamptz not null default now(),
  constraint judgment_rater_shape check ((kind = 'calibration') = (rater_id is not null))
);
create index judgments_trial_idx on sealed.judgments (trial_id, kind);
create trigger judgments_append_only before update or delete on sealed.judgments
  for each row execute function arena.tg_forbid_mutation();

create table sealed.commitment_nonces (
  trial_id uuid primary key references arena.trials(id) on delete restrict,
  nonce    bytea not null check (octet_length(nonce) = 32)
);
create trigger commitment_nonces_append_only before update or delete on sealed.commitment_nonces
  for each row execute function arena.tg_forbid_mutation();

-- -----------------------------------------------------------------------------
-- Ledger records
-- -----------------------------------------------------------------------------
-- Execution record (F15): exactly one per trial attempt; the planned trial's execution record
-- is its latest attempt's. Immutable.
create table ledger.terminal_records (
  trial_id         uuid primary key references arena.trials(id) on delete restrict,
  planned_trial_id uuid references arena.planned_trials(id) on delete restrict,
  state            text not null check (state in ('completed', 'subject_quarantined', 'assistant_failed', 'infra_failed',
                                                   'budget_skipped', 'budget_truncated', 'source_unavailable')),
  reason           text check (length(reason) between 1 and 500),
  work_item_id     uuid references arena.work_items(id) on delete restrict,
  event_seq        bigint not null references ledger.events(seq) on delete restrict,
  created_at       timestamptz not null default now()
);
create trigger terminal_records_append_only before update or delete on ledger.terminal_records
  for each row execute function arena.tg_forbid_mutation();

create table ledger.finding_commitments (
  trial_id          uuid primary key references arena.trials(id) on delete restrict,
  -- {trial, kind, transcript_sha256, evidence_sha256, coaching_sha256, finding_sha256, manifest_sha256}
  payload           jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256    text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  commitment_sha256 text not null check (commitment_sha256 ~ '^[0-9a-f]{64}$'),  -- sha256(nonce || payload text)
  event_seq         bigint not null references ledger.events(seq) on delete restrict,
  created_at        timestamptz not null default now()
);
create trigger finding_commitments_append_only before update or delete on ledger.finding_commitments
  for each row execute function arena.tg_forbid_mutation();

create table ledger.validity_adjudications (
  id              uuid primary key default gen_random_uuid(),
  adj_seq         bigint generated always as identity unique,
  trial_id        uuid not null references arena.trials(id) on delete restrict,
  verdict         text not null check (verdict in ('valid', 'subject_invalid')),
  reason          text not null check (length(reason) between 1 and 2000),   -- S3 reason_code maps here (C-33)
  evidence_ref    text check (length(evidence_ref) between 1 and 500),
  decided_by      text not null check (decided_by ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),  -- 'auto_rule' or reviewer ID (C-33)
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 200),
  after_reveal    boolean not null,
  event_seq       bigint not null references ledger.events(seq) on delete restrict,
  created_at      timestamptz not null default now()
);
create index validity_adjudications_trial_idx on ledger.validity_adjudications (trial_id, adj_seq desc);
create trigger validity_adjudications_append_only before update or delete on ledger.validity_adjudications
  for each row execute function arena.tg_forbid_mutation();

create table ledger.corpus_seals (
  tournament_id uuid primary key references arena.tournaments(id) on delete restrict,
  corpus_sha256 text not null check (corpus_sha256 ~ '^[0-9a-f]{64}$'),
  n_transcripts integer not null check (n_transcripts >= 0),
  event_seq     bigint not null references ledger.events(seq) on delete restrict,
  created_at    timestamptz not null default now()
);
create trigger corpus_seals_append_only before update or delete on ledger.corpus_seals
  for each row execute function arena.tg_forbid_mutation();

create table ledger.inclusion_manifests (
  id              uuid primary key default gen_random_uuid(),
  tournament_id   uuid not null references arena.tournaments(id) on delete restrict,
  version         integer not null check (version >= 1),       -- 1 = the result sealed at reveal
  -- S3 4.4 canonical text (header line, then one line per planned trial); hashed as text (X-07)
  manifest        text not null check (manifest like 'arena-inclusion-manifest|v1|%' and right(manifest, 1) = E'\n'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  supersedes_id   uuid references ledger.inclusion_manifests(id) on delete restrict,
  event_seq       bigint not null references ledger.events(seq) on delete restrict,
  created_at      timestamptz not null default now(),
  unique (tournament_id, version),
  constraint manifest_supersedes_shape check ((version = 1) = (supersedes_id is null))
);
create trigger inclusion_manifests_append_only before update or delete on ledger.inclusion_manifests
  for each row execute function arena.tg_forbid_mutation();

-- Nonces published at reveal so anyone can verify every commitment.
create table ledger.revealed_nonces (
  trial_id    uuid primary key references ledger.finding_commitments(trial_id) on delete restrict,
  nonce_hex   text not null check (nonce_hex ~ '^[0-9a-f]{64}$'),
  revealed_at timestamptz not null default now()
);
create trigger revealed_nonces_append_only before update or delete on ledger.revealed_nonces
  for each row execute function arena.tg_forbid_mutation();

-- -----------------------------------------------------------------------------
-- Scores and leaderboards (EVL-1, EVL-6, EVL-10, BKO-9): written by arena_referee only after
-- reveal, each bound to an inclusion manifest.
-- -----------------------------------------------------------------------------
create table arena.scores (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references arena.tournaments(id) on delete restrict,
  manifest_id   uuid not null references ledger.inclusion_manifests(id) on delete restrict,
  candidate_id  uuid references arena.candidates(id) on delete restrict,
  metric        text not null check (metric ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- {point, ci_low, ci_high, n_families, counts, provisional, notes}
  value         jsonb not null check (jsonb_typeof(value) = 'object'),
  created_at    timestamptz not null default now(),
  unique (manifest_id, candidate_id, metric)
);
create trigger scores_append_only before update or delete on arena.scores
  for each row execute function arena.tg_forbid_mutation();

create table arena.leaderboards (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references arena.tournaments(id) on delete restrict,
  manifest_id   uuid not null references ledger.inclusion_manifests(id) on delete restrict,
  board         text not null check (board in ('assistant', 'subject')),
  label         text not null check (label in ('original', 'corrected')),
  body          jsonb not null check (jsonb_typeof(body) = 'object'),
  sha256        text not null generated always as (ledger.hash_jsonb(body)) stored,
  created_at    timestamptz not null default now(),
  unique (manifest_id, board)
);
create trigger leaderboards_append_only before update or delete on arena.leaderboards
  for each row execute function arena.tg_forbid_mutation();

-- Scores and leaderboards bind to a revealed tournament's own manifest. The leaderboard label rule is a
-- separate trigger: arena.scores has no label column, and PL/pgSQL resolves NEW.label when it prepares an
-- expression, before any short-circuit (SG3-01, reproduced on PostgreSQL 17.11).
create or replace function arena.tg_bound_to_revealed_manifest() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_status text;
  v_mt     uuid;
begin
  select status into v_status from arena.tournaments where id = new.tournament_id;
  select tournament_id into v_mt from ledger.inclusion_manifests where id = new.manifest_id;
  if v_status is distinct from 'revealed' or v_mt is distinct from new.tournament_id then
    raise exception using errcode = 'AR020', message = 'scores and leaderboards need a revealed tournament and its own manifest';
  end if;
  return new;
end $$;
create trigger scores_revealed before insert on arena.scores
  for each row execute function arena.tg_bound_to_revealed_manifest();
create trigger leaderboards_revealed before insert on arena.leaderboards
  for each row execute function arena.tg_bound_to_revealed_manifest();

-- original boards only on manifest version 1, corrected boards only on later versions (RV-16)
create or replace function arena.tg_leaderboard_label() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.label = 'original') is distinct from
     ((select m.version from ledger.inclusion_manifests m where m.id = new.manifest_id) = 1) then
    raise exception using errcode = 'AR020', message = 'only the manifest sealed at reveal yields the original leaderboard';
  end if;
  return new;
end $$;
create trigger leaderboards_label before insert on arena.leaderboards
  for each row execute function arena.tg_leaderboard_label();

create table arena.isolation_checks (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid references arena.candidates(id) on delete restrict,
  check_name   text not null check (check_name ~ '^[a-z][a-z0-9_]{0,63}$'),
  passed       boolean not null,
  evidence     jsonb not null check (jsonb_typeof(evidence) = 'object'),
  created_at   timestamptz not null default now()
);
create trigger isolation_checks_append_only before update or delete on arena.isolation_checks
  for each row execute function arena.tg_forbid_mutation();

-- -----------------------------------------------------------------------------
-- Derived views of execution state (read by functions and projections)
-- -----------------------------------------------------------------------------
-- The planned trial's execution record is its latest attempt's terminal record.
create or replace function ledger.planned_execution(p_tournament uuid)
returns table (planned_trial_id uuid, track text, trial_id uuid, attempt smallint, state text, terminal_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.track, t.id, t.attempt, r.state, r.created_at
    from arena.planned_trials p
    left join lateral (select t2.id, t2.attempt from arena.trials t2
                        where t2.planned_trial_id = p.id order by t2.attempt desc limit 1) t on true
    left join ledger.terminal_records r on r.trial_id = t.id
   where p.tournament_id = p_tournament
$$;

create or replace function arena.roster_digest(p_tournament uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select ledger.hash_text(
    (select 'tournament:' || t.id || ':' || t.split || ':' || t.seed || ':' || t.max_exchanges
       from arena.tournaments t where t.id = p_tournament)
    || E'\n' ||
    coalesce((select string_agg(
       p.position || ':' || p.id || ':' || p.track || ':' || coalesce(b.block_no::text, '-') || ':' || p.variant_id
       || ':' || coalesce(a.sha256, '-') || ':' || coalesce(s.sha256, '-') || ':' || p.repeat
       || ':' || coalesce(src.position::text, '-'), E'\n' order by p.position)
       from arena.planned_trials p
       left join arena.blocks b on b.id = p.block_id
       left join arena.candidates a on a.id = p.assistant_candidate_id
       left join arena.candidates s on s.id = p.subject_candidate_id
       left join arena.planned_trials src on src.id = p.source_planned_trial_id
      where p.tournament_id = p_tournament), ''))
$$;

-- -----------------------------------------------------------------------------
-- Tournament lifecycle (arena_referee unless noted)
-- -----------------------------------------------------------------------------
create or replace function arena.create_tournament(p_name text, p_split text, p_seed bigint, p_bucket text,
                                                   p_max_exchanges smallint default 12)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v record;
begin
  perform ledger.require_read_committed();
  select * into v from arena.tournaments where name = p_name;
  if found then
    if (v.split, v.seed, v.budget_bucket, v.max_exchanges) = (p_split, p_seed, p_bucket, p_max_exchanges) then
      return v.id;
    end if;
    raise exception using errcode = 'AR003', message = 'tournament name reused with different parameters';
  end if;
  insert into arena.tournaments (name, split, seed, budget_bucket, max_exchanges)
    values (p_name, p_split, p_seed, p_bucket, p_max_exchanges) returning * into v;
  perform ledger.append_event('tournament_created', v.id, null,
    jsonb_build_object('name', p_name, 'split', p_split, 'seed', p_seed, 'bucket', p_bucket));
  return v.id;
end $$;

-- rows: [{position, track, block_no, variant_id, assistant_candidate_id, subject_candidate_id, repeat,
--         source_position}] ; draft only. Order inside a block comes from the tournament seed (app code),
-- and is recorded as position.
create or replace function arena.add_planned_trials(p_tournament uuid, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_t     record;
  r       jsonb;
  v_block uuid;
  v_fam   uuid;
  v_n     integer := 0;
begin
  perform ledger.require_read_committed();
  select * into v_t from arena.tournaments where id = p_tournament for update;
  if not found or v_t.status <> 'draft' then
    raise exception using errcode = 'AR001', message = 'planned trials are added to a draft tournament only';
  end if;
  -- non-replay rows first so replay rows can reference their corpus row by position
  for r in select x from jsonb_array_elements(p_rows) x order by (x ->> 'track' = 'replay'), (x ->> 'position')::integer loop
    select v.family_id into v_fam from arena.case_variants v where v.id = (r ->> 'variant_id')::uuid;
    if exists (select 1 from arena.family_retirements fr where fr.family_id = v_fam) then
      raise exception using errcode = 'AR007', message = 'a retired family takes no new trials (SG1-11)';
    end if;
    v_block := null;
    if r ? 'block_no' and r ->> 'block_no' is not null then
      insert into arena.blocks (tournament_id, block_no, family_id)
        values (p_tournament, (r ->> 'block_no')::integer, v_fam)
        on conflict (tournament_id, block_no) do nothing;
      select id into v_block from arena.blocks
       where tournament_id = p_tournament and block_no = (r ->> 'block_no')::integer and family_id = v_fam;
      if v_block is null then
        raise exception using errcode = 'AR007', message = 'a block holds one family (both variants)';
      end if;
    end if;
    if exists (select 1 from arena.candidates c where c.id = (r ->> 'assistant_candidate_id')::uuid and c.kind <> 'assistant')
       or exists (select 1 from arena.candidates c where c.id = (r ->> 'subject_candidate_id')::uuid and c.kind <> 'subject') then
      raise exception using errcode = 'AR007', message = 'candidate kind does not match its slot';
    end if;
    insert into arena.planned_trials (tournament_id, position, track, block_id, variant_id, assistant_candidate_id,
                                      subject_candidate_id, repeat, source_planned_trial_id)
      values (p_tournament, (r ->> 'position')::integer, r ->> 'track', v_block, (r ->> 'variant_id')::uuid,
              (r ->> 'assistant_candidate_id')::uuid, (r ->> 'subject_candidate_id')::uuid,
              coalesce((r ->> 'repeat')::smallint, 1),
              (select p.id from arena.planned_trials p
                where p.tournament_id = p_tournament and p.track = 'replay_corpus'
                  and p.position = (r ->> 'source_position')::integer));
    v_n := v_n + 1;
  end loop;
  -- a replay row must score the corpus transcript of its own variant
  if exists (select 1 from arena.planned_trials p join arena.planned_trials s on s.id = p.source_planned_trial_id
              where p.tournament_id = p_tournament and s.variant_id <> p.variant_id) then
    raise exception using errcode = 'AR007', message = 'replay rows must reference a corpus row of the same variant';
  end if;
  return v_n;
end $$;

-- Freeze: hash the roster, bind the hidden seal, create attempt 1 of every planned trial.
create or replace function arena.freeze_tournament(p_tournament uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_t      record;
  v_seal   uuid;
  v_roster text;
begin
  perform ledger.require_read_committed();
  select * into v_t from arena.tournaments where id = p_tournament for update;
  if not found or v_t.status <> 'draft' then
    raise exception using errcode = 'AR001', message = 'only a draft tournament can be frozen';
  end if;
  if not exists (select 1 from arena.planned_trials where tournament_id = p_tournament) then
    raise exception using errcode = 'AR001', message = 'an empty roster cannot be frozen';
  end if;
  if v_t.split = 'hidden' then
    select id into v_seal from sealed.hidden_split_seals;
    if v_seal is null or not sealed.verify_hidden_seal() then
      raise exception using errcode = 'AR021', message = 'the hidden split must be sealed and verify before freeze';
    end if;
  end if;
  if exists (select 1 from arena.planned_trials p join arena.case_variants v on v.id = p.variant_id
               join arena.case_families f on f.id = v.family_id
              where p.tournament_id = p_tournament and f.split <> v_t.split) then
    raise exception using errcode = 'AR001', message = 'every planned variant must belong to the tournament split';
  end if;
  v_roster := arena.roster_digest(p_tournament);
  update arena.tournaments set status = 'frozen', roster_sha256 = v_roster, hidden_seal_id = v_seal, frozen_at = now()
   where id = p_tournament;
  insert into arena.trials (kind, tournament_id, planned_trial_id, attempt, variant_id, assistant_candidate_id,
                            subject_candidate_id, mode, max_exchanges)
    select p.track, p.tournament_id, p.id, 1, p.variant_id, p.assistant_candidate_id, p.subject_candidate_id,
           'harness', v_t.max_exchanges
      from arena.planned_trials p where p.tournament_id = p_tournament;
  perform ledger.append_event('roster_frozen', p_tournament, null,
    jsonb_build_object('roster_sha256', v_roster, 'hidden_seal_id', v_seal,
                       'planned_trials', (select count(*) from arena.planned_trials where tournament_id = p_tournament)));
  return v_roster;
end $$;

create or replace function arena.open_tournament(p_tournament uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  perform ledger.require_read_committed();
  select status into v_status from arena.tournaments where id = p_tournament for update;
  if v_status = 'running' then
    return;
  end if;
  if v_status is distinct from 'frozen' then
    raise exception using errcode = 'AR001', message = 'only a frozen tournament can start running';
  end if;
  update arena.tournaments set status = 'running', running_at = now() where id = p_tournament;
  perform ledger.append_event('tournament_running', p_tournament, null, '{}'::jsonb);
end $$;

-- Replay corpus seal (BKO-6): every corpus planned trial has an execution record; the seal hashes
-- each one's state and, when completed, its committed transcript and evidence hashes, its R1 report (the
-- first fidelity_detail judgment) and its initial validity verdict (the first adjudication), so what the
-- replay track may use is fixed before any assistant sees a transcript (SG2-27). Later corrections append
-- adjudications and never change the first one, so the digest stays verifiable at reveal.
create or replace function ledger.corpus_digest(p_tournament uuid)
returns table (corpus_sha256 text, n_transcripts integer)
language sql stable security definer set search_path = '' as $$
  select ledger.hash_text(coalesce(string_agg(
           e.planned_trial_id || ':' || coalesce(e.state, 'none') || ':'
           || coalesce(c.payload ->> 'transcript_sha256', '-') || ':' || coalesce(c.payload ->> 'evidence_sha256', '-')
           || ':' || coalesce((select ledger.hash_jsonb(j.payload) from sealed.judgments j
                                where j.trial_id = e.trial_id and j.kind = 'fidelity_detail'
                                order by j.created_at, j.id limit 1), '-')
           || ':' || coalesce((select a.id::text || '/' || a.verdict from ledger.validity_adjudications a
                                where a.trial_id = e.trial_id order by a.adj_seq limit 1), '-'),
           E'\n' order by e.planned_trial_id::text collate "C"), '')),
         count(*) filter (where e.state = 'completed')::integer
    from ledger.planned_execution(p_tournament) e
    left join ledger.finding_commitments c on c.trial_id = e.trial_id
   where e.track = 'replay_corpus'
$$;

create or replace function ledger.seal_replay_corpus(p_tournament uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_existing text;
  v record;
  v_seq bigint;
begin
  perform ledger.require_read_committed();
  select status into v_status from arena.tournaments where id = p_tournament for update;
  if v_status is distinct from 'running' then
    raise exception using errcode = 'AR001', message = 'the replay corpus is sealed while the tournament runs';
  end if;
  -- SG3-24: idempotent; the tournament job asks the referee to seal once the corpus is reviewed, and a
  -- retry returns the stored seal instead of failing.
  select corpus_sha256 into v_existing from ledger.corpus_seals where tournament_id = p_tournament;
  if found then
    return v_existing;
  end if;
  if exists (select 1 from ledger.planned_execution(p_tournament) e where e.track = 'replay_corpus' and e.state is null) then
    raise exception using errcode = 'AR001', message = 'every corpus transcript needs an execution record before the seal';
  end if;
  -- SG2-27: R1 and an initial validity verdict precede the seal for every completed corpus transcript.
  if exists (select 1 from ledger.planned_execution(p_tournament) e
              where e.track = 'replay_corpus' and e.state = 'completed'
                and (not exists (select 1 from sealed.judgments j where j.trial_id = e.trial_id and j.kind = 'fidelity_detail')
                     or not exists (select 1 from ledger.validity_adjudications a where a.trial_id = e.trial_id))) then
    raise exception using errcode = 'AR001',
      message = 'every completed corpus transcript needs its R1 report and an initial validity verdict before the seal';
  end if;
  select * into v from ledger.corpus_digest(p_tournament);
  v_seq := ledger.append_event('replay_corpus_sealed', p_tournament, null,
             jsonb_build_object('corpus_sha256', v.corpus_sha256, 'n_transcripts', v.n_transcripts));
  insert into ledger.corpus_seals (tournament_id, corpus_sha256, n_transcripts, event_seq)
    values (p_tournament, v.corpus_sha256, v.n_transcripts, v_seq);
  return v.corpus_sha256;
end $$;

create or replace function arena.close_tournament_run(p_tournament uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  perform ledger.require_read_committed();
  select status into v_status from arena.tournaments where id = p_tournament for update;
  if v_status is distinct from 'running' then
    raise exception using errcode = 'AR001', message = 'only a running tournament can be closed';
  end if;
  if exists (select 1 from ledger.planned_execution(p_tournament) e where e.state is null) then
    raise exception using errcode = 'AR001', message = 'every planned trial needs an execution record';
  end if;
  if exists (select 1 from arena.planned_trials where tournament_id = p_tournament and track = 'replay_corpus')
     and not exists (select 1 from ledger.corpus_seals where tournament_id = p_tournament) then
    raise exception using errcode = 'AR001', message = 'the replay corpus must be sealed';
  end if;
  update arena.tournaments set status = 'sealed', sealed_at = now() where id = p_tournament;
  perform ledger.append_event('tournament_sealed', p_tournament, null, '{}'::jsonb);
end $$;

create or replace function arena.begin_scoring(p_tournament uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
begin
  perform ledger.require_read_committed();
  select status into v_status from arena.tournaments where id = p_tournament for update;
  if v_status = 'scoring' then
    return;
  end if;
  if v_status is distinct from 'sealed' then
    raise exception using errcode = 'AR001', message = 'scoring starts after the run is sealed';
  end if;
  update arena.tournaments set status = 'scoring', scoring_at = now() where id = p_tournament;
  perform ledger.append_event('tournament_scoring', p_tournament, null, '{}'::jsonb);
end $$;

-- retry_trial (arena_public, the tournament job): a new attempt only after an infra_failed attempt,
-- at most 3 attempts, same planned trial (and so the same seed and position). Outcome-independent:
-- infra failure carries no classification.
create or replace function arena.retry_trial(p_planned_trial uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_last  record;
  v_tstat text;
  v_id    uuid;
begin
  perform ledger.require_read_committed();
  select tr.status into v_tstat from arena.planned_trials p join arena.tournaments tr on tr.id = p.tournament_id
   where p.id = p_planned_trial for share of tr;
  if v_tstat is distinct from 'running' then
    raise exception using errcode = 'AR001', message = 'retries happen while the tournament runs';
  end if;
  select t.*, r.state into v_last from arena.trials t left join ledger.terminal_records r on r.trial_id = t.id
   where t.planned_trial_id = p_planned_trial order by t.attempt desc limit 1 for update of t;
  if v_last.state is distinct from 'infra_failed' or v_last.attempt >= 3 then
    raise exception using errcode = 'AR001', message = 'a retry needs an infra_failed latest attempt below 3 attempts';
  end if;
  insert into arena.trials (kind, tournament_id, planned_trial_id, attempt, variant_id, assistant_candidate_id,
                            subject_candidate_id, mode, max_exchanges)
    values (v_last.kind, v_last.tournament_id, p_planned_trial, v_last.attempt + 1, v_last.variant_id,
            v_last.assistant_candidate_id, v_last.subject_candidate_id, 'harness', v_last.max_exchanges)
    returning id into v_id;
  perform ledger.append_event('trial_retry', v_last.tournament_id, v_id,
    jsonb_build_object('planned_trial_id', p_planned_trial, 'attempt', v_last.attempt + 1, 'previous_trial_id', v_last.id));
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- RLS (default deny) and privileges for this file's tables and functions
-- -----------------------------------------------------------------------------
alter table ledger.chain_head enable row level security;
alter table ledger.events enable row level security;
alter table arena.tournaments enable row level security;
alter table arena.blocks enable row level security;
alter table arena.planned_trials enable row level security;
alter table arena.trials enable row level security;
alter table arena.turns enable row level security;
alter table arena.released_evidence enable row level security;
alter table arena.work_items enable row level security;
alter table arena.trial_events enable row level security;
alter table arena.final_findings enable row level security;
alter table sealed.subject_tag_proposals enable row level security;
alter table sealed.quarantined_artifacts enable row level security;
alter table sealed.independent_labels enable row level security;
alter table sealed.judgments enable row level security;
alter table sealed.commitment_nonces enable row level security;
alter table ledger.terminal_records enable row level security;
alter table ledger.finding_commitments enable row level security;
alter table ledger.validity_adjudications enable row level security;
alter table ledger.corpus_seals enable row level security;
alter table ledger.inclusion_manifests enable row level security;
alter table ledger.revealed_nonces enable row level security;
alter table arena.scores enable row level security;
alter table arena.leaderboards enable row level security;
alter table arena.isolation_checks enable row level security;

revoke all on all tables in schema arena, sealed, ledger from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;
revoke all on all sequences in schema arena, sealed, ledger from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;
revoke all on all functions in schema arena, sealed, ledger from public, anon, authenticated, service_role,
  arena_public, arena_subject, arena_referee;

-- arena_referee: read every table in these schemas; insert its own label, judgment, score,
-- leaderboard and isolation rows; every other write goes through functions.
grant select on all tables in schema arena, sealed, ledger to arena_referee;
grant insert on sealed.independent_labels, sealed.judgments, arena.scores, arena.leaderboards, arena.isolation_checks
  to arena_referee;
do $$
declare
  r record;
begin
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname in ('arena', 'sealed', 'ledger') and c.relkind = 'r' loop
    execute format('create policy %I on %I.%I for select to arena_referee using (true)',
                   r.relname || '_referee_read', r.nspname, r.relname);
  end loop;
end $$;
create policy independent_labels_referee_insert on sealed.independent_labels for insert to arena_referee with check (true);
create policy judgments_referee_insert on sealed.judgments for insert to arena_referee with check (true);
create policy scores_referee_insert on arena.scores for insert to arena_referee with check (true);
create policy leaderboards_referee_insert on arena.leaderboards for insert to arena_referee with check (true);
create policy isolation_checks_referee_insert on arena.isolation_checks for insert to arena_referee with check (true);

-- re-grant what 0002 granted (the blanket revoke above covered all functions in these schemas)
grant execute on function sealed.ingest_case_family(jsonb), sealed.seal_hidden_split(jsonb), sealed.verify_hidden_seal(),
  sealed.hidden_split_digest(), arena.register_candidate(text, text, text, jsonb) to arena_referee;
grant execute on function arena.actor_id() to arena_public;

grant execute on function
  arena.create_tournament(text, text, bigint, text, smallint),
  arena.add_planned_trials(uuid, jsonb),
  arena.freeze_tournament(uuid),
  arena.open_tournament(uuid),
  ledger.seal_replay_corpus(uuid),
  arena.close_tournament_run(uuid),
  arena.begin_scoring(uuid),
  ledger.verify_chain(),
  ledger.planned_execution(uuid),
  ledger.corpus_digest(uuid),
  arena.roster_digest(uuid)
  to arena_referee;

grant usage on schema ledger to arena_public;
grant execute on function arena.retry_trial(uuid) to arena_public;
