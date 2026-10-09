-- 1000 finding contract (S2 4.8, S5 5.4; WP-02). Not a draft port: one defect the WP-02 Codex gate found where the
-- v2.7 draft (docs/spec/sql/0004_privileged_functions.sql, arena.finalize_trial) disagrees with S2 4.8, proposed for
-- the spec's next revision. The function is the draft's body with the marked change; `create or replace` keeps its
-- grants (capability fixture unchanged).
--   Fix 1: S2 4.8 stores one finding object whose `alternative_explanations` is null unless the form collects it
--          (investigators) and null on card and deep findings; the shared contract (arena_core.contracts.findings
--          StoredFinding) always carries the key. The draft accepted the key only as an array, so every investigator
--          commit without alternatives was refused with AR007. It now accepts an array or null.
-- Gates: supabase/tests/016_finding.sql FN-01, FN-02; packages/core/tests/contracts/test_finding_sql.py.

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
        -- Fix 1: null is the stored finding's "no alternatives" (S2 4.8; contracts StoredFinding)
        or (p_final_finding ? 'alternative_explanations'
            and jsonb_typeof(p_final_finding -> 'alternative_explanations') not in ('array', 'null'))
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
