-- 012_reveal_manifest.sql (S4 section 6; sql/TESTS.md section 12; WP-16). A small interactive-only `dev`
-- tournament through close_tournament_run, begin_scoring and reveal: RV-10 (successful reveal, manifest
-- shape), RV-11 (completeness and byte-order), RV-15 (idempotent reveal), RV-16 (a leaderboard insert before
-- reveal and with the wrong manifest), RV-17/18 (seal_corrected_manifest: no change returns the latest
-- version with no new row; a later adjudication seals version 2 with the right parent, v1 untouched).
-- RV-12a (AC-S3-4.2 SQL/Python parity): the raw rows exported as one JSON document, rebuilt in Python by
-- tools/wp16_manifest_parity.py (arena_core.scoring.inclusion.build_manifest, WP-15) and compared byte for
-- byte against the SQL-sealed hash.
begin;
\ir harness/fixtures.psql
select plan(15);

create temp table tt (tour uuid, trial_t uuid, trial_d uuid) on commit drop;
insert into tt (tour) select tests.tournament('dev', array['interactive']);
update tt set trial_t = tests.trial(tour, 3), trial_d = tests.trial(tour, 4);
grant select on tt to arena_referee;   -- read under `set local role` below (a temp table grants nothing by default)

-- Leaderboard insert before reveal (RV-16): no manifest exists yet for this tournament, so any manifest_id
-- given is either nonexistent or some other tournament's -- `tg_leaderboard_label` (alphabetically first of
-- the two BEFORE INSERT triggers) catches it before `tg_bound_to_revealed_manifest` would.
set local role arena_referee;
select tests.throws(
  format($q$insert into arena.leaderboards (tournament_id, manifest_id, board, label, body)
           values (%L, gen_random_uuid(), 'assistant', 'original', '{}'::jsonb)$q$, (select tour from tt)),
  'AR020', 'only the manifest sealed at reveal', 'a leaderboard cannot be inserted before reveal');
reset role;

-- Start both trials (freeze_tournament leaves every attempt 'planned', H-09), then one minimal exchange and
-- finalize per trial (empty citation arrays: the family fixture carries no initial_documents, and citing
-- nothing is valid, S4 arena.finalize_trial).
select set_config('arena.actor_id', '', true);
select arena.start_trial((select trial_t from tt));
select arena.start_trial((select trial_d from tt));
select tests.exchange((select trial_t from tt), 'What happened?', '{}', 'A plain answer.');
select tests.exchange((select trial_d from tt), 'What happened?', '{}', 'A plain answer.');

create function pg_temp.finding(p_label text) returns jsonb
language sql as $$
  select jsonb_build_object('label', p_label, 'likelihood', 'likely', 'confidence', 'moderate',
    'rationale', 'A sufficiently long rationale for the fixture finding.', 'basis_flag_refs', '[]'::jsonb,
    'corroboration_needed', '[]'::jsonb, 'cited_turns', '[1]'::jsonb, 'cited_records', '[]'::jsonb)
$$;

create function pg_temp.finalize(p_trial uuid, p_key text, p_label text) returns jsonb
language sql as $$
  select arena.finalize_trial(p_trial, (arena.open_work_item(p_trial, 'finalize', p_key) ->> 'work_item_id')::uuid,
    pg_temp.finding(p_label))
$$;
select pg_temp.finalize((select trial_t from tt), 'wp16-finalize-t', 'truthful');
select pg_temp.finalize((select trial_d from tt), 'wp16-finalize-d', 'deceptive');

-- Both trials valid (S3 4.2 item 1's automatic path, recorded here directly): nothing to invalidate.
select ledger.adjudicate_validity((select trial_t from tt), 'valid', 'fixture', 'wp16-ev-t', 'auto_rule', 'wp16-adj-t');
select ledger.adjudicate_validity((select trial_d from tt), 'valid', 'fixture', 'wp16-ev-d', 'auto_rule', 'wp16-adj-d');

select arena.close_tournament_run((select tour from tt));
select arena.begin_scoring((select tour from tt));

-- RV-10: a successful reveal moves the tournament to revealed and seals manifest version 1.
select is(
  (select r -> 'manifest_sha256' is not null from (select ledger.reveal((select tour from tt)) as r) x),
  true, 'reveal returns a manifest hash');
select is((select status from arena.tournaments where id = (select tour from tt)), 'revealed',
  'the tournament is revealed');
select is((select version from ledger.inclusion_manifests where tournament_id = (select tour from tt)), 1,
  'manifest version 1 is sealed');

-- RV-11: the manifest lists exactly the two planned trials, sorted by planned_trial_id in byte order.
create temp table mv on commit drop as
  select manifest, manifest_sha256 from ledger.inclusion_manifests
   where tournament_id = (select tour from tt) and version = 1;
select is(
  (select count(*)::int from arena.planned_trials where tournament_id = (select tour from tt)),
  (select array_length(regexp_split_to_array(rtrim(manifest, E'\n'), E'\n'), 1) - 1 from mv),
  'one manifest line per planned trial');
-- Compared in the manifest's OWN line order (ordinal `n`, header at n=1 skipped) against the planned-trial
-- ids sorted ascending -- re-sorting both sides first (as an earlier version of this check did) would only
-- prove the two SETS of ids are equal, never that the manifest text itself is byte-sorted (S3 4.4), which
-- is what RV-11 claims.
select is(
  (select string_agg(split_part(x, '|', 1), ',' order by n) from mv,
     unnest(string_to_array(rtrim(manifest, E'\n'), E'\n')) with ordinality as t(x, n)
    where n > 1),
  (select string_agg(id::text, ',' order by id::text) from arena.planned_trials where tournament_id = (select tour from tt)),
  'the manifest body lines appear in planned_trial_id byte order (S3 4.4)');

-- RV-12a / AC-S3-4.2: export the raw rows (still exactly as v1 sealed them, before any correction below)
-- and have Python rebuild the sealed text independently.
\o ../../.gates/wp16_manifest_check.json
select jsonb_build_object(
  'tournament_id', t.id, 'manifest_version', 1, 'roster_hash', t.roster_sha256,
  'corpus_seal_hash', (select corpus_sha256 from ledger.corpus_seals where tournament_id = t.id),
  'hidden_seal_hash', (select seal_sha256 from sealed.hidden_split_seals h where h.id = t.hidden_seal_id),
  'manifest_sha256', (select manifest_sha256 from mv),
  'rows', (select jsonb_agg(jsonb_build_object(
             -- ledger.build_manifest's own `l` CTE: `v.family_id` (case_variants.family_id, a UUID, never
             -- the human-readable family_code) and `i.variant_id` (= p.variant_id, case_variants.id itself,
             -- never v.variant_code) -- every id-shaped field in the line is the raw internal UUID.
             'planned_trial_id', p.id, 'track', p.track, 'assistant_id', p.assistant_candidate_id,
             'subject_id', p.subject_candidate_id, 'family_id', v.family_id, 'variant_id', p.variant_id,
             'role', ep.role, 'repeat', p.repeat, 'block_id', p.block_id, 'exec_state', e.state,
             'adjudication_id', adj.id, 'verdict', adj.verdict))
           from arena.planned_trials p
           join arena.case_variants v on v.id = p.variant_id
           join sealed.evaluator_packets ep on ep.variant_id = p.variant_id
           join ledger.planned_execution(t.id) e on e.planned_trial_id = p.id
           left join lateral (select a.id, a.verdict from ledger.validity_adjudications a
                               where a.trial_id = e.trial_id order by a.adj_seq desc limit 1) adj on true
          where p.tournament_id = t.id))
  from arena.tournaments t where t.id = (select tour from tt);
\o
\set parity_result `cd ../.. && uv run --locked python tools/wp16_manifest_parity.py .gates/wp16_manifest_check.json`
select is(:'parity_result'::text, 'MATCH', 'the Python verifier rebuilds version 1''s sealed text byte for byte (AC-S3-4.2)');

-- RV-15: a second reveal is a no-op (same manifest id and hash, no new row).
select is(
  (select jsonb_build_object('manifest_sha256', r -> 'manifest_sha256')
     from (select ledger.reveal((select tour from tt)) as r) x),
  (select jsonb_build_object('manifest_sha256', to_jsonb(manifest_sha256)) from mv),
  'a second reveal returns the same manifest hash');
select is((select count(*)::int from ledger.inclusion_manifests where tournament_id = (select tour from tt)), 1,
  'still exactly one manifest row after the second reveal');

-- RV-18: seal_corrected_manifest with nothing changed returns the latest version, no new row.
select is(
  (select (ledger.seal_corrected_manifest((select tour from tt)) ->> 'version')::int), 1,
  'an unchanged correction reports version 1, not a new one');
select is((select count(*)::int from ledger.inclusion_manifests where tournament_id = (select tour from tt)), 1,
  'seal_corrected_manifest with no change writes no new row');

-- RV-17: a later adjudication (the deceptive trial's subject ruled invalid) seals version 2 with the right
-- parent hash; v1 stays exactly as sealed.
select ledger.adjudicate_validity((select trial_d from tt), 'subject_invalid', 'fixture, corrected',
  'wp16-ev-d-2', 'auto_rule', 'wp16-adj-d-2');
create temp table mv2 on commit drop as
  select (ledger.seal_corrected_manifest((select tour from tt))) as r;
select is((select (r ->> 'version')::int from mv2), 2, 'the correction seals version 2');
select is(
  (select supersedes_id from ledger.inclusion_manifests where tournament_id = (select tour from tt) and version = 2),
  (select id from ledger.inclusion_manifests where tournament_id = (select tour from tt) and version = 1),
  'version 2 supersedes version 1''s row');
select is(
  (select split_part(manifest, '|', 5) from ledger.inclusion_manifests where tournament_id = (select tour from tt) and version = 2),
  (select manifest_sha256 from mv), 'version 2''s header names version 1''s hash as its parent (S3 4.4)');
select is((select manifest_sha256 from ledger.inclusion_manifests where tournament_id = (select tour from tt) and version = 1),
  (select manifest_sha256 from mv), 'version 1 is unchanged byte for byte after the correction');

select * from finish();
rollback;
