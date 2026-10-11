-- WP-14: referee calls, label pipeline, adjudication queue (S2 7.2-7.3, S3 1.3, 3.8, 4.2; S4 4.2, 4.4).
--
-- `arena_referee` already holds SELECT on every table of arena, subject, sealed, ledger, training and ops
-- (migrations 0003-0006), INSERT on sealed.independent_labels and sealed.judgments, and EXECUTE on
-- ledger.adjudicate_validity and training.publish_debrief. This migration adds only what those grants do not
-- already cover: two small write functions that make the two insert paths atomic and idempotent (a bare
-- INSERT would let a retried call race or silently duplicate a row), and the blinded trainer review queue
-- (S3 7.3), which is new storage with no existing table.
--
-- Every new function follows 6.1's contract: SECURITY DEFINER, `set search_path = ''`, schema-qualified names,
-- EXECUTE revoked from PUBLIC then granted to exactly `arena_referee`.

-- -----------------------------------------------------------------------------
-- sealed.record_independent_labels: one call's whole per-turn label set (R1's or R3's `r3_subject` labeler
-- 'model'; a human consensus row would use 'human_consensus', written by the same function once WP-25
-- computes one). Idempotent on (trial, labeler): a retry with the exact same rows returns 'exists'; different
-- content for an already-recorded (trial, labeler) is a defect (AR003), never a silent overwrite (the table
-- is append-only, SG2-08). p_rows: jsonb array of {turn_no, label, compliant, rationale}, one per subject turn;
-- an empty array is valid (S2 6.10: no answer to label when the first turn was quarantined).
-- -----------------------------------------------------------------------------
create or replace function sealed.record_independent_labels(p_trial uuid, p_labeler text, p_rows jsonb,
                                                             p_prompt_sha256 text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_existing jsonb;
  v_new      jsonb;
begin
  perform ledger.require_read_committed();
  if p_labeler not in ('model', 'human_consensus') then
    raise exception using errcode = 'AR007', message = 'labeler is model or human_consensus';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception using errcode = 'AR007', message = 'rows must be a jsonb array';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('turn_no', turn_no, 'label', label, 'compliant', compliant,
                                               'rationale', rationale) order by turn_no), '[]'::jsonb)
    into v_existing from sealed.independent_labels where trial_id = p_trial and labeler = p_labeler;
  select coalesce(jsonb_agg(jsonb_build_object('turn_no', (r ->> 'turn_no')::int, 'label', r ->> 'label',
                                               'compliant', (r ->> 'compliant')::boolean, 'rationale', r ->> 'rationale')
                            order by (r ->> 'turn_no')::int), '[]'::jsonb)
    into v_new from jsonb_array_elements(p_rows) r;
  if v_existing <> '[]'::jsonb then
    if v_existing = v_new then
      return jsonb_build_object('outcome', 'exists', 'count', jsonb_array_length(v_existing));
    end if;
    raise exception using errcode = 'AR003',
      message = 'independent labels already recorded for this trial and labeler with different content';
  end if;
  insert into sealed.independent_labels (trial_id, turn_no, labeler, label, compliant, rationale, prompt_sha256)
    select p_trial, (r ->> 'turn_no')::smallint, p_labeler, r ->> 'label', (r ->> 'compliant')::boolean,
           r ->> 'rationale', p_prompt_sha256
      from jsonb_array_elements(p_rows) r;
  return jsonb_build_object('outcome', 'recorded', 'count', jsonb_array_length(p_rows));
end $$;
revoke all on function sealed.record_independent_labels(uuid, text, jsonb, text) from public;
grant execute on function sealed.record_independent_labels(uuid, text, jsonb, text) to arena_referee;

-- -----------------------------------------------------------------------------
-- sealed.record_judgment: one sealed.judgments row (R1's full report as `fidelity_detail`, R2's two reports as
-- `flag_support` and `questioning_quality`, or one human rater's `calibration` rating), idempotent by stage key
-- exactly as `ledger.adjudicate_validity` is (S2 7.1: "<trial>:r1", "<trial>:r2:flag_support", a review item's
-- "<item>:<rater>" for calibration). The table's own CHECK enforces rater_id present iff kind = 'calibration'.
-- -----------------------------------------------------------------------------
create or replace function sealed.record_judgment(p_trial uuid, p_kind text, p_rater_id text, p_payload jsonb,
                                                   p_prompt_sha256 text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v sealed.judgments;
begin
  perform ledger.require_read_committed();
  select * into v from sealed.judgments where idempotency_key = p_idempotency_key;
  if found then
    if (v.trial_id, v.kind, v.rater_id, v.payload) is not distinct from (p_trial, p_kind, p_rater_id, p_payload) then
      return jsonb_build_object('outcome', 'exists', 'id', v.id);
    end if;
    raise exception using errcode = 'AR003', message = 'idempotency key reused with a different judgment';
  end if;
  insert into sealed.judgments (trial_id, kind, rater_id, payload, prompt_sha256, idempotency_key)
    values (p_trial, p_kind, p_rater_id, p_payload, p_prompt_sha256, p_idempotency_key)
    returning * into v;
  return jsonb_build_object('outcome', 'recorded', 'id', v.id);
end $$;
revoke all on function sealed.record_judgment(uuid, text, text, jsonb, text, text) from public;
grant execute on function sealed.record_judgment(uuid, text, text, jsonb, text, text) to arena_referee;

-- -----------------------------------------------------------------------------
-- Blinded trainer review queue (S3 7.2-7.3; SG4-09, SG4-11). One item per rating task: T-RUB (instrument
-- C-RUB or C-QQ), T-LAB (C-LAB) or T-FLAG. `payload` is the exact `ReviewItem` the trainer console renders
-- (contracts/review.py: RubricItem, LabelItem or FlagItem) -- case content only, no role, outcome, candidate
-- or participant identity (S3 7.3). `context_trial_id` and `context_session_id` are never projected to the
-- API: they let `submit_review_item` write the rating back to `sealed.judgments` without the rater ever
-- seeing which trial or session produced the item. A row is written once and its submission once (append
-- shape below); nothing here is deleted.
-- -----------------------------------------------------------------------------
create table training.review_items (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('T-RUB', 'T-LAB', 'T-FLAG')),
  instrument          text check (instrument in ('C-RUB', 'C-QQ')),
  rater_user_id       uuid not null references auth.users(id) on delete restrict,
  context_trial_id    uuid not null references arena.trials(id) on delete restrict,
  context_session_id  uuid references training.sessions(id) on delete restrict,
  payload             jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  submission          jsonb,
  submitted_at        timestamptz,
  created_at          timestamptz not null default now(),
  constraint review_item_instrument_shape check ((kind = 'T-RUB') = (instrument is not null)),
  constraint review_item_submission_shape check ((submission is null) = (submitted_at is null))
);
create index review_items_rater_idx on training.review_items (rater_user_id, created_at);
alter table training.review_items enable row level security;

-- Append-only except the one submission transition (null -> set); never deleted.
create or replace function training.tg_review_item_submit_once() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'AR010', message = 'training.review_items is append-only (DELETE refused)';
  end if;
  if old.submission is not null
     or (to_jsonb(new) - array['submission', 'submitted_at'])
        is distinct from (to_jsonb(old) - array['submission', 'submitted_at']) then
    raise exception using errcode = 'AR010', message = 'a review item''s task is immutable and its submission is written once';
  end if;
  return new;
end $$;
create trigger review_items_submit_once before update or delete on training.review_items
  for each row execute function training.tg_review_item_submit_once();

-- create_review_item (arena_referee): the sampler (WP-25) or an operator script assigns one task to one
-- rater. p_context_session is null for a T-RUB item rating a tournament trial's replay-track QQ (instrument
-- C-QQ) rather than a training session's investigator score (instrument C-RUB).
create or replace function training.create_review_item(p_kind text, p_instrument text, p_rater_user_id uuid,
                                                        p_context_trial uuid, p_context_session uuid, p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform ledger.require_read_committed();
  if p_kind not in ('T-RUB', 'T-LAB', 'T-FLAG') then
    raise exception using errcode = 'AR007', message = 'kind is T-RUB, T-LAB or T-FLAG';
  end if;
  if p_rater_user_id is null or p_context_trial is null or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception using errcode = 'AR007', message = 'a review item needs a rater, a context trial and an object payload';
  end if;
  insert into training.review_items (kind, instrument, rater_user_id, context_trial_id, context_session_id, payload)
    values (p_kind, p_instrument, p_rater_user_id, p_context_trial, p_context_session, p_payload)
    returning id into v_id;
  return v_id;
end $$;
revoke all on function training.create_review_item(text, text, uuid, uuid, uuid, jsonb) from public;
grant execute on function training.create_review_item(text, text, uuid, uuid, uuid, jsonb) to arena_referee;

-- list_review_items (arena_referee): `GET /api/review/items` (S3 7.3, ReviewList: item_id, task, submitted).
create or replace function training.list_review_items(p_rater_user_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('item_id', id, 'task', kind, 'submitted', submitted_at is not null)
                            order by created_at), '[]'::jsonb)
    from training.review_items where rater_user_id = p_rater_user_id
$$;
revoke all on function training.list_review_items(uuid) from public;
grant execute on function training.list_review_items(uuid) to arena_referee;

-- get_review_item (arena_referee): `GET /api/review/items/{id}`, the stored payload; null for an item not
-- assigned to this rater (no existence oracle for someone else's item, AR040 at the route).
create or replace function training.get_review_item(p_item uuid, p_rater_user_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select payload from training.review_items where id = p_item and rater_user_id = p_rater_user_id
$$;
revoke all on function training.get_review_item(uuid, uuid) from public;
grant execute on function training.get_review_item(uuid, uuid) to arena_referee;

-- submit_review_item (arena_referee): `POST /api/review/items/{id}` (idempotent per item and rater). The
-- caller validates the submission against the task's typed schema (contracts/review.py) before calling this;
-- the function stores it once and, in the same transaction, writes the rater's calibration judgment
-- (sealed.judgments, kind 'calibration', rater_id = the rater's user id, stage key "<item>:<rater>").
create or replace function training.submit_review_item(p_item uuid, p_rater_user_id uuid, p_submission jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v        training.review_items;
  v_judge  jsonb;
begin
  perform ledger.require_read_committed();
  select * into v from training.review_items where id = p_item and rater_user_id = p_rater_user_id for update;
  if v.id is null then
    raise exception using errcode = 'AR040', message = 'review item refused';
  end if;
  if v.submission is not null then
    if v.submission = p_submission then
      return jsonb_build_object('outcome', 'exists');
    end if;
    raise exception using errcode = 'AR003', message = 'this item was already submitted with different content';
  end if;
  update training.review_items set submission = p_submission, submitted_at = now() where id = p_item;
  v_judge := sealed.record_judgment(v.context_trial_id, 'calibration', p_rater_user_id::text, p_submission, null,
                                    p_item::text || ':' || p_rater_user_id::text);
  return jsonb_build_object('outcome', 'recorded', 'judgment', v_judge);
end $$;
revoke all on function training.submit_review_item(uuid, uuid, jsonb) from public;
grant execute on function training.submit_review_item(uuid, uuid, jsonb) to arena_referee;
