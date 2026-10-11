-- 012_reveal_manifest.sql (sql/TESTS.md section 12; BKO-9, EVL-9, EVL-10, F14, F15; WP-04b). No dblink.
begin;
\ir harness/fixtures.psql
select plan(23);  -- RV-01..RV-22 plus RV-12a
select tests.users();

-- ---------------------------------------------------------------------------- shared helpers
create or replace function pg_temp.rv_fail(p_trial uuid, p_state text, p_reason text) returns void
language plpgsql as $$
declare v_wi uuid;
begin
  v_wi := (arena.open_work_item(p_trial, 'failure', tests.k(p_trial, 0, 'failure', p_state)) ->> 'work_item_id')::uuid;
  perform arena.record_execution_failure(p_trial, v_wi, p_state, 'rv fixture');
end $$;
create or replace function pg_temp.rv_quarantine(p_trial uuid) returns void
language plpgsql as $$
declare v_wi uuid;
begin
  perform arena.submit_question(p_trial, 0, 'Question 1', tests.k(p_trial, 1, 'question', 'q1'), 'harness_fixed');
  v_wi := (arena.open_work_item(p_trial, 'subject_answer', tests.k(p_trial, 1, 'subject_answer', 'ans')) ->> 'work_item_id')::uuid;
  perform arena.record_subject_turn(p_trial, v_wi, '', null, '{"passed": false, "rule": "G0_blocked"}'::jsonb);
end $$;
create or replace function pg_temp.rv_complete(p_trial uuid, p_key text, p_corpus boolean default false) returns void
language plpgsql as $$
declare v_wi uuid;
begin
  perform tests.exchange(p_trial, 'Question 1', '{}'::text[], 'Answer 1');
  v_wi := (arena.open_work_item(p_trial, 'finalize', tests.k(p_trial, 1, 'finalize', p_key)) ->> 'work_item_id')::uuid;
  perform arena.finalize_trial(p_trial, v_wi, case when p_corpus then null else
    jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
      'rationale', 'rv', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb,
      'corroboration_needed', '[]'::jsonb) end);
end $$;
create or replace function pg_temp.rv_adj(p_trial uuid, p_verdict text, p_key text, p_by text default 'rvreviewer')
returns uuid language sql as $$
  select ledger.adjudicate_validity(p_trial, p_verdict, 'rv fixture reason', null, p_by, p_key)
$$;
create or replace function pg_temp.rv_start(p_trial uuid) returns void
language sql as $$ select tests.as_role('arena_public', format('select arena.start_trial(%L)', p_trial)) $$;
-- a draft tournament with two interactive positions (truthful at 1, deceptive at 2), NOT frozen or opened:
-- unlike tests.tournament (which freezes and opens internally), this stays in draft so RV-01 can observe
-- reveal's refusal at each lifecycle stage.
create or replace function pg_temp.rv_draft(p_code text) returns uuid
language plpgsql as $$
declare
  v_a  uuid := tests.candidate('assistant', 'A1');
  v_s  uuid := tests.candidate('subject', 'S1');
  v_t  uuid;
  v_vt uuid;
  v_vd uuid;
begin
  perform tests.family(p_code, 'dev');
  v_vt := tests.variant(p_code, 'truthful');
  v_vd := tests.variant(p_code, 'deceptive');
  v_t := arena.create_tournament('t-' || lower(p_code) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
                                 'dev', 42, 'global');
  perform arena.add_planned_trials(v_t, jsonb_build_array(
    jsonb_build_object('position', 1, 'track', 'interactive', 'block_no', 1, 'variant_id', v_vt,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 2, 'track', 'interactive', 'block_no', 1, 'variant_id', v_vd,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s)));
  return v_t;
end $$;

-- ============================================================================ RV-01, RV-10..RV-18, RV-21 (part)
-- the golden-path tournament: two interactive positions, both completed and adjudicated, carried all the
-- way through draft -> frozen -> running -> sealed -> scoring -> revealed -> a correction.
create temp table rvg on commit drop as select pg_temp.rv_draft('RV01DEV') as tour;
create temp table rv01 (step integer, val text) on commit drop;
insert into rv01 select 1, tests.error(format('select ledger.reveal(%L)', (select tour from rvg)));  -- draft
select arena.freeze_tournament((select tour from rvg));
-- freeze_tournament is what creates arena.trials rows (one per planned trial); only now do tests.trial lookups resolve.
create temp table rvg3 on commit drop as select tests.trial((select tour from rvg), 1) as trial;
create temp table rvg4 on commit drop as select tests.trial((select tour from rvg), 2) as trial;
insert into rv01 select 2, tests.error(format('select ledger.reveal(%L)', (select tour from rvg)));  -- frozen
select arena.open_tournament((select tour from rvg));
insert into rv01 select 3, tests.error(format('select ledger.reveal(%L)', (select tour from rvg)));  -- running
select pg_temp.rv_start((select trial from rvg3));
select pg_temp.rv_start((select trial from rvg4));
select pg_temp.rv_complete((select trial from rvg3), 'g3');
select pg_temp.rv_complete((select trial from rvg4), 'g4');
create temp table rvg3adj on commit drop as select pg_temp.rv_adj((select trial from rvg3), 'valid', 'rvg-adj-3-001') as id;
select pg_temp.rv_adj((select trial from rvg4), 'valid', 'rvg-adj-4-001');
select arena.close_tournament_run((select tour from rvg));
insert into rv01 select 4, tests.error(format('select ledger.reveal(%L)', (select tour from rvg)));  -- sealed
select is(array[(select val from rv01 where step = 1), (select val from rv01 where step = 2),
                (select val from rv01 where step = 3), (select val from rv01 where step = 4)],
  array['AR020: reveal follows scoring (draft/frozen/running/sealed refused)',
        'AR020: reveal follows scoring (draft/frozen/running/sealed refused)',
        'AR020: reveal follows scoring (draft/frozen/running/sealed refused)',
        'AR020: reveal follows scoring (draft/frozen/running/sealed refused)'],
  'RV-01 reveal in draft, frozen, running and sealed is refused (AR020) each time');

create or replace function pg_temp.rv_force_scoring(p_tour uuid) returns void
language sql as $$ update arena.tournaments set status = 'scoring' where id = p_tour $$;

-- ---------------------------------------------------------------------------- RV-02
create temp table rv02 on commit drop as select pg_temp.rv_draft('RV02DEV') as tour;
select arena.freeze_tournament((select tour from rv02));
select arena.open_tournament((select tour from rv02));
select pg_temp.rv_start(tests.trial((select tour from rv02), 1));
select pg_temp.rv_complete(tests.trial((select tour from rv02), 1), 'rv02');
select pg_temp.rv_adj(tests.trial((select tour from rv02), 1), 'valid', 'rv02-adj-0001');
-- position 2 is left untouched: still planned, no execution record.
select pg_temp.rv_force_scoring((select tour from rv02));
select is(tests.error(format('select ledger.reveal(%L)', (select tour from rv02))),
  'AR020: a planned trial has no execution record',
  'RV-02 a planned trial without an execution record (owner forces scoring for the test) is refused (AR020)');

-- ---------------------------------------------------------------------------- RV-03
create temp table rv03 on commit drop as select pg_temp.rv_draft('RV03DEV') as tour;
select arena.freeze_tournament((select tour from rv03));
select arena.open_tournament((select tour from rv03));
select pg_temp.rv_start(tests.trial((select tour from rv03), 1));
select pg_temp.rv_start(tests.trial((select tour from rv03), 2));
select pg_temp.rv_complete(tests.trial((select tour from rv03), 1), 'rv03');
select pg_temp.rv_fail(tests.trial((select tour from rv03), 2), 'infra_failed', 'rv03 infra');
select arena.close_tournament_run((select tour from rv03));
select arena.begin_scoring((select tour from rv03));
select is(tests.error(format('select ledger.reveal(%L)', (select tour from rv03))),
  'AR020: a subject review is unresolved',
  'RV-03 a completed interactive trial without review is refused (AR020)');

-- ---------------------------------------------------------------------------- RV-04
create temp table rv04 on commit drop as select pg_temp.rv_draft('RV04DEV') as tour;
select arena.freeze_tournament((select tour from rv04));
select arena.open_tournament((select tour from rv04));
select pg_temp.rv_start(tests.trial((select tour from rv04), 1));
select pg_temp.rv_start(tests.trial((select tour from rv04), 2));
select pg_temp.rv_fail(tests.trial((select tour from rv04), 1), 'assistant_failed', 'rv04 assistant down');
select pg_temp.rv_fail(tests.trial((select tour from rv04), 2), 'infra_failed', 'rv04 infra');
select arena.close_tournament_run((select tour from rv04));
select arena.begin_scoring((select tour from rv04));
select is(tests.error(format('select ledger.reveal(%L)', (select tour from rv04))),
  'AR020: a subject review is unresolved',
  'RV-04 an assistant_failed interactive trial without review is refused (AR020)');

-- ---------------------------------------------------------------------------- RV-05
-- a) seal missing: a replay_corpus-only tournament (no replay row needed), completed and reviewed, never
-- sealed; the owner forces scoring directly (close_tournament_run would otherwise refuse this itself).
create temp table rv05a on commit drop as select tests.tournament('dev', array['replay_corpus']) as tour;
create temp table rv05acorpus on commit drop as select tests.trial((select tour from rv05a), 1) as trial;
select pg_temp.rv_start((select trial from rv05acorpus));
select pg_temp.rv_complete((select trial from rv05acorpus), 'rv05a', true);
select pg_temp.rv_adj((select trial from rv05acorpus), 'valid', 'rv05a-adj-001');
select pg_temp.rv_force_scoring((select tour from rv05a));
-- b) tampered after the seal: a second, properly sealed replay_corpus-only tournament, then its one R1
-- judgment is altered (append-only trigger disabled) so corpus_digest no longer matches the stored seal.
create temp table rv05b on commit drop as select tests.tournament('dev', array['replay_corpus']) as tour;
create temp table rv05bcorpus on commit drop as select tests.trial((select tour from rv05b), 1) as trial;
select pg_temp.rv_start((select trial from rv05bcorpus));
select pg_temp.rv_complete((select trial from rv05bcorpus), 'rv05b', true);
insert into sealed.judgments (trial_id, kind, payload, idempotency_key)
  values ((select trial from rv05bcorpus), 'fidelity_detail', '{"summary": "none"}'::jsonb, 'rv05b-r1-001');
select pg_temp.rv_adj((select trial from rv05bcorpus), 'valid', 'rv05b-adj-001');
select ledger.seal_replay_corpus((select tour from rv05b));
select arena.close_tournament_run((select tour from rv05b));
select arena.begin_scoring((select tour from rv05b));
do $$
begin
  alter table sealed.judgments disable trigger judgments_append_only;
  update sealed.judgments set payload = '{"summary": "tampered"}'::jsonb where idempotency_key = 'rv05b-r1-001';
  alter table sealed.judgments enable trigger judgments_append_only;
end $$;
select is(array[
    tests.error(format('select ledger.reveal(%L)', (select tour from rv05a))),
    tests.error(format('select ledger.reveal(%L)', (select tour from rv05b)))],
  array['AR021: replay corpus is not sealed or does not match its seal',
        'AR021: replay corpus is not sealed or does not match its seal'],
  'RV-05 a missing corpus seal, and a corpus transcript tampered after the seal, are each refused (AR021)');
do $$
begin
  alter table sealed.judgments disable trigger judgments_append_only;
  update sealed.judgments set payload = '{"summary": "none"}'::jsonb where idempotency_key = 'rv05b-r1-001';
  alter table sealed.judgments enable trigger judgments_append_only;
end $$;

-- ---------------------------------------------------------------------------- RV-06
create temp table rv06a on commit drop as select pg_temp.rv_draft('RV06ADEV') as tour;
select arena.freeze_tournament((select tour from rv06a));
select arena.open_tournament((select tour from rv06a));
select pg_temp.rv_start(tests.trial((select tour from rv06a), 1));
select pg_temp.rv_start(tests.trial((select tour from rv06a), 2));
select pg_temp.rv_complete(tests.trial((select tour from rv06a), 1), 'rv06a-1');
select pg_temp.rv_fail(tests.trial((select tour from rv06a), 2), 'infra_failed', 'rv06a infra');
select pg_temp.rv_adj(tests.trial((select tour from rv06a), 1), 'valid', 'rv06a-adj-001');
select arena.close_tournament_run((select tour from rv06a));
select arena.begin_scoring((select tour from rv06a));
do $$
begin
  alter table ledger.finding_commitments disable trigger finding_commitments_append_only;
  update ledger.finding_commitments set commitment_sha256 = repeat('0', 64)
   where trial_id = (select trial from (select tests.trial((select tour from rv06a), 1) as trial) z);
  alter table ledger.finding_commitments enable trigger finding_commitments_append_only;
end $$;

create temp table rv06b on commit drop as select pg_temp.rv_draft('RV06BDEV') as tour;
select arena.freeze_tournament((select tour from rv06b));
select arena.open_tournament((select tour from rv06b));
select pg_temp.rv_start(tests.trial((select tour from rv06b), 1));
select pg_temp.rv_start(tests.trial((select tour from rv06b), 2));
select pg_temp.rv_complete(tests.trial((select tour from rv06b), 1), 'rv06b-1');
select pg_temp.rv_fail(tests.trial((select tour from rv06b), 2), 'infra_failed', 'rv06b infra');
select pg_temp.rv_adj(tests.trial((select tour from rv06b), 1), 'valid', 'rv06b-adj-001');
select arena.close_tournament_run((select tour from rv06b));
select arena.begin_scoring((select tour from rv06b));
do $$
begin
  alter table sealed.commitment_nonces disable trigger commitment_nonces_append_only;
  delete from sealed.commitment_nonces
   where trial_id = (select trial from (select tests.trial((select tour from rv06b), 1) as trial) z);
  alter table sealed.commitment_nonces enable trigger commitment_nonces_append_only;
end $$;

create temp table rv06c on commit drop as select pg_temp.rv_draft('RV06CDEV') as tour;
select arena.freeze_tournament((select tour from rv06c));
select arena.open_tournament((select tour from rv06c));
select pg_temp.rv_start(tests.trial((select tour from rv06c), 1));
select pg_temp.rv_start(tests.trial((select tour from rv06c), 2));
select pg_temp.rv_complete(tests.trial((select tour from rv06c), 1), 'rv06c-1');
select pg_temp.rv_fail(tests.trial((select tour from rv06c), 2), 'infra_failed', 'rv06c infra');
select pg_temp.rv_adj(tests.trial((select tour from rv06c), 1), 'valid', 'rv06c-adj-001');
select arena.close_tournament_run((select tour from rv06c));
select arena.begin_scoring((select tour from rv06c));
do $$
begin
  alter table ledger.terminal_records disable trigger terminal_records_append_only;
  update ledger.terminal_records set state = 'budget_truncated'
   where trial_id = (select trial from (select tests.trial((select tour from rv06c), 1) as trial) z);
  alter table ledger.terminal_records enable trigger terminal_records_append_only;
end $$;
create temp table rv06c1 on commit drop as select tests.error(format('select ledger.reveal(%L)', (select tour from rv06c))) as v;
do $$
begin
  alter table ledger.finding_commitments disable trigger finding_commitments_append_only;
  delete from ledger.finding_commitments
   where trial_id = (select trial from (select tests.trial((select tour from rv06c), 1) as trial) z);
  alter table ledger.finding_commitments enable trigger finding_commitments_append_only;
end $$;
create temp table rv06c2 on commit drop as select tests.error(format('select ledger.reveal(%L)', (select tour from rv06c))) as v;

select is(array[
    tests.error(format('select ledger.reveal(%L)', (select tour from rv06a))),
    tests.error(format('select ledger.reveal(%L)', (select tour from rv06b))),
    (select v from rv06c1), (select v from rv06c2)],
  array['AR021: commitment of trial ' || (select tests.trial((select tour from rv06a), 1))::text || ' does not verify',
        'AR021: commitment of trial ' || (select tests.trial((select tour from rv06b), 1))::text || ' does not verify',
        'AR021: commitment of trial ' || (select tests.trial((select tour from rv06c), 1))::text || ' does not verify',
        'AR021: commitment of trial ' || (select tests.trial((select tour from rv06c), 1))::text || ' does not verify'],
  'RV-06 a commitment that does not verify, a missing commitment or nonce, and (SG3-47) a completed trial '
  || 'whose terminal state is rewritten away from completed (with its commitment first kept, then deleted) '
  || 'are each refused (AR021): the population is every chained trial_finalized event plus every completed '
  || 'terminal record, so the rewrite alone does not let the trial escape the check');

-- ---------------------------------------------------------------------------- RV-07 (restores the chain before continuing)
create temp table rv07 on commit drop as select pg_temp.rv_draft('RV07DEV') as tour;
select arena.freeze_tournament((select tour from rv07));
select arena.open_tournament((select tour from rv07));
select pg_temp.rv_start(tests.trial((select tour from rv07), 1));
select pg_temp.rv_start(tests.trial((select tour from rv07), 2));
select pg_temp.rv_complete(tests.trial((select tour from rv07), 1), 'rv07-1');
select pg_temp.rv_fail(tests.trial((select tour from rv07), 2), 'infra_failed', 'rv07 infra');
select pg_temp.rv_adj(tests.trial((select tour from rv07), 1), 'valid', 'rv07-adj-001');
select arena.close_tournament_run((select tour from rv07));
select arena.begin_scoring((select tour from rv07));
create temp table rv07event on commit drop as select seq, sha256 from ledger.events
 where tournament_id = (select tour from rv07) order by seq desc limit 1;
do $$
begin
  alter table ledger.events disable trigger events_append_only;
  update ledger.events set sha256 = repeat('0', 64) where seq = (select seq from pg_temp.rv07event);
  alter table ledger.events enable trigger events_append_only;
end $$;
create temp table rv07err on commit drop as select tests.error(format('select ledger.reveal(%L)', (select tour from rv07))) as v;
do $$
begin
  alter table ledger.events disable trigger events_append_only;
  update ledger.events set sha256 = (select sha256 from pg_temp.rv07event) where seq = (select seq from pg_temp.rv07event);
  alter table ledger.events enable trigger events_append_only;
end $$;
select is(array[(select v from rv07err), (select ledger.verify_chain() is null)::text],
  array['AR021: ledger chain breaks at seq ' || (select seq from rv07event), 'true'],
  'RV-07 a broken ledger chain (owner edits one event with the trigger disabled) is refused (AR021); restoring '
  || 'the event makes the chain verify again (so later reveals in this file are unaffected)');

-- ---------------------------------------------------------------------------- RV-08
create temp table rv08 on commit drop as select tests.tournament('hidden', array['interactive']) as tour;
select pg_temp.rv_start(tests.trial((select tour from rv08), 3));
select pg_temp.rv_start(tests.trial((select tour from rv08), 4));
select pg_temp.rv_complete(tests.trial((select tour from rv08), 3), 'rv08-3');
select pg_temp.rv_complete(tests.trial((select tour from rv08), 4), 'rv08-4');
select pg_temp.rv_adj(tests.trial((select tour from rv08), 3), 'valid', 'rv08-adj-3-01');
select pg_temp.rv_adj(tests.trial((select tour from rv08), 4), 'valid', 'rv08-adj-4-01');
select arena.close_tournament_run((select tour from rv08));
select arena.begin_scoring((select tour from rv08));
-- sealed.ingest_case_family refuses a new hidden family once the split is sealed (by design), so the seal is
-- broken directly instead: the stored n_variants no longer matches sealed.hidden_split_digest()'s count.
do $$
begin
  alter table sealed.hidden_split_seals disable trigger hidden_split_seals_immutable;
  update sealed.hidden_split_seals set n_variants = n_variants + 1;
  alter table sealed.hidden_split_seals enable trigger hidden_split_seals_immutable;
end $$;
select is(tests.error(format('select ledger.reveal(%L)', (select tour from rv08))),
  'AR021: hidden split seal does not verify',
  'RV-08 a hidden tournament whose seal no longer verifies (the stored n_variants tampered, trigger disabled) is '
  || 'refused (AR021)');
-- restore: there is one hidden_split_seals row for the whole hidden split, so leaving it broken would also
-- break RV-19..22's own (separate) hidden tournament reveal later in this file.
do $$
begin
  alter table sealed.hidden_split_seals disable trigger hidden_split_seals_immutable;
  update sealed.hidden_split_seals set n_variants = n_variants - 1;
  alter table sealed.hidden_split_seals enable trigger hidden_split_seals_immutable;
end $$;

-- ---------------------------------------------------------------------------- RV-09
create temp table rv09 on commit drop as select pg_temp.rv_draft('RV09DEV') as tour;
select arena.freeze_tournament((select tour from rv09));
create temp table rv09pos on commit drop as
  select tests.trial((select tour from rv09), 1) as t1, tests.trial((select tour from rv09), 2) as t2;
do $$
declare v_v1 uuid; v_v2 uuid;
begin
  select variant_id into v_v1 from arena.planned_trials where id = (select planned_trial_id from arena.trials
    where id = (select t1 from pg_temp.rv09pos));
  select variant_id into v_v2 from arena.planned_trials where id = (select planned_trial_id from arena.trials
    where id = (select t2 from pg_temp.rv09pos));
  alter table arena.planned_trials disable trigger planned_trials_immutable;
  update arena.planned_trials set variant_id = v_v2
   where id = (select planned_trial_id from arena.trials where id = (select t1 from pg_temp.rv09pos));
  alter table arena.planned_trials enable trigger planned_trials_immutable;
end $$;
select pg_temp.rv_force_scoring((select tour from rv09));
select is(tests.error(format('select ledger.reveal(%L)', (select tour from rv09))),
  'AR021: roster is not frozen or does not match its hash',
  'RV-09 a roster row (planned_trials) tampered after freeze is refused (AR021)');

select arena.begin_scoring((select tour from rvg));
create temp table rv10 on commit drop as select ledger.reveal((select tour from rvg)) as r;
create temp table rv10manifest on commit drop as select manifest, manifest_sha256 from ledger.inclusion_manifests
 where tournament_id = (select tour from rvg) and version = 1;
select is(array[
    (select status from arena.tournaments where id = (select tour from rvg)),
    (select (manifest ~ '^arena-inclusion-manifest\|v1\|') from rv10manifest)::text,
    (select (manifest ~ ('\|' || (select tour from rvg) || '\|1\|\|')) from rv10manifest)::text,
    (select (manifest !~ E'\r') from rv10manifest)::text,
    (select right(manifest, 1) from rv10manifest),
    (select (manifest_sha256 = ledger.hash_text(manifest)) from rv10manifest)::text,
    (select (r ->> 'manifest_sha256') from rv10)],
  array['revealed', 'true', 'true', 'true', E'\n', 'true', (select manifest_sha256 from rv10manifest)],
  'RV-10 a successful reveal: status revealed; manifest version 1 in S3 4.4''s canonical text (header, LF, '
  || 'trailing newline, an empty parent); manifest_sha256 = hash_text(manifest)');

create temp table rv11lines on commit drop as
  select line from (select regexp_split_to_table(manifest, E'\n') as line from rv10manifest) x where x.line <> '';
select is(array[
    (select count(*)::text from ledger.events where event_type = 'tournament_revealed' and tournament_id = (select tour from rvg)
       and payload ->> 'manifest_sha256' = (select manifest_sha256 from rv10manifest)),
    (select count(distinct split_part(line, '|', 1))::text from rv11lines where line !~ '^arena-'),
    (select count(*)::text from rv11lines)],
  array['1', '2', '3'],
  'RV-11 manifest completeness: ledger records the reveal with the same hash (X-07); the two planned trial '
  || 'lines have distinct planned_trial_id values; one header line plus two trial lines (three non-empty '
  || 'lines total)');

select is((select decided_by from ledger.v_adjudications where id = (select id from rvg3adj)) is not null
          and (select (manifest ~ (select id::text from rvg3adj)) from rv10manifest), true,
  'RV-13 the adjudication id in force for a trial appears in the manifest');

select is((select nonce_hex from ledger.revealed_nonces where trial_id = (select trial from rvg3)),
  (select encode(nonce, 'hex') from sealed.commitment_nonces where trial_id = (select trial from rvg3)),
  'RV-14 ledger.revealed_nonces holds the sealed nonce in hex for a revealed trial');

select is((select (r ->> 'manifest_id') = (select ledger.reveal((select tour from rvg)) ->> 'manifest_id') from rv10)::text,
  'true',
  'RV-15 a second reveal returns the same manifest id and hash');

-- ---------------------------------------------------------------------------- RV-16 (a second revealed tournament)
create temp table rvg2 on commit drop as select tests.tournament('dev', array['interactive']) as tour;
select pg_temp.rv_start(tests.trial((select tour from rvg2), 3));
select pg_temp.rv_start(tests.trial((select tour from rvg2), 4));
select pg_temp.rv_complete(tests.trial((select tour from rvg2), 3), 'g2-3');
select pg_temp.rv_complete(tests.trial((select tour from rvg2), 4), 'g2-4');
select pg_temp.rv_adj(tests.trial((select tour from rvg2), 3), 'valid', 'rvg2-adj-3-01');
select pg_temp.rv_adj(tests.trial((select tour from rvg2), 4), 'valid', 'rvg2-adj-4-01');
select arena.close_tournament_run((select tour from rvg2));
select arena.begin_scoring((select tour from rvg2));
select ledger.reveal((select tour from rvg2));
create temp table rv16v1 on commit drop as select id from ledger.inclusion_manifests
 where tournament_id = (select tour from rvg2) and version = 1;
select pg_temp.rv_adj(tests.trial((select tour from rvg2), 3), 'subject_invalid', 'rvg2-adj-3-corr');
create temp table rv16v2 on commit drop as select (ledger.seal_corrected_manifest((select tour from rvg2)) ->> 'manifest_id')::uuid as id;
create temp table rv16tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
select is(array[
    tests.sqlstate(format('insert into arena.leaderboards (tournament_id, manifest_id, board, label, body) '
      || 'values (%L, %L, %L, %L, %L)', (select tour from rv16tour), (select id from rv16v1), 'assistant',
      'original', '{}'::jsonb)),
    tests.sqlstate(format('insert into arena.leaderboards (tournament_id, manifest_id, board, label, body) '
      || 'values (%L, %L, %L, %L, %L)', (select tour from rvg), (select id from rv16v1), 'assistant',
      'original', '{}'::jsonb)),
    tests.sqlstate(format('insert into arena.leaderboards (tournament_id, manifest_id, board, label, body) '
      || 'values (%L, %L, %L, %L, %L)', (select tour from rvg2), (select id from rv16v2), 'assistant',
      'original', '{}'::jsonb)),
    tests.sqlstate(format('insert into arena.leaderboards (tournament_id, manifest_id, board, label, body) '
      || 'values (%L, %L, %L, %L, %L)', (select tour from rvg2), (select id from rv16v1), 'assistant',
      'corrected', '{}'::jsonb)),
    tests.sqlstate(format('insert into arena.scores (tournament_id, manifest_id, candidate_id, metric, value) '
      || 'values (%L, %L, null, %L, %L)', (select tour from rv16tour), (select id from rv16v1), 'overall',
      '{"point": 1}'::jsonb))],
  array['AR020', 'AR020', 'AR020', 'AR020', 'AR020'],
  'RV-16 a leaderboard insert before reveal, with another tournament''s manifest, original on v2, corrected on '
  || 'v1, and a score insert before reveal are each refused');

-- ---------------------------------------------------------------------------- RV-17, RV-18
create temp table rv17v1 on commit drop as select manifest, manifest_sha256 from ledger.inclusion_manifests
 where tournament_id = (select tour from rvg) and version = 1;
select pg_temp.rv_adj((select trial from rvg3), 'subject_invalid', 'rvg-adj-3-corr');
create temp table rv17v2 on commit drop as select ledger.seal_corrected_manifest((select tour from rvg)) as r;
create temp table rv17v2row on commit drop as select * from ledger.inclusion_manifests
 where id = (select (r ->> 'manifest_id')::uuid from rv17v2);
select is(array[
    (select (r ->> 'version') from rv17v2),
    (select v1.id = rv17v2row.supersedes_id from ledger.inclusion_manifests v1, rv17v2row
       where v1.tournament_id = (select tour from rvg) and v1.version = 1)::text,
    (select (manifest ~ ('\|' || (select manifest_sha256 from rv17v1) || '\|')) from rv17v2row)::text,
    (select manifest from ledger.inclusion_manifests where tournament_id = (select tour from rvg) and version = 1),
    (select manifest_sha256 from ledger.inclusion_manifests where tournament_id = (select tour from rvg) and version = 1)],
  array['2', 'true', 'true', (select manifest from rv17v1), (select manifest_sha256 from rv17v1)],
  'RV-17 a later adjudication, then seal_corrected_manifest: version 2 supersedes v1 and carries v1''s hash '
  || 'as its header''s parent field; version 1 stays byte for byte unchanged');

create temp table rv18 on commit drop as select ledger.seal_corrected_manifest((select tour from rvg)) as r;
select is(array[(select (r ->> 'manifest_id') from rv18), (select count(*)::text from ledger.inclusion_manifests
                  where tournament_id = (select tour from rvg))],
  array[(select (r ->> 'manifest_id') from rv17v2), '2'],
  'RV-18 seal_corrected_manifest with no trial line changed returns the latest version and writes no new row');

-- ============================================================================ RV-12, RV-12a
-- One tournament covering every S4 7.5 inclusion row: completed+valid, assistant_failed+valid,
-- completed+subject_invalid, quarantined, infra_failed, budget_skipped, budget_truncated, two replay rows
-- made source_unavailable (one from a quarantined corpus, one from a corpus whose sealed verdict is
-- subject_invalid: EF-09 and EF-14's patterns), a plain corpus row, and a block with one infra_failed trial
-- invalidating its other (otherwise-valid) member. An interactive row always needs a block (planned_track_shape),
-- and a lone infra_failed trial in any block under 20 members is always also block-invalid (20 x 1 > n for n <
-- 20) -- so the "plain infra_failed" row (P5) uses a replay_corpus trial instead, which carries no block at all.
select tests.family('RV12DEV', 'dev');
create temp table rv12 on commit drop as
  select arena.create_tournament('rv12-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16), 'dev', 42, 'global') as tour;
do $$
declare
  v_a  uuid := tests.candidate('assistant', 'A1');
  v_s  uuid := tests.candidate('subject', 'S1');
  v_vt uuid := tests.variant('RV12DEV', 'truthful');
  v_vd uuid := tests.variant('RV12DEV', 'deceptive');
  v_t  uuid := (select tour from pg_temp.rv12);
begin
  perform arena.add_planned_trials(v_t, jsonb_build_array(
    jsonb_build_object('position', 1, 'track', 'interactive', 'block_no', 1, 'variant_id', v_vt,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 2, 'track', 'interactive', 'block_no', 2, 'variant_id', v_vd,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 3, 'track', 'interactive', 'block_no', 3, 'variant_id', v_vt,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 4, 'track', 'interactive', 'block_no', 4, 'variant_id', v_vd,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 5, 'track', 'replay_corpus', 'variant_id', v_vd, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 6, 'track', 'interactive', 'block_no', 5, 'variant_id', v_vd,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 7, 'track', 'interactive', 'block_no', 6, 'variant_id', v_vt,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 8, 'track', 'interactive', 'block_no', 7, 'variant_id', v_vt,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 9, 'track', 'interactive', 'block_no', 7, 'variant_id', v_vd,
                       'assistant_candidate_id', v_a, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 10, 'track', 'replay_corpus', 'variant_id', v_vt, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 11, 'track', 'replay', 'variant_id', v_vt, 'assistant_candidate_id', v_a,
                       'source_position', 10),
    jsonb_build_object('position', 12, 'track', 'replay_corpus', 'variant_id', v_vt, 'subject_candidate_id', v_s),
    jsonb_build_object('position', 13, 'track', 'replay', 'variant_id', v_vt, 'assistant_candidate_id', v_a,
                       'source_position', 12)));
end $$;
select arena.freeze_tournament((select tour from rv12));
select arena.open_tournament((select tour from rv12));
create temp table rv12p on commit drop as
  select n, tests.trial((select tour from rv12), n) as trial from generate_series(1, 13) n;
-- BKO-2 order: the replay_corpus and replay tracks finish (corpus sealed, every replay row has an execution
-- record) before any interactive trial may start.
select pg_temp.rv_start((select trial from rv12p where n = x)) from (select unnest(array[5, 10, 12]) x) z;
select pg_temp.rv_fail((select trial from rv12p where n = 5), 'infra_failed', 'rv12 corpus infra');
select pg_temp.rv_quarantine((select trial from rv12p where n = 10));
select pg_temp.rv_complete((select trial from rv12p where n = 12), 'rv12-12', true);
insert into sealed.judgments (trial_id, kind, payload, idempotency_key)
  values ((select trial from rv12p where n = 12), 'fidelity_detail', '{"summary": "none"}'::jsonb, 'rv12-r1-001-00');
select pg_temp.rv_adj((select trial from rv12p where n = 12), 'subject_invalid', 'rv12-adj-12-001');
select ledger.seal_replay_corpus((select tour from rv12));
select pg_temp.rv_start((select trial from rv12p where n = 11));
select pg_temp.rv_start((select trial from rv12p where n = 13));
-- now the interactive trials (every replay row has an execution record; the corpus is sealed).
select pg_temp.rv_start((select trial from rv12p where n = x)) from (select unnest(array[1, 2, 3, 4, 7, 8, 9]) x) z;
select pg_temp.rv_complete((select trial from rv12p where n = 1), 'rv12-1');
select pg_temp.rv_adj((select trial from rv12p where n = 1), 'valid', 'rv12-adj-01-001');
select pg_temp.rv_fail((select trial from rv12p where n = 2), 'assistant_failed', 'rv12 assistant down');
select pg_temp.rv_adj((select trial from rv12p where n = 2), 'valid', 'rv12-adj-02-001');
select pg_temp.rv_complete((select trial from rv12p where n = 3), 'rv12-3');
select pg_temp.rv_adj((select trial from rv12p where n = 3), 'subject_invalid', 'rv12-adj-03-001');
select pg_temp.rv_quarantine((select trial from rv12p where n = 4));
create temp table rv12p6wi on commit drop as
  select (arena.open_work_item((select trial from rv12p where n = 6), 'failure',
            tests.k((select trial from rv12p where n = 6), 0, 'failure', 'budget_skipped')) ->> 'work_item_id')::uuid as wi;
select arena.record_execution_failure((select trial from rv12p where n = 6), (select wi from rv12p6wi), 'budget_skipped', 'rv12 skipped');
select pg_temp.rv_fail((select trial from rv12p where n = 7), 'budget_truncated', 'rv12 truncated');
select pg_temp.rv_fail((select trial from rv12p where n = 8), 'infra_failed', 'rv12 block infra');
select pg_temp.rv_complete((select trial from rv12p where n = 9), 'rv12-9');
select pg_temp.rv_adj((select trial from rv12p where n = 9), 'valid', 'rv12-adj-09-001');
select arena.close_tournament_run((select tour from rv12));
select arena.begin_scoring((select tour from rv12));
create temp table rv12r on commit drop as select ledger.reveal((select tour from rv12)) as r;
create temp table rv12m on commit drop as select manifest from ledger.inclusion_manifests
 where tournament_id = (select tour from rv12) and version = 1;
create temp table rv12lines on commit drop as
  select split_part(line, '|', 1) as planned_trial_id, line from (
    select regexp_split_to_table(manifest, E'\n') as line from rv12m) x where x.line <> '' and x.line !~ '^arena-';
create temp table rv12pt on commit drop as
  select n, pt.id as planned_trial_id from rv12p join arena.trials t on t.id = rv12p.trial
    join arena.planned_trials pt on pt.id = t.planned_trial_id;
create or replace function pg_temp.rv12_field(p_n integer, p_field integer) returns text
language sql as $$
  select split_part(l.line, '|', p_field) from rv12lines l join rv12pt p on p.planned_trial_id::text = l.planned_trial_id
   where p.n = p_n
$$;
select is(array[
    pg_temp.rv12_field(1, 12), pg_temp.rv12_field(1, 13), pg_temp.rv12_field(1, 14),
    pg_temp.rv12_field(2, 12), pg_temp.rv12_field(2, 13), pg_temp.rv12_field(2, 14),
    pg_temp.rv12_field(3, 12), pg_temp.rv12_field(3, 13), pg_temp.rv12_field(3, 14),
    pg_temp.rv12_field(4, 12), pg_temp.rv12_field(4, 13), pg_temp.rv12_field(4, 14),
    pg_temp.rv12_field(5, 13), pg_temp.rv12_field(5, 14),
    pg_temp.rv12_field(6, 12), pg_temp.rv12_field(6, 13), pg_temp.rv12_field(6, 14),
    pg_temp.rv12_field(7, 12), pg_temp.rv12_field(7, 13), pg_temp.rv12_field(7, 14),
    pg_temp.rv12_field(8, 12), pg_temp.rv12_field(8, 13), pg_temp.rv12_field(8, 14),
    pg_temp.rv12_field(9, 12), pg_temp.rv12_field(9, 13), pg_temp.rv12_field(9, 14),
    pg_temp.rv12_field(11, 12), pg_temp.rv12_field(11, 14),
    pg_temp.rv12_field(13, 12), pg_temp.rv12_field(13, 14),
    pg_temp.rv12_field(10, 13), pg_temp.rv12_field(10, 14)],
  array['included', 'counted', 'included',
        'included_as_insufficient', 'counted', 'assistant_failed_as_insufficient',
        'excluded', 'against_subject', 'subject_invalid',
        'excluded', 'against_subject', 'subject_quarantined',
        'excluded', 'infra_failed',
        'excluded', 'excluded', 'budget_skipped',
        'excluded', 'excluded', 'budget_truncated',
        'excluded', 'excluded', 'block_invalid_infra',
        'excluded', 'excluded', 'block_invalid_infra',
        'excluded', 'source_unavailable',
        'excluded', 'source_unavailable',
        'against_subject', 'subject_quarantined'],
  'RV-12 S4 7.5''s inclusion rows, each from its own fixture in one tournament: completed+valid, '
  || 'assistant_failed+valid, completed+subject_invalid, quarantined, infra_failed (a replay_corpus row, '
  || 'no block), budget_skipped, budget_truncated, a block''s one infra_failed trial invalidating its '
  || 'otherwise-valid co-member (reason block_invalid_infra for both), and two replay rows made '
  || 'source_unavailable (one from a quarantined corpus, one from a corpus whose sealed verdict is '
  || 'subject_invalid) each match S3 4.3 inclusion()');

-- RV-12a: an independent rebuild of the same manifest text straight from the raw rows (this suite's stand-in
-- for the Python verifier it must byte-match, since pgTAP cannot invoke Python; packages/core's own
-- test_inclusion.py is the Python-side half of this parity).
create or replace function pg_temp.rv12_rebuild(p_tournament uuid) returns text
language sql as $$
  with x as (select p.id as planned_trial_id, p.track, p.block_id, p.assistant_candidate_id, p.subject_candidate_id,
                    p.variant_id, p.repeat, p.position,
                    case when p.track = 'replay' then rs.state else r.state end as state,
                    case when p.track = 'replay' then src.id else t.id end as reviewed_trial_id
               from arena.planned_trials p
               left join lateral (select t2.id from arena.trials t2 where t2.planned_trial_id = p.id
                                   order by t2.attempt desc limit 1) t on true
               left join ledger.terminal_records r on r.trial_id = t.id
               left join arena.planned_trials sp on sp.id = p.source_planned_trial_id
               left join lateral (select t3.id from arena.trials t3 where t3.planned_trial_id = sp.id
                                   order by t3.attempt desc limit 1) src on true
               left join ledger.terminal_records rs on rs.trial_id = t.id
              where p.tournament_id = p_tournament),
       blocks as (select block_id, 20 * count(*) filter (where state = 'infra_failed') > count(*) as invalid
                    from x where block_id is not null group by block_id),
       a as (select x.*, adj.id as adjudication_id, adj.verdict, coalesce(b.invalid, false) as block_invalid
               from x left join blocks b on b.block_id = x.block_id
               left join lateral (select v.id, v.verdict from ledger.validity_adjudications v
                                   where v.trial_id = x.reviewed_trial_id order by v.adj_seq desc limit 1) adj on true),
       i as (select a.*, case
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
             from a)
  select concat_ws('|', 'arena-inclusion-manifest', 'v1', t.id, 1, '', t.roster_sha256,
                   coalesce((select c.corpus_sha256 from ledger.corpus_seals c where c.tournament_id = t.id), ''),
                   coalesce((select h.seal_sha256 from sealed.hidden_split_seals h where h.id = t.hidden_seal_id), ''))
    || E'\n' ||
    coalesce((select string_agg(
        concat_ws('|', i.planned_trial_id, i.track, coalesce(i.assistant_candidate_id::text, ''),
                  coalesce(i.subject_candidate_id::text, ''), v.family_id, i.variant_id, ep.role, i.repeat,
                  coalesce(i.state, ''), coalesce(i.adjudication_id::text, ''), coalesce(i.verdict, ''),
                  case when i.track = 'replay_corpus' then '' else split_part(i.inc, '|', 1) end,
                  case when i.track = 'replay' then '' else split_part(i.inc, '|', 2) end,
                  split_part(i.inc, '|', 3)) || E'\n', '' order by i.planned_trial_id::text collate "C")
      from i join arena.case_variants v on v.id = i.variant_id join sealed.evaluator_packets ep on ep.variant_id = i.variant_id),
     '')
    from arena.tournaments t where t.id = p_tournament
$$;
select is((select manifest from rv12m), (select pg_temp.rv12_rebuild((select tour from rv12))),
  'RV-12a S3 FX-M01 parity: an independent rebuild of the manifest straight from the raw rows is byte-equal '
  || 'to ledger.build_manifest''s own text (and so hashes equal)');

-- ============================================================================ RV-19, RV-20, RV-21, RV-22
create temp table rvh on commit drop as select tests.tournament('hidden', array['interactive']) as tour;
create temp table rvh3 on commit drop as select tests.trial((select tour from rvh), 3) as trial;
create temp table rvh4 on commit drop as select tests.trial((select tour from rvh), 4) as trial;
select pg_temp.rv_start((select trial from rvh3));
select pg_temp.rv_start((select trial from rvh4));
select pg_temp.rv_complete((select trial from rvh3), 'rvh-3');
select pg_temp.rv_complete((select trial from rvh4), 'rvh-4');

-- RV-19: before reveal.
create temp table rv19 on commit drop as select tests.as_role('arena_public', format(
  'select jsonb_build_object(%L, (select count(*) from arena.v_transcripts where trial_id = %L),'
  || ' %L, (select count(*) from arena.v_findings where trial_id = %L),'
  || ' %L, (select count(*) from arena.v_trial_events where trial_id = %L),'
  || ' %L, (select count(*) from ledger.v_adjudications where trial_id = %L),'
  || ' %L, (select payload from ledger.v_commitments where trial_id = %L),'
  || ' %L, (select commitment_sha256 is not null from ledger.v_commitments where trial_id = %L))',
  'transcripts', (select trial from rvh3), 'findings', (select trial from rvh3),
  'trial_events', (select trial from rvh3), 'adjudications', (select trial from rvh3),
  'payload', (select trial from rvh3), 'hash_visible', (select trial from rvh3))) as r;
select is(array[
    (select (r ->> 'transcripts') from rv19), (select (r ->> 'findings') from rv19),
    (select (r ->> 'trial_events') from rv19), (select (r ->> 'adjudications') from rv19),
    (select (r -> 'payload') from rv19)::text, (select (r ->> 'hash_visible') from rv19)],
  array['0', '0', '0', '0', 'null', 'true'],
  'RV-19 before reveal of a hidden tournament, as arena_public: v_transcripts, v_findings, v_trial_events '
  || 'and v_adjudications return no rows for its trials; v_commitments.payload is null while the commitment '
  || 'hash stays visible');

-- RV-22 (D9): before reveal.
create temp table rv22 on commit drop as select tests.as_role('arena_public', format(
  'select jsonb_build_object(%L, (select count(*) from arena.v_tournament_progress where tournament_id = %L),'
  || ' %L, (select sum(planned) from arena.v_tournament_progress where tournament_id = %L),'
  || ' %L, (select count(*) from ledger.v_events where tournament_id = %L and trial_id = %L))',
  'rows', (select tour from rvh), 'planned', (select tour from rvh),
  'leaked_trial_events', (select tour from rvh), (select trial from rvh3))) as r;
select is(array[(select ((r ->> 'rows')::integer > 0) from rv22)::text, (select (r ->> 'planned') from rv22),
                (select (r ->> 'leaked_trial_events') from rv22)],
  array['true', '2', '0'],
  'RV-22 D9: as arena_public before reveal of a hidden tournament, arena.v_tournament_progress gives per '
  || 'track and block the planned/running/ended counts (two positions planned); ledger.v_events hides its '
  || 'trial-level rows for the hidden trial');

select arena.close_tournament_run((select tour from rvh));
select arena.begin_scoring((select tour from rvh));
create temp table rvh3adj on commit drop as select pg_temp.rv_adj((select trial from rvh3), 'valid', 'rvh-adj-3-01') as id;
select pg_temp.rv_adj((select trial from rvh4), 'valid', 'rvh-adj-4-01');
select ledger.reveal((select tour from rvh));

-- RV-20: after reveal, the same views now return the rows.
select is(array[
    tests.as_role('arena_public', format('select count(*) from arena.v_transcripts where trial_id = %L', (select trial from rvh3)))::text,
    tests.as_role('arena_public', format('select count(*) from arena.v_findings where trial_id = %L', (select trial from rvh3)))::text,
    (tests.as_role('arena_public', format('select count(*) from arena.v_trial_events where trial_id = %L', (select trial from rvh3)))::text::integer > 0)::text,
    tests.as_role('arena_public', format('select count(*) from ledger.v_adjudications where trial_id = %L', (select trial from rvh3)))::text,
    (tests.as_role('arena_public', format('select payload from ledger.v_commitments where trial_id = %L', (select trial from rvh3))) is not null)::text],
  array['1', '1', 'true', '1', 'true'],
  'RV-20 after reveal, the same views return the hidden trial''s rows (and v_commitments.payload too)');

-- RV-21 (SG3-01).
create temp table rv21v1 on commit drop as select id from ledger.inclusion_manifests
 where tournament_id = (select tour from rvh) and version = 1;
create temp table rv21score1 on commit drop as select tests.as_role('arena_referee', format(
  'insert into arena.scores (tournament_id, manifest_id, candidate_id, metric, value) values (%L, %L, null, %L, %L) '
  || 'returning jsonb_build_object(%L, true)', (select tour from rvh), (select id from rv21v1), 'overall',
  '{"point": 1}'::jsonb, 'ok')) as r;
create temp table rv21board1 on commit drop as select tests.as_role('arena_referee', format(
  'insert into arena.leaderboards (tournament_id, manifest_id, board, label, body) values (%L, %L, %L, %L, %L) '
  || 'returning jsonb_build_object(%L, true)', (select tour from rvh), (select id from rv21v1), 'assistant',
  'original', '{}'::jsonb, 'ok')) as r;
select pg_temp.rv_adj((select trial from rvh3), 'subject_invalid', 'rvh-adj-3-corr');
create temp table rv21v2 on commit drop as select (ledger.seal_corrected_manifest((select tour from rvh)) ->> 'manifest_id')::uuid as id;
create temp table rv21score2 on commit drop as select tests.as_role('arena_referee', format(
  'insert into arena.scores (tournament_id, manifest_id, candidate_id, metric, value) values (%L, %L, null, %L, %L) '
  || 'returning jsonb_build_object(%L, true)', (select tour from rvh), (select id from rv21v2), 'overall',
  '{"point": 1}'::jsonb, 'ok')) as r;
create temp table rv21board2 on commit drop as select tests.as_role('arena_referee', format(
  'insert into arena.leaderboards (tournament_id, manifest_id, board, label, body) values (%L, %L, %L, %L, %L) '
  || 'returning jsonb_build_object(%L, true)', (select tour from rvh), (select id from rv21v2), 'assistant',
  'corrected', '{}'::jsonb, 'ok')) as r;
select is(array[(select (r ->> 'ok') from rv21score1), (select (r ->> 'ok') from rv21board1),
                (select (r ->> 'ok') from rv21score2), (select (r ->> 'ok') from rv21board2)],
  array['true', 'true', 'true', 'true'],
  'RV-21 SG3-01: after reveal, arena_referee inserts a score bound to v1, an original board on v1, then '
  || 'after a correction a score and a corrected board on v2, each accepted');

select * from finish();
rollback;
