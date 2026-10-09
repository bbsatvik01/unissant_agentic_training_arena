-- 000_harness.sql (sql/TESTS.md section 0; WI-S4-02): the harness itself works, so the suites built on it test
-- the schema and not the harness: pgTAP, the plan variable, the Supabase stand-ins (real or shim), role
-- switching, real second sessions through dblink, and the shared fixtures in harness/fixtures.psql.
begin;
\ir harness/fixtures.psql
select plan(12);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

select cmp_ok(pgtap_version(), '>=', 1.3, 'H-01 pgTAP 1.3 or later is loaded');

select ok((select jsonb_typeof(plan) = 'object' and plan ? 'global' from t_plan),
  'H-02 the runner passes cost_model.py --plan-json as the psql variable plan (a JSON object naming global)');

select ok(to_regclass('auth.users') is not null and to_regnamespace('extensions') is not null
          and to_regprocedure('extensions.gen_random_bytes(integer)') is not null
          and (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) = 3,
  'H-03 auth.users, pgcrypto in schema extensions, and the three Supabase API roles exist');

select is(tests.as_role('arena_public', $$ select to_jsonb(current_user::text) $$) #>> '{}', 'arena_public',
  'H-04 tests.as_role runs a statement as a runtime role (SET membership granted inside the test transaction)');

-- A real second session: it reaches this database and cannot see this transaction's uncommitted users.
select results_eq(
  $$ select * from dblink(current_setting('arena_test.dblink_dsn'),
       'select current_database()::text, (select count(*) from auth.users
          where id in (''00000000-0000-0000-0000-00000000000a'', ''00000000-0000-0000-0000-00000000000b''))::int')
       as t(db text, uncommitted_users int) $$,
  $$ values (current_database()::text collate "default", 0) $$,
  'H-05 dblink opens a separate session on this database (arena_test.dblink_dsn), isolated from this transaction');

select is(array[tests.sqlstate('select 1'), tests.sqlstate('select 1/0'), tests.error('select 1/0')],
          array['00000', '22012', '22012: division by zero'],
  'H-06 tests.sqlstate and tests.error report the SQLSTATE and message a statement raises');

select tests.throws('select 1/0', '22012', 'division by zero', 'H-07 tests.throws pins SQLSTATE and message');

-- tests.bundle and tests.family: a matched dev family, both roles, three packet tiers
create temp table t_fam on commit drop as select tests.family('HDEV', 'dev') as id;
select is(
  array[(select count(*) from arena.case_variants v, t_fam where v.family_id = t_fam.id)::text,
        (select string_agg(e.role, ',' order by e.role) from arena.case_variants v
           join sealed.evaluator_packets e on e.variant_id = v.id, t_fam where v.family_id = t_fam.id),
        (select count(*) from arena.public_packets p join arena.case_variants v on v.id = p.variant_id, t_fam
          where v.family_id = t_fam.id)::text,
        (select count(*) from subject.private_packets p join arena.case_variants v on v.id = p.variant_id, t_fam
          where v.family_id = t_fam.id)::text,
        (select count(*) from sealed.evidence_artifacts a join arena.case_variants v on v.id = a.variant_id, t_fam
          where v.family_id = t_fam.id)::text,
        (tests.family('HDEV', 'dev') = (select id from t_fam))::text],
  array['2', 'deceptive,truthful', '2', '2', '3', 'true'],
  'H-08 tests.family ingests tests.bundle once: truthful and deceptive dev variants, three packet tiers, 3 artifacts');

-- tests.tournament: a frozen, running dev tournament with the requested tracks and attempt-1 trials
create temp table t_tour (full_id uuid, inter_id uuid) on commit drop;
insert into t_tour (full_id) select tests.tournament('dev', array['replay_corpus', 'replay', 'interactive']);
update t_tour set inter_id = tests.tournament('dev', array['interactive']);
select is(
  (select array[(select status from arena.tournaments where id = full_id),
                (select string_agg(p.position || ':' || p.track || ':' || t.status, ',' order by p.position)
                   from arena.planned_trials p join arena.trials t on t.planned_trial_id = p.id
                  where p.tournament_id = full_id)]
     from t_tour),
  array['running', '1:replay_corpus:planned,2:replay:planned,3:interactive:planned,4:interactive:planned'],
  'H-09 tests.tournament creates, freezes and opens a roster with attempt-1 trials of every requested track');

-- tests.exchange: two exchanges on an interactive trial (the second requests rec-01, releasable after 1 exchange)
select arena.start_trial(tests.trial((select inter_id from t_tour), 3));
select tests.exchange(tests.trial((select inter_id from t_tour), 3), 'Why did you enter room 4?', '{}', 'A busy shift.');
select tests.exchange(tests.trial((select inter_id from t_tour), 3), 'Which task needed entry?', '{rec-01}', 'The HVAC ticket.');
select is(
  (select array[t.exchanges::text, t.transcript_version::text,
                (select string_agg(turn_no || '=' || answer, ';' order by turn_no) from arena.turns where trial_id = t.id),
                (select string_agg(record_id, ',' order by release_seq) from arena.released_evidence where trial_id = t.id),
                (select string_agg(kind, ',' order by seq) from arena.trial_events where trial_id = t.id)]
     from arena.trials t where t.id = tests.trial((select inter_id from t_tour), 3)),
  array['2', '5', '1=A busy shift.;2=The HVAC ticket.', 'rec-01',
        'question_recorded,subject_turn,coach_card,question_recorded,evidence_released,subject_turn,coach_card'],
  'H-10 tests.exchange runs question, release, subject answer and coach card (version +1 +0 +1 +0, then +1 +1 +1 +0)');

-- The seed families F01-F03 ingest through S1 4.4's loader rule (TESTS.md section 0): two variants each, five rec-NN
-- artifact rows per variant (the three initial documents stay in the public packet), the archived file text
-- hashing to its attestation.
create temp table t_seeds on commit drop as
  select code, tests.seed_family(code) as id from (values ('F01'), ('F02'), ('F03')) c(code);
select is(
  (select array_agg(format('%s:%s:%s:%s:%s', f.family_code, f.split,
                           (select count(*) from arena.case_variants v where v.family_id = f.id),
                           (select string_agg(n::text, ',') from (
                              select count(*) as n from arena.case_variants v
                                join sealed.evidence_artifacts a on a.variant_id = v.id
                               where v.family_id = f.id group by v.id order by v.id) x),
                           (i.source_sha256 = i.attestation ->> 'family_sha256')::text)
                    order by f.family_code)
     from t_seeds s join arena.case_families f on f.id = s.id join sealed.family_ingests i on i.family_id = f.id),
  array['F01:dev:2:5,5:true', 'F02:dev:2:5,5:true', 'F03:dev:2:5,5:true'],
  'H-12 the seed families F01-F03 ingest through the loader rule (two variants, five rec-NN rows each, attested)');

-- The TESTS.md section 0 pattern: an assertion evaluated while switched to a runtime role.
set local role arena_public;
select ok(current_user = 'arena_public' and tests.h('x') = tests.h('x'),
  'H-11 assertions and fixtures run while switched to a runtime role (set local role arena_public)');
reset role;

select * from finish();
rollback;
