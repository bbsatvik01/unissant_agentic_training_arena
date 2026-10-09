-- 016_finding.sql (S2 4.8, S5 5.4; WP-02). Rows for migration 1000 (proposed for the spec): the stored finding the
-- shared contract produces (arena_core.contracts.findings.InvestigatorFinding.stored(), its canonical JSON below,
-- checked against the contract by packages/core/tests/contracts/test_finding_sql.py) commits through
-- arena.finalize_trial. FN-01 an alternative_explanations that is neither an array nor null is still AR007;
-- FN-02 the contract's finding with alternative_explanations null commits and is stored as sent.
-- The trial is a voice session (it finalizes with released records only); its second exchange releases the
-- scheduled rec-02 the finding cites.
begin;
\ir harness/fixtures.psql
select plan(2);

create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();
select tests.apply_plan(plan) from t_plan;
select tests.family('FDEV', 'dev');
select set_config('arena.actor_id', tests.uid('A')::text, true);
create temp table ft on commit drop as
  select (tests.as_role('arena_public', format('select training.start_session(%L, %L, %L, %L, true, %L)',
            tests.variant('FDEV', 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
            tests.candidate('subject', 'S1'), 'fn-voice-session-1')) ->> 'trial_id')::uuid as trial;

-- One voice session with two stored exchanges (the second releases rec-02), closed and settled.
create function pg_temp.voice_session() returns void
language plpgsql as $$
declare
  v_trial uuid := (select trial from ft);
  v_token text;
  v_ticket uuid;
  v_res uuid;
  v_session text;
  n integer;
begin
  v_token := tests.as_role('arena_public', format('select to_jsonb(training.issue_access_ticket(%L, %L))', 'voice', v_trial))
             #>> '{}';
  v_ticket := (tests.as_role('arena_public', format('select training.redeem_access_ticket(%L, %L)', v_token, 'voice'))
               ->> 'ticket_id')::uuid;
  perform tests.as_role('arena_subject', format('select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))',
                                                v_ticket, tests.uid('A'), v_trial, 'practice'));
  v_res := (tests.as_role('arena_subject', format('select ops.reserve_voice(%L, %L, %L, %L, %L, null)',
              'fn-res-' || v_ticket, 'global', 'voice_session', 'voice.session', v_trial)) ->> 'id')::uuid;
  v_session := tests.as_role('arena_subject', format('select to_jsonb(training.open_voice_session(%L, %L))', v_ticket, v_res))
               #>> '{}';
  for n in 1..2 loop
    perform tests.as_role('arena_subject', format('select training.record_voice_exchange(%L, %s::smallint, %L)',
      v_session, n,
      jsonb_build_array(jsonb_build_object('role', 'investigator', 'text', 'Question ' || n, 'partial', false),
                        jsonb_build_object('role', 'subject', 'text', 'Answer ' || n, 'partial', false))));
  end loop;
  perform tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)', v_session, '1000'));
  perform tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', v_res, 'committed'));
end $$;
select pg_temp.voice_session();

create function pg_temp.finalize(p_key text, p_finding jsonb) returns jsonb
language sql as $$
  select tests.as_role('arena_public', format('select arena.finalize_trial(%L, %L, %L)', (select trial from ft),
    tests.as_role('arena_public', format('select arena.open_work_item(%L, %L, %L)', (select trial from ft), 'finalize', p_key))
      ->> 'work_item_id',
    p_finding))
$$;

create temp table contract_finding on commit drop as select
  '{"alternative_explanations":null,"basis_flag_refs":[],"cited_records":["rec-02"],"cited_turns":[],"confidence":"low","corroboration_needed":["the work order"],"label":"insufficient_evidence","last_revised_turn":null,"likelihood":"roughly_even_chance","rationale":"The reason for entry is not yet established."}'::jsonb
  as finding;

select is(tests.error(format('select pg_temp.finalize(%L, %L)', 'fn-finalize-bad-alternatives',
              (select finding || '{"alternative_explanations": "The alarm was elsewhere."}'::jsonb from contract_finding))),
          'AR007: finding needs label, likelihood, confidence, rationale, and citations of answered turns and existing records',
  'FN-01 an alternative_explanations that is neither an array nor null is refused with AR007');

select pg_temp.finalize('fn-finalize-contract', (select finding from contract_finding));
select is((select finding from arena.final_findings where trial_id = (select trial from ft)),
          (select finding from contract_finding),
  'FN-02 the shared contract''s stored finding, alternative_explanations null, commits and is stored as sent');

select * from finish();
rollback;
