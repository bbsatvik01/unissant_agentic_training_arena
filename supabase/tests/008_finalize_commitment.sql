-- 008_finalize_commitment.sql (sql/TESTS.md section 8; BKO-9, SOL-5, EVL-9; WP-04a).
begin;
\ir harness/fixtures.psql
select plan(24);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

create temp table fc on commit drop as select tests.family('FCDEV', 'dev') as id;
create temp table fctour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table fct on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fctour), 3)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from fct), 'Why did you enter room 4?', '{}', 'A busy shift.');
select tests.exchange((select trial from fct), 'Which task needed entry?', array['rec-01'], 'The HVAC ticket.');
create temp table fc_finding on commit drop as select
  '{"label": "insufficient_evidence", "likelihood": "roughly_even_chance", "confidence": "low", "basis_flag_refs": [],
    "cited_turns": [2], "cited_records": ["rec-01"], "corroboration_needed": [], "rationale": "Not established yet."}'::jsonb as f;

-- ---------------------------------------------------------------------------- FC-01
create temp table fc01wi on commit drop as
  select (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from fct),
            'finalize', tests.k((select trial from fct), 1, 'finalize', 'done'))) ->> 'work_item_id')::uuid as wi;
create temp table fc01 on commit drop as
  select arena.finalize_trial((select trial from fct), (select wi from fc01wi), (select f from fc_finding)) as r;
select is(array[
    (select (r ? 'commitment_sha256' and r ? 'payload_sha256') from fc01)::text,
    (select count(*)::text from arena.final_findings where trial_id = (select trial from fct)),
    (select (octet_length(nonce) = 32)::text from sealed.commitment_nonces where trial_id = (select trial from fct)),
    (select count(*)::text from ledger.finding_commitments where trial_id = (select trial from fct)),
    (select state from ledger.terminal_records where trial_id = (select trial from fct)),
    (select status from arena.trials where id = (select trial from fct)),
    (select count(*)::text from arena.trial_events where trial_id = (select trial from fct) and kind = 'trial_ended')],
          array['true', '1', 'true', '1', 'completed', 'finalized', '1'],
  'FC-01 finalize returns commitment_sha256 and payload_sha256; writes final_findings, a 32-byte nonce, one '
  || 'finding_commitments row, terminal completed, finalized status, and one trial_ended event');

-- ---------------------------------------------------------------------------- FC-02, FC-03
select is(
  arena.finalize_trial((select trial from fct), (select wi from fc01wi), (select f from fc_finding)),
  (select r from fc01), 'FC-02 a duplicate work item with the same finding returns the same result');
select tests.throws(
  format('select arena.finalize_trial(%L, %L, %L::jsonb)', (select trial from fct), (select wi from fc01wi),
         (select f || '{"rationale": "Different."}'::jsonb from fc_finding)),
  'AR003', 'reused with different input', 'FC-03 a duplicate work item with a different finding is refused (AR003)');

-- ---------------------------------------------------------------------------- FC-04
create temp table fc04t on commit drop as
  select tests.family('FC04DEV', 'dev') as fam;
create temp table fc04tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table fc04tr on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fc04tour), 3)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from fc04tr), 'Why did you enter room 4?', '{}', 'A busy shift.');
select tests.exchange((select trial from fc04tr), 'Which task needed entry?', array['rec-01'], 'The HVAC ticket.');
create or replace function pg_temp.fc04_finalize(p_finding jsonb) returns text
language sql as $$
  select tests.error(format('select arena.finalize_trial(%L, %L, %L::jsonb)', (select trial from fc04tr),
    (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from fc04tr), 'finalize',
       tests.h(p_finding::text))) ->> 'work_item_id'), p_finding))
$$;
select is(array[
    pg_temp.fc04_finalize((select f - 'label' from fc_finding)),
    pg_temp.fc04_finalize((select jsonb_set(f, '{label}', '"classification"') from fc_finding)),
    pg_temp.fc04_finalize((select jsonb_set(f, '{likelihood}', '"maybe"') from fc_finding)),
    pg_temp.fc04_finalize((select jsonb_set(f, '{confidence}', '"medium"') from fc_finding)),
    pg_temp.fc04_finalize((select jsonb_set(f, '{cited_turns}', '[9]') from fc_finding)),
    pg_temp.fc04_finalize((select jsonb_set(f, '{cited_turns}', '["one"]') from fc_finding)),
    pg_temp.fc04_finalize((select f - 'cited_records' from fc_finding)),
    pg_temp.fc04_finalize((select jsonb_set(f, '{cited_records}', '["rec-99"]') from fc_finding))],
  array['AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records'],
  'FC-04 (C-27): a missing/invalid label, likelihood, or confidence; a cited turn beyond the transcript or '
  || 'non-numeric; and missing or unreleased cited_records are each refused (AR007)');

-- ---------------------------------------------------------------------------- FC-05
select arena.submit_question((select trial from fc04tr), (select transcript_version from arena.trials where id = (select trial from fc04tr)),
         'An open question', tests.k((select trial from fc04tr), 2, 'question', 'harness_fixed'), 'harness_fixed');
select tests.throws(
  format('select arena.finalize_trial(%L, %L, %L::jsonb)', (select trial from fc04tr),
         (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from fc04tr), 'finalize',
            tests.k((select trial from fc04tr), 2, 'finalize', 'open-q'))) ->> 'work_item_id'), (select f from fc_finding)),
  'AR004', 'open question must be answered', 'FC-05 finalize over an open (unanswered) question is refused (AR004)');

-- ---------------------------------------------------------------------------- FC-06
create temp table fccorpus on commit drop as select tests.tournament('dev', array['replay_corpus']) as tour;
create temp table fcct on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fccorpus), 1)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from fcct), 0, 'Question 1',
         tests.k((select trial from fcct), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select trial from fcct),
         (arena.open_work_item((select trial from fcct), 'subject_answer',
            tests.k((select trial from fcct), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
create temp table fc06 on commit drop as select tests.family('FC06DEV', 'dev') as id;
create temp table fc06tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table fc06tr on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fc06tour), 3)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from fc06tr), 'Why did you enter room 4?', '{}', 'A busy shift.');
select is(array[
    tests.error(format('select arena.finalize_trial(%L, %L, %L::jsonb)', (select trial from fcct),
      (arena.open_work_item((select trial from fcct), 'finalize', tests.k((select trial from fcct), 1, 'finalize', 'corpus-finding'))
        ->> 'work_item_id'), (select f from fc_finding))),
    tests.error(format('select arena.finalize_trial(%L, %L, null)', (select trial from fc06tr),
      (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from fc06tr), 'finalize',
         tests.k((select trial from fc06tr), 1, 'finalize', 'no-finding'))) ->> 'work_item_id')))],
  array['AR007: a corpus transcript carries no finding', 'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records'],
  'FC-06 a corpus transcript finalized with a finding, and an interview finalized without one, are each refused (AR007)');

-- ---------------------------------------------------------------------------- FC-07
select is(ledger.verify_commitment((select trial from fct)), true, 'FC-07 verify_commitment holds right after finalization');
do $$
declare
  v_nonce   bytea;
  v_payload jsonb;
begin
  alter table arena.final_findings disable trigger final_findings_append_only;
  alter table ledger.finding_commitments disable trigger finding_commitments_append_only;
  update arena.final_findings set finding = finding || '{"rationale": "Tampered."}'::jsonb
   where trial_id = (select trial from fct);
  v_payload := ledger.commitment_payload((select trial from fct),
                 (select finding from arena.final_findings where trial_id = (select trial from fct)));
  select nonce into v_nonce from sealed.commitment_nonces where trial_id = (select trial from fct);
  -- payload AND commitment_sha256 are both recomputed to match the tampered finding: otherwise the stale
  -- commitment_sha256 alone would make verify_commitment false, masking whether the ledger event's own
  -- embedded commitment_sha256 (SG3-42's cross-check, still stale here) is actually what is being tested.
  update ledger.finding_commitments set payload = v_payload,
         commitment_sha256 = encode(sha256(v_nonce || convert_to(v_payload::text, 'UTF8')), 'hex')
   where trial_id = (select trial from fct);
  alter table ledger.finding_commitments enable trigger finding_commitments_append_only;
  alter table arena.final_findings enable trigger final_findings_append_only;
end $$;
select is(ledger.verify_commitment((select trial from fct)), false,
  'FC-07 SG3-42: after the finding changes with the commitment row recomputed to match, the ledger event no '
  || 'longer matches the recomputed commitment, so verify_commitment is false');
do $$
begin
  alter table arena.final_findings disable trigger final_findings_append_only;
  update arena.final_findings set finding = (select f from fc_finding) where trial_id = (select trial from fct);
  alter table arena.final_findings enable trigger final_findings_append_only;
  alter table ledger.finding_commitments disable trigger finding_commitments_append_only;
  delete from ledger.finding_commitments where trial_id = (select trial from fct);
  alter table ledger.finding_commitments enable trigger finding_commitments_append_only;
end $$;
select is(ledger.verify_commitment((select trial from fct)), false,
  'FC-07 SG3-47: after the commitment row is deleted, verify_commitment is false (RV-06, file 012, checks the '
  || 'tournament-scoped reveal population this feeds; this restores the row next)');
do $$
declare
  v_payload jsonb := ledger.commitment_payload((select trial from fct), (select f from fc_finding));
  v_nonce bytea;
  v_commit text;
begin
  select nonce into v_nonce from sealed.commitment_nonces where trial_id = (select trial from fct);
  v_commit := encode(sha256(v_nonce || convert_to(v_payload::text, 'UTF8')), 'hex');
  insert into ledger.finding_commitments (trial_id, payload, payload_sha256, commitment_sha256, event_seq)
    select (select trial from fct), v_payload, ledger.hash_jsonb(v_payload), v_commit, e.seq
      from ledger.events e where e.trial_id = (select trial from fct) and e.event_type = 'trial_finalized';
end $$;
select is(ledger.verify_commitment((select trial from fct)), true, 'FC-07 restored: verify_commitment holds again');

-- ---------------------------------------------------------------------------- FC-08, FC-09, FC-10
do $$
begin
  alter table arena.turns disable trigger turns_answer_once;
  alter table arena.turns disable trigger turns_running;
  update arena.turns set answer = 'Tampered answer' where trial_id = (select trial from fct) and turn_no = 1;
  alter table arena.turns enable trigger turns_answer_once;
  alter table arena.turns enable trigger turns_running;
end $$;
select is(ledger.verify_commitment((select trial from fct)), false, 'FC-08 a tampered answer (trigger disabled) makes verify_commitment false');
do $$
begin
  alter table arena.turns disable trigger turns_answer_once;
  alter table arena.turns disable trigger turns_running;
  update arena.turns set answer = 'A busy shift.' where trial_id = (select trial from fct) and turn_no = 1;
  alter table arena.turns enable trigger turns_answer_once;
  alter table arena.turns enable trigger turns_running;
  alter table arena.final_findings disable trigger final_findings_append_only;
  update arena.final_findings set finding = finding || '{"rationale": "Edited finding."}'::jsonb
   where trial_id = (select trial from fct);
end $$;
select is(ledger.verify_commitment((select trial from fct)), false, 'FC-09 an edited stored finding makes verify_commitment false');
do $$
begin
  update arena.final_findings set finding = (select f from fc_finding) where trial_id = (select trial from fct);
  alter table arena.final_findings enable trigger final_findings_append_only;
  alter table arena.trial_events disable trigger trial_events_append_only;
  update arena.trial_events set payload = jsonb_build_object('card', 'tampered')
   where trial_id = (select trial from fct) and kind = 'coach_card' and turn_no = 2;
  alter table arena.trial_events enable trigger trial_events_append_only;
end $$;
select is(ledger.verify_commitment((select trial from fct)), false, 'FC-10 an edited coach event payload makes verify_commitment false');
do $$
begin
  alter table arena.trial_events disable trigger trial_events_append_only;
  update arena.trial_events set payload = jsonb_build_object('card', 'fixture', 'turn_no', 2)
   where trial_id = (select trial from fct) and kind = 'coach_card' and turn_no = 2;
  alter table arena.trial_events enable trigger trial_events_append_only;
end $$;

-- ---------------------------------------------------------------------------- FC-11
select is(
  (select encode(sha256(n.nonce || convert_to(c.payload::text, 'UTF8')), 'hex')
     from sealed.commitment_nonces n, ledger.finding_commitments c
    where n.trial_id = (select trial from fct) and c.trial_id = (select trial from fct)),
  (select commitment_sha256 from ledger.finding_commitments where trial_id = (select trial from fct)),
  'FC-11 sha256(nonce || payload::text), recomputed in the test, equals the stored commitment');

-- ---------------------------------------------------------------------------- FC-12
create temp table fc12a on commit drop as select tests.family('FC12DEV', 'dev') as id;
create temp table fc12tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table fc12t1 on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fc12tour), 3)))) ->> 'trial_id')::uuid as trial;
create temp table fc12t2 on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fc12tour), 4)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from fc12t1), 'Why did you enter room 4?', '{}', 'A busy shift.');
select tests.exchange((select trial from fc12t2), 'Why did you enter room 4?', '{}', 'A busy shift.');
create temp table fc12r1 on commit drop as
  select arena.finalize_trial((select trial from fc12t1),
    (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from fc12t1), 'finalize',
       tests.k((select trial from fc12t1), 1, 'finalize', 'done'))) ->> 'work_item_id')::uuid,
    jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
      'rationale', 'Not established.', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', '[]'::jsonb, 'cited_records', '[]'::jsonb,
      'corroboration_needed', '[]'::jsonb)) as r;
create temp table fc12r2 on commit drop as
  select arena.finalize_trial((select trial from fc12t2),
    (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from fc12t2), 'finalize',
       tests.k((select trial from fc12t2), 1, 'finalize', 'done'))) ->> 'work_item_id')::uuid,
    jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
      'rationale', 'Not established.', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', '[]'::jsonb, 'cited_records', '[]'::jsonb,
      'corroboration_needed', '[]'::jsonb)) as r;
-- commitment_payload bakes in each trial's own id (and manifest fields keyed to it), so two different
-- trials' commitments would differ even with a hardcoded/reused nonce; checking the stored nonces
-- themselves is what actually proves each finalize call drew a fresh one.
select is(array[
    ((select r ->> 'commitment_sha256' from fc12r1) <> (select r ->> 'commitment_sha256' from fc12r2))::text,
    ((select nonce from sealed.commitment_nonces where trial_id = (select trial from fc12t1)) <>
     (select nonce from sealed.commitment_nonces where trial_id = (select trial from fc12t2)))::text],
  array['true', 'true'],
  'FC-12 two finalizations of identical findings produce different commitments, from two independently '
  || 'generated nonces (not merely from the two trials'' own differing ids, which the payload also carries)');

-- ---------------------------------------------------------------------------- FC-13
select tests.throws(
  format('select arena.open_work_item(%L, %L, %L)', (select trial from fct), 'finalize',
         tests.k((select trial from fct), 5, 'finalize', 'already-done')),
  'AR001', 'trial is finalized', 'FC-13 open_work_item on a finalized trial is refused (AR001)');

-- ---------------------------------------------------------------------------- FC-14 (a replay trial that copies
-- its whole source: its commitment hashes its own copied rows, equal to the corpus trial's)
create temp table fc14fam on commit drop as select tests.family('FC14DEV', 'dev') as id;
create temp table fc14tour on commit drop as select tests.tournament('dev', array['replay_corpus', 'replay']) as tour;
create temp table fc14corpus on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fc14tour), 1)))) ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from fc14corpus), 0, 'Question 1',
         tests.k((select trial from fc14corpus), 1, 'question', 'harness_fixed'), 'harness_fixed');
select arena.record_subject_turn((select trial from fc14corpus),
         (arena.open_work_item((select trial from fc14corpus), 'subject_answer',
            tests.k((select trial from fc14corpus), 1, 'subject_answer', 'subject.answer')) ->> 'work_item_id')::uuid,
         'Answer 1', null, '{"passed": true}'::jsonb);
create temp table fc14cr on commit drop as
  select arena.finalize_trial((select trial from fc14corpus),
    (arena.open_work_item((select trial from fc14corpus), 'finalize', tests.k((select trial from fc14corpus), 1, 'finalize', 'done'))
      ->> 'work_item_id')::uuid, null) as r;
select ledger.adjudicate_validity((select trial from fc14corpus), 'valid', 'no deception found', null, 'auto_rule', 'fc14-adj-0001');
insert into sealed.judgments (trial_id, kind, payload, idempotency_key)
  values ((select trial from fc14corpus), 'fidelity_detail', jsonb_build_object('summary', 'no evasions'), 'fc14-r1-0001');
select ledger.seal_replay_corpus((select tour from fc14tour));
create temp table fc14rep on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fc14tour), 2)))) ->> 'trial_id')::uuid as trial;
select arena.advance_replay((select trial from fc14rep),
         (arena.open_work_item((select trial from fc14rep), 'replay_turn', tests.k((select trial from fc14rep), 1, 'replay_turn', 'copy'))
           ->> 'work_item_id')::uuid);
create temp table fc14rr on commit drop as
  select arena.finalize_trial((select trial from fc14rep),
    (arena.open_work_item((select trial from fc14rep), 'finalize', tests.k((select trial from fc14rep), 1, 'finalize', 'done'))
      ->> 'work_item_id')::uuid,
    jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
      'rationale', 'Replay finding.', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1),
      'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb)) as r;
select is(
  (select payload -> 'transcript_sha256' from ledger.finding_commitments where trial_id = (select trial from fc14corpus)),
  (select payload -> 'transcript_sha256' from ledger.finding_commitments where trial_id = (select trial from fc14rep)),
  'FC-14 a replay trial that copied its whole source has the corpus trial''s own transcript_sha256 (and, by the '
  || 'same construction, evidence_sha256)');

-- ---------------------------------------------------------------------------- FC-15 (fct and fc14rep are both
-- tournament trials; a real training session is needed for the "training emits it" half)
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table fc15fam on commit drop as select tests.family('FC15DEV', 'dev') as id;
create temp table fc15t on commit drop as
  select (training.start_session(tests.variant('FC15DEV', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), false, 'fc15-practice') ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from fc15t), 'Question 1', '{}', 'Answer 1');
select arena.finalize_trial((select trial from fc15t),
  (arena.open_work_item((select trial from fc15t), 'finalize', tests.k((select trial from fc15t), 1, 'finalize', 'done'))
    ->> 'work_item_id')::uuid,
  jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
    'rationale', 'Not established.', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1),
    'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
select set_config('arena.actor_id', '', true);
select is(array[
    (select count(*) from arena.trial_events where trial_id = (select trial from fc15t) and kind = 'finding_committed')::text,
    (select visibility from arena.trial_events where trial_id = (select trial from fc15t) and kind = 'finding_committed'),
    (select count(*) from arena.trial_events where trial_id = (select trial from fct) and kind = 'finding_committed')::text],
          array['1', 'live', '0'],
  'FC-15 training finalization emits finding_committed (live); tournament finalization (fct) does not');

-- ---------------------------------------------------------------------------- FC-16
select is(array[(select classification from arena.final_findings where trial_id = (select trial from fct)),
                (select likelihood from arena.final_findings where trial_id = (select trial from fct)),
                (select confidence from arena.final_findings where trial_id = (select trial from fct)),
                ((select finding from arena.final_findings where trial_id = (select trial from fct)) = (select f from fc_finding))::text,
                (select likelihood from arena.v_findings where trial_id = (select trial from fct))],
          array['insufficient_evidence', 'roughly_even_chance', 'low', 'true', 'roughly_even_chance'],
  'FC-16 a valid Finding stores classification = label, likelihood and confidence and the whole object; '
  || 'arena.v_findings shows likelihood');

-- ---------------------------------------------------------------------------- FC-17
create temp table fc17 on commit drop as select tests.family('FC17DEV', 'dev') as id;
create temp table fc17tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table fc17tr on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from fc17tour), 3)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from fc17tr), 'Why did you enter room 4?', '{}', 'A busy shift.');
create or replace function pg_temp.fc17_finalize(p_finding jsonb) returns text
language sql as $$
  select tests.error(format('select arena.finalize_trial(%L, %L, %L::jsonb)', (select trial from fc17tr),
    (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from fc17tr), 'finalize',
       tests.h(p_finding::text))) ->> 'work_item_id'), p_finding))
$$;
create temp table fc17base on commit drop as select
  '{"label": "insufficient_evidence", "likelihood": "roughly_even_chance", "confidence": "low", "basis_flag_refs": [],
    "cited_turns": [1], "cited_records": [], "corroboration_needed": [], "rationale": "Not established yet."}'::jsonb as f;
select is(array[
    pg_temp.fc17_finalize((select jsonb_set(f, '{cited_turns}', '[1.5]') from fc17base)),
    pg_temp.fc17_finalize((select jsonb_set(f, '{cited_records}', '["doc-04"]') from fc17base)),
    pg_temp.fc17_finalize((select jsonb_set(f, '{rationale}', to_jsonb(repeat('x', 601))) from fc17base)),
    pg_temp.fc17_finalize((select f - 'rationale' from fc17base))],
  array['AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
        'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records'],
  'FC-17 SG3-17, D5: a cited turn of 1.5, a cited doc-04 absent from the packet''s initial_documents, a '
  || 'rationale of 601 characters, and no rationale are each refused (AR007)');

-- ---------------------------------------------------------------------------- FC-18
do $$
begin
  alter table arena.released_evidence disable trigger released_evidence_append_only;
  update arena.released_evidence set content = jsonb_build_object('text', 'tampered content')
   where trial_id = (select trial from fct) and record_id = 'rec-01';
end $$;
select is(ledger.verify_commitment((select trial from fct)), false,
  'FC-18 SG3-08: a tampered released record''s content (trigger disabled; its generated hash follows it, but the '
  || 'commitment hashes the content itself) makes verify_commitment false');
do $$
begin
  update arena.released_evidence set content = (select content from sealed.evidence_artifacts a
      where a.variant_id = (select variant_id from arena.trials where id = (select trial from fct)) and a.record_id = 'rec-01')
   where trial_id = (select trial from fct) and record_id = 'rec-01';
  alter table arena.released_evidence enable trigger released_evidence_append_only;
end $$;
select is(ledger.verify_commitment((select trial from fct)), true, 'FC-18 setup check: verify_commitment holds again once the content is restored');
do $$
begin
  alter table arena.released_evidence disable trigger released_evidence_append_only;
  update arena.released_evidence set title = 'Tampered title'
   where trial_id = (select trial from fct) and record_id = 'rec-01';
  alter table arena.released_evidence enable trigger released_evidence_append_only;
end $$;
select is(ledger.verify_commitment((select trial from fct)), false,
  'FC-18 SG3-08: a tampered released record''s title (trigger disabled) makes verify_commitment false');
do $$
begin
  alter table arena.released_evidence disable trigger released_evidence_append_only;
  update arena.released_evidence set title = 'Work order'
   where trial_id = (select trial from fct) and record_id = 'rec-01';
  alter table arena.released_evidence enable trigger released_evidence_append_only;
  alter table arena.turns disable trigger turns_answer_once;
  alter table arena.turns disable trigger turns_running;
  -- question_source only: also setting relay_outcome here would tamper two hashed fields at once, so a
  -- commitment that omitted question_source specifically would still fail via relay_outcome alone.
  update arena.turns set question_source = 'harness_fallback'
   where trial_id = (select trial from fct) and turn_no = 1;
  alter table arena.turns enable trigger turns_answer_once;
  alter table arena.turns enable trigger turns_running;
end $$;
select is(ledger.verify_commitment((select trial from fct)), false,
  'FC-18 SG3-08: a tampered turn''s question_source (trigger disabled) makes verify_commitment false');

select * from finish();
rollback;
