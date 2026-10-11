-- 002_cases_and_seal.sql (sql/TESTS.md section 2; SCN-1, SCN-5, SCN-7..SCN-12, AST-5, BKO-5; WP-04a).
-- Case ingest, the hidden-split seal, the candidate registry and development revisions/retirements.
-- AC-S1-11 (packets immutable once ingested; a trial's finalize hashes match the stored packets) is exercised
-- here as the CS-xx rows the spec cites (CS-11, the immutability triggers over every content table).
-- Note on CS-21/CS-22: they run first, before CS-02 ingests the first hidden family that this transaction never
-- commits. The dblink sessions below only ever see what the real database has really committed, never this
-- transaction's own uncommitted hidden families (CS02H and later); any seal digest or verify check that must
-- match "what a fresh session would see" is therefore always read through dblink, never through this
-- transaction, and both races end by cleaning up every row and ledger event they committed for real (deletes,
-- a disabled trigger where one would otherwise forbid it, the chain head restored) so no later file inherits
-- a sealed hidden split.
begin;
\ir harness/fixtures.psql
select plan(54);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();

-- ---------------------------------------------------------------------------- CS-01
select is_empty($$
  select n.nspname || '.' || c.relname || '.' || a.attname
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'arena' and c.relkind in ('r', 'v') and a.attnum > 0 and not a.attisdropped
     and (a.attname = 'role' or a.attname like '%\_role') $$,
  'CS-01 no column in schema arena is named role or ends in _role (SCN-5)');

-- ---------------------------------------------------------------------------- CS-21, CS-22 (dblink; see the file
-- header). Neither race ever permanently seals the real hidden split: CS-21's seal is checked and then rolled
-- back by the same session before it commits; CS-22 inserts and then deletes its own seal row directly.
select dblink_connect('cs2a', current_setting('arena_test.dblink_dsn'));
select dblink_connect('cs2b', current_setting('arena_test.dblink_dsn'));

create temp table cs21_file on commit drop as select tests.family_file('CS21HID', 'hidden') as f;
create temp table cs21_bundle on commit drop as select tests.bundle_of((select f from cs21_file)) as b;
create temp table cs21sampler on commit drop as
  select jsonb_build_object('seed', 42, 'max_phi', 0.1, 'n', 1,
           'assignment', jsonb_build_array(jsonb_build_object('family_id', (select f ->> 'family_id' from cs21_file),
             'violation_type', (select f #> '{taxonomy,violation_type}' from cs21_file),
             'misleading_types', (select f #> '{taxonomy,misleading_types}' from cs21_file),
             'level', (select f #> '{difficulty,level}' from cs21_file),
             'style', (select f -> 'style' from cs21_file)))) as s;
create temp table cs21 (step integer, val text) on commit drop;
select dblink_exec('cs2a', 'begin');
insert into cs21 select 1, r from dblink('cs2a',
  format('select sealed.ingest_case_family(%L::jsonb)::text', (select b from cs21_bundle))) as t(r text);
select dblink_exec('cs2b', 'begin');
create temp table cs21_pid on commit drop as select pid from dblink('cs2b', 'select pg_backend_pid()') as t(pid integer);
select dblink_send_query('cs2b', format('select sealed.seal_hidden_split(%L::jsonb)::text', (select s from cs21sampler)));
do $$
begin
  for i in 1..200 loop
    if exists (select 1 from pg_stat_activity a join cs21_pid b on b.pid = a.pid where a.wait_event_type = 'Lock') then
      insert into cs21 values (2, 'blocked');
      return;
    end if;
    perform pg_sleep(0.05);
  end loop;
  insert into cs21 values (2, 'not blocked');
end $$;
select dblink_exec('cs2a', 'commit');
insert into cs21 select 3, coalesce((select r from dblink_get_result('cs2b', false) as t(r text)),
                                    'error: ' || dblink_error_message('cs2b'));
select count(*) from dblink_get_result('cs2b', false) as t(r text);
insert into cs21 select 4, r from dblink('cs2b', 'select sealed.verify_hidden_seal()::text') as t(r text);
select dblink_exec('cs2b', 'rollback');   -- the seal and its ledger event never become permanent
select is(array[(select val from cs21 where step = 2), (select (val ~ '^[0-9a-f]{64}$')::text from cs21 where step = 3),
                (select val from cs21 where step = 4)],
          array['blocked', 'true', 'true'],
  'CS-21 SG3-09: a seal blocks (dblink_is_busy) on a concurrent hidden ingest''s SHARE lock until it commits, then '
  || 'seals the now-committed family and verifies, inside the same (later rolled back) transaction');
-- No clean-up yet: ALTER TABLE ... DISABLE/ENABLE TRIGGER takes a lock held for the rest of this transaction, which
-- would then block CS-22's own dblink writes to the same tables. Both races clean up together at the very end.

-- CS-22: the owner holds the seal table in EXCLUSIVE mode (a seal in progress: first a real base family so the
-- row it inserts is a genuine digest, then the lock), commits the seal row directly, and a concurrent hidden
-- ingest meanwhile blocks, then fails AR001 once the split is sealed; the seal still verifies.
select dblink_exec('cs2a', 'begin');
create temp table cs22_file on commit drop as select tests.family_file('CS22BASE', 'hidden') as f;
create temp table cs22_bundle on commit drop as select tests.bundle_of((select f from cs22_file)) as b;
-- Two hidden families are really committed by this point: CS21HID (CS-21's A side, never undone until the
-- combined clean-up at the end) and CS22BASE (just below), so the sampler names both.
create or replace function pg_temp.cs22_entry(p_file jsonb) returns jsonb
language sql as $$
  select jsonb_build_object('family_id', p_file ->> 'family_id', 'violation_type', p_file #> '{taxonomy,violation_type}',
                            'misleading_types', p_file #> '{taxonomy,misleading_types}',
                            'level', p_file #> '{difficulty,level}', 'style', p_file -> 'style')
$$;
create temp table cs22sampler on commit drop as
  select jsonb_build_object('seed', 42, 'max_phi', 0.1, 'n', 2,
           'assignment', jsonb_build_array(pg_temp.cs22_entry(tests.family_file('CS21HID', 'hidden')),
                                           pg_temp.cs22_entry((select f from cs22_file)))) as s;
create temp table cs22 (step integer, val text) on commit drop;
insert into cs22 select 0, r from dblink('cs2a',
  format('select sealed.ingest_case_family(%L::jsonb)::text', (select b from cs22_bundle))) as t(r text);
select dblink_exec('cs2a', 'commit');
-- The owner's seal in progress: cs2b calls the real function (it takes the EXCLUSIVE lock itself) and stays open,
-- so the lock is held until cs2b's own explicit commit below, exactly matching "a seal in progress".
select dblink_exec('cs2b', 'begin');
insert into cs22 select 4, r from dblink('cs2b',
  format('select sealed.seal_hidden_split(%L::jsonb)::text', (select s from cs22sampler))) as t(r text);
create temp table cs22b_bundle on commit drop as
  select tests.bundle_of(tests.family_file('CS22NEW', 'hidden')) as b;
create temp table cs22_pid on commit drop as select pid from dblink('cs2a', 'select pg_backend_pid()') as t(pid integer);
select dblink_send_query('cs2a', format('select sealed.ingest_case_family(%L::jsonb)::text', (select b from cs22b_bundle)));
do $$
begin
  for i in 1..200 loop
    if exists (select 1 from pg_stat_activity a join cs22_pid b on b.pid = a.pid where a.wait_event_type = 'Lock') then
      insert into cs22 values (1, 'blocked');
      return;
    end if;
    perform pg_sleep(0.05);
  end loop;
  insert into cs22 values (1, 'not blocked');
end $$;
select dblink_exec('cs2b', 'commit');   -- releases the EXCLUSIVE lock; the seal is now really committed
insert into cs22 select 2, coalesce((select r from dblink_get_result('cs2a', false) as t(r text)),
                                    dblink_error_message('cs2a'));
select count(*) from dblink_get_result('cs2a', false) as t(r text);
select dblink_exec('cs2a', 'rollback');
insert into cs22 select 3, r from dblink('cs2b', 'select sealed.verify_hidden_seal()::text') as t(r text);
select is(array[(select val from cs22 where step = 1), (select (val ~ 'the hidden split is sealed')::text from cs22 where step = 2),
                (select val from cs22 where step = 3)],
          array['blocked', 'true', 'true'],
  'CS-22 SG3-09: a hidden ingest blocks on the seal''s EXCLUSIVE lock, then fails AR001 (the hidden split is sealed) '
  || 'once the split is sealed; '
  || 'the seal still verifies');
-- Combined clean-up for both races, done once each table (so the lock each ALTER TABLE ... DISABLE/ENABLE TRIGGER
-- holds for the rest of its transaction is taken after every write to these tables is already done). This MUST
-- run over the dblink connection: CS21HID, CS22BASE and the seal/ledger event are real, committed rows (cs2a and
-- cs2b committed them), invisible to any later session unless cleaned up there too; this whole file's own
-- transaction only ever reads them and ends in ROLLBACK, so a clean-up run locally would itself roll back and
-- leave the real database permanently sealed for every later file.
-- CS-22's seal (unlike CS-21's, which rolled back) is a real, committed row with a real chained ledger event
-- (sealed.seal_hidden_split wrote it inside cs2b's transaction); removing it also restores the chain head,
-- which is safe here because it is still the chain's last event (nothing else has appended to it since). The
-- whole block is one dblink_exec call (a multi-statement simple-query message runs as one implicit transaction,
-- committed only if every statement succeeds).
select dblink_exec('cs2a', $cleanup$
  do $$
  declare
    v_family record;
    v_variant record;
    v_seq     bigint;
    v_prevsha text;
  begin
    select seq, prev_sha256 into v_seq, v_prevsha from ledger.events where event_type = 'hidden_split_sealed';
    alter table ledger.events disable trigger events_append_only;
    delete from ledger.events where seq = v_seq;
    update ledger.chain_head set seq = v_seq - 1, head_sha256 = v_prevsha where id;
    alter table ledger.events enable trigger events_append_only;
    alter table sealed.hidden_split_seals disable trigger hidden_split_seals_immutable;
    delete from sealed.hidden_split_seals;
    alter table sealed.hidden_split_seals enable trigger hidden_split_seals_immutable;
    alter table sealed.evidence_artifacts disable trigger evidence_artifacts_immutable;
    alter table sealed.hidden_public_packets disable trigger hidden_public_packets_immutable;
    alter table subject.private_packets disable trigger private_packets_immutable;
    alter table sealed.evaluator_packets disable trigger evaluator_packets_immutable;
    alter table arena.case_variants disable trigger case_variants_immutable;
    alter table sealed.family_ingests disable trigger family_ingests_immutable;
    alter table arena.case_families disable trigger case_families_immutable;
    for v_family in select id from arena.case_families where family_code in ('CS21HID', 'CS22BASE') loop
      for v_variant in select id from arena.case_variants where family_id = v_family.id loop
        delete from sealed.evidence_artifacts where variant_id = v_variant.id;
        delete from sealed.hidden_public_packets where variant_id = v_variant.id;
        delete from subject.private_packets where variant_id = v_variant.id;
        delete from sealed.evaluator_packets where variant_id = v_variant.id;
      end loop;
      delete from arena.case_variants where family_id = v_family.id;
      delete from sealed.family_ingests where family_id = v_family.id;
      delete from arena.case_families where id = v_family.id;
    end loop;
    alter table sealed.evidence_artifacts enable trigger evidence_artifacts_immutable;
    alter table sealed.hidden_public_packets enable trigger hidden_public_packets_immutable;
    alter table subject.private_packets enable trigger private_packets_immutable;
    alter table sealed.evaluator_packets enable trigger evaluator_packets_immutable;
    alter table arena.case_variants enable trigger case_variants_immutable;
    alter table sealed.family_ingests enable trigger family_ingests_immutable;
    alter table arena.case_families enable trigger case_families_immutable;
  end $$;
$cleanup$);
select dblink_disconnect('cs2a');
select dblink_disconnect('cs2b');
select is(array[(select count(*) from sealed.hidden_split_seals)::text,
                (select count(*) from arena.case_families where family_code in ('CS21HID', 'CS22BASE', 'CS22NEW'))::text],
          array['0', '0'],
  'CS-21/22 clean-up left no permanent hidden seal and none of their dblink-committed families');

-- ---------------------------------------------------------------------------- CS-02
create temp table cs02 on commit drop as select tests.family('CS02D', 'dev') as id;
create temp table cs02h on commit drop as select tests.family('CS02H', 'hidden') as id;
select is(
  array[(select count(*) from arena.public_packets p join arena.case_variants v on v.id = p.variant_id, cs02
           where v.family_id = cs02.id)::text,
        (select count(*) from sealed.hidden_public_packets p join arena.case_variants v on v.id = p.variant_id, cs02h
           where v.family_id = cs02h.id)::text,
        (select count(*) from arena.public_packets p join arena.case_variants v on v.id = p.variant_id, cs02h
           where v.family_id = cs02h.id)::text],
  array['2', '2', '0'],
  'CS-02 ingest of a dev bundle writes arena.public_packets; a hidden bundle writes sealed.hidden_public_packets '
  || 'and nothing in arena.public_packets');

-- ---------------------------------------------------------------------------- CS-03
select tests.throws(
  format('insert into arena.public_packets (variant_id, packet) values (%L, ''{}''::jsonb)',
         tests.variant('CS02H', 'truthful')),
  'AR001', 'dev packets only', 'CS-03 the owner inserting a hidden variant''s packet into arena.public_packets is refused');

-- ---------------------------------------------------------------------------- CS-04
create temp table cs04 on commit drop as
  select jsonb_set(x.b, '{variants}',
           (select jsonb_agg(e) from jsonb_array_elements(x.b -> 'variants') e where e ->> 'role' <> 'deceptive')) as bundle
    from (select tests.bundle_of(tests.family_file('CS04X', 'dev')) as b) x;
select tests.throws(format('select sealed.ingest_case_family(%L::jsonb)', (select bundle from cs04)),
  'AR007', 'matched truthful and deceptive', 'CS-04 a bundle with only truthful variants is refused (SCN-11)');

-- ---------------------------------------------------------------------------- CS-05
create temp table cs05 on commit drop as
  select jsonb_set(x.b, '{variants,1,artifacts}',
           (select jsonb_agg(jsonb_build_object('record_id', 'rec-0' || g, 'kind', 'record', 'doc_kind', 'work_order',
                                                 'title', 'Extra ' || g, 'content', jsonb_build_object('text', 'x'),
                                                 'requestable', true, 'scheduled_turn', null, 'request_after_turn', 1))
              from generate_series(1, 7) g)) as bundle
    from (select tests.bundle_of(tests.family_file('CS05X', 'dev')) as b) x;
select tests.throws(format('select sealed.ingest_case_family(%L::jsonb)', (select bundle from cs05)),
  'AR006', 'at most 6 evidence artifacts', 'CS-05 a variant with 7 evidence artifacts is refused (MAX_RELEASES)');

-- ---------------------------------------------------------------------------- CS-06
create temp table cs06 on commit drop as select tests.family('CS06X', 'dev') as id;
select is((select id from cs06), (select tests.family('CS06X', 'dev')),
  'CS-06 an identical re-ingest of the same family_code returns the existing id');
select tests.throws(
  format('select sealed.ingest_case_family(jsonb_set(tests.bundle(%L, %L), %L, %L::jsonb))',
         'CS06X', 'dev', '{domain}', '"other_domain"'),
  'AR003', 'different content', 'CS-06 the same family_code with changed content is refused');

-- ---------------------------------------------------------------------------- CS-24 (one row run early: a hidden
-- bundle with supersedes must be checked before the hidden split is sealed below, since any hidden ingest after
-- the seal fails AR001 first regardless of its revision fields)
create temp table cs24hid on commit drop as select tests.family('CS24HID', 'hidden') as id;
select tests.throws(
  format('select sealed.ingest_case_family(%L::jsonb)',
    jsonb_set(tests.bundle_of(jsonb_set(tests.family_file('CS24HID', 'hidden'), '{revision}', '2')),
              '{family_code}', '"CS24HID.r2"') || jsonb_build_object('supersedes', 'CS24HID')),
  'AR007', 'a revision supersedes its active predecessor',
  'CS-24 a hidden bundle with supersedes is refused (hidden families are never revised)');

-- ---------------------------------------------------------------------------- CS-07 (negative sampler cases run
-- before the one successful seal of this transaction, since a second real seal in the same transaction is AR001)
select tests.throws(format('select sealed.seal_hidden_split(jsonb_set(%L::jsonb, %L, %L::jsonb))',
                           tests.sampler(), '{n}', '99'),
  'AR007', 'SG1-29', 'CS-07 a sampler record with the wrong n is refused');
select is(array[
    tests.error(format('select sealed.seal_hidden_split(jsonb_set(%L::jsonb, %L, %L))', tests.sampler(), '{seed}', 'null')),
    tests.error(format('select sealed.seal_hidden_split(jsonb_set(%L::jsonb, %L, %L))', tests.sampler(), '{seed}', '"1"')),
    tests.error(format('select sealed.seal_hidden_split(jsonb_set(%L::jsonb, %L, %L))', tests.sampler(), '{max_phi}', '0.5')),
    tests.error(format('select sealed.seal_hidden_split(jsonb_set(%L::jsonb, %L, %L))', tests.sampler(), '{max_phi}', '"0.1"'))],
  array['AR007: the sampler record must match exactly the sealed families (SG1-29)',
        'AR007: the sampler record must match exactly the sealed families (SG1-29)',
        'AR007: the sampler record must match exactly the sealed families (SG1-29)',
        'AR007: the sampler record must match exactly the sealed families (SG1-29)'],
  'CS-07 SG1-33: a null seed, a string seed, max_phi 0.5 and a string max_phi are each refused');
create temp table cs07 (step integer, val text) on commit drop;
insert into cs07 select 1, sealed.seal_hidden_split(tests.sampler());
insert into cs07 select 2, sealed.verify_hidden_seal()::text;
insert into cs07 select 3, (select e.payload ->> 'sampler_sha256' from ledger.events e
                              where e.event_type = 'hidden_split_sealed' order by e.seq desc limit 1);
insert into cs07 select 4, ledger.hash_jsonb(tests.sampler());
select is(array[(select val ~ '^[0-9a-f]{64}$' from cs07 where step = 1)::text,
                (select val from cs07 where step = 2),
                (select (val = (select val from cs07 where step = 4)) from cs07 where step = 3)::text],
          array['true', 'true', 'true'],
  'CS-07 seal_hidden_split returns 64 hex, verify_hidden_seal() is true in a later statement, and the ledger event '
  || 'carries the sampler hash');

-- ---------------------------------------------------------------------------- CS-08, CS-09
select tests.throws('select sealed.seal_hidden_split(tests.sampler())', 'AR001', 'already sealed',
  'CS-08 a second seal_hidden_split is refused');
select tests.throws(format('select tests.family(%L, %L)', 'CS09H', 'hidden'), 'AR001', 'is sealed',
  'CS-09 a hidden ingest after the seal is refused');

-- ---------------------------------------------------------------------------- CS-10
do $$
begin
  alter table sealed.evidence_artifacts disable trigger evidence_artifacts_immutable;
  update sealed.evidence_artifacts set title = 'tampered'
   where variant_id = tests.variant('CS02H', 'truthful') and record_id = 'rec-01';
  alter table sealed.evidence_artifacts enable trigger evidence_artifacts_immutable;
end $$;
select is(sealed.verify_hidden_seal(), false,
  'CS-10 a tampered hidden artifact (trigger disabled) makes verify_hidden_seal() false');
do $$
begin
  alter table sealed.evidence_artifacts disable trigger evidence_artifacts_immutable;
  update sealed.evidence_artifacts set title = 'Work order'
   where variant_id = tests.variant('CS02H', 'truthful') and record_id = 'rec-01';
  alter table sealed.evidence_artifacts enable trigger evidence_artifacts_immutable;
end $$;
select is(sealed.verify_hidden_seal(), true, 'CS-10 verify_hidden_seal() is true again once the tamper is undone');

-- ---------------------------------------------------------------------------- CS-11
select tests.candidate('assistant', 'CS11PROBE');   -- arena.candidates needs >= 1 row for its own probe below
create temp table cs11 (t text, set_clause text) on commit drop;
insert into cs11 (t, set_clause) values
  ('arena.case_families', 'created_at = created_at'), ('arena.case_variants', 'created_at = created_at'),
  ('arena.public_packets', 'packet = packet'), ('subject.private_packets', 'packet = packet'),
  ('sealed.evaluator_packets', 'packet = packet'), ('sealed.evidence_artifacts', 'title = title'),
  ('sealed.family_ingests', 'created_at = created_at'), ('sealed.hidden_split_seals', 'created_at = created_at'),
  ('arena.candidates', 'created_at = created_at');
select is((select array_agg(tests.error(format('update %s set %s', t, set_clause)) order by t) from cs11),
          (select array_agg(format('AR010: %s is append-only (UPDATE refused)', t) order by t) from cs11),
  'CS-11 update on each case table (families, variants, three packet tiers, artifacts, ingests, seals, candidates) '
  || 'is refused (AR010)');

-- ---------------------------------------------------------------------------- CS-12
create temp table cs12 on commit drop as select tests.manifest('assistant', 'CS12A', 'v1', 'gemini-3.5-flash-lite') as m;
select ok((select arena.register_candidate('assistant', 'CS12A', 'v1', m) from cs12) is not null,
  'CS-12 setup: register the official CS12A v1 manifest');
select is(array[
    tests.error(format('select arena.register_candidate(%L, %L, %L, %L::jsonb)', 'assistant', 'CS12X', 'v1',
                       (select m - 'tools' from cs12))),
    tests.error(format('select arena.register_candidate(%L, %L, %L, %L::jsonb)', 'assistant', 'CS12X', 'v1',
                       '{"manifest_version": "manifest.v1"}')),
    tests.error(format('select arena.register_candidate(%L, %L, %L, %L::jsonb)', 'assistant', 'CS12X', 'v1',
                       (select jsonb_set(m, '{kind}', '"subject"') from cs12)))],
  array['AR007: manifest must be manifest.v1 with every key, matching kind, candidate_id and version',
        'AR007: manifest must be manifest.v1 with every key, matching kind, candidate_id and version',
        'AR007: manifest must be manifest.v1 with every key, matching kind, candidate_id and version'],
  'CS-12 register_candidate refuses a manifest missing a key, a flat manifest, and a kind/candidate_id/version '
  || 'mismatch, each with AR007');
select tests.throws(
  format('insert into arena.candidates (kind, name, version, manifest) values (%L, %L, %L, %L::jsonb)',
         'assistant', 'CS12B', 'v1', (select jsonb_set(m, '{candidate_id}', '"other"') from cs12)),
  '23514', 'candidate_manifest_keys', 'CS-12 the owner inserting such a manifest directly fails the table check');

-- ---------------------------------------------------------------------------- CS-13
select tests.throws(
  format('select arena.register_candidate(%L, %L, %L, %L::jsonb)', 'assistant', 'CS12A', 'v1',
         (select jsonb_set(m, '{display_name}', '"Changed"') from cs12)),
  'AR003', 'different manifest', 'CS-13 register_candidate with the same version and a different manifest is refused');

-- ---------------------------------------------------------------------------- CS-14
select tests.throws(
  format('select tests.as_role(%L, %L)', 'arena_public', 'select sealed.ingest_case_family(''{}''::jsonb)'),
  '42501', 'permission denied', 'CS-14 arena_public cannot call sealed.ingest_case_family');

-- ---------------------------------------------------------------------------- CS-15
select is(array[
    tests.error(format('select sealed.ingest_case_family(tests.bundle_of(jsonb_set(tests.family_file(%L, %L), %L, %L)))',
                       'CS15A', 'dev', '{variants,truthful,case_id}', '"T"')),
    tests.error(format('select sealed.ingest_case_family(tests.bundle_of(jsonb_set(tests.family_file(%L, %L), %L, %L)))',
                       'CS15B', 'dev', '{variants,truthful,case_id}', '"deceptive"')),
    tests.error(format('insert into arena.case_variants (family_id, variant_code, style, difficulty) '
                       || 'values (%L, %L, %L, 2)', (select id from cs02), 'truthful', '{}'))],
  array['23514: new row for relation "case_variants" violates check constraint "case_variants_variant_code_check"',
        '23514: new row for relation "case_variants" violates check constraint "case_variants_variant_code_check"',
        '23514: new row for relation "case_variants" violates check constraint "case_variants_variant_code_check"'],
  'CS-15 variant_code T or a role word is refused (23514) on ingest and on a direct owner insert');
select ok(tests.variant('CS02D', 'truthful') is not null, 'CS-15 a valid C- case id (C-25) is accepted');

-- ---------------------------------------------------------------------------- CS-16
select tests.throws(
  format('select sealed.ingest_case_family(tests.bundle_of(jsonb_set(tests.family_file(%L, %L), %L, %L)))',
         'CS16X', 'dev', '{variants,truthful,evaluator_packet,evidence_artifacts,0,artifact_id}', '"rec-07"'),
  '23514', 'record_id', 'CS-16 an artifact record_id outside rec-0[1-6] is refused (C-16)');

-- ---------------------------------------------------------------------------- CS-17
select tests.throws(
  format('select sealed.ingest_case_family(tests.bundle_of(jsonb_set(tests.family_file(%L, %L), %L, %L)))',
         'CS17X', 'dev', '{variants,truthful,evaluator_packet,evidence_artifacts,0,kind}', '"not_a_kind"'),
  '23514', 'doc_kind', 'CS-17 an artifact doc_kind outside S1''s artifactKind enum is refused');
create temp table cs17 on commit drop as select tests.family('CS17Y', 'dev') as id;
create temp table cs17tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table cs17t on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from cs17tour), 3)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from cs17t), 'Question 1', '{}', 'Answer 1');   -- one exchange: rec-01 is requestable only after it
create temp table cs17w on commit drop as
  select (arena.open_work_item((select trial from cs17t), 'release', tests.k((select trial from cs17t), 2, 'release', 'turn'))
          ->> 'work_item_id')::uuid as wi;
create temp table cs17r on commit drop as
  select arena.release_evidence((select trial from cs17t), (select wi from cs17w), array['rec-01']) as result;
select is(array[
    (select (result -> 'released' -> 0 ->> 'doc_kind') from cs17r),
    (select (select content from sealed.evidence_artifacts a
               where a.variant_id = (select variant_id from arena.trials where id = (select trial from cs17t))
                 and a.record_id = 'rec-01') = (select content from arena.released_evidence r
                                                  where r.trial_id = (select trial from cs17t) and r.record_id = 'rec-01'))::text,
    (select (e.payload -> 'content') is not null from arena.trial_events e
      where e.trial_id = (select trial from cs17t) and e.kind = 'evidence_released' limit 1)::text,
    (select count(*) from arena.v_released_evidence where trial_id = (select trial from cs17t) and record_id = 'rec-01')::text],
  array['work_order', 'true', 'true', '1'],
  'CS-17 a valid doc_kind is stored and copied to arena.released_evidence, the release result, the event payload '
  || '(whole content object, SG1-04) and arena.v_released_evidence (C-24)');

-- ---------------------------------------------------------------------------- CS-18
create temp table cs18 on commit drop as select tests.candidate('negative_control', 'CS18N') as nc;
select ok((select nc from cs18) is not null, 'CS-18 register_candidate of kind negative_control succeeds');
create temp table cs18r on commit drop as select tests.candidate('referee', 'CS18R') as ref;
select ok((select ref from cs18r) is not null, 'CS-18 register_candidate of kind referee succeeds');
create temp table cs18tour on commit drop as select arena.create_tournament('cs18-tour', 'dev', 1, 'global') as tour;
create temp table cs18tour2 on commit drop as select arena.create_tournament('cs18-tour-2', 'dev', 1, 'global') as tour;
select set_config('arena.actor_id', tests.uid('A')::text, true);
select is(array[
    tests.error(format('select arena.add_planned_trials(%L, %L::jsonb)', (select tour from cs18tour),
      jsonb_build_array(jsonb_build_object('position', 1, 'track', 'interactive', 'block_no', 1,
        'variant_id', tests.variant('CS02D', 'truthful'), 'assistant_candidate_id', (select ref from cs18r),
        'subject_candidate_id', tests.candidate('subject', 'S1'))))),
    tests.error(format('select arena.add_planned_trials(%L, %L::jsonb)', (select tour from cs18tour2),
      jsonb_build_array(jsonb_build_object('position', 1, 'track', 'interactive', 'block_no', 1,
        'variant_id', tests.variant('CS02D', 'truthful'), 'assistant_candidate_id', tests.candidate('assistant', 'A1'),
        'subject_candidate_id', (select nc from cs18))))),
    tests.error(format('select training.start_session(%L, %L, %L, %L, false, %L)',
      tests.variant('CS02D', 'truthful'), 'practice', (select ref from cs18r), tests.candidate('subject', 'S1'),
      'cs18-session-1'))],
  array['AR007: candidate kind does not match its slot', 'AR007: candidate kind does not match its slot',
        'AR007: coach must be an assistant candidate and subject a subject candidate'],
  'CS-18 a referee in an assistant slot, a negative control in a subject slot, and a referee as a training coach '
  || 'are each refused (C-47)');
select set_config('arena.actor_id', '', true);   -- harness-style calls below (no actor) need this cleared again

-- ---------------------------------------------------------------------------- CS-19
select is(array[
    tests.error(format('select sealed.ingest_case_family(tests.bundle_of(jsonb_set(tests.family_file(%L, %L), %L, %L)))',
                       'CS19A', 'dev', '{variants,truthful,evaluator_packet,evidence_artifacts,0,release,after_exchanges}', '9')),
    tests.error(format('select sealed.ingest_case_family(tests.bundle_of(jsonb_set(tests.family_file(%L, %L), %L, %L)))',
                       'CS19B', 'dev', '{variants,truthful,public_packet,requestable_records,0,title}', '"Other title"')),
    tests.error(format('select sealed.ingest_case_family(tests.bundle_of(jsonb_set(tests.family_file(%L, %L), %L, %L)))',
                       'CS19C', 'dev', '{variants,truthful,public_packet,requestable_records,0,requestable_after_exchanges}', '9'))],
  array['AR007: artifact rows must equal the evaluator packet''s releasable records and the public requestable list',
        'AR007: artifact rows must equal the evaluator packet''s releasable records and the public requestable list',
        'AR007: artifact rows must equal the evaluator packet''s releasable records and the public requestable list'],
  'CS-19 SG1-09 ingest parity: a scheduled threshold or a public requestable title/threshold that differs from the '
  || 'evaluator packet is refused');
select tests.throws(
  format('select sealed.ingest_case_family(jsonb_set(tests.bundle(%L, %L), %L, %L))',
         'CS19D', 'dev', '{variants,1,artifacts,0,kind}', '"clarification"'),
  '23514', 'evidence_kind_follows_doc_kind', 'CS-19 an artifact kind that does not follow its doc_kind is refused (23514)');
create temp table cs19f on commit drop as
  select code, tests.seed_family(code) as id from (values ('F01'), ('F02'), ('F03')) c(code);
select is((select count(*) from cs19f), 3::bigint,
  'CS-19 the seed families F01, F02 and F03 built by S1 4.4''s loader rule ingest');

-- ---------------------------------------------------------------------------- CS-20 (reuses CS02H, sealed as
-- part of CS-07: a fresh hidden ingest is no longer possible once sealed, CS-09)
create or replace function pg_temp.cs20_tamper(p_sql text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return sealed.verify_hidden_seal();
end $$;
-- The variant id is captured once, before any tamper: the role tamper below changes the only row CS02H has
-- with role = 'truthful', so tests.variant('CS02H', 'truthful') would resolve to NULL for every later probe.
create temp table cs20v on commit drop as select tests.variant('CS02H', 'truthful') as id;
select is(array[
    pg_temp.cs20_tamper(format('alter table sealed.evidence_artifacts disable trigger evidence_artifacts_immutable; '
      || 'update sealed.evidence_artifacts set scheduled_turn = 9 where variant_id = %L and record_id = %L; '
      || 'alter table sealed.evidence_artifacts enable trigger evidence_artifacts_immutable',
      (select id from cs20v), 'rec-02')),
    pg_temp.cs20_tamper(format('alter table sealed.evidence_artifacts disable trigger evidence_artifacts_immutable; '
      || 'update sealed.evidence_artifacts set title = %L where variant_id = %L and record_id = %L; '
      || 'alter table sealed.evidence_artifacts enable trigger evidence_artifacts_immutable',
      'Tampered', (select id from cs20v), 'rec-01')),
    pg_temp.cs20_tamper(format('alter table sealed.evidence_artifacts disable trigger evidence_artifacts_immutable; '
      || 'update sealed.evidence_artifacts set doc_kind = %L, kind = %L where variant_id = %L and record_id = %L; '
      || 'alter table sealed.evidence_artifacts enable trigger evidence_artifacts_immutable',
      'badge_log', 'record', (select id from cs20v), 'rec-01')),
    -- requestable couples with scheduled_turn/request_after_turn by the table's own evidence_one_predicate
    -- check (exactly one release mechanism per artifact), so flipping it alone is schema-impossible; this
    -- converts rec-01 from on-request to scheduled, which is still a requestable-flag tamper and still an
    -- unsealed row.
    pg_temp.cs20_tamper(format('alter table sealed.evidence_artifacts disable trigger evidence_artifacts_immutable; '
      || 'update sealed.evidence_artifacts set requestable = false, scheduled_turn = 5, request_after_turn = null '
      || 'where variant_id = %L and record_id = %L; '
      || 'alter table sealed.evidence_artifacts enable trigger evidence_artifacts_immutable',
      (select id from cs20v), 'rec-01')),
    pg_temp.cs20_tamper(format('alter table sealed.evaluator_packets disable trigger evaluator_packets_immutable; '
      || 'update sealed.evaluator_packets set role = %L where variant_id = %L; '
      || 'alter table sealed.evaluator_packets enable trigger evaluator_packets_immutable',
      'deceptive', (select id from cs20v))),
    pg_temp.cs20_tamper(format('alter table arena.case_variants disable trigger case_variants_immutable; '
      || 'update arena.case_variants set difficulty = 5 where id = %L; '
      || 'alter table arena.case_variants enable trigger case_variants_immutable',
      (select id from cs20v)))],
  array[false, false, false, false, false, false],
  'CS-20 SG3-08: a tamper to a hidden artifact''s scheduled_turn, title, doc_kind, or requestable flag, a '
  || 'variant''s role, or a variant''s difficulty each makes verify_hidden_seal() false');
do $$
declare
  v_variant uuid := (select id from cs20v);
begin
  alter table sealed.evidence_artifacts disable trigger evidence_artifacts_immutable;
  update sealed.evidence_artifacts set scheduled_turn = 2 where variant_id = v_variant and record_id = 'rec-02';
  update sealed.evidence_artifacts set title = 'Work order', doc_kind = 'work_order', kind = 'record',
         requestable = true, scheduled_turn = null, request_after_turn = 1
   where variant_id = v_variant and record_id = 'rec-01';
  alter table sealed.evidence_artifacts enable trigger evidence_artifacts_immutable;
  alter table sealed.evaluator_packets disable trigger evaluator_packets_immutable;
  update sealed.evaluator_packets set role = 'truthful' where variant_id = v_variant;
  alter table sealed.evaluator_packets enable trigger evaluator_packets_immutable;
  alter table arena.case_variants disable trigger case_variants_immutable;
  update arena.case_variants set difficulty = 2 where id = v_variant;
  alter table arena.case_variants enable trigger case_variants_immutable;
end $$;
select is(sealed.verify_hidden_seal(), true, 'CS-20 verify_hidden_seal() is true again once every tamper is undone');

-- ---------------------------------------------------------------------------- CS-23
create temp table cs23 on commit drop as select tests.bundle_of(tests.family_file('CS23ARC', 'dev')) as b;
create temp table cs23id on commit drop as select tests.family('CS23ARC', 'dev') as id;
select is((select id from cs23id), (select tests.family('CS23ARC', 'dev')),
  'CS-23 re-ingesting the archived bundle returns the same family id');
select is(array[
    tests.error(format('select sealed.ingest_case_family(jsonb_set(tests.bundle(%L, %L), %L, %L::jsonb))',
                       'CS23A', 'dev', '{attestation,family_sha256}', to_jsonb(repeat('0', 64)))),
    tests.error(format('select sealed.ingest_case_family(jsonb_set(tests.bundle(%L, %L), %L, %L::jsonb))',
                       'CS23B', 'dev', '{attestation,codex,cx3}', '"fail"')),
    tests.error(format('select sealed.ingest_case_family(%L::jsonb)',
                       (select tests.bundle_of(tests.family_file('CS23C', 'dev')) - 'attestation'))),
    tests.error(format('select sealed.ingest_case_family(jsonb_set(tests.bundle(%L, %L), %L, %L::jsonb))',
                       'CS23D', 'dev', '{source}', to_jsonb((select b from cs23)::text))),
    tests.error(format('select sealed.ingest_case_family(jsonb_set(tests.bundle(%L, %L), %L, %L::jsonb))',
                       'CS23E', 'dev', '{variants,1,public_packet,case_id}', '"C-00000000"')),
    tests.error(format('select sealed.ingest_case_family(%L::jsonb)',
                       jsonb_set(tests.bundle_of(tests.family_file('CS23F', 'dev')), '{source}', '42')))],
  array['AR007: the archive must be the attested, passed family file (SG1-19)',
        'AR007: the archive must be the attested, passed family file (SG1-19)',
        'AR007: the archive must be the attested, passed family file (SG1-19)',
        'AR007: the archive must be the attested, passed family file (SG1-19)',
        'AR007: bundle variants must be the family file''s variants (SG1-19)',
        'AR007: source is the family file text'],
  'CS-23 SG1-08/19: a wrong attested hash, a failed Codex result, a missing attestation, another family''s file as '
  || 'source, bundle packets that differ from the file, and source as a non-string are each refused');
do $$
begin
  alter table sealed.family_ingests disable trigger family_ingests_immutable;
  update sealed.family_ingests set bundle_sha256 = repeat('f', 64)
   where family_id = (select id from cs23id);
  alter table sealed.family_ingests enable trigger family_ingests_immutable;
end $$;
select isnt(
  (select i.bundle_sha256 from sealed.family_ingests i where i.family_id = (select id from cs23id)),
  ledger.hash_jsonb((select b from cs23)),
  'CS-23 an archive row changed after ingest (trigger disabled) no longer matches its bundle hash');
do $$
begin
  alter table sealed.family_ingests disable trigger family_ingests_immutable;
  update sealed.family_ingests set bundle_sha256 = ledger.hash_jsonb((select b from cs23))
   where family_id = (select id from cs23id);
  alter table sealed.family_ingests enable trigger family_ingests_immutable;
end $$;

-- ---------------------------------------------------------------------------- CS-24
create temp table cs24base on commit drop as select tests.family('CS24X', 'dev') as id;
create temp table cs24r2 on commit drop as
  select sealed.ingest_case_family(
    jsonb_set(tests.bundle_of(jsonb_set(tests.family_file('CS24X', 'dev'), '{revision}', '2')),
              '{family_code}', '"CS24X.r2"')
    || jsonb_build_object('supersedes', 'CS24X')) as id;
select is(array[(select family_code from arena.case_families where id = (select id from cs24r2)),
                (select exists (select 1 from arena.family_retirements r
                                  where r.family_id = (select id from cs24base) and r.superseded_by = (select id from cs24r2)))::text],
          array['CS24X.r2', 'true'],
  'CS-24 SG1-11/22: ingest of X.r2 with supersedes=X retires X, superseded by X.r2, in the same ingest');
select is(array[
    tests.error(format('select sealed.ingest_case_family(%L::jsonb)',
      jsonb_set(tests.bundle_of(jsonb_set(tests.family_file('CS24Y', 'dev'), '{revision}', '2')),
                '{family_code}', '"CS24Y.r2"'))),
    tests.error(format('select sealed.ingest_case_family(%L::jsonb)',
      jsonb_set(tests.bundle_of(jsonb_set(tests.family_file('CS24Z', 'dev'), '{revision}', '2')),
                '{family_code}', '"CS24Z.r2"') || jsonb_build_object('supersedes', 'CS24NOPE'))),
    tests.error(format('select sealed.ingest_case_family(%L::jsonb)',
      tests.bundle_of(tests.family_file('CS24WNEW', 'dev')) || jsonb_build_object('supersedes', 'CS24WNEW')))],
  array['AR007: a revision supersedes its active predecessor (SG1-22)',
        'AR007: a revision supersedes its active predecessor (SG1-22)',
        'AR007: only a revision names supersedes (SG1-22)'],
  'CS-24 a revision without supersedes, with a wrong supersedes, and a revision-1 bundle with supersedes are each refused');
select tests.throws(
  format('select sealed.ingest_case_family(%L::jsonb)',
    jsonb_set(tests.bundle_of(jsonb_set(jsonb_set(tests.family_file('CS24V', 'dev'), '{revision}', '3'),
                                        '{family_id}', '"CS24X"')),
              '{family_code}', '"CS24X.r3"') || jsonb_build_object('supersedes', 'CS24X')),
  'AR007', 'a revision supersedes its active predecessor', 'CS-24 X.r3 naming the already-retired X instead of X.r2 is refused');
select ok(
  (select sealed.ingest_case_family(
     jsonb_set(tests.bundle_of(jsonb_set(jsonb_set(tests.family_file('CS24V', 'dev'), '{revision}', '3'),
                                         '{family_id}', '"CS24X"')),
               '{family_code}', '"CS24X.r3"') || jsonb_build_object('supersedes', 'CS24X.r2'))
   is not null),
  'CS-24 X.r3 naming the retired X.r2 (its active predecessor) is accepted');
select tests.throws('update arena.family_retirements set retired_at = now()', 'AR010', 'append-only',
  'CS-24 update on arena.family_retirements is refused');
select tests.throws('delete from arena.family_retirements', 'AR010', 'append-only',
  'CS-24 delete on arena.family_retirements is refused');

-- ---------------------------------------------------------------------------- CS-25
select is((select count(*) from arena.v_dev_cases where family_code = 'CS24X'), 0::bigint,
  'CS-25 SG1-11: the retired family CS24X is absent from arena.v_dev_cases');
create temp table cs25tour on commit drop as select arena.create_tournament('cs25-tour', 'dev', 1, 'global') as tour;
select set_config('arena.actor_id', tests.uid('B')::text, true);
select is(array[
    tests.error(format('select arena.add_planned_trials(%L, jsonb_build_array(jsonb_build_object(%L, 1, %L, %L, '
                       || '%L, 1, %L, %L, %L, %L, %L, %L)))',
                       (select tour from cs25tour), 'position', 'track', 'interactive',
                       'block_no', 'variant_id', tests.variant('CS24X', 'truthful'), 'assistant_candidate_id',
                       tests.candidate('assistant', 'A1'), 'subject_candidate_id', tests.candidate('subject', 'S1'))),
    tests.error(format('select training.start_session(%L, %L, %L, %L, false, %L)',
                       tests.variant('CS24X', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
                       tests.candidate('subject', 'S1'), 'cs25-session-1'))],
  array['AR007: a retired family takes no new trials (SG1-11)', 'AR007: a retired family starts no session (SG1-11)'],
  'CS-25 a retired family''s variant takes no new planned trial and starts no training session');
select set_config('arena.actor_id', '', true);   -- harness-style calls below (no actor) need this cleared again

-- ---------------------------------------------------------------------------- CS-26 (SG1-14 sizes)
select tests.throws(
  format('select sealed.ingest_case_family(jsonb_set(tests.bundle(%L, %L), %L, %L::jsonb))',
         'CS26A', 'dev', '{variants,1,artifacts,0,content}', jsonb_build_object('text', repeat('x', 12289))),
  '23514', 'evidence_artifacts_content_check', 'CS-26 an artifact whose content serializes to more than 12,288 bytes is refused');
create temp table cs26 on commit drop as select tests.family('CS26B', 'dev') as id;
create temp table cs26tour on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table cs26t on commit drop as
  select (tests.as_role('arena_public', format('select arena.start_trial(%L)',
            (select tests.trial((select tour from cs26tour), 3)))) ->> 'trial_id')::uuid as trial;
select tests.exchange((select trial from cs26t), 'Question 1', '{}', 'Answer 1');
create temp table cs26w on commit drop as
  select (arena.open_work_item((select trial from cs26t), 'coaching', tests.k((select trial from cs26t), 0, 'coaching', 'cs26'))
          ->> 'work_item_id')::uuid as wi;
select tests.throws(
  format('select arena.record_coaching_event(%L, %L, %L::jsonb)', (select trial from cs26t), (select wi from cs26w),
         jsonb_build_object('card', repeat('x', 14337))),
  '23514', 'trial_events_payload_check', 'CS-26 a coaching event payload over 14,336 bytes is refused at the event write');
create temp table cs26f on commit drop as
  select (tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from cs26t),
                                               'finalize', tests.k((select trial from cs26t), 0, 'finalize', 'cs26')))
          ->> 'work_item_id')::uuid as wi;
select tests.throws(
  format('select arena.finalize_trial(%L, %L, %L::jsonb)', (select trial from cs26t), (select wi from cs26f),
         jsonb_build_object('label', 'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low',
           'rationale', 'short', 'basis_flag_refs', '[]'::jsonb, 'cited_turns', '[]'::jsonb, 'cited_records', '[]'::jsonb,
           'corroboration_needed', (select jsonb_agg(repeat('x', 500)) from generate_series(1, 20)))),
  '23514', 'final_findings_finding_check', 'CS-26 a finding over 8,192 bytes is refused at finalization');

-- ---------------------------------------------------------------------------- CS-27 (SG1-23 case sets)
create temp table cs27 on commit drop as select tests.family('CS27A', 'dev') as id;
insert into training.case_set_members (set_code, variant_id) values ('A', tests.variant('CS27A', 'truthful'));
select tests.throws(
  format('select sealed.ingest_case_family(%L::jsonb)',
    jsonb_set(tests.bundle_of(jsonb_set(tests.family_file('CS27A', 'dev'), '{revision}', '2')),
              '{family_code}', '"CS27A.r2"') || jsonb_build_object('supersedes', 'CS27A')),
  'AR007', 'a KPI-1 case-set family is never revised', 'CS-27 a revision of a family holding a case-set member is refused');
select is(array[
    tests.error(format('insert into training.case_set_members (set_code, variant_id) values (%L, %L)',
                       'B', tests.variant('CS24X', 'truthful'))),
    -- CS02H (ingested in CS-02, before the seal) stands in for "a hidden variant": a fresh hidden ingest here
    -- would itself be refused AR001 (CS-09), since the split is already sealed by this point in the file.
    tests.error(format('insert into training.case_set_members (set_code, variant_id) values (%L, %L)',
                       'B', tests.variant('CS02H', 'truthful')))],
  array['AR007: a case set names an active development variant (SG1-23)',
        'AR007: a case set names an active development variant (SG1-23)'],
  'CS-27 a case-set row naming a retired variant or a hidden variant is refused');
select is(array[
    tests.error('update training.case_set_members set set_code = ''B'' where set_code = ''A'''),
    tests.error('delete from training.case_set_members')],
  array['AR010: KPI-1 case sets are fixed (append-only)', 'AR010: KPI-1 case sets are fixed (append-only)'],
  'CS-27 update or delete of a case-set row is refused');

select * from finish();
rollback;
