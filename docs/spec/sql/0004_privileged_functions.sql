-- =============================================================================
-- 0004_privileged_functions.sql  (DRAFT, spec S4; not applied anywhere)
-- The six privileged operations of direction section 4.2, the public-tier transactional writes
-- they depend on (start_trial, open_work_item, submit_question, record_coaching_event), the
-- per-trial event store writer, the two context readers (arena.trial_context,
-- subject.turn_context), commitment verification, the inclusion manifest, and the projections
-- arena_public reads.
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
-- One turn (direction 4.5, S5 5.2):
--   submit_question (v+1) -> release_evidence, also with an empty list so scheduled releases apply
--   (v+1 if anything is released) -> open_work_item('subject_answer') -> record_subject_turn (v+1,
--   coaching_pending) -> open_work_item('coaching') -> record_coaching_event (clears pending)
--   -> ... -> open_work_item('finalize') -> finalize_trial (v+1, frozen).
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

-- Records Q(t) for an investigator, the harness or a voice session. Caller holds the trial lock.
create or replace function arena._record_question(p_trial arena.trials, p_question text, p_source text, p_key text)
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
  update arena.trials set transcript_version = transcript_version + 1, coaching_pending = false where id = p_trial.id;
  insert into arena.turns (trial_id, turn_no, question, question_source, question_version, idempotency_key)
    values (p_trial.id, v_turn, p_question, p_source, p_trial.transcript_version + 1, p_key);
  perform arena._emit(p_trial, 'question_recorded', null, jsonb_build_object('turn_no', v_turn, 'question', p_question));
  perform ledger.append_event('question_asked', p_trial.tournament_id, p_trial.id,
    jsonb_build_object('turn_no', v_turn, 'question_sha256', ledger.hash_text(p_question)));
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
-- open_work_item (arena_public): a work item bound to the CURRENT committed transcript version.
-- subject_answer: only while a question is open; it is handed to arena-subject with answer().
-- -----------------------------------------------------------------------------
create or replace function arena.open_work_item(p_trial uuid, p_kind text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v arena.trials;
  v_id uuid;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  if p_kind not in ('subject_answer', 'release', 'coaching', 'finalize', 'failure') then
    raise exception using errcode = 'AR007', message = format('unknown work item kind %s', p_kind);
  end if;
  if (p_kind = 'failure' and v.status not in ('planned', 'running'))
     or (p_kind <> 'failure' and v.status <> 'running') then
    raise exception using errcode = 'AR001', message = format('trial is %s', v.status);
  end if;
  if (p_kind in ('release', 'subject_answer') and v.kind = 'replay') or (p_kind = 'coaching' and v.kind = 'replay_corpus') then
    raise exception using errcode = 'AR001', message = format('%s does not apply to a %s trial', p_kind, v.kind);
  end if;
  if p_kind = 'subject_answer' and not exists (select 1 from arena.turns where trial_id = p_trial and answer is null) then
    raise exception using errcode = 'AR004', message = 'no open question to answer';
  end if;
  if (select count(*) from arena.work_items where trial_id = p_trial and status = 'open') >= 20 then
    raise exception using errcode = 'AR001', message = 'too many open work items on this trial';
  end if;
  insert into arena.work_items (trial_id, kind, transcript_version, turn_no)
    values (p_trial, p_kind, v.transcript_version,
            coalesce((select max(turn_no) from arena.turns where trial_id = p_trial), 0))
    returning id into v_id;
  return jsonb_build_object('work_item_id', v_id, 'transcript_version', v.transcript_version,
                            'turn_no', coalesce((select max(turn_no) from arena.turns where trial_id = p_trial), 0));
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
    select e.trial_id into v_src from ledger.planned_execution(v_tid) e
     where e.planned_trial_id = v_src_pt and e.state = 'completed';
    if v_src is null then
      update arena.trials set status = 'terminated', ended_at = now() where id = p_trial;
      v_seq := ledger.append_event('execution_recorded', v_tid, p_trial,
                 jsonb_build_object('state', 'source_unavailable'));
      insert into ledger.terminal_records (trial_id, planned_trial_id, state, reason, event_seq)
        values (p_trial, v.planned_trial_id, 'source_unavailable', 'corpus transcript did not complete', v_seq);
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
-- Idempotent on (trial, idempotency_key). Source is derived: investigator for training, harness
-- for tournament trials. Voice questions use training.record_voice_question (arena_subject).
-- -----------------------------------------------------------------------------
create or replace function arena.submit_question(p_trial uuid, p_expected_version integer, p_question text,
                                                 p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v    arena.trials;
  v_t  arena.turns;
begin
  perform ledger.require_read_committed();
  v := arena._lock_trial(p_trial);
  perform arena._check_caller(v.kind, v.owner_user_id);
  select * into v_t from arena.turns where trial_id = p_trial and idempotency_key = p_idempotency_key;
  if found then
    if v_t.question is distinct from p_question then
      raise exception using errcode = 'AR003', message = 'idempotency key reused with a different question';
    end if;
    return jsonb_build_object('turn_no', v_t.turn_no, 'transcript_version', v_t.question_version);
  end if;
  if v.transcript_version <> p_expected_version then
    raise exception using errcode = 'AR002', message = format('stale transcript version %s (current %s)',
                                                               p_expected_version, v.transcript_version);
  end if;
  return arena._record_question(v, p_question, case v.kind when 'training' then 'investigator' else 'harness' end,
                                p_idempotency_key);
end $$;

-- -----------------------------------------------------------------------------
-- 1. release_evidence (arena_public)  SCN-4, SCN-10
-- Called after each question (also with an empty list, so scheduled releases apply) and before the
-- subject answers, so the answer is given in light of the released evidence. Releases every due
-- scheduled artifact plus each requested artifact whose request predicate holds, at most 6 per
-- trial, each once. Predicates read completed exchanges. Returns only newly released public
-- content; denied ids carry no reason.
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

  select coalesce(jsonb_agg(jsonb_build_object('record_id', a.record_id, 'kind', a.kind, 'title', a.title,
                                               'content', a.content, 'sha256', a.sha256)
                            order by a.record_id collate "C"), '[]'::jsonb),
         count(*)::integer
    into v_new, v_n_new
    from sealed.evidence_artifacts a
   where a.variant_id = v.variant_id
     and not exists (select 1 from arena.released_evidence r where r.trial_id = p_trial and r.record_id = a.record_id)
     and ((a.scheduled_turn is not null and a.scheduled_turn <= v.exchanges)
          or (a.requestable and a.record_id = any (v_req) and a.request_after_turn <= v.exchanges));
  select count(*)::integer into v_n_old from arena.released_evidence where trial_id = p_trial;
  if v_n_old + v_n_new > 6 then
    raise exception using errcode = 'AR006', message = 'release limit (6 per case) exceeded';
  end if;

  if v_n_new > 0 then
    update arena.trials set transcript_version = transcript_version + 1 where id = p_trial;
    v_seq := ledger.append_event('evidence_released', v.tournament_id, p_trial,
               jsonb_build_object('work_item_id', p_work_item, 'after_exchanges', v.exchanges,
                                  'records', (select jsonb_agg(jsonb_build_object('record_id', e ->> 'record_id',
                                                                                  'sha256', e ->> 'sha256'))
                                                from jsonb_array_elements(v_new) e)));
    insert into arena.released_evidence (trial_id, record_id, release_seq, released_after_exchanges, kind, title,
                                         content, content_sha256, event_seq)
      select p_trial, e.value ->> 'record_id', (v_n_old + e.ordinality)::smallint, v.exchanges, e.value ->> 'kind',
             e.value ->> 'title', e.value -> 'content', e.value ->> 'sha256', v_seq
        from jsonb_array_elements(v_new) with ordinality e;
    for v_art in select x from jsonb_array_elements(v_new) x loop
      perform arena._emit(v, case when v_art ->> 'kind' = 'clarification' then 'clarification' else 'evidence_released' end,
                          null, v_art - 'sha256');
    end loop;
  end if;

  v_result := jsonb_build_object(
    'released', (select coalesce(jsonb_agg(e - 'sha256'), '[]'::jsonb) from jsonb_array_elements(v_new) e),
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
-- the same transaction. p_partial marks a voice utterance interrupted before it was fully played.
-- -----------------------------------------------------------------------------
create or replace function arena.record_subject_turn(p_trial uuid, p_work_item uuid, p_utterance text,
                                                     p_tag_proposal jsonb, p_guard_result jsonb,
                                                     p_partial boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v       arena.trials;
  v_wi    arena.work_items;
  v_sha   text := ledger.hash_jsonb(jsonb_build_object('u', p_utterance, 't', p_tag_proposal, 'g', p_guard_result,
                                                       'p', coalesce(p_partial, false)));
  v_seq   bigint;
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
  if jsonb_typeof(p_guard_result -> 'passed') is distinct from 'boolean'
     or (p_tag_proposal is not null and jsonb_typeof(p_tag_proposal) <> 'object')
     or coalesce(length(p_utterance), 0) = 0 then
    raise exception using errcode = 'AR007', message = 'utterance, tag proposal object and guard_result.passed are required';
  end if;

  if (p_guard_result ->> 'passed')::boolean then
    update arena.turns set answer = p_utterance, answer_partial = coalesce(p_partial, false), answered_at = now()
     where trial_id = p_trial and turn_no = v_wi.turn_no;
    update arena.trials set exchanges = exchanges + 1, transcript_version = transcript_version + 1,
                            coaching_pending = (assistant_candidate_id is not null)
     where id = p_trial;
    if p_tag_proposal is not null then
      insert into sealed.subject_tag_proposals (trial_id, turn_no, tag) values (p_trial, v_wi.turn_no, p_tag_proposal);
    end if;
    perform arena._emit(v, 'subject_turn', null,
      jsonb_build_object('turn_no', v_wi.turn_no, 'answer', p_utterance, 'partial', coalesce(p_partial, false)));
    perform ledger.append_event('subject_answered', v.tournament_id, p_trial,
      jsonb_build_object('turn_no', v_wi.turn_no, 'answer_sha256', ledger.hash_text(p_utterance)));
    v_res := jsonb_build_object('outcome', 'recorded', 'turn_no', v_wi.turn_no,
                                'transcript_version', v.transcript_version + 1);
  else
    insert into sealed.quarantined_artifacts (trial_id, turn_no, utterance, tag, guard_result)
      values (p_trial, v_wi.turn_no, p_utterance, p_tag_proposal, p_guard_result);
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
-- discarded by the caller. coach_card and coach_unavailable end the turn in progress and write the
-- KPI-4 server segment (subject_turn commit to this commit, both clock_timestamp()).
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
  v_ans   timestamptz;
  v_now   timestamptz;
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
    select max(e.created_at) into v_ans from arena.trial_events e where e.trial_id = p_trial and e.kind = 'subject_turn';
    select created_at into v_now from arena.trial_events where trial_id = p_trial and seq = v_seq;
    if v_ans is not null and v.kind <> 'replay' then
      insert into ops.latency_samples (trial_id, turn_no, server_ms, miss)
        values (p_trial, v_wi.turn_no, (extract(epoch from (v_now - v_ans)) * 1000)::integer, p_kind = 'coach_unavailable')
        on conflict (trial_id, turn_no) do nothing;
    end if;
  end if;
  return arena._complete_work_item(p_work_item, v_sha, jsonb_build_object('seq', v_seq));
end $$;

-- -----------------------------------------------------------------------------
-- Commitment payload, computed only from stored rows (BKO-9). Used by finalize and verify.
-- -----------------------------------------------------------------------------
create or replace function ledger.commitment_payload(p_trial uuid, p_finding jsonb)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (
    select tr.*, case when tr.kind = 'replay' then tr.source_trial_id else tr.id end as src
      from arena.trials tr where tr.id = p_trial
  )
  select jsonb_build_object(
    'trial', t.id,
    'kind', t.kind,
    'transcript_sha256', ledger.hash_jsonb(coalesce((
        select jsonb_agg(jsonb_build_object('turn', u.turn_no, 'q', u.question, 'a', u.answer, 'partial', u.answer_partial)
                         order by u.turn_no)
          from arena.turns u where u.trial_id = t.src), '[]'::jsonb)),
    'evidence_sha256', ledger.hash_jsonb(coalesce((
        select jsonb_agg(jsonb_build_object('record', r.record_id, 'seq', r.release_seq,
                                            'after', r.released_after_exchanges, 'sha256', r.content_sha256)
                         order by r.release_seq)
          from arena.released_evidence r where r.trial_id = t.src), '[]'::jsonb)),
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
  from t
$$;

-- -----------------------------------------------------------------------------
-- 3. finalize_trial (arena_public)  BKO-9, SOL-5
-- Freezes the execution artifacts and writes the commitment, the sealed nonce and the
-- execution record `completed` in one transaction.
-- -----------------------------------------------------------------------------
create or replace function arena.finalize_trial(p_trial uuid, p_work_item uuid, p_final_finding jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v        arena.trials;
  v_wi     arena.work_items;
  v_sha    text := ledger.hash_jsonb(p_final_finding);
  v_len    integer;
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
  select count(*) into v_len from arena.turns
   where trial_id = case when v.kind = 'replay' then v.source_trial_id else p_trial end;
  if v_len = 0 then
    raise exception using errcode = 'AR001', message = 'nothing to finalize: the transcript is empty';
  end if;
  if v.kind = 'replay_corpus' then
    if p_final_finding is not null then
      raise exception using errcode = 'AR007', message = 'a corpus transcript carries no finding';
    end if;
  elsif jsonb_typeof(p_final_finding) is distinct from 'object'
        or coalesce(p_final_finding ->> 'classification', '') not in ('deceptive', 'truthful', 'insufficient_evidence')
        or coalesce(length(p_final_finding ->> 'confidence'), 0) not between 1 and 40
        or jsonb_typeof(p_final_finding -> 'cited_turns') is distinct from 'array'
        or exists (select 1 from jsonb_array_elements(p_final_finding -> 'cited_turns') c
                    where jsonb_typeof(c) <> 'number' or (c #>> '{}')::numeric not between 1 and v_len) then
    raise exception using errcode = 'AR007',
      message = 'finding needs classification, confidence and cited_turns that exist in the transcript';
  end if;

  if p_final_finding is not null then
    insert into arena.final_findings (trial_id, classification, confidence, finding)
      values (p_trial, p_final_finding ->> 'classification', p_final_finding ->> 'confidence', p_final_finding);
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
create or replace function ledger.verify_commitment(p_trial uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select c.commitment_sha256 = encode(sha256(n.nonce || convert_to(p.payload::text, 'UTF8')), 'hex')
           and c.payload = p.payload
      from ledger.finding_commitments c
      join sealed.commitment_nonces n on n.trial_id = c.trial_id
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
                                                      p_idempotency_key text)
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
    if (v_prev.trial_id, v_prev.verdict, v_prev.reason, v_prev.evidence_ref)
       is not distinct from (p_trial, p_verdict, p_reason, p_evidence_ref) then
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
  insert into ledger.validity_adjudications (id, trial_id, verdict, reason, evidence_ref, idempotency_key, after_reveal, event_seq)
    values (v_id, p_trial, p_verdict, p_reason, p_evidence_ref, p_idempotency_key, v_tstat = 'revealed', v_seq);
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- Inclusion manifest (F14, F15; direction 7.1 table). One entry per planned trial.
-- assistant / subject: 'included' | 'included_as_insufficient' | 'excluded' | null (not applicable)
-- -----------------------------------------------------------------------------
create or replace function ledger.build_manifest(p_tournament uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with e as (
    select p.id as planned_trial_id, p.position, p.track, p.source_planned_trial_id, x.trial_id, x.attempt, x.state,
           (select a.id from ledger.validity_adjudications a where a.trial_id = x.trial_id
             order by a.adj_seq desc limit 1) as adjudication_id
      from arena.planned_trials p
      join ledger.planned_execution(p_tournament) x on x.planned_trial_id = p.id
  ), v as (
    select e.*, (select a.verdict from ledger.validity_adjudications a where a.id = e.adjudication_id) as verdict
      from e
  ), src as (
    -- corpus usable: completed and adjudicated valid
    select v.planned_trial_id, (v.state = 'completed' and v.verdict = 'valid') as usable from v where v.track = 'replay_corpus'
  ), rows as (
    select v.*,
      case
        when v.track = 'replay_corpus' then null
        when v.track = 'replay' and not coalesce((select s.usable from src s where s.planned_trial_id = v.source_planned_trial_id), false)
          then 'excluded'
        when v.state in ('infra_failed', 'budget_skipped', 'budget_truncated', 'source_unavailable', 'subject_quarantined') then 'excluded'
        when v.track = 'interactive' and v.verdict = 'subject_invalid' then 'excluded'
        when v.state = 'assistant_failed' then 'included_as_insufficient'
        when v.state = 'completed' then 'included'
      end as assistant,
      case
        when v.track = 'replay' then null
        when v.state in ('completed', 'assistant_failed', 'subject_quarantined') then 'included'
        else 'excluded'
      end as subject,
      case
        when v.track = 'replay' and not coalesce((select s.usable from src s where s.planned_trial_id = v.source_planned_trial_id), false)
          then 'source_transcript_invalid'
        when v.state in ('infra_failed', 'budget_skipped', 'budget_truncated', 'source_unavailable') then v.state
        when v.state = 'subject_quarantined' then 'subject_quarantined: counts against the subject'
        when v.verdict = 'subject_invalid' then 'subject_invalid: counts against the subject'
        when v.state = 'assistant_failed' then 'assistant_failed: counted as insufficient evidence'
        else 'included'
      end as reason
    from v
  )
  select jsonb_build_object(
    'tournament', p_tournament,
    'roster_sha256', (select roster_sha256 from arena.tournaments where id = p_tournament),
    'corpus_sha256', (select corpus_sha256 from ledger.corpus_seals where tournament_id = p_tournament),
    'hidden_seal_sha256', (select s.seal_sha256 from arena.tournaments t join sealed.hidden_split_seals s on s.id = t.hidden_seal_id
                            where t.id = p_tournament),
    'trials', coalesce(jsonb_agg(jsonb_build_object(
        'planned_trial_id', r.planned_trial_id, 'position', r.position, 'track', r.track, 'trial_id', r.trial_id,
        'attempt', r.attempt, 'execution_state', r.state, 'adjudication_id', r.adjudication_id, 'verdict', r.verdict,
        'assistant', r.assistant, 'subject', r.subject, 'reason', r.reason) order by r.position), '[]'::jsonb))
  from rows r
$$;

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
  select c.trial_id into v_bad from ledger.finding_commitments c join arena.trials t on t.id = c.trial_id
   where t.tournament_id = p_tournament and not ledger.verify_commitment(c.trial_id) limit 1;
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
  v_manifest jsonb;
  v_sha      text;
  v_id       uuid;
  v_seq      bigint;
begin
  perform ledger.require_read_committed();
  select status into v_status from arena.tournaments where id = p_tournament for update;
  if v_status = 'revealed' then
    select jsonb_build_object('manifest_id', id, 'manifest_sha256', manifest_sha256) into v_manifest
      from ledger.inclusion_manifests where tournament_id = p_tournament and version = 1;
    return v_manifest;
  end if;
  if v_status is distinct from 'scoring' then
    raise exception using errcode = 'AR020', message = 'reveal follows scoring (draft/frozen/running/sealed refused)';
  end if;
  perform ledger.check_reveal_preconditions(p_tournament);
  v_manifest := ledger.build_manifest(p_tournament);
  v_sha := ledger.hash_jsonb(v_manifest);
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
  v_manifest jsonb;
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
  v_sha := ledger.hash_jsonb(v_manifest);
  if v_sha = v_last.manifest_sha256 then
    return jsonb_build_object('manifest_id', v_last.id, 'manifest_sha256', v_sha, 'version', v_last.version);
  end if;
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
-- open coaching, finalize or release work item. Hidden public packets are reachable only here,
-- only while the trial runs (SCN-12). S5 builds PublicTrialView from this result.
create or replace function arena.trial_context(p_trial uuid, p_work_item uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v     arena.trials;
  v_wi  arena.work_items;
  v_src uuid;
begin
  select * into v from arena.trials where id = p_trial;
  select * into v_wi from arena.work_items where id = p_work_item;
  if v.id is null or v_wi.id is null or v_wi.trial_id <> p_trial or v_wi.status <> 'open'
     or v_wi.kind not in ('coaching', 'finalize', 'release') or v.status <> 'running' then
    raise exception using errcode = 'AR003', message = 'context needs an open coaching, finalize or release work item on a running trial';
  end if;
  perform arena._check_caller(v.kind, v.owner_user_id);
  v_src := case when v.kind = 'replay' then v.source_trial_id else v.id end;
  return jsonb_build_object(
    'trial_id', v.id, 'kind', v.kind, 'mode', v.mode, 'transcript_version', v.transcript_version,
    'exchanges', (select count(*) from arena.turns where trial_id = v_src and answer is not null),
    'max_exchanges', v.max_exchanges,
    'public_packet', coalesce((select packet from arena.public_packets where variant_id = v.variant_id),
                              (select packet from sealed.hidden_public_packets where variant_id = v.variant_id)),
    'transcript', coalesce((select jsonb_agg(jsonb_build_object('turn_no', turn_no, 'question', question, 'answer', answer,
                                                                'partial', answer_partial)
                                             order by turn_no) from arena.turns where trial_id = v_src), '[]'::jsonb),
    'released_evidence', coalesce((select jsonb_agg(jsonb_build_object('record_id', record_id, 'kind', kind, 'title', title,
                                                                       'content', content, 'after_exchanges', released_after_exchanges)
                                                    order by release_seq) from arena.released_evidence where trial_id = v_src), '[]'::jsonb),
    'coaching', coalesce((select jsonb_agg(jsonb_build_object('seq', seq, 'kind', kind, 'turn_no', turn_no, 'card', payload)
                                           order by seq)
                            from arena.trial_events where trial_id = v.id
                             and kind in ('coach_card', 'coach_deep', 'coach_unavailable')), '[]'::jsonb),
    'assistant_manifest', (select manifest from arena.candidates where id = v.assistant_candidate_id));
end $$;

-- turn_context (arena_subject): the private packet plus the public transcript, for one open
-- subject_answer work item at the current version. arena_subject holds no table privileges.
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
  return jsonb_build_object(
    'trial_id', v.id, 'turn_no', v_wi.turn_no, 'transcript_version', v.transcript_version,
    'private_packet', (select packet from subject.private_packets where variant_id = v.variant_id),
    'public_packet', coalesce((select packet from arena.public_packets where variant_id = v.variant_id),
                              (select packet from sealed.hidden_public_packets where variant_id = v.variant_id)),
    'transcript', coalesce((select jsonb_agg(jsonb_build_object('turn_no', turn_no, 'question', question, 'answer', answer)
                                             order by turn_no) from arena.turns where trial_id = v.id), '[]'::jsonb),
    'released_evidence', coalesce((select jsonb_agg(jsonb_build_object('record_id', record_id, 'kind', kind, 'title', title,
                                                                       'content', content) order by release_seq)
                                     from arena.released_evidence where trial_id = v.id), '[]'::jsonb),
    'subject_manifest', (select manifest from arena.candidates where id = v.subject_candidate_id));
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
create view arena.v_dev_cases with (security_barrier = true) as
  select v.id as variant_id, f.family_code, f.domain, v.variant_code, v.style, v.difficulty, p.packet as public_packet
    from arena.case_variants v join arena.case_families f on f.id = v.family_id
    join arena.public_packets p on p.variant_id = v.id
   where f.split = 'dev';

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
  select u.trial_id, u.turn_no, u.question, u.question_source, u.asked_at, u.answer, u.answer_partial, u.answered_at
    from arena.turns u where arena.trial_visible(u.trial_id);

create view arena.v_released_evidence with (security_barrier = true) as
  select r.trial_id, r.record_id, r.release_seq, r.released_after_exchanges, r.kind, r.title, r.content, r.released_at
    from arena.released_evidence r where arena.trial_visible(r.trial_id);

-- debriefs and exports: assessment coaching (debrief rows) stays hidden until the trial ends (SOL-6)
create view arena.v_trial_events with (security_barrier = true) as
  select e.trial_id, e.seq, e.kind, e.visibility, e.transcript_version, e.turn_no, e.candidate_id, e.payload, e.created_at
    from arena.trial_events e join arena.trials t on t.id = e.trial_id
   where arena.trial_visible(e.trial_id) and not (e.visibility = 'debrief' and t.status = 'running');

create view arena.v_findings with (security_barrier = true) as
  select f.trial_id, f.classification, f.confidence, f.finding, f.committed_at
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

-- commitments are public from finalization (that is their purpose); payloads once visible
create view ledger.v_commitments with (security_barrier = true) as
  select c.trial_id, c.commitment_sha256, c.created_at,
         case when arena.trial_visible(c.trial_id) then c.payload end as payload,
         case when arena.trial_visible(c.trial_id) then c.payload::text end as payload_text
    from ledger.finding_commitments c;

create view ledger.v_revealed_nonces with (security_barrier = true) as
  select trial_id, nonce_hex, revealed_at from ledger.revealed_nonces;

create view ledger.v_manifests with (security_barrier = true) as
  select id, tournament_id, version, manifest, manifest_sha256, supersedes_id, created_at from ledger.inclusion_manifests;

create view ledger.v_adjudications with (security_barrier = true) as
  select a.id, a.trial_id, a.verdict, a.reason, a.after_reveal, a.created_at
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
  arena.open_work_item(uuid, text),
  arena.start_trial(uuid),
  arena.retry_trial(uuid),
  arena.submit_question(uuid, integer, text, text),
  arena.release_evidence(uuid, uuid, text[]),
  arena.record_coaching_event(uuid, uuid, jsonb, text),
  arena.finalize_trial(uuid, uuid, jsonb),
  arena.record_execution_failure(uuid, uuid, text, text),
  arena.trial_context(uuid, uuid),
  arena.events_after(uuid, integer, integer)
  to arena_public;
grant select on arena.v_dev_cases, arena.v_candidates, arena.v_tournaments, arena.v_planned_trials, arena.v_trials,
  arena.v_transcripts, arena.v_released_evidence, arena.v_trial_events, arena.v_findings, arena.v_scores,
  arena.v_leaderboards, ledger.v_events, ledger.v_commitments, ledger.v_revealed_nonces, ledger.v_manifests,
  ledger.v_adjudications, ledger.v_corpus_seals
  to arena_public;

-- arena_subject: two functions here, no tables
grant usage on schema arena, subject to arena_subject;
grant execute on function arena.record_subject_turn(uuid, uuid, text, jsonb, jsonb, boolean), subject.turn_context(uuid, uuid)
  to arena_subject;

-- arena_referee: reads every tier, its own inserts, lifecycle and the two referee privileged functions
grant usage on schema arena, subject, sealed, ledger to arena_referee;
grant select on all tables in schema arena, subject, sealed, ledger to arena_referee;
grant insert on sealed.independent_labels, sealed.judgments, arena.scores, arena.leaderboards, arena.isolation_checks
  to arena_referee;
grant execute on function
  ledger.hash_text(text),
  ledger.hash_jsonb(jsonb),
  sealed.ingest_case_family(jsonb), sealed.seal_hidden_split(), sealed.verify_hidden_seal(), sealed.hidden_split_digest(),
  arena.register_candidate(text, text, text, jsonb),
  arena.create_tournament(text, text, bigint, text, smallint), arena.add_planned_trials(uuid, jsonb),
  arena.freeze_tournament(uuid), arena.open_tournament(uuid), ledger.seal_replay_corpus(uuid),
  arena.close_tournament_run(uuid), arena.begin_scoring(uuid),
  ledger.verify_chain(), ledger.planned_execution(uuid), ledger.corpus_digest(uuid), arena.roster_digest(uuid),
  ledger.adjudicate_validity(uuid, text, text, text, text),
  ledger.reveal(uuid),
  ledger.seal_corrected_manifest(uuid),
  ledger.build_manifest(uuid),
  ledger.verify_commitment(uuid)
  to arena_referee;
