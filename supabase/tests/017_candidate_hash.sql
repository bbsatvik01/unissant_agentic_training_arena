-- 017_candidate_hash.sql (S2 3.1, 3.2; WP-10). Rows for migration 1100: the database's candidate hash is S2 3.2's
-- manifest hash, the one arena_core.agents.manifests.manifest_sha256 computes (the literals below are checked against
-- the Python side by packages/core/tests/agents/test_manifest_sql.py).
-- CH-01 ledger.canonical_json renders a value exactly as Python's canonical JSON (sorted keys by code point, compact
-- separators, non-ASCII kept, the same escapes); CH-02 arena.manifest_sha256 drops `sha256` and `frozen_at` before
-- hashing; CH-03 registering the official A1 manifest stores and logs its S2 3.2 hash, and registering it again
-- returns the same row; CH-04 a manifest whose embedded sha256 is not its own hash is refused with AR007; CH-05 a
-- manifest holding a fractional number is refused with AR007; CH-06 the migration guard passes while no tournament
-- has frozen; CH-07 it refuses once one has (the rewrite would break that roster's commitment). CH-08 (two
-- sessions) is 018_candidate_hash_lock.sql, CH-09 is in 016_finding.sql.
begin;
\ir harness/fixtures.psql
select plan(8);

select is(ledger.canonical_json('{"b": [1, {"z": null, "a": true}], "aa": "é \"q\" \\ \n\t\u0001 ✓  ", "A": -3, "sha256": "ignored", "frozen_at": "x", "": [], "ü": {"Z": 0, "a": "x"}}'::jsonb),
          '{"":[],"A":-3,"aa":"é \"q\" \\ \n\t\u0001 ✓  ","b":[1,{"a":true,"z":null}],"frozen_at":"x","sha256":"ignored","ü":{"Z":0,"a":"x"}}',
  'CH-01 canonical JSON equals Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)');

select is(arena.manifest_sha256('{"b": [1, {"z": null, "a": true}], "aa": "é \"q\" \\ \n\t\u0001 ✓  ", "A": -3, "sha256": "ignored", "frozen_at": "x", "": [], "ü": {"Z": 0, "a": "x"}}'::jsonb),
          '89e39e51ccbed27af3358d4696fe39e22654aed8cc3383fc211069187e246552',
  'CH-02 the manifest hash drops sha256 and frozen_at, then hashes the canonical JSON');

create temp table a1 on commit drop as select '{"candidate_id":"A1","coaching_policy":{"deep_update":{"every_n_exchanges":3,"on_release":true},"design":"two_stage","max_flags_per_card":3,"may_request_commit":true},"display_name":"Evidence Strategist","kind":"assistant","limits":{"card":{"attempt_timeout_ms":6000,"deadline_ms":12000,"max_input_tokens":128000,"max_output_tokens":1600,"model_id":"gemini-3.5-flash-lite","thinking_level":"MINIMAL"},"deep":{"attempt_timeout_ms":10000,"deadline_ms":20000,"max_input_tokens":128000,"max_output_tokens":3000,"model_id":"gemini-3.5-flash-lite","thinking_level":"MINIMAL"},"final":{"attempt_timeout_ms":15000,"deadline_ms":30000,"max_input_tokens":128000,"max_output_tokens":3000,"model_id":"gemini-3.5-flash-lite","thinking_level":"MINIMAL"}},"lineage":{"change_note":"initial","parent_sha256":null},"manifest_version":"manifest.v1","model":{"location":"global","provider":"vertex"},"official":true,"prompt":{"assembly":{"card":["prompts/coach/common.v1.txt","prompts/coach/a1.strategy.v1.txt"],"deep":["prompts/coach/a1.deep.v1.txt"],"final":["prompts/coach/common.v1.txt","prompts/coach/a1.strategy.v1.txt","prompts/coach/final.v1.txt"]},"files":[{"path":"prompts/coach/common.v1.txt","sha256":"7824b0e20a1eb3a682f11f2460d996867ab1b8239588f20b20311a61457c09ba"},{"path":"prompts/coach/a1.strategy.v1.txt","sha256":"7d4d06cd276f7c31440e6b0b633428f05bb394e99d95f7193aa58e0ae26cde0f"},{"path":"prompts/coach/a1.deep.v1.txt","sha256":"1d04a6c81e54520f965e320dd99e1f53b4772b3cd04ef8cbf65fd25a35f3a64a"},{"path":"prompts/coach/final.v1.txt","sha256":"0ae3be07bbd9d85b7af8c849ee4b312c60bd5d2b177694c30cc00b7361d62d8a"}],"output_schemas":[{"name":"CoachingCard","sha256":"eb8ce04d2ceb93ba0e43927589d7d63fdd397dbddc2ed90e509819b35350c6b1","version":"card.v1"},{"name":"DeepUpdate","sha256":"83ef146f11fac393e2223cf562fa10843c3361dd2de99f6ea1d2f1b23e2051b1","version":"deep.v1"},{"name":"FinalFinding","sha256":"ad1efadd7020278de1befffc5110a872d94fead85359d303a1caa392c967f8a1","version":"final.v1"}],"user_templates":[{"path":"prompts/coach/user.card.v1.txt","sha256":"046441e4bf52e22a8977f2c6db60701633ac31e3877dd776910f4819e1230c92"},{"path":"prompts/coach/user.deep.v1.txt","sha256":"b677c571fe25f5793dce0c57e92574705b6ae7a3d89ee37a0045b4622f5a83cb"},{"path":"prompts/coach/user.final.v1.txt","sha256":"167fa48c12214e476fc5196ed206cfb2b8e81f379cdd77b1bca449a8b46e37d5"}]},"repair":{"schema_repairs":1,"transient_retries":2},"sampling":{"seed_rule":"sha256(trial:turn:purpose:attempt)[:4]","temperature":null},"sha256":"de01ff7127f6dc6f34ce2721355dc66439ef6cfe5126598907216b4b02d3c63c","subject_policy":null,"tools":["record_request"],"transport":"in_process","version":"1.0.0"}'::jsonb as manifest;
create temp table reg on commit drop as
  select arena.register_candidate('assistant', 'A1', '1.0.0', manifest) as id from a1;
select is((select c.sha256 from arena.candidates c join reg on reg.id = c.id),
          'de01ff7127f6dc6f34ce2721355dc66439ef6cfe5126598907216b4b02d3c63c',
  'CH-03 the stored sha256 of the official A1 manifest is its S2 3.2 hash');
select is((select arena.register_candidate('assistant', 'A1', '1.0.0', manifest) from a1), (select id from reg),
  'CH-03 registering the same manifest again returns the same candidate');

select is(tests.error(format('select arena.register_candidate(%L, %L, %L, %L)', 'assistant', 'A1', '1.0.1',
              (select jsonb_set(manifest, '{version}', '"1.0.1"') from a1))),
          'AR007: manifest sha256 is not its S2 3.2 hash',
  'CH-04 a manifest whose embedded sha256 is not its own hash is refused');

select is(tests.error(format('select arena.register_candidate(%L, %L, %L, %L)', 'assistant', 'A1', '1.0.2',
              (select jsonb_set(manifest - 'sha256', '{version}', '"1.0.2"')
                      || '{"repair": {"schema_repairs": 1.5, "transient_retries": 2}}'::jsonb from a1))),
          'AR007: canonical JSON holds integers only (S2 3.1: a manifest has no floats)',
  'CH-05 a manifest holding a fractional number is refused');

select is(tests.error('select arena.candidate_hash_migration_guard()'), '00000',
  'CH-06 the migration guard passes while every tournament is a draft');
select tests.tournament('dev', array['interactive']);
select is(tests.error('select arena.candidate_hash_migration_guard()'),
          'AR007: migration 1100 would rewrite candidate hashes a frozen roster or a finding commitment commits to',
  'CH-07 the migration guard refuses once a tournament roster is frozen');

select * from finish();
rollback;
