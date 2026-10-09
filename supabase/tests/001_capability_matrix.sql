-- 001_capability_matrix.sql (S4 section 10; sql/TESTS.md section 1; SCN-5, SCN-9, EVL-10, KPI-5; WI-S4-04)
-- The capability matrix is an executable fixture: the actual privilege set of the six roles over the six arena
-- schemas equals the expanded allowlist in fixtures/capability_matrix.csv exactly, in both directions. Any new
-- grant, function or view fails here until the fixture is regenerated in the same change (db_test.sh also
-- fails when the committed fixture differs from the one regenerated from the migrated database).
-- CM-01..CM-15 are sql/TESTS.md section 1 (v2.7). CM-16..CM-21 are WP-03 additions, proposed for the spec's next
-- revision: the loss direction of the gate (CM-16), column grants (CM-17, CM-18), grant options (CM-19, CM-20) and
-- S4 2.1's `public` schema default-privilege revokes (CM-21).
begin;
\ir harness/fixtures.psql
\ir harness/capability.psql
select plan(21);

-- The fixture, loaded client-side (the runner's working directory is supabase/tests).
create temp table capability_fixture (role text, object_type text, object text, privilege text, expect text)
  on commit drop;
\copy capability_fixture from 'fixtures/capability_matrix.csv' with (format csv, header true)

-- A malformed fixture row is an error, never a silently ignored row.
do $$
declare
  v_bad text;
begin
  select string_agg(format('%s,%s,%s,%s,%s', role, object_type, object, privilege, expect), '; ') into v_bad
    from capability_fixture
   where role not in ('arena_public', 'arena_subject', 'arena_referee', 'anon', 'authenticated', 'service_role')
      or object_type not in ('function', 'schema', 'table', 'view', 'column', 'sequence', 'table+view')
      or expect not in ('allow', 'deny')
      or (object_type = 'table+view' and (expect <> 'allow' or object !~ '^[a-z_]+\.\*$'))
      or (expect = 'deny' and object_type not in ('table', 'view'));
  if v_bad is not null then
    raise exception 'capability fixture has malformed rows: %', v_bad;
  end if;
end $$;

-- Expansion (S4 section 10): explicit allow rows, plus every relation of a `<schema>.*` pattern row, minus the
-- deny rows (applied last).
create or replace temp view capability_expected as
select role, object_type, object, privilege from capability_fixture
 where expect = 'allow' and object_type <> 'table+view'
union
select f.role, r.object_type, r.object, f.privilege
  from capability_fixture f join capability_relations r on f.object = r.nsp || '.*'
 where f.expect = 'allow' and f.object_type = 'table+view'
except
select role, object_type, object, privilege from capability_fixture where expect = 'deny';

select is_empty($$ select role, object_type, object, privilege from capability_actual
                   except select role, object_type, object, privilege from capability_expected $$,
  'CM-01 no privilege of the six roles on the six schemas beyond the allowlist');

select is_empty($$ select role, object_type, object, privilege from capability_expected
                   except select role, object_type, object, privilege from capability_actual $$,
  'CM-02 every allowlisted privilege is actually held');

select is_empty($$ select * from capability_actual where role in ('anon', 'authenticated', 'service_role') $$,
  'CM-03 anon, authenticated and service_role hold nothing on the six schemas');

select is_empty($$ select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname in ('arena', 'subject', 'sealed', 'ledger', 'training', 'ops')
                      and c.relkind in ('r', 'p') and not c.relrowsecurity $$,
  'CM-04 row level security is enabled on every table of the six schemas');

select is_empty($$ select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname in ('arena', 'subject', 'sealed', 'ledger', 'training', 'ops')
                      and not coalesce(p.proconfig @> array['search_path=""'], false) $$,
  'CM-05 every function of the six schemas pins search_path to empty');

select is_empty($$ select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname in ('arena', 'subject', 'sealed', 'ledger', 'training', 'ops')
                      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   where a.grantee = 0 and a.privilege_type = 'EXECUTE') $$,
  'CM-06 no function of the six schemas is executable by PUBLIC');

select results_eq(
  $$ select f.fn, (select array_agg(r order by r) from unnest(array['arena_public', 'arena_subject', 'arena_referee']) r
                    where has_function_privilege(r, f.fn::regprocedure, 'EXECUTE'))
       from unnest(array['arena.release_evidence(uuid,uuid,text[])',
                         'arena.record_subject_turn(uuid,uuid,text,jsonb,jsonb)',
                         'arena.finalize_trial(uuid,uuid,jsonb)',
                         'arena.record_execution_failure(uuid,uuid,text,text)',
                         'ledger.adjudicate_validity(uuid,text,text,text,text,text)',
                         'ledger.reveal(uuid)']) with ordinality f(fn, ord)
      order by f.ord $$,
  $$ values ('arena.release_evidence(uuid,uuid,text[])', array['arena_public']),
            ('arena.record_subject_turn(uuid,uuid,text,jsonb,jsonb)', array['arena_subject']),
            ('arena.finalize_trial(uuid,uuid,jsonb)', array['arena_public']),
            ('arena.record_execution_failure(uuid,uuid,text,text)', array['arena_public']),
            ('ledger.adjudicate_validity(uuid,text,text,text,text,text)', array['arena_referee']),
            ('ledger.reveal(uuid)', array['arena_referee']) $$,
  'CM-07 each of the six privileged functions (direction 4.2) has exactly its one runtime grantee');

select is_empty($$ select a.role, a.object, a.privilege from capability_actual a
                   where a.role in ('arena_public', 'arena_subject')
                     and (a.object_type = 'table'
                          or (a.object_type = 'column'
                              and exists (select 1 from capability_relations r
                                           where r.base_table and starts_with(a.object, r.object || '.')))) $$,
  'CM-08 arena_public and arena_subject hold no privilege on any base table or any of its columns');

select is(array[has_schema_privilege('arena_public', 'sealed', 'USAGE'),
                has_schema_privilege('arena_public', 'subject', 'USAGE')],
          array[false, false],
  'CM-09 arena_public has no USAGE on sealed or subject');

select is_empty($$ select 'missing: ' || r from unnest(array['arena_public', 'arena_subject', 'arena_referee']) r
                    where not exists (select 1 from pg_roles where rolname = r)
                   union all
                   select 'attributes: ' || rolname from pg_roles
                    where rolname in ('arena_public', 'arena_subject', 'arena_referee')
                      and (rolinherit or rolbypassrls or rolsuper or rolcreaterole or rolcreatedb or rolreplication)
                   union all
                   select 'member of ' || m.roleid::regrole::text || ': ' || m.member::regrole::text
                     from pg_auth_members m
                    where m.member::regrole::text in ('arena_public', 'arena_subject', 'arena_referee') $$,
  'CM-10 runtime roles: NOINHERIT, no BYPASSRLS, SUPERUSER, CREATEROLE, CREATEDB or REPLICATION, members of nothing');

select is_empty($$ select c.oid::regclass::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname in ('arena', 'subject', 'sealed', 'ledger', 'training', 'ops')
                      and c.relkind = 'v' and not coalesce(c.reloptions @> array['security_barrier=true'], false) $$,
  'CM-11 every view of the six schemas is a security barrier');

select is_empty($$ select r || ' ' || f from unnest(array['arena_public', 'arena_subject', 'arena_referee']) r,
                          unnest(array['ops.set_kill_switch(boolean,text)',
                                       'ops.set_bucket_ceiling(text,text,numeric,text)']) f
                    where has_function_privilege(r, f::regprocedure, 'EXECUTE') $$,
  'CM-12 the owner-only spend controls are executable by no runtime role');

-- Gate-proofs. Each change runs in its own subtransaction: the CM-01 difference (extra) and the CM-02 difference
-- (missing) are read, then the change is undone, so every proof sees the migrated privileges plus exactly its
-- own change, whatever order the proofs run in.
create function pg_temp.capability_diff_after(p_change text) returns setof text
language plpgsql as $$
declare
  v_diff text[];
begin
  begin
    execute p_change;
    select array_agg(d order by d) into v_diff from (
      select 'extra|' || concat_ws('|', role, object_type, object, privilege) as d
        from (select role, object_type, object, privilege from capability_actual
              except select role, object_type, object, privilege from capability_expected) x
      union all
      select 'missing|' || concat_ws('|', role, object_type, object, privilege)
        from (select role, object_type, object, privilege from capability_expected
              except select role, object_type, object, privilege from capability_actual) y) z;
    raise exception using errcode = 'TS000', message = 'undo the gate-proof change';
  exception when sqlstate 'TS000' then
    null;
  end;
  return query select unnest(coalesce(v_diff, '{}'::text[]));
end $$;

select results_eq(
  $$ select n, d from unnest(array[
         'grant select on sealed.evaluator_packets to arena_public',
         'grant references, trigger, maintain on sealed.evaluator_packets to arena_public',
         'grant select (role) on sealed.evaluator_packets to arena_subject',
         'grant create on schema sealed to arena_referee',
         'grant usage on sequence ops.kill_switch_events_id_seq to arena_public']) with ordinality c(change, n),
       lateral pg_temp.capability_diff_after(c.change) d
      order by n, d $$,
  $$ values (1::bigint, 'extra|arena_public|table|sealed.evaluator_packets|SELECT'::text),
            (2, 'extra|arena_public|table|sealed.evaluator_packets|MAINTAIN'),
            (2, 'extra|arena_public|table|sealed.evaluator_packets|REFERENCES'),
            (2, 'extra|arena_public|table|sealed.evaluator_packets|TRIGGER'),
            (3, 'extra|arena_subject|column|sealed.evaluator_packets.role|SELECT'),
            (4, 'extra|arena_referee|schema|sealed|CREATE'),
            (5, 'extra|arena_public|sequence|ops.kill_switch_events_id_seq|USAGE') $$,
  'CM-13 gate-proof: each of the five leaks (table SELECT; REFERENCES, TRIGGER, MAINTAIN; a column grant; schema '
  || 'CREATE; sequence USAGE) makes CM-01 report exactly one row per leaked privilege');

select is_empty($$
  select a.role || ' ' || a.privilege || ' ' || a.object from capability_actual a
   where a.role in ('arena_public', 'arena_subject', 'arena_referee')
     and ((a.object_type = 'schema' and split_part(a.privilege, ' ', 1) = 'CREATE')
          or a.object_type = 'sequence'
          or (a.object_type in ('table', 'view', 'column')
              and split_part(a.privilege, ' ', 1) in ('UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')))
  union all
  select 'owns relation ' || c.oid::regclass::text from pg_class c
   where pg_get_userbyid(c.relowner) in ('arena_public', 'arena_subject', 'arena_referee')
  union all
  select 'owns function ' || p.oid::regprocedure::text from pg_proc p
   where pg_get_userbyid(p.proowner) in ('arena_public', 'arena_subject', 'arena_referee') $$,
  'CM-14 no runtime role holds schema CREATE, a sequence privilege, or UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER '
  || 'or MAINTAIN on any relation, and none owns a relation or a function');

-- SG3-20: a helper the migration owner adds to arena later is executable by nobody until granted (0001's global
-- default-privilege revoke). Created inside this rolled-back transaction as the migration owner.
set local role postgres;
create function arena.zz_probe() returns integer language sql set search_path = '' as $$ select 1 $$;
reset role;
select is(array[has_function_privilege('arena_public', 'arena.zz_probe()', 'EXECUTE'),
                has_function_privilege('arena_subject', 'arena.zz_probe()', 'EXECUTE'),
                has_function_privilege('arena_referee', 'arena.zz_probe()', 'EXECUTE'),
                exists (select 1 from aclexplode(coalesce((select proacl from pg_proc
                                                            where oid = 'arena.zz_probe()'::regprocedure),
                                                           acldefault('f', 'postgres'::regrole))) a
                         where a.grantee = 0)],
          array[false, false, false, false],
  'CM-15 SG3-20: a function the owner creates in arena after the migrations is executable by no runtime role and '
  || 'PUBLIC is absent from its ACL');

select results_eq(
  $$ select * from pg_temp.capability_diff_after('revoke execute on function arena.trial_visible(uuid) from arena_public') $$,
  $$ values ('missing|arena_public|function|arena.trial_visible(uuid)|EXECUTE'::text) $$,
  'CM-16 gate-proof: revoking an allowlisted grant makes CM-02 report exactly that loss');

select results_eq(
  $$ select * from pg_temp.capability_diff_after(
       'revoke select on arena.v_dev_cases from arena_public; grant select (variant_id) on arena.v_dev_cases to arena_public') $$,
  $$ values ('extra|arena_public|column|arena.v_dev_cases.variant_id|SELECT'::text),
            ('missing|arena_public|view|arena.v_dev_cases|SELECT'::text) $$,
  'CM-17 gate-proof: a column grant is not the relation grant it replaces (CM-02 reports the loss, CM-01 the column)');

select results_eq(
  $$ select * from pg_temp.capability_diff_after('grant select (role) on sealed.evaluator_packets to arena_public') $$,
  $$ values ('extra|arena_public|column|sealed.evaluator_packets.role|SELECT'::text) $$,
  'CM-18 gate-proof: a column-only grant on a sealed table is a leak CM-01 reports');

select results_eq(
  $$ select * from pg_temp.capability_diff_after(
       'grant execute on function ledger.reveal(uuid) to arena_referee with grant option') $$,
  $$ values ('extra|arena_referee|function|ledger.reveal(uuid)|EXECUTE WITH GRANT OPTION'::text) $$,
  'CM-19 gate-proof: upgrading an allowlisted grant to WITH GRANT OPTION makes CM-01 report the grant option');

select is_empty($$ select role, object_type, object, privilege from capability_actual
                   where privilege like '% WITH GRANT OPTION' $$,
  'CM-20 no role of the six holds a grant option on the six schemas (none can pass a privilege on)');

-- S4 2.1 (`public` schema): an object the migration owner creates in public later, by accident, is reachable by no
-- Data API role and by nobody through PUBLIC (Supabase "Securing your API", default privileges). The probe objects
-- are created as the migration owner inside this rolled-back transaction.
set local role postgres;
create table public.cm21_probe_table (id bigint generated always as identity primary key, note text);
create function public.cm21_probe_function() returns integer language sql as $$ select 1 $$;
create view public.cm21_probe_view as select note from public.cm21_probe_table;
reset role;
select is_empty($$
  select r || ' ' || x.privilege || ' ' || o.object
    from unnest(array['anon', 'authenticated', 'service_role']) r,
         (values ('public.cm21_probe_table', 'table'), ('public.cm21_probe_view', 'table'),
                 ('public.cm21_probe_table_id_seq', 'sequence'), ('public.cm21_probe_function()', 'function')) o(object, kind),
         lateral (select p from unnest(case o.kind
                    when 'table' then array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
                    when 'sequence' then array['USAGE', 'SELECT', 'UPDATE']
                    else array['EXECUTE'] end) p) x(privilege)
   where case o.kind
           when 'table' then has_table_privilege(r, o.object, x.privilege)
           when 'sequence' then has_sequence_privilege(r, o.object, x.privilege)
           else has_function_privilege(r, o.object::regprocedure, x.privilege) end
  union all
  select 'PUBLIC EXECUTE public.cm21_probe_function()'
   where exists (select 1 from aclexplode(coalesce((select proacl from pg_proc
                                                      where oid = 'public.cm21_probe_function()'::regprocedure),
                                                     acldefault('f', 'postgres'::regrole))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE') $$,
  'CM-21 a table, view, sequence or function the migration owner creates in public is reachable by no API role '
  || 'and not executable through PUBLIC (S4 2.1 default-privilege revokes)');

select * from finish();
rollback;
