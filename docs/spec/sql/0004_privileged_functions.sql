-- =============================================================================
-- 0004_privileged_functions.sql  (DRAFT v2.6, spec S4; applied only to throwaway local PostgreSQL 17.11 containers)
-- The six privileged operations of direction section 4.2, the public-tier transactional writes
-- they depend on (start_trial, open_work_item, submit_question, record_coaching_event,
-- advance_replay), the per-trial event store writer, the context readers (arena.trial_context,
-- subject.turn_context), work-item recovery, commitment verification, the inclusion manifest, and
-- the projections arena_public reads.
-- Requirements: SCN-4, SCN-5, SCN-9, SCN-10, SCN-12, SUB-7, SUB-8, SOL-6, BKO-2, BKO-6, BKO-7,
-- BKO-9, EVL-5, EVL-9, EVL-10, EVL-11, KPI-4, KPI-5.
--
-- Every function: SECURITY DEFINER, search_path = '', EXECUTE revoked from PUBLIC and granted to
-- exactly one role, READ COMMITTED required for writes, trial row locked FOR UPDATE, inputs derived
-- from committed rows (never caller-supplied turn numbers, versions or hashes), work items for
-- idempotency (F07). Pattern: TechnoMile supabase/migrations/20260928001100_holdout_scoring.sql
-- lines 60-88 and 171-179; 20260927000600_run_ledger_rpcs.sql lines 746-760 (key reuse with
-- different input is refused).
--
-- One turn (direction 4.5, S5 5.2); every work item is opened with the caller's request key (D3):
--   submit_question (v+1) -> release_evidence, also with an empty list so scheduled releases apply
--   (v+1 if anything is released) -> open_work_item('subject_answer') -> record_subject_turn (v+1,
--   coaching_pending, KPI-4 sample pending) -> open_work_item('coaching', card key) ->
--   record_coaching_event (clears pending, completes the sample) -> [A1: open_work_item('coaching', card version,
--   deep key) -> record_coaching_event 'coach_deep'] -> ... -> open_work_item('finalize') ->
--   finalize_trial (v+1, frozen).
-- One replay turn (D2): open_work_item('replay_turn') -> advance_replay (v+1: copies source turn n with
--   the releases made before its answer) -> coaching as above.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Internal helpers (no role holds EXECUTE)
-- -----------------------------------------------------------------------------
create or replace function arena._lock_trial(p_trial uuid)
returns arena.trials
language plpgsql security definer set search_path = '' as $$
declare
  v arena.trials;
begin
  select * into v from arena.trials where id = p_trial for update;
  if not found then
    raise exception using errcode = 'AR001', message = 'trial not found';
  end if;
  return v;
end $$;

-- Locks the work item after the trial. Rejects unknown ids, cross-trial use, the wrong kind, and a
-- completed item replayed with different input. A completed item with the same input is returned
-- so the caller can answer with the stored result.
create or replace function arena._take_work_item(p_trial uuid, p_work_item uuid, p_kind text, p_request_sha256 text)
returns arena.work_items
language plpgsql security definer set search_path = '' as $$
declare
  v arena.work_items;
begin
  select * into v from arena.work_items where id = p_work_item for update;
  if not found then
    raise exception using errcode = 'AR003', message = 'unknown work item';
  end if;
  if v.trial_id <> p_trial then
    raise exception using errcode = 'AR003', message = 'work item belongs to another trial';
  end if;
  if v.kind <> p_kind then
    raise exception using errcode = 'AR003', message = format('work item kind %s cannot be used for %s', v.kind, p_kind);
  end if;
  if v.status = 'done' and v.request_sha256 is distinct from p_request_sha256 then
    raise exception using errcode = 'AR003', message = 'work item reused with different input';
  end if;
  return v;
end $$;

create or replace function arena._complete_work_item(p_work_item uuid, p_request_sha256 text, p_result jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  update arena.work_items
     set status = 'done', request_sha256 = p_request_sha256, result = p_result, completed_at = now()
   where id = p_work_item;
  return p_result;
end $$;

-- Separates the two kinds of arena_public request inside one credential (route-bug defense; the
-- credential boundary is unchanged). arena-api sets arena.actor_id on investigator requests; the
-- tournament harness and job never do. Investigator requests reach only the actor's own training
-- trials; harness requests reach only tournament trials.
create or replace function arena._check_caller(p_kind text, p_owner uuid)
returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := arena.actor_id();
begin
  if (p_kind = 'training' and (v_actor is null or v_actor <> p_owner))
     or (p_kind <> 'training' and v_actor is not null) then
    raise exception using errcode = 'AR040', message = 'this request may not act on this trial';
  end if;
end $$;

-- A turn is in progress from the subject's committed answer until its coach_card or
-- coach_unavailable event, or 120 s after the answer (a crashed request cannot block the trial).
create or replace function arena._turn_in_progress(p_trial arena.trials)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_trial.coaching_pending
         and coalesce((select u.answered_at > now() - interval '120 seconds' from arena.turns u
                         where u.trial_id = p_trial.id order by u.turn_no desc limit 1), false)
$$;

-- Event writer: next per-trial seq under the caller's trial lock, visibility by trial kind and
-- mode (S5 6.1), and a wake-up for SSE listeners (pg_notify is delivered at commit).
create or replace function arena._emit(p_trial arena.trials, p_kind text, p_work_item uuid, p_payload jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_seq integer;
  v_vis text;
  v_version integer;
  v_turn smallint;
begin
  select transcript_version, exchanges into v_version, v_turn from arena.trials where id = p_trial.id;
  select coalesce(max(seq), 0) + 1 into v_seq from arena.trial_events where trial_id = p_trial.id;
  v_vis := case
             when p_trial.kind <> 'training' then 'internal'
             when p_kind in ('coach_card', 'coach_deep', 'coach_unavailable') and p_trial.mode = 'assessment' then 'debrief'
             else 'live'
           end;
  insert into arena.trial_events (trial_id, seq, kind, visibility, transcript_version, turn_no, work_item_id, candidate_id,
                                  payload)
    values (p_trial.id, v_seq, p_kind, v_vis, v_version,
            coalesce((select max(turn_no) from arena.turns where trial_id = p_trial.id), 0),
            p_work_item,
            case when p_kind in ('coach_card', 'coach_deep', 'coach_unavailable') then p_trial.assistant_candidate_id end,
            coalesce(p_payload, '{}'::jsonb));
  perform pg_notify('arena_events', p_trial.id::text);
  return v_seq;
end $$;

-- Records Q(t) for an investigator or the harness. Caller holds the trial lock.
-- Origin (SG2-09): source, relay outcome and the relayed or rejected proposal are stored with the
-- question; a proposal must be a coach_card of this trial on the previous turn. A KPI-4 sample still
-- pending from the previous turn becomes unmeasured_timeout here (D4).
create or replace function arena._record_question(p_trial arena.trials, p_question text, p_source text,
                                                  p_relay_outcome text, p_proposal_seq integer, p_channel text,
                                                  p_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_turn smallint := p_trial.exchanges + 1;
begin
  if p_trial.status <> 'running' or p_trial.kind = 'replay' then
    raise exception using errcode = 'AR001', message = 'questions go to a running interview';
  end if;
  if exists (select 1 from arena.turns where trial_id = p_trial.id and answer is null) then
    raise exception using errcode = 'AR004', message = 'the previous question is still unanswered';
  end if;
  if arena._turn_in_progress(p_trial) then
    raise exception using errcode = 'AR004', message = 'turn in progress: the coaching for the last answer is pending';
  end if;
  if p_trial.exchanges >= p_trial.max_exchanges then
    raise exception using errcode = 'AR001', message = 'exchange cap reached (BKO-8)';
  end if;
  if p_proposal_seq is not null and not exists (
       select 1 from arena.trial_events e
        where e.trial_id = p_trial.id and e.seq = p_proposal_seq and e.kind = 'coach_card' and e.turn_no = v_turn - 1) then
    raise exception using errcode = 'AR007', message = 'the proposal must be this trial''s coach card for the previous turn';
  end if;
  perform ops._close_pending_latency(p_trial.id);
  update arena.trials set transcript_version = transcript_version + 1, coaching_pending = false where id = p_trial.id;
  insert into arena.turns (trial_id, turn_no, question, question_source, relay_outcome, proposal_seq, channel,
                           question_version, idempotency_key)
    values (p_trial.id, v_turn, p_question, p_source, p_relay_outcome, p_proposal_seq, p_channel,
            p_trial.transcript_version + 1, p_key);
  perform arena._emit(p_trial, 'question_recorded', null,
    jsonb_build_object('turn_no', v_turn, 'question', p_question, 'source', p_source, 'channel', p_channel));
  perform ledger.append_event('question_asked', p_trial.tournament_id, p_trial.id,
    jsonb_build_object('turn_no', v_turn, 'question_sha256', ledger.hash_text(p_question), 'source', p_source));
  return jsonb_build_object('turn_no', v_turn, 'transcript_version', p_trial.transcript_version + 1);
end $$;

-- Visibility of a trial's content to arena_public projections: an investigator's own training
-- trial, a dev tournament trial, or a trial of a revealed tournament (SCN-12, BKO-9).
create or replace function arena.trial_visible(p_trial uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when t.kind = 'training' then t.owner_user_id = arena.actor_id()
                else tr.split = 'dev' or tr.status = 'revealed' end
      from arena.trials t left join arena.tournaments tr on tr.id = t.tournament_id
     where t.id = p_trial), false)
$$;

-- -----------------------------------------------------------------------------
-- open_work_item (arena_public; D3): one work item per step, bound to the CURRENT committed transcript
-- version. The caller's request key (a hash of trial, turn, step kind and purpose, for example
-- sha256('<trial>:3:coaching:coach.deep')) identifies the step: a repeated key returns the existing item
-- with its status and stored result, before any state check, so a retry after a crash (even after
-- finalization) resumes instead of failing. Kinds by trial kind: training and interactive trials take
-- subject_answer, release, coaching, finalize, failure; replay_corpus takes all but coaching; replay takes
-- replay_turn, coaching, finalize, failure. subject_answer needs an open question; replay_turn needs an
-- unreplayed source turn. At most 200 items per trial (a 12-turn trial needs about 60).
-- -----------------------------------------------------------------------------
create or replace function arena._work_item_json(p_wi arena.work_items)
returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('work_item_id', p_wi.id, 'kind', p_wi.kind, 'request_key', p_wi.idempotency_key,
                            'transcript_version', p_wi.transcript_version, 'turn_no', p_wi.turn_no,
                            'status', p_wi.status, 'result', p_wi.result)
$$;

-- p_expected_version (SG3-26): when given, the item is created only if the trial is still at that version,
-- so a step bound to an earlier step's version (the A1 deep update, bound to its card's version) is refused
-- as stale (AR002) once a question or release has overtaken it, instead of binding to the newer version.
create or replace function arena.open_work_item(p_trial uuid, p_kind text, p_request_key text,
                                                p_expected_version integer default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v    arena.trials;
  v_wi arena.work_items;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  if p_kind not in ('subject_answer', 'release', 'coaching', 'finalize', 'failure', 'replay_turn') then
    raise exception using errcode = 'AR007', message = format('unknown work item kind %s', p_kind);
  end if;
  if coalesce(length(p_request_key), 0) not between 8 and 200 then
    raise exception using errcode = 'AR007', message = 'a work item needs a request key of 8 to 200 characters';
  end if;
  select * into v_wi from arena.work_items where trial_id = p_trial and idempotency_key = p_request_key;
  if found then
    if v_wi.kind <> p_kind then
      raise exception using errcode = 'AR003', message = 'request key reused for another step kind';
    end if;
    return arena._work_item_json(v_wi);
  end if;
  if (p_kind = 'failure' and v.status not in ('planned', 'running'))
     or (p_kind <> 'failure' and v.status <> 'running') then
    raise exception using errcode = 'AR001', message = format('trial is %s', v.status);
  end if;
  if p_expected_version is not null and p_expected_version <> v.transcript_version then
    raise exception using errcode = 'AR002', message = 'stale transcript version: the step this item follows was overtaken';
  end if;
  if (p_kind in ('release', 'subject_answer') and v.kind = 'replay')
     or (p_kind = 'coaching' and v.kind = 'replay_corpus')
     or (p_kind = 'replay_turn' and v.kind <> 'replay') then
    raise exception using errcode = 'AR001', message = format('%s does not apply to a %s trial', p_kind, v.kind);
  end if;
  if p_kind = 'subject_answer' and not exists (select 1 from arena.turns where trial_id = p_trial and answer is null) then
    raise exception using errcode = 'AR004', message = 'no open question to answer';
  end if;
  if p_kind = 'replay_turn' and not exists (select 1 from arena.turns s
                                             where s.trial_id = v.source_trial_id and s.turn_no = v.exchanges + 1
                                               and s.answer is not null) then
    raise exception using errcode = 'AR001', message = 'the source transcript is fully replayed';
  end if;
  if (select count(*) from arena.work_items where trial_id = p_trial) >= 200 then
    raise exception using errcode = 'AR001', message = 'too many work items on this trial';
  end if;
  insert into arena.work_items (trial_id, kind, transcript_version, turn_no, idempotency_key)
    values (p_trial, p_kind, v.transcript_version,
            coalesce((select max(turn_no) from arena.turns where trial_id = p_trial), 0), p_request_key)
    returning * into v_wi;
  return arena._work_item_json(v_wi);
end $$;

-- work_item_results (arena_public; D3, SG3-03): every work item of a trial with its status and stored
-- result, for the caller allowed to act on the trial (arena._check_caller). Results never carry case
-- content (release results list ids and kinds only), so this is safe on a hidden trial at any time.
create or replace function arena.work_item_results(p_trial uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v arena.trials;
begin
  select * into v from arena.trials where id = p_trial;
  if not found then
    raise exception using errcode = 'AR040', message = 'this request may not act on this trial';
  end if;
  perform arena._check_caller(v.kind, v.owner_user_id);
  return coalesce((select jsonb_agg(arena._work_item_json(w) order by w.created_at, w.id)
                     from arena.work_items w where w.trial_id = p_trial), '[]'::jsonb);
end $$;

-- -----------------------------------------------------------------------------
-- start_trial (arena_public, the tournament job): planned -> running. Enforces the sponsor's
-- order (BKO-2): replay scoring starts after the corpus seal; interactive trials start after
-- every replay trial has an execution record. A replay trial whose corpus transcript did not
-- complete gets the execution record source_unavailable here (derived, no caller input).
-- -----------------------------------------------------------------------------
create or replace function arena.start_trial(p_trial uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v        arena.trials;
  v_tid    uuid;
  v_tstat  text;
  v_src    uuid;
  v_src_pt uuid;
  v_seq    bigint;
begin
  perform ledger.require_read_committed();
  select tournament_id into v_tid from arena.trials where id = p_trial;
  select status into v_tstat from arena.tournaments where id = v_tid for share;
  v := arena._lock_trial(p_trial);
  if v.kind = 'training' then
    raise exception using errcode = 'AR001', message = 'training trials start through training.start_session';
  end if;
  perform arena._check_caller(v.kind, v.owner_user_id);
  if v.status = 'running' then
    return jsonb_build_object('status', 'running', 'trial_id', v.id);
  end if;
  if v.status <> 'planned' or v_tstat <> 'running' then
    raise exception using errcode = 'AR001', message = 'a planned trial starts only while its tournament runs';
  end if;
  if v.attempt < (select max(attempt) from arena.trials where planned_trial_id = v.planned_trial_id) then
    raise exception using errcode = 'AR001', message = 'only the latest attempt can start';
  end if;
  if v.kind = 'replay' and not exists (select 1 from ledger.corpus_seals where tournament_id = v_tid) then
    raise exception using errcode = 'AR001', message = 'replay scoring starts after the corpus seal (BKO-2, BKO-6)';
  end if;
  if v.kind = 'interactive' and exists (select 1 from arena.planned_trials where tournament_id = v_tid and track <> 'interactive')
     and (not exists (select 1 from ledger.corpus_seals where tournament_id = v_tid)
          or exists (select 1 from ledger.planned_execution(v_tid) e where e.track = 'replay' and e.state is null)) then
    raise exception using errcode = 'AR001', message = 'interactive trials start after the replay track (BKO-2)';
  end if;
  if v.kind = 'replay' then
    select p.source_planned_trial_id into v_src_pt from arena.planned_trials p where p.id = v.planned_trial_id;
    -- SG2-27: a replay source is a completed corpus transcript whose initial (sealed) verdict is valid.
    select e.trial_id into v_src from ledger.planned_execution(v_tid) e
     where e.planned_trial_id = v_src_pt and e.state = 'completed'
       and (select a.verdict from ledger.validity_adjudications a where a.trial_id = e.trial_id
             order by a.adj_seq limit 1) = 'valid';
    if v_src is null then
      update arena.trials set status = 'terminated', ended_at = now() where id = p_trial;
      v_seq := ledger.append_event('execution_recorded', v_tid, p_trial,
                 jsonb_build_object('state', 'source_unavailable'));
      insert into ledger.terminal_records (trial_id, planned_trial_id, state, reason, event_seq)
        values (p_trial, v.planned_trial_id, 'source_unavailable', 'corpus transcript did not complete or is invalid', v_seq);
      perform arena._emit(v, 'trial_ended', null, jsonb_build_object('reason', 'source_unavailable'));
      return jsonb_build_object('status', 'terminated', 'state', 'source_unavailable', 'trial_id', p_trial);
    end if;
  end if;
  update arena.trials set status = 'running', started_at = now(), source_trial_id = v_src where id = p_trial;
  perform ledger.append_event('trial_started', v_tid, p_trial, jsonb_build_object('attempt', v.attempt, 'source_trial_id', v_src));
  return jsonb_build_object('status', 'running', 'trial_id', p_trial);
end $$;

-- -----------------------------------------------------------------------------
-- submit_question (arena_public; S5 "record_question"): records Q(t) and bumps the version.
-- Idempotent on (trial, idempotency_key). Training trials: the source is investigator and the caller
-- passes no origin. Tournament trials: the harness names the source (harness_fixed, harness_fallback or
-- assistant_relay), the relay outcome and, for a relayed or rejected proposal, its coach_card seq (SG2-09).
-- A voice session's trial takes no typed questions (D-016): its exchanges go to training.voice_exchanges.
-- -----------------------------------------------------------------------------
create or replace function arena.submit_question(p_trial uuid, p_expected_version integer, p_question text,
                                                 p_idempotency_key text, p_source text default null,
                                                 p_relay_outcome text default null, p_proposal_seq integer default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v        arena.trials;
  v_t      arena.turns;
  v_source text;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  v_source := case when v.kind = 'training' then 'investigator' else p_source end;
  select * into v_t from arena.turns where trial_id = p_trial and idempotency_key = p_idempotency_key;
  if found then
    if (v_t.question, v_t.question_source, v_t.relay_outcome, v_t.proposal_seq)
       is distinct from (p_question, v_source, p_relay_outcome, p_proposal_seq) then
      raise exception using errcode = 'AR003', message = 'idempotency key reused with a different question';
    end if;
    return jsonb_build_object('turn_no', v_t.turn_no, 'transcript_version', v_t.question_version);
  end if;
  if v.transcript_version <> p_expected_version then
    raise exception using errcode = 'AR002', message = format('stale transcript version %s (current %s)',
                                                               p_expected_version, v.transcript_version);
  end if;
  if (v.kind = 'training' and (p_source is not null or p_relay_outcome is not null or p_proposal_seq is not null))
     or (v.kind <> 'training' and v_source is distinct from 'harness_fixed' and v_source is distinct from 'harness_fallback'
         and v_source is distinct from 'assistant_relay') then
    raise exception using errcode = 'AR007', message = 'investigator questions carry no origin; harness questions name theirs';
  end if;
  if v.kind = 'training' and exists (select 1 from training.sessions s where s.trial_id = p_trial and s.voice) then
    raise exception using errcode = 'AR007', message = 'a voice session is spoken; commit the finding in text';
  end if;
  return arena._record_question(v, p_question, v_source, p_relay_outcome, p_proposal_seq, 'text', p_idempotency_key);
end $$;

-- -----------------------------------------------------------------------------
-- advance_replay (arena_public, the tournament job; D2, SG3-02, SG2-17): a replay trial owns its
-- transcript. Each call copies the next source turn n of the sealed corpus transcript into this trial as
-- turn n: the question, then every source release made after turn n - 1 was answered (the evidence the
-- source subject had when it answered n), then the answer, with the same turn number, record ids and
-- release sequence. Work items, events, citations, the commitment and the scorer then use this trial's
-- own rows exactly as for an interactive trial; nothing later than turn n is visible to the coach.
-- Version +1 per call; the coaching hold applies as after a subject answer. No KPI-4 sample (no live
-- subject). Idempotent by work item.
-- -----------------------------------------------------------------------------
create or replace function arena.advance_replay(p_trial uuid, p_work_item uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v      arena.trials;
  v_wi   arena.work_items;
  v_sha  text := ledger.hash_text('advance_replay');
  v_src  arena.turns;
  v_turn smallint;
  v_seq  bigint;
  v_res  jsonb;
  v_rel  jsonb;
  r      record;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  v_wi := arena._take_work_item(p_trial, p_work_item, 'replay_turn', v_sha);
  if v_wi.status = 'done' then
    return v_wi.result;
  end if;
  if v.kind <> 'replay' or v.status <> 'running' then
    raise exception using errcode = 'AR001', message = 'replay turns are copied into a running replay trial';
  end if;
  if v_wi.transcript_version <> v.transcript_version then
    raise exception using errcode = 'AR002', message = 'stale transcript version';
  end if;
  if arena._turn_in_progress(v) then
    raise exception using errcode = 'AR004', message = 'turn in progress: the coaching for the last copied answer is pending';
  end if;
  v_turn := v.exchanges + 1;
  select * into v_src from arena.turns where trial_id = v.source_trial_id and turn_no = v_turn and answer is not null;
  if not found then
    raise exception using errcode = 'AR001', message = 'the source transcript is fully replayed';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('record_id', x.record_id, 'sha256', ledger.hash_jsonb(x.content))
                            order by x.release_seq), '[]'::jsonb)
    into v_rel from arena.released_evidence x
   where x.trial_id = v.source_trial_id and x.released_after_exchanges = v_turn - 1;
  update arena.trials set transcript_version = transcript_version + 1, exchanges = exchanges + 1,
                          coaching_pending = (assistant_candidate_id is not null)
   where id = p_trial;
  v_seq := ledger.append_event('replay_turn_copied', v.tournament_id, p_trial,
             jsonb_build_object('turn_no', v_turn, 'source_trial_id', v.source_trial_id,
                                'question_sha256', ledger.hash_text(v_src.question),
                                'answer_sha256', ledger.hash_text(v_src.answer), 'records', v_rel));
  insert into arena.turns (trial_id, turn_no, question, question_source, relay_outcome, proposal_seq, channel,
                           question_version, idempotency_key, answer, answer_partial, answered_at)
    values (p_trial, v_turn, v_src.question, v_src.question_source, v_src.relay_outcome, null, v_src.channel,
            v.transcript_version + 1, 'replay:' || v_turn, v_src.answer, v_src.answer_partial, now());
  perform arena._emit(v, 'question_recorded', null,
    jsonb_build_object('turn_no', v_turn, 'question', v_src.question, 'source', v_src.question_source,
                       'channel', v_src.channel));
  for r in select x.* from arena.released_evidence x
            where x.trial_id = v.source_trial_id and x.released_after_exchanges = v_turn - 1 order by x.release_seq loop
    insert into arena.released_evidence (trial_id, record_id, release_seq, released_after_exchanges, kind, doc_kind, title,
                                         content, event_seq)
      values (p_trial, r.record_id, r.release_seq, r.released_after_exchanges, r.kind, r.doc_kind, r.title, r.content, v_seq);
    perform arena._emit(v, case when r.kind = 'clarification' then 'clarification' else 'evidence_released' end, null,
      jsonb_build_object('record_id', r.record_id, 'kind', r.kind, 'doc_kind', r.doc_kind, 'title', r.title,
                         'content', r.content));
  end loop;
  perform arena._emit(v, 'subject_turn', null,
    jsonb_build_object('turn_no', v_turn, 'answer', v_src.answer, 'partial', v_src.answer_partial, 'channel', v_src.channel));
  v_res := jsonb_build_object('turn_no', v_turn, 'transcript_version', v.transcript_version + 1,
                              'released', (select coalesce(jsonb_agg(e ->> 'record_id'), '[]'::jsonb) from jsonb_array_elements(v_rel) e));
  return arena._complete_work_item(p_work_item, v_sha, v_res);
end $$;

-- _apply_releases (internal): releases every due scheduled artifact of the trial plus each requested
-- artifact whose request predicate holds, at most 6 per trial, each once, under the caller's trial lock;
-- bumps the version once when anything is released and emits the events. Returns the released rows
-- (with content, for the caller's result projection). Shared by release_evidence and
-- training.record_voice_exchange (the voice boundary release commits with the exchange, D-016). Predicates
-- read completed exchanges: the trial's text exchanges plus its stored voice exchanges (a voice session's
-- trial has no text turns, so exactly one of the two is non-zero).
create or replace function arena._apply_releases(p_trial uuid, p_req text[], p_work_item uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v         arena.trials;
  v_new     jsonb;
  v_n_new   integer;
  v_n_old   integer;
  v_seq     bigint;
  v_art     jsonb;
  v_ex      integer;
begin
  select * into v from arena.trials where id = p_trial;
  v_ex := v.exchanges + (select count(*) from training.voice_exchanges x where x.trial_id = p_trial);
  select coalesce(jsonb_agg(jsonb_build_object('record_id', a.record_id, 'kind', a.kind, 'doc_kind', a.doc_kind,
                                               'title', a.title, 'content', a.content, 'sha256', a.sha256)
                            order by a.record_id collate "C"), '[]'::jsonb),
         count(*)::integer
    into v_new, v_n_new
    from sealed.evidence_artifacts a
   where a.variant_id = v.variant_id
     and not exists (select 1 from arena.released_evidence r where r.trial_id = p_trial and r.record_id = a.record_id)
     and ((a.scheduled_turn is not null and a.scheduled_turn <= v_ex)
          or (a.requestable and a.record_id = any (p_req) and a.request_after_turn <= v_ex));
  select count(*)::integer into v_n_old from arena.released_evidence where trial_id = p_trial;
  if v_n_old + v_n_new > 6 then
    raise exception using errcode = 'AR006', message = 'release limit (6 per case) exceeded';
  end if;

  if v_n_new > 0 then
    update arena.trials set transcript_version = transcript_version + 1 where id = p_trial;
    v_seq := ledger.append_event('evidence_released', v.tournament_id, p_trial,
               jsonb_build_object('work_item_id', p_work_item, 'after_exchanges', v_ex,
                                  'records', (select jsonb_agg(jsonb_build_object('record_id', e ->> 'record_id',
                                                                                  'sha256', e ->> 'sha256'))
                                                from jsonb_array_elements(v_new) e)));
    insert into arena.released_evidence (trial_id, record_id, release_seq, released_after_exchanges, kind, doc_kind,
                                         title, content, event_seq)
      select p_trial, e.value ->> 'record_id', (v_n_old + e.ordinality)::smallint, v_ex, e.value ->> 'kind',
             e.value ->> 'doc_kind', e.value ->> 'title', e.value -> 'content', v_seq
        from jsonb_array_elements(v_new) with ordinality e;
    for v_art in select x from jsonb_array_elements(v_new) x loop
      perform arena._emit(v, case when v_art ->> 'kind' = 'clarification' then 'clarification' else 'evidence_released' end,
                          null, v_art - 'sha256');
    end loop;
  end if;

  return v_new;
end $$;

-- -----------------------------------------------------------------------------
-- 1. release_evidence (arena_public)  SCN-4, SCN-10
-- Called after each question (also with an empty list, so scheduled releases apply) and before the
-- subject answers, so the answer is given in light of the released evidence; between turns for an
-- evidence request (C-18), in text and in voice; a voice exchange applies its scheduled releases inside
-- training.record_voice_exchange (D-016). Releases every
-- due scheduled artifact plus each requested artifact whose request predicate holds, at most 6 per
-- trial, each once. Predicates read completed exchanges. An id that is not on the variant's requestable
-- list is refused (AR005); a known id requested too early is returned in denied, with no reason, beside
-- anything the same call released (SG1-15). The result lists ids and kinds only: content reaches the
-- browser through the evidence events and the coach through trial_context, and a stored result never
-- carries case content (D3, work_item_results).
-- -----------------------------------------------------------------------------
create or replace function arena.release_evidence(p_trial uuid, p_work_item uuid, p_requested_record_ids text[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v         arena.trials;
  v_wi      arena.work_items;
  v_req     text[] := coalesce((select array_agg(distinct x order by x) from unnest(p_requested_record_ids) x), '{}');
  v_sha     text;
  v_new     jsonb;
  v_n_new   integer;
  v_n_old   integer;
  v_seq     bigint;
  v_art     jsonb;
  v_result  jsonb;
begin
  perform ledger.require_read_committed();
  v_sha := ledger.hash_jsonb(to_jsonb(v_req));
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  v_wi := arena._take_work_item(p_trial, p_work_item, 'release', v_sha);
  if v_wi.status = 'done' then
    return v_wi.result;
  end if;
  if v.status <> 'running' or v.kind = 'replay' then
    raise exception using errcode = 'AR001', message = 'evidence is released into a running interview';
  end if;
  if v_wi.transcript_version <> v.transcript_version then
    raise exception using errcode = 'AR002', message = 'stale transcript version';
  end if;
  if arena._turn_in_progress(v) then
    raise exception using errcode = 'AR004', message = 'turn in progress: release with the next question';
  end if;
  if exists (select 1 from unnest(v_req) r
              where not exists (select 1 from sealed.evidence_artifacts a
                                 where a.variant_id = v.variant_id and a.record_id = r and a.requestable)) then
    raise exception using errcode = 'AR005', message = 'requested id is not on the case''s requestable list';
  end if;

  v_new := arena._apply_releases(p_trial, v_req, p_work_item);
  v_n_new := jsonb_array_length(v_new);

  v_result := jsonb_build_object(
    'released', (select coalesce(jsonb_agg(jsonb_build_object('record_id', e ->> 'record_id', 'kind', e ->> 'kind',
                                                              'doc_kind', e ->> 'doc_kind')), '[]'::jsonb)
                   from jsonb_array_elements(v_new) e),
    'already_released', to_jsonb(coalesce((select array_agg(r order by r) from unnest(v_req) r
                                     where exists (select 1 from arena.released_evidence x
                                                    where x.trial_id = p_trial and x.record_id = r)
                                       and not exists (select 1 from jsonb_array_elements(v_new) e
                                                        where e ->> 'record_id' = r)), '{}'::text[])),
    'denied', to_jsonb(coalesce((select array_agg(r order by r) from unnest(v_req) r
                                  where not exists (select 1 from arena.released_evidence x
                                                     where x.trial_id = p_trial and x.record_id = r)), '{}'::text[])),
    'transcript_version', v.transcript_version + case when v_n_new > 0 then 1 else 0 end);
  return arena._complete_work_item(p_work_item, v_sha, v_result);
end $$;

-- -----------------------------------------------------------------------------
-- 2. record_subject_turn (arena_subject)  SUB-7, SUB-8, SCN-6
-- Answers exactly the open question the work item names, at the version the item was opened.
-- A guard rejection stores the offending artifact in sealed and records subject_quarantined in
-- the same transaction. On a turn of a trial with an assistant the coaching hold starts and the turn's
-- KPI-4 sample opens pending with the subject commit time (D4, SG3-16). Voice writes no turns (D-016).
-- -----------------------------------------------------------------------------
create or replace function arena.record_subject_turn(p_trial uuid, p_work_item uuid, p_utterance text,
                                                     p_tag_proposal jsonb, p_guard_result jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v       arena.trials;
  v_wi    arena.work_items;
  v_sha   text := ledger.hash_jsonb(jsonb_build_object('u', p_utterance, 't', p_tag_proposal, 'g', p_guard_result));
  v_seq   bigint;
  v_evt   integer;
  v_res   jsonb;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  v_wi := arena._take_work_item(p_trial, p_work_item, 'subject_answer', v_sha);
  if v_wi.status = 'done' then
    return v_wi.result;
  end if;
  if v.status <> 'running' then
    raise exception using errcode = 'AR001', message = 'trial is not running';
  end if;
  if v_wi.transcript_version <> v.transcript_version then
    raise exception using errcode = 'AR002', message = 'stale transcript version';
  end if;
  if not exists (select 1 from arena.turns where trial_id = p_trial and turn_no = v_wi.turn_no and answer is null)
     or exists (select 1 from arena.turns where trial_id = p_trial and turn_no > v_wi.turn_no) then
    raise exception using errcode = 'AR004', message = 'no open question for this work item';
  end if;
  -- An accepted answer needs text. Only a G0 failure (schema failure or provider block after the repair) may
  -- arrive without text; it is quarantined with a null utterance (SG2-39).
  if jsonb_typeof(p_guard_result -> 'passed') is distinct from 'boolean'
     or (p_tag_proposal is not null and jsonb_typeof(p_tag_proposal) <> 'object')
     or (coalesce(length(p_utterance), 0) = 0
         and ((p_guard_result ->> 'passed')::boolean
              or coalesce(p_guard_result ->> 'rule', '') not in ('G0_schema', 'G0_blocked'))) then
    raise exception using errcode = 'AR007', message = 'utterance, tag proposal object and guard_result.passed are required';
  end if;

  if (p_guard_result ->> 'passed')::boolean then
    update arena.turns set answer = p_utterance, answered_at = now()
     where trial_id = p_trial and turn_no = v_wi.turn_no;
    update arena.trials set exchanges = exchanges + 1, transcript_version = transcript_version + 1,
                            coaching_pending = (assistant_candidate_id is not null)
     where id = p_trial;
    if p_tag_proposal is not null then
      insert into sealed.subject_tag_proposals (trial_id, turn_no, tag) values (p_trial, v_wi.turn_no, p_tag_proposal);
    end if;
    v_evt := arena._emit(v, 'subject_turn', null,
      jsonb_build_object('turn_no', v_wi.turn_no, 'answer', p_utterance, 'partial', false, 'channel', 'text'));
    if v.assistant_candidate_id is not null then
      insert into ops.latency_samples (trial_id, turn_no, subject_commit_at, card_outcome, population)
        select p_trial, v_wi.turn_no, e.created_at, 'pending',
               case when v.kind <> 'training' then 'harness' when v.mode = 'practice' then 'practice_client' else 'assessment' end
          from arena.trial_events e where e.trial_id = p_trial and e.seq = v_evt;
    end if;
    perform ledger.append_event('subject_answered', v.tournament_id, p_trial,
      jsonb_build_object('turn_no', v_wi.turn_no, 'answer_sha256', ledger.hash_text(p_utterance)));
    v_res := jsonb_build_object('outcome', 'recorded', 'turn_no', v_wi.turn_no,
                                'transcript_version', v.transcript_version + 1);
  else
    insert into sealed.quarantined_artifacts (trial_id, turn_no, utterance, tag, guard_result)
      values (p_trial, v_wi.turn_no, nullif(p_utterance, ''), p_tag_proposal, p_guard_result);
    update arena.trials set status = 'terminated', ended_at = now(), transcript_version = transcript_version + 1
     where id = p_trial;
    v_seq := ledger.append_event('execution_recorded', v.tournament_id, p_trial,
               jsonb_build_object('state', 'subject_quarantined', 'turn_no', v_wi.turn_no));
    insert into ledger.terminal_records (trial_id, planned_trial_id, state, reason, work_item_id, event_seq)
      values (p_trial, v.planned_trial_id, 'subject_quarantined', 'guard rejection', p_work_item, v_seq);
    perform arena._emit(v, 'trial_ended', null, jsonb_build_object('reason', 'subject_invalid'));
    v_res := jsonb_build_object('outcome', 'quarantined', 'turn_no', v_wi.turn_no);
  end if;
  return arena._complete_work_item(p_work_item, v_sha, v_res);
end $$;

-- -----------------------------------------------------------------------------
-- record_coaching_event (arena_public; S5 "record_coaching"): one validated card bound to the
-- version it read (the work item carries the version). A stale card is refused (AR002) and
-- discarded by the caller. Each model step has its own work item (D3, SG3-04): the card and an A1 deep
-- update use two coaching items with different request keys, each bound to the version it read, so a
-- deep update overtaken by the next question or a release is refused as stale and discarded.
-- coach_card and coach_unavailable end the turn in progress and complete the turn's pending KPI-4
-- sample (D4; S3 6.4, C-28): card_validated_server_at = clock_timestamp() of this event, card_outcome,
-- and instance_cold from the transaction-local setting arena.instance_cold (unset = false). The client's
-- acknowledgement (ops.ack_card) later stamps client_ack_at on practice turns.
-- coach_unavailable payload reason: 'repair_failed' is recorded as such, anything else as 'timeout'.
-- -----------------------------------------------------------------------------
create or replace function arena.record_coaching_event(p_trial uuid, p_work_item uuid, p_card jsonb,
                                                       p_kind text default 'coach_card')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v       arena.trials;
  v_wi    arena.work_items;
  v_sha   text := ledger.hash_jsonb(jsonb_build_object('card', p_card, 'kind', p_kind));
  v_seq   integer;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  v_wi := arena._take_work_item(p_trial, p_work_item, 'coaching', v_sha);
  if v_wi.status = 'done' then
    return v_wi.result;
  end if;
  if p_kind not in ('coach_card', 'coach_deep', 'coach_unavailable') then
    raise exception using errcode = 'AR007', message = 'kind must be coach_card, coach_deep or coach_unavailable';
  end if;
  if v.status <> 'running' or v.kind = 'replay_corpus' then
    raise exception using errcode = 'AR001', message = 'coaching attaches to a running trial with an assistant';
  end if;
  if v_wi.transcript_version <> v.transcript_version then
    raise exception using errcode = 'AR002', message = 'stale transcript version: discard this card';
  end if;
  v_seq := arena._emit(v, p_kind, p_work_item, p_card);
  if p_kind in ('coach_card', 'coach_unavailable') then
    update arena.trials set coaching_pending = false where id = p_trial;
    update ops.latency_samples l
       set card_validated_server_at = e.created_at,
           card_outcome = case when p_kind = 'coach_card' then 'delivered'
                               when p_card ->> 'reason' = 'repair_failed' then 'repair_failed'
                               else 'timeout' end,
           instance_cold = coalesce(nullif(current_setting('arena.instance_cold', true), '')::boolean, false)
      from arena.trial_events e
     where e.trial_id = p_trial and e.seq = v_seq
       and l.trial_id = p_trial and l.turn_no = v_wi.turn_no and l.card_outcome = 'pending';
  end if;
  return arena._complete_work_item(p_work_item, v_sha, jsonb_build_object('seq', v_seq));
end $$;

-- -----------------------------------------------------------------------------
-- Commitment payload, computed only from stored rows of the trial itself (BKO-9; a replay trial's own
-- copied rows, D2). SG3-08: the transcript hash covers every stored turn field except timestamps, the
-- request key and the version counter; the evidence hash covers every released field and hashes the
-- content itself, never a cached hash column. A replay trial that copied its whole source therefore has
-- the source corpus trial's transcript_sha256 and evidence_sha256.
-- -----------------------------------------------------------------------------
create or replace function ledger.commitment_payload(p_trial uuid, p_finding jsonb)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'trial', t.id,
    'kind', t.kind,
    'transcript_sha256', ledger.hash_jsonb(coalesce((
        select jsonb_agg(to_jsonb(u) - array['trial_id', 'idempotency_key', 'question_version', 'asked_at', 'answered_at']
                         order by u.turn_no)
          from arena.turns u where u.trial_id = t.id), '[]'::jsonb)),
    'evidence_sha256', ledger.hash_jsonb(coalesce((
        select jsonb_agg(jsonb_build_object('record', r.record_id, 'seq', r.release_seq, 'after', r.released_after_exchanges,
                                            'kind', r.kind, 'doc_kind', r.doc_kind, 'title', r.title,
                                            'content_sha256', ledger.hash_jsonb(r.content))
                         order by r.release_seq)
          from arena.released_evidence r where r.trial_id = t.id), '[]'::jsonb)),
    'coaching_sha256', ledger.hash_jsonb(coalesce((
        select jsonb_agg(jsonb_build_object('seq', c.seq, 'kind', c.kind, 'version', c.transcript_version,
                                            'turn', c.turn_no, 'card', c.payload) order by c.seq)
          from arena.trial_events c
         where c.trial_id = t.id and c.kind in ('coach_card', 'coach_deep', 'coach_unavailable')), '[]'::jsonb)),
    'finding_sha256', ledger.hash_jsonb(p_finding),
    'manifest_sha256', ledger.hash_jsonb(jsonb_build_object(
        'planned_trial', t.planned_trial_id, 'attempt', t.attempt, 'variant', t.variant_id,
        'assistant', (select a.sha256 from arena.candidates a where a.id = t.assistant_candidate_id),
        'subject', (select s.sha256 from arena.candidates s where s.id = t.subject_candidate_id),
        'source_trial', t.source_trial_id,
        'roster', (select x.roster_sha256 from arena.tournaments x where x.id = t.tournament_id))))
  from arena.trials t where t.id = p_trial
$$;

-- -----------------------------------------------------------------------------
-- 3. finalize_trial (arena_public)  BKO-9, SOL-5
-- Freezes the execution artifacts and writes the commitment, the sealed nonce and the
-- execution record `completed` in one transaction. A replay trial finalizes after its whole source
-- transcript is copied (D2).
-- The finding is the one Finding object for assistants and investigators (C-27, D5; S2 $defs.Finding):
--   {label, likelihood, confidence, basis_flag_refs, corroboration_needed, rationale (1-600 characters),
--    cited_turns, cited_records, alternative_explanations (optional)}
-- Citations (SG3-17): every cited turn is an integer naming an answered, non-partial turn of this trial;
-- every cited record is an initial document of the trial's public packet (doc-NN) or a record released
-- on this trial (rec-NN). S2 4.2's label and likelihood pairing is schema validation in code. A KPI-4
-- sample still pending becomes unmeasured_timeout (D4).
-- -----------------------------------------------------------------------------
create or replace function arena.finalize_trial(p_trial uuid, p_work_item uuid, p_final_finding jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v        arena.trials;
  v_wi     arena.work_items;
  v_sha    text := ledger.hash_jsonb(p_final_finding);
  v_len    integer;
  v_docs   jsonb;
  v_payload jsonb;
  v_nonce  bytea;
  v_commit text;
  v_seq    bigint;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  v_wi := arena._take_work_item(p_trial, p_work_item, 'finalize', v_sha);
  if v_wi.status = 'done' then
    return v_wi.result;
  end if;
  if v.status <> 'running' then
    raise exception using errcode = 'AR001', message = format('trial is %s', v.status);
  end if;
  if v_wi.transcript_version <> v.transcript_version then
    raise exception using errcode = 'AR002', message = 'stale transcript version';
  end if;
  if exists (select 1 from arena.turns where trial_id = p_trial and answer is null) then
    raise exception using errcode = 'AR004', message = 'an open question must be answered before finalization';
  end if;
  -- a voice session's trial has stored voice exchanges and no turns (D-016); its finding cites records only
  select (select count(*) from arena.turns where trial_id = p_trial)
         + (select count(*) from training.voice_exchanges where trial_id = p_trial) into v_len;
  if v_len = 0 then
    raise exception using errcode = 'AR001', message = 'nothing to finalize: the transcript is empty';
  end if;
  if v.kind = 'replay' and v.exchanges < (select count(*) from arena.turns s
                                           where s.trial_id = v.source_trial_id and s.answer is not null) then
    raise exception using errcode = 'AR001', message = 'a replay finalizes after its whole source transcript is copied';
  end if;
  v_docs := coalesce((select jsonb_agg(d ->> 'doc_id')
                        from jsonb_array_elements(coalesce(
                               (select packet from arena.public_packets where variant_id = v.variant_id),
                               (select packet from sealed.hidden_public_packets where variant_id = v.variant_id)) -> 'initial_documents') d),
                     '[]'::jsonb);
  if v.kind = 'replay_corpus' then
    if p_final_finding is not null then
      raise exception using errcode = 'AR007', message = 'a corpus transcript carries no finding';
    end if;
  elsif jsonb_typeof(p_final_finding) is distinct from 'object'
        or coalesce(p_final_finding ->> 'label', '') not in ('deceptive', 'truthful', 'insufficient_evidence')
        or coalesce(p_final_finding ->> 'likelihood', '') not in ('almost_no_chance', 'very_unlikely', 'unlikely',
                                                                  'roughly_even_chance', 'likely', 'very_likely',
                                                                  'almost_certain')
        or coalesce(p_final_finding ->> 'confidence', '') not in ('low', 'moderate', 'high')
        or jsonb_typeof(p_final_finding -> 'rationale') is distinct from 'string'
        or length(p_final_finding ->> 'rationale') not between 1 and 600
        or jsonb_typeof(p_final_finding -> 'basis_flag_refs') is distinct from 'array'
        or jsonb_typeof(p_final_finding -> 'corroboration_needed') is distinct from 'array'
        or (p_final_finding ? 'alternative_explanations' and jsonb_typeof(p_final_finding -> 'alternative_explanations') <> 'array')
        or jsonb_typeof(p_final_finding -> 'cited_turns') is distinct from 'array'
        or exists (select 1 from jsonb_array_elements(p_final_finding -> 'cited_turns') c
                    where jsonb_typeof(c) <> 'number' or (c #>> '{}') !~ '^[0-9]{1,2}$'
                       or not exists (select 1 from arena.turns u
                                       where u.trial_id = p_trial and u.turn_no = (c #>> '{}')::smallint
                                         and u.answer is not null and not u.answer_partial))
        or jsonb_typeof(p_final_finding -> 'cited_records') is distinct from 'array'
        or exists (select 1 from jsonb_array_elements(p_final_finding -> 'cited_records') r
                    where jsonb_typeof(r) <> 'string'
                       or not (v_docs ? (r #>> '{}')
                               or exists (select 1 from arena.released_evidence x
                                           where x.trial_id = p_trial and x.record_id = r #>> '{}'))) then
    raise exception using errcode = 'AR007',
      message = 'finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records';
  end if;

  perform ops._close_pending_latency(p_trial);
  if p_final_finding is not null then
    insert into arena.final_findings (trial_id, classification, likelihood, confidence, finding)
      values (p_trial, p_final_finding ->> 'label', p_final_finding ->> 'likelihood', p_final_finding ->> 'confidence',
              p_final_finding);
  end if;
  v_payload := ledger.commitment_payload(p_trial, p_final_finding);
  v_nonce := extensions.gen_random_bytes(32);
  v_commit := encode(sha256(v_nonce || convert_to(v_payload::text, 'UTF8')), 'hex');
  insert into sealed.commitment_nonces (trial_id, nonce) values (p_trial, v_nonce);
  update arena.trials set status = 'finalized', ended_at = now(), transcript_version = transcript_version + 1,
                          coaching_pending = false
   where id = p_trial;
  v_seq := ledger.append_event('trial_finalized', v.tournament_id, p_trial,
             jsonb_build_object('commitment_sha256', v_commit, 'state', 'completed'));
  insert into ledger.finding_commitments (trial_id, payload, payload_sha256, commitment_sha256, event_seq)
    values (p_trial, v_payload, ledger.hash_jsonb(v_payload), v_commit, v_seq);
  insert into ledger.terminal_records (trial_id, planned_trial_id, state, work_item_id, event_seq)
    values (p_trial, v.planned_trial_id, 'completed', p_work_item, v_seq);
  if v.kind = 'training' then
    perform arena._emit(v, 'finding_committed', null, p_final_finding);
  end if;
  perform arena._emit(v, 'trial_ended', null, jsonb_build_object('reason', 'completed', 'commitment_sha256', v_commit));
  return arena._complete_work_item(p_work_item, v_sha,
    jsonb_build_object('commitment_sha256', v_commit, 'payload_sha256', ledger.hash_jsonb(v_payload)));
end $$;

-- Recompute a commitment from stored rows and the sealed nonce.
-- SG3-42: a commitment verifies only when the recomputed commitment equals both the stored row and the one
-- the chained ledger published at finalization: the trial_finalized event at the row's event_seq, for this
-- trial and tournament, which is also the completed terminal record's event. A missing row or nonce, or a
-- finding changed with its commitment recomputed, fails (the ledger event is not rewritable without
-- breaking ledger.verify_chain).
create or replace function ledger.verify_commitment(p_trial uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select c.commitment_sha256 = encode(sha256(n.nonce || convert_to(p.payload::text, 'UTF8')), 'hex')
           and c.payload = p.payload
           and e.event_type = 'trial_finalized' and e.trial_id = c.trial_id
           and e.tournament_id is not distinct from t.tournament_id
           and e.payload ->> 'commitment_sha256' = encode(sha256(n.nonce || convert_to(p.payload::text, 'UTF8')), 'hex')
           and r.state = 'completed' and r.event_seq = c.event_seq
      from ledger.finding_commitments c
      join arena.trials t on t.id = c.trial_id
      join sealed.commitment_nonces n on n.trial_id = c.trial_id
      join ledger.events e on e.seq = c.event_seq
      join ledger.terminal_records r on r.trial_id = c.trial_id
      cross join lateral (select ledger.commitment_payload(c.trial_id,
                                   (select f.finding from arena.final_findings f where f.trial_id = c.trial_id)) as payload) p
     where c.trial_id = p_trial), false)
$$;

-- -----------------------------------------------------------------------------
-- 4. record_execution_failure (arena_public)  F15, BKO-9, EVL-5
-- One execution record per trial attempt; allowed transitions only:
--   planned -> budget_skipped;  running -> assistant_failed | infra_failed | budget_truncated
-- -----------------------------------------------------------------------------
create or replace function arena.record_execution_failure(p_trial uuid, p_work_item uuid, p_state text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v     arena.trials;
  v_wi  arena.work_items;
  v_sha text := ledger.hash_jsonb(jsonb_build_object('state', p_state, 'reason', p_reason));
  v_seq bigint;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  v_wi := arena._take_work_item(p_trial, p_work_item, 'failure', v_sha);
  if v_wi.status = 'done' then
    return v_wi.result;
  end if;
  if p_state not in ('assistant_failed', 'infra_failed', 'budget_skipped', 'budget_truncated')
     or coalesce(length(p_reason), 0) not between 1 and 500
     or (p_state = 'assistant_failed' and v.kind = 'replay_corpus') then
    raise exception using errcode = 'AR007', message = 'state must be a failure state valid for this trial, with a reason';
  end if;
  if (p_state = 'budget_skipped' and v.status <> 'planned')
     or (p_state <> 'budget_skipped' and v.status <> 'running') then
    raise exception using errcode = 'AR001', message = format('%s is not allowed from %s', p_state, v.status);
  end if;
  if v_wi.transcript_version <> v.transcript_version then
    raise exception using errcode = 'AR002', message = 'stale transcript version';
  end if;
  perform ops._close_pending_latency(p_trial);
  update arena.trials set status = 'terminated', ended_at = now(), coaching_pending = false where id = p_trial;
  v_seq := ledger.append_event('execution_recorded', v.tournament_id, p_trial, jsonb_build_object('state', p_state));
  insert into ledger.terminal_records (trial_id, planned_trial_id, state, reason, work_item_id, event_seq)
    values (p_trial, v.planned_trial_id, p_state, p_reason, p_work_item, v_seq);
  perform arena._emit(v, 'trial_ended', null,
    jsonb_build_object('reason', case when p_state like 'budget%' then 'budget' else p_state end));
  return arena._complete_work_item(p_work_item, v_sha, jsonb_build_object('trial_id', p_trial, 'state', p_state));
end $$;

-- -----------------------------------------------------------------------------
-- 5. adjudicate_validity (arena_referee)  SUB-7, SUB-8, EVL-11, F15
-- Append-only subject verdict after blinded review. Never edits transcripts, findings or
-- commitments. The latest adjudication of a trial is the one in force.
-- -----------------------------------------------------------------------------
create or replace function ledger.adjudicate_validity(p_trial uuid, p_verdict text, p_reason text, p_evidence_ref text,
                                                      p_decided_by text, p_idempotency_key text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v        arena.trials;
  v_tid    uuid;
  v_tstat  text;
  v_state  text;
  v_prev   ledger.validity_adjudications;
  v_id     uuid;
  v_seq    bigint;
begin
  perform ledger.require_read_committed();
  select tournament_id into v_tid from arena.trials where id = p_trial;
  select status into v_tstat from arena.tournaments where id = v_tid for share;
  v := arena._lock_trial(p_trial);
  select * into v_prev from ledger.validity_adjudications where idempotency_key = p_idempotency_key;
  if found then
    if (v_prev.trial_id, v_prev.verdict, v_prev.reason, v_prev.evidence_ref, v_prev.decided_by)
       is not distinct from (p_trial, p_verdict, p_reason, p_evidence_ref, p_decided_by) then
      return v_prev.id;
    end if;
    raise exception using errcode = 'AR003', message = 'idempotency key reused with a different adjudication';
  end if;
  if v.kind not in ('interactive', 'replay_corpus') then
    raise exception using errcode = 'AR001', message = 'subject validity is adjudicated on tournament interviews only';
  end if;
  select state into v_state from ledger.terminal_records where trial_id = p_trial;
  if v_state is null or v_state not in ('completed', 'assistant_failed') then
    raise exception using errcode = 'AR001', message = 'only completed or assistant_failed interviews need subject review';
  end if;
  v_id := gen_random_uuid();
  v_seq := ledger.append_event('validity_adjudicated', v_tid, p_trial,
             jsonb_build_object('adjudication_id', v_id, 'verdict', p_verdict, 'after_reveal', v_tstat = 'revealed'));
  insert into ledger.validity_adjudications (id, trial_id, verdict, reason, evidence_ref, decided_by, idempotency_key,
                                             after_reveal, event_seq)
    values (v_id, p_trial, p_verdict, p_reason, p_evidence_ref, p_decided_by, p_idempotency_key, v_tstat = 'revealed',
            v_seq);
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- Inclusion manifest (F14, F15; direction 7.1; S3 4.3-4.4 canonical text, X-07). UTF-8, LF line
-- endings, trailing newline; a header line, then one line per planned trial sorted by
-- planned_trial_id in byte order:
--   arena-inclusion-manifest|v1|{tournament_id}|{version}|{parent_sha256 or empty}|{roster_sha256}|
--     {corpus_sha256 or empty}|{hidden_seal_sha256 or empty}
--   {planned_trial_id}|{track}|{assistant_id}|{subject_id}|{family_id}|{variant_id}|{role}|{repeat}|
--     {exec_state}|{adjudication_id}|{verdict}|{asst_inclusion}|{subj_inclusion}|{reason}
-- Inclusion is S3's inclusion() exactly: assistant included | included_as_insufficient | excluded;
-- subject counted | against_subject | excluded; reasons source_unavailable, block_invalid_infra,
-- infra_failed, budget_skipped, budget_truncated, subject_quarantined, subject_invalid, included,
-- assistant_failed_as_insufficient. asst_inclusion is empty on replay_corpus rows and subj_inclusion
-- on replay rows (not applicable). A replay row carries its source corpus transcript's adjudication.
-- Block infra rule (the default until OD-14 decides; S3 4.3): a block is invalid when more than 5%
-- of its planned trials end infra_failed (20 x infra_failed > planned). The text is built for the
-- next version (1 at reveal, n + 1 for a correction); the hash is ledger.hash_text of the text, which
-- S3's Python verifier recomputes byte for byte. A reviewed trial without a verdict, or a planned
-- trial without an execution record, raises AR020 (S3 RevealBlocked).
-- -----------------------------------------------------------------------------
create or replace function ledger.build_manifest(p_tournament uuid)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_last   ledger.inclusion_manifests;
  v_header text;
  v_body   text;
  v_open   integer;
begin
  select * into v_last from ledger.inclusion_manifests
   where tournament_id = p_tournament order by version desc limit 1;
  with x as (
    select * from ledger.planned_execution(p_tournament)
  ), e as (
    select p.id as planned_trial_id, p.track, p.block_id, p.assistant_candidate_id, p.subject_candidate_id,
           p.variant_id, p.repeat, x.state,
           case when p.track = 'replay' then src.trial_id else x.trial_id end as reviewed_trial_id
      from arena.planned_trials p
      join x on x.planned_trial_id = p.id
      left join x src on src.planned_trial_id = p.source_planned_trial_id
     where p.tournament_id = p_tournament
  ), blocks as (
    select bp.block_id, 20 * count(*) filter (where x.state = 'infra_failed') > count(*) as invalid
      from arena.planned_trials bp join x on x.planned_trial_id = bp.id
     where bp.tournament_id = p_tournament and bp.block_id is not null
     group by bp.block_id
  ), a as (
    select e.*, adj.id as adjudication_id, adj.verdict, coalesce(b.invalid, false) as block_invalid
      from e
      left join blocks b on b.block_id = e.block_id
      left join lateral (select v.id, v.verdict from ledger.validity_adjudications v
                          where v.trial_id = e.reviewed_trial_id order by v.adj_seq desc limit 1) adj on true
  ), i as (
    select a.*,
      case
        when a.state = 'source_unavailable' then 'excluded|excluded|source_unavailable'
        when a.block_invalid then 'excluded|excluded|block_invalid_infra'
        when a.state = 'infra_failed' then 'excluded|excluded|infra_failed'
        when a.state in ('budget_skipped', 'budget_truncated') then 'excluded|excluded|' || a.state
        when a.state = 'subject_quarantined' then 'excluded|against_subject|subject_quarantined'
        when a.state not in ('completed', 'assistant_failed') or a.verdict is null then null
        when a.verdict = 'subject_invalid' then 'excluded|against_subject|subject_invalid'
        when a.state = 'completed' then 'included|counted|included'
        else 'included_as_insufficient|counted|assistant_failed_as_insufficient'
      end as inc
      from a
  ), l as (
    select i.planned_trial_id::text as sort_key, i.inc,
           concat_ws('|', i.planned_trial_id, i.track, coalesce(i.assistant_candidate_id::text, ''),
                     coalesce(i.subject_candidate_id::text, ''), v.family_id, i.variant_id, ep.role, i.repeat,
                     coalesce(i.state, ''), coalesce(i.adjudication_id::text, ''), coalesce(i.verdict, ''),
                     case when i.track = 'replay_corpus' then '' else split_part(i.inc, '|', 1) end,
                     case when i.track = 'replay' then '' else split_part(i.inc, '|', 2) end,
                     split_part(i.inc, '|', 3)) as line
      from i
      join arena.case_variants v on v.id = i.variant_id
      join sealed.evaluator_packets ep on ep.variant_id = i.variant_id
  )
  select count(*) filter (where l.inc is null),
         coalesce(string_agg(l.line || E'\n', '' order by l.sort_key collate "C"), '')
    into v_open, v_body
    from l;
  if v_open > 0 then
    raise exception using errcode = 'AR020',
      message = format('%s planned trials lack an execution record or a subject review', v_open);
  end if;
  select concat_ws('|', 'arena-inclusion-manifest', 'v1', t.id, coalesce(v_last.version, 0) + 1,
                   coalesce(v_last.manifest_sha256, ''), t.roster_sha256,
                   coalesce((select c.corpus_sha256 from ledger.corpus_seals c where c.tournament_id = t.id), ''),
                   coalesce((select h.seal_sha256 from sealed.hidden_split_seals h where h.id = t.hidden_seal_id), ''))
    into v_header from arena.tournaments t where t.id = p_tournament;
  return v_header || E'\n' || v_body;
end $$;

-- Shared preconditions of reveal and corrected manifests. Raises AR020/AR021 on the first failure.
create or replace function ledger.check_reveal_preconditions(p_tournament uuid)
returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_t    arena.tournaments;
  v_bad  uuid;
  v_seq  bigint;
begin
  select * into v_t from arena.tournaments where id = p_tournament;
  if v_t.roster_sha256 is null or v_t.roster_sha256 <> arena.roster_digest(p_tournament) then
    raise exception using errcode = 'AR021', message = 'roster is not frozen or does not match its hash';
  end if;
  if exists (select 1 from ledger.planned_execution(p_tournament) e where e.state is null) then
    raise exception using errcode = 'AR020', message = 'a planned trial has no execution record';
  end if;
  if exists (select 1 from ledger.planned_execution(p_tournament) e
              where e.track in ('interactive', 'replay_corpus') and e.state in ('completed', 'assistant_failed')
                and not exists (select 1 from ledger.validity_adjudications a where a.trial_id = e.trial_id)) then
    raise exception using errcode = 'AR020', message = 'a subject review is unresolved';
  end if;
  if exists (select 1 from arena.planned_trials where tournament_id = p_tournament and track = 'replay_corpus')
     and not exists (select 1 from ledger.corpus_seals s, ledger.corpus_digest(p_tournament) d
                      where s.tournament_id = p_tournament and s.corpus_sha256 = d.corpus_sha256) then
    raise exception using errcode = 'AR021', message = 'replay corpus is not sealed or does not match its seal';
  end if;
  -- SG3-42: every completed trial of the tournament (its terminal record, not the surviving commitment rows)
  -- must have a commitment and nonce that verify against its trial_finalized event.
  select r.trial_id into v_bad from ledger.terminal_records r join arena.trials t on t.id = r.trial_id
   where t.tournament_id = p_tournament and r.state = 'completed' and not ledger.verify_commitment(r.trial_id) limit 1;
  if v_bad is not null then
    raise exception using errcode = 'AR021', message = format('commitment of trial %s does not verify', v_bad);
  end if;
  if v_t.split = 'hidden' and not sealed.verify_hidden_seal() then
    raise exception using errcode = 'AR021', message = 'hidden split seal does not verify';
  end if;
  v_seq := ledger.verify_chain();
  if v_seq is not null then
    raise exception using errcode = 'AR021', message = format('ledger chain breaks at seq %s', v_seq);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 6. reveal (arena_referee)  BKO-9, EVL-10, F15
-- Checks every precondition, seals inclusion manifest version 1, publishes the nonces, and moves
-- the tournament to revealed (which unlocks hidden debriefs, exports, spans and scoring writes).
-- -----------------------------------------------------------------------------
create or replace function ledger.reveal(p_tournament uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_status   text;
  v_result   jsonb;
  v_manifest text;
  v_sha      text;
  v_id       uuid;
  v_seq      bigint;
begin
  perform ledger.require_read_committed();
  select status into v_status from arena.tournaments where id = p_tournament for update;
  if v_status = 'revealed' then
    select jsonb_build_object('manifest_id', id, 'manifest_sha256', manifest_sha256) into v_result
      from ledger.inclusion_manifests where tournament_id = p_tournament and version = 1;
    return v_result;
  end if;
  if v_status is distinct from 'scoring' then
    raise exception using errcode = 'AR020', message = 'reveal follows scoring (draft/frozen/running/sealed refused)';
  end if;
  perform ledger.check_reveal_preconditions(p_tournament);
  v_manifest := ledger.build_manifest(p_tournament);
  v_sha := ledger.hash_text(v_manifest);
  update arena.tournaments set status = 'revealed', revealed_at = now() where id = p_tournament;
  v_seq := ledger.append_event('tournament_revealed', p_tournament, null,
             jsonb_build_object('manifest_sha256', v_sha, 'manifest_version', 1));
  insert into ledger.inclusion_manifests (tournament_id, version, manifest, manifest_sha256, event_seq)
    values (p_tournament, 1, v_manifest, v_sha, v_seq) returning id into v_id;
  insert into ledger.revealed_nonces (trial_id, nonce_hex)
    select n.trial_id, encode(n.nonce, 'hex')
      from sealed.commitment_nonces n join arena.trials t on t.id = n.trial_id
     where t.tournament_id = p_tournament;
  return jsonb_build_object('manifest_id', v_id, 'manifest_sha256', v_sha);
end $$;

-- A later adjudication produces a new, separately labeled manifest; version 1 never changes.
create or replace function ledger.seal_corrected_manifest(p_tournament uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_status   text;
  v_last     ledger.inclusion_manifests;
  v_manifest text;
  v_sha      text;
  v_id       uuid;
  v_seq      bigint;
begin
  perform ledger.require_read_committed();
  select status into v_status from arena.tournaments where id = p_tournament for update;
  if v_status is distinct from 'revealed' then
    raise exception using errcode = 'AR020', message = 'corrections follow reveal';
  end if;
  perform ledger.check_reveal_preconditions(p_tournament);
  select * into v_last from ledger.inclusion_manifests where tournament_id = p_tournament order by version desc limit 1;
  v_manifest := ledger.build_manifest(p_tournament);
  -- unchanged trial lines: the last version stands (the header always differs)
  if substr(v_manifest, strpos(v_manifest, E'\n') + 1) = substr(v_last.manifest, strpos(v_last.manifest, E'\n') + 1) then
    return jsonb_build_object('manifest_id', v_last.id, 'manifest_sha256', v_last.manifest_sha256, 'version', v_last.version);
  end if;
  v_sha := ledger.hash_text(v_manifest);
  v_seq := ledger.append_event('manifest_corrected', p_tournament, null,
             jsonb_build_object('manifest_sha256', v_sha, 'manifest_version', v_last.version + 1, 'supersedes', v_last.id));
  insert into ledger.inclusion_manifests (tournament_id, version, manifest, manifest_sha256, supersedes_id, event_seq)
    values (p_tournament, v_last.version + 1, v_manifest, v_sha, v_last.id, v_seq) returning id into v_id;
  return jsonb_build_object('manifest_id', v_id, 'manifest_sha256', v_sha, 'version', v_last.version + 1);
end $$;

-- -----------------------------------------------------------------------------
-- Context readers
-- -----------------------------------------------------------------------------
-- trial_context (arena_public): what the coach and harness may see for a running trial, given an
-- open coaching, finalize or release work item: the trial's own transcript and releases (a replay trial's
-- copied prefix, D2), prior coaching and the assistant manifest. Hidden public packets are reachable only
-- here, only while the trial runs (SCN-12). S5 builds PublicTrialView from this result.
create or replace function arena.trial_context(p_trial uuid, p_work_item uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v     arena.trials;
  v_wi  arena.work_items;
begin
  select * into v from arena.trials where id = p_trial;
  select * into v_wi from arena.work_items where id = p_work_item;
  if v.id is null or v_wi.id is null or v_wi.trial_id <> p_trial or v_wi.status <> 'open'
     or v_wi.kind not in ('coaching', 'finalize', 'release') or v.status <> 'running' then
    raise exception using errcode = 'AR003', message = 'context needs an open coaching, finalize or release work item on a running trial';
  end if;
  perform arena._check_caller(v.kind, v.owner_user_id);
  return jsonb_build_object(
    'trial_id', v.id, 'kind', v.kind, 'mode', v.mode, 'transcript_version', v.transcript_version,
    'exchanges', v.exchanges, 'max_exchanges', v.max_exchanges,
    'public_packet', coalesce((select packet from arena.public_packets where variant_id = v.variant_id),
                              (select packet from sealed.hidden_public_packets where variant_id = v.variant_id)),
    'transcript', coalesce((select jsonb_agg(jsonb_build_object('turn_no', turn_no, 'question', question, 'answer', answer,
                                                                'partial', answer_partial)
                                             order by turn_no) from arena.turns where trial_id = v.id), '[]'::jsonb),
    'released_evidence', coalesce((select jsonb_agg(jsonb_build_object('record_id', record_id, 'kind', kind,
                                                                       'doc_kind', doc_kind, 'title', title, 'content', content,
                                                                       'after_exchanges', released_after_exchanges)
                                                    order by release_seq) from arena.released_evidence where trial_id = v.id),
                                  '[]'::jsonb),
    'coaching', coalesce((select jsonb_agg(jsonb_build_object('seq', seq, 'kind', kind, 'turn_no', turn_no, 'card', payload)
                                           order by seq)
                            from arena.trial_events where trial_id = v.id
                             and kind in ('coach_card', 'coach_deep', 'coach_unavailable')), '[]'::jsonb),
    'assistant_manifest', (select manifest from arena.candidates where id = v.assistant_candidate_id));
end $$;

-- The subject's view of a trial (internal; no role holds EXECUTE): private and public packet, transcript,
-- released evidence and the committed disclosure state (SG1-02): for each fact first disclosed and each
-- gate opened in a stored tag, the earliest turn. Tags are stored only for answers that passed the guard,
-- so quarantined attempts never count. S2 6.7 renders gate status from this and the released records.
create or replace function subject._view(p_trial arena.trials)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'trial_id', p_trial.id, 'transcript_version', p_trial.transcript_version, 'exchanges', p_trial.exchanges,
    'private_packet', (select packet from subject.private_packets where variant_id = p_trial.variant_id),
    'public_packet', coalesce((select packet from arena.public_packets where variant_id = p_trial.variant_id),
                              (select packet from sealed.hidden_public_packets where variant_id = p_trial.variant_id)),
    'transcript', coalesce((select jsonb_agg(jsonb_build_object('turn_no', u.turn_no, 'question', u.question, 'answer', u.answer,
                                                                'channel', u.channel)
                                             order by u.turn_no) from arena.turns u where u.trial_id = p_trial.id), '[]'::jsonb),
    'released_evidence', coalesce((select jsonb_agg(jsonb_build_object('record_id', r.record_id, 'kind', r.kind,
                                                                       'doc_kind', r.doc_kind, 'title', r.title,
                                                                       'content', r.content) order by r.release_seq)
                                     from arena.released_evidence r where r.trial_id = p_trial.id), '[]'::jsonb),
    'disclosure_state', jsonb_build_object(
       'disclosed', coalesce((select jsonb_agg(jsonb_build_object('fact_id', d.id, 'first_turn', d.turn_no)
                                               order by d.turn_no, d.id collate "C")
                                from (select x.id, min(p.turn_no) as turn_no
                                        from sealed.subject_tag_proposals p
                                        cross join lateral jsonb_array_elements_text(coalesce(p.tag -> 'disclosed', '[]'::jsonb)) x(id)
                                       where p.trial_id = p_trial.id group by x.id) d), '[]'::jsonb),
       'gates_opened', coalesce((select jsonb_agg(jsonb_build_object('gate_id', g.id, 'turn', g.turn_no)
                                                  order by g.turn_no, g.id collate "C")
                                   from (select x.id, min(p.turn_no) as turn_no
                                           from sealed.subject_tag_proposals p
                                           cross join lateral jsonb_array_elements_text(coalesce(p.tag -> 'gates_opened', '[]'::jsonb)) x(id)
                                          where p.trial_id = p_trial.id group by x.id) g), '[]'::jsonb)),
    'subject_manifest', (select manifest from arena.candidates where id = p_trial.subject_candidate_id))
$$;

-- turn_context (arena_subject): the subject's view for one open subject_answer work item at the current
-- version. arena_subject holds no table privileges. Voice sessions read subject.voice_context (0006).
create or replace function subject.turn_context(p_trial uuid, p_work_item uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v    arena.trials;
  v_wi arena.work_items;
begin
  select * into v from arena.trials where id = p_trial;
  select * into v_wi from arena.work_items where id = p_work_item;
  if v.id is null or v_wi.id is null or v_wi.trial_id <> p_trial or v_wi.kind <> 'subject_answer'
     or v_wi.status <> 'open' or v.status <> 'running' or v_wi.transcript_version <> v.transcript_version then
    raise exception using errcode = 'AR003', message = 'context needs the open subject_answer work item at the current version';
  end if;
  return subject._view(v) || jsonb_build_object('turn_no', v_wi.turn_no);
end $$;

-- -----------------------------------------------------------------------------
-- SSE projection (S5 6.2): events of the actor's own training trial after a sequence number.
-- live rows always; debrief rows once the trial has ended; internal rows never.
-- -----------------------------------------------------------------------------
create or replace function arena.events_after(p_trial uuid, p_after_seq integer, p_limit integer)
returns table (seq integer, kind text, transcript_version integer, turn_no smallint, payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.seq, e.kind, e.transcript_version, e.turn_no, e.payload, e.created_at
    from arena.trial_events e join arena.trials t on t.id = e.trial_id
   where e.trial_id = p_trial and e.seq > coalesce(p_after_seq, 0)
     and t.kind = 'training' and t.owner_user_id = arena.actor_id()
     and (e.visibility = 'live' or (e.visibility = 'debrief' and t.status in ('finalized', 'terminated')))
   order by e.seq
   limit least(greatest(coalesce(p_limit, 200), 1), 200)
$$;

-- -----------------------------------------------------------------------------
-- Projection views for arena_public (security_barrier: a caller-supplied function in a WHERE
-- clause cannot see filtered rows). No role reads a base table in arena, sealed, subject or ledger
-- except arena_referee.
-- -----------------------------------------------------------------------------
-- arena.v_dev_cases (the case browser) is defined in 0005, after training.case_set_members exists.

create view arena.v_candidates with (security_barrier = true) as
  select id, kind, name, version, manifest, sha256, created_at from arena.candidates;

create view arena.v_tournaments with (security_barrier = true) as
  select id, name, split, status, seed, budget_bucket, max_exchanges, roster_sha256, created_at, frozen_at, running_at,
         sealed_at, scoring_at, revealed_at
    from arena.tournaments;

create view arena.v_planned_trials with (security_barrier = true) as
  select p.id, p.tournament_id, p.position, p.track, b.block_no, p.variant_id, p.assistant_candidate_id,
         p.subject_candidate_id, p.repeat, p.source_planned_trial_id
    from arena.planned_trials p left join arena.blocks b on b.id = p.block_id;

-- trial metadata: every tournament trial (ids and states only) plus the actor's own training trials
create view arena.v_trials with (security_barrier = true) as
  select t.id, t.kind, t.tournament_id, t.planned_trial_id, t.attempt, t.variant_id, t.assistant_candidate_id,
         t.subject_candidate_id, t.mode, t.status, t.transcript_version, t.exchanges, t.max_exchanges,
         t.coaching_pending, t.started_at, t.ended_at, r.state as execution_state
    from arena.trials t left join ledger.terminal_records r on r.trial_id = t.id
   where t.kind <> 'training' or t.owner_user_id = arena.actor_id();

create view arena.v_transcripts with (security_barrier = true) as
  select u.trial_id, u.turn_no, u.question, u.question_source, u.relay_outcome, u.proposal_seq, u.channel, u.asked_at,
         u.answer, u.answer_partial, u.answered_at
    from arena.turns u where arena.trial_visible(u.trial_id);

create view arena.v_released_evidence with (security_barrier = true) as
  select r.trial_id, r.record_id, r.release_seq, r.released_after_exchanges, r.kind, r.doc_kind, r.title, r.content,
         r.released_at
    from arena.released_evidence r where arena.trial_visible(r.trial_id);

-- debriefs and exports: assessment coaching (debrief rows) stays hidden until the trial ends (SOL-6)
create view arena.v_trial_events with (security_barrier = true) as
  select e.trial_id, e.seq, e.kind, e.visibility, e.transcript_version, e.turn_no, e.candidate_id, e.payload, e.created_at
    from arena.trial_events e join arena.trials t on t.id = e.trial_id
   where arena.trial_visible(e.trial_id) and not (e.visibility = 'debrief' and t.status = 'running');

create view arena.v_findings with (security_barrier = true) as
  select f.trial_id, f.classification, f.likelihood, f.confidence, f.finding, f.committed_at
    from arena.final_findings f where arena.trial_visible(f.trial_id);

create view arena.v_scores with (security_barrier = true) as
  select id, tournament_id, manifest_id, candidate_id, metric, value, created_at from arena.scores;

create view arena.v_leaderboards with (security_barrier = true) as
  select l.id, l.tournament_id, l.manifest_id, m.manifest_sha256, m.version as manifest_version, l.board, l.label,
         l.body, l.sha256, l.created_at
    from arena.leaderboards l join ledger.inclusion_manifests m on m.id = l.manifest_id;

create view ledger.v_events with (security_barrier = true) as
  select seq, event_type, tournament_id, trial_id, transcript_version, payload, created_us, prev_sha256, sha256
    from ledger.events e
   where e.trial_id is null or arena.trial_visible(e.trial_id);

-- Tournament progress (D9, SG3-15, SG4-04): counts per track and block, by latest-attempt status and
-- execution state, for every tournament including a hidden one before reveal. No trial id, text, card,
-- record or flag count appears; hidden trials are visible before reveal only as these counts.
create view arena.v_tournament_progress with (security_barrier = true) as
  with latest as (
    select p.tournament_id, p.track, b.block_no, t.status, r.state
      from arena.planned_trials p
      left join arena.blocks b on b.id = p.block_id
      left join lateral (select t2.id, t2.status from arena.trials t2 where t2.planned_trial_id = p.id
                          order by t2.attempt desc limit 1) t on true
      left join ledger.terminal_records r on r.trial_id = t.id
  )
  select l.tournament_id, l.track, l.block_no, count(*)::integer as planned,
         count(*) filter (where l.status = 'running')::integer as running,
         count(*) filter (where l.state is not null)::integer as ended,
         (select coalesce(jsonb_object_agg(x.state, x.n), '{}'::jsonb)
            from (select l2.state, count(*) as n from latest l2
                   where l2.tournament_id = l.tournament_id and l2.track = l.track
                     and l2.block_no is not distinct from l.block_no and l2.state is not null
                   group by l2.state) x) as states
    from latest l
   group by l.tournament_id, l.track, l.block_no;

-- commitments are public from finalization (that is their purpose); payloads once visible
create view ledger.v_commitments with (security_barrier = true) as
  select c.trial_id, c.commitment_sha256, c.created_at,
         case when arena.trial_visible(c.trial_id) then c.payload end as payload,
         case when arena.trial_visible(c.trial_id) then c.payload::text end as payload_text
    from ledger.finding_commitments c;

-- SG3-43: the trust center's isolation results. Check name, candidate, pass or fail, run time and the commit
-- the check ran on; the evidence object (scan matches, file paths, hidden field paths) stays referee-only.
create view arena.v_isolation_checks with (security_barrier = true) as
  select i.check_name, i.candidate_id, c.name as candidate_name, i.passed, i.created_at as run_at,
         case when i.evidence ->> 'commit_sha' ~ '^[0-9a-f]{40}$' then i.evidence ->> 'commit_sha' end as commit_sha
    from arena.isolation_checks i left join arena.candidates c on c.id = i.candidate_id;

create view ledger.v_revealed_nonces with (security_barrier = true) as
  select trial_id, nonce_hex, revealed_at from ledger.revealed_nonces;

create view ledger.v_manifests with (security_barrier = true) as
  select id, tournament_id, version, manifest, manifest_sha256, supersedes_id, created_at from ledger.inclusion_manifests;

create view ledger.v_adjudications with (security_barrier = true) as
  select a.id, a.trial_id, a.verdict, a.reason, a.decided_by, a.after_reveal, a.created_at
    from ledger.validity_adjudications a where arena.trial_visible(a.trial_id);

create view ledger.v_corpus_seals with (security_barrier = true) as
  select tournament_id, corpus_sha256, n_transcripts, created_at from ledger.corpus_seals;

-- -----------------------------------------------------------------------------
-- Privileges: revoke everything in these schemas, then grant each function to exactly one role.
-- -----------------------------------------------------------------------------
revoke all on all functions in schema arena, subject, sealed, ledger
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
revoke all on all tables in schema arena, subject, sealed, ledger
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;

-- arena_public
grant usage on schema arena, ledger to arena_public;
grant execute on function
  arena.actor_id(),
  arena.trial_visible(uuid),
  arena.open_work_item(uuid, text, text, integer),
  arena.work_item_results(uuid),
  arena.start_trial(uuid),
  arena.retry_trial(uuid),
  arena.submit_question(uuid, integer, text, text, text, text, integer),
  arena.advance_replay(uuid, uuid),
  arena.release_evidence(uuid, uuid, text[]),
  arena.record_coaching_event(uuid, uuid, jsonb, text),
  arena.finalize_trial(uuid, uuid, jsonb),
  arena.record_execution_failure(uuid, uuid, text, text),
  arena.trial_context(uuid, uuid),
  arena.events_after(uuid, integer, integer)
  to arena_public;
grant select on arena.v_candidates, arena.v_tournaments, arena.v_planned_trials, arena.v_trials,
  arena.v_transcripts, arena.v_released_evidence, arena.v_trial_events, arena.v_findings, arena.v_scores,
  arena.v_leaderboards, arena.v_tournament_progress, ledger.v_events, ledger.v_commitments, ledger.v_revealed_nonces,
  ledger.v_manifests, ledger.v_adjudications, ledger.v_corpus_seals, arena.v_isolation_checks
  to arena_public;

-- arena_subject: two functions here, no tables
grant usage on schema arena, subject to arena_subject;
grant execute on function arena.record_subject_turn(uuid, uuid, text, jsonb, jsonb), subject.turn_context(uuid, uuid)
  to arena_subject;

-- arena_referee: reads every tier, its own inserts, lifecycle and the two referee privileged functions
grant usage on schema arena, subject, sealed, ledger to arena_referee;
grant select on all tables in schema arena, subject, sealed, ledger to arena_referee;
-- SG2-31, SG3-38: the actor-scoped public projections call arena.trial_visible or arena.actor_id, which only
-- arena_public may execute, and filter by an investigator the referee never is. The referee reads the base
-- tables instead, so it holds no SELECT on these views (a grant it could never use).
revoke select on arena.v_findings, arena.v_released_evidence, arena.v_transcripts, arena.v_trial_events,
  arena.v_trials, ledger.v_adjudications, ledger.v_events, ledger.v_commitments from arena_referee;   -- SG3-45
grant insert on sealed.independent_labels, sealed.judgments, arena.scores, arena.leaderboards, arena.isolation_checks
  to arena_referee;
grant execute on function
  ledger.hash_text(text),
  ledger.hash_jsonb(jsonb),
  sealed.ingest_case_family(jsonb), sealed.seal_hidden_split(jsonb), sealed.verify_hidden_seal(), sealed.hidden_split_digest(),
  arena.register_candidate(text, text, text, jsonb),
  arena.create_tournament(text, text, bigint, text, smallint), arena.add_planned_trials(uuid, jsonb),
  arena.freeze_tournament(uuid), arena.open_tournament(uuid), ledger.seal_replay_corpus(uuid),
  arena.close_tournament_run(uuid), arena.begin_scoring(uuid),
  ledger.verify_chain(), ledger.planned_execution(uuid), ledger.corpus_digest(uuid), arena.roster_digest(uuid),
  ledger.adjudicate_validity(uuid, text, text, text, text, text),
  ledger.reveal(uuid),
  ledger.seal_corrected_manifest(uuid),
  ledger.build_manifest(uuid),
  ledger.verify_commitment(uuid)
  to arena_referee;
