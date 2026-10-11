-- 016_training_tickets.sql (sql/TESTS.md section 16; SOL-6, KPI-1, EVL-7, SCN-12, direction 4.3; WP-04b).
-- No dblink: every scenario here is a single-session sequence.
begin;
\ir harness/fixtures.psql
select plan(19);
create temp table t_plan on commit drop as select :'plan'::jsonb as plan;
select tests.users();
select tests.apply_plan(plan) from t_plan;

create or replace function pg_temp.tt_act(p_actor text) returns void
language sql as $$ select set_config('arena.actor_id', tests.uid(p_actor)::text, true) $$;
-- one exchange and a finalize (assumes arena.actor_id is already set correctly for the trial's owner).
create or replace function pg_temp.tt_finalize(p_trial uuid, p_key text) returns void
language plpgsql as $$
declare v_wi uuid;
begin
  perform tests.exchange(p_trial, 'Question 1', '{}'::text[], 'Answer 1');
  v_wi := (arena.open_work_item(p_trial, 'finalize', tests.k(p_trial, 1, 'finalize', p_key)) ->> 'work_item_id')::uuid;
  perform arena.finalize_trial(p_trial, v_wi, jsonb_build_object('label', 'insufficient_evidence', 'likelihood',
    'roughly_even_chance', 'confidence', 'low', 'rationale', 'tt', 'basis_flag_refs', '[]'::jsonb,
    'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
end $$;
-- a fresh practice session for the given actor on a fresh dev family, run to completion (finalized).
create or replace function pg_temp.tt_finalized(p_actor text, p_code text, p_key text) returns uuid
language plpgsql as $$
declare v_trial uuid; v_wi uuid;
begin
  perform tests.family(p_code, 'dev');
  perform pg_temp.tt_act(p_actor);
  v_trial := (training.start_session(tests.variant(p_code, 'truthful'), 'practice', tests.candidate('assistant', 'A1'),
    tests.candidate('subject', 'S1'), false, p_key) ->> 'trial_id')::uuid;
  perform pg_temp.tt_finalize(v_trial, p_key);
  perform pg_temp.tt_act('');
  return v_trial;
end $$;
-- text_sessions_per_user_day (seeded 5) counts every one of an actor's sessions created today, text or
-- voice, any mode (start_session, no filter). Several sections below reuse the same actor for more than
-- five sessions; this backdates that actor's today's rows out of the count once a section is done with
-- them. _ended_sessions and session_counts never filter on created_at, so this has no effect on the
-- protocol-phase logic the rest of the file checks.
create or replace function pg_temp.tt_backdate(p_actor text) returns void
language plpgsql as $$
begin
  alter table training.sessions disable trigger sessions_immutable;
  update training.sessions set created_at = created_at - interval '1 day'
   where user_id = tests.uid(p_actor) and created_at >= date_trunc('day', now());
  alter table training.sessions enable trigger sessions_immutable;
end $$;

-- ---------------------------------------------------------------------------- TT-01
create temp table tt01h on commit drop as select tests.family('TT01HID', 'hidden') as id;
select sealed.seal_hidden_split(tests.sampler());
select pg_temp.tt_act('A');
select is(tests.error(format('select training.start_session(%L, %L, %L, %L, false, %L)',
    tests.variant('TT01HID', 'truthful'), 'practice', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'),
    'tt01-session-01')),
  'AR001: training trials use development cases only',
  'TT-01 start_session on a hidden variant is refused (AR001)');

-- ---------------------------------------------------------------------------- TT-02
select tests.family('TT02DEV', 'dev');
create temp table tt02a on commit drop as select training.start_session(tests.variant('TT02DEV', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt02-session-01') as r;
create temp table tt02b on commit drop as select training.start_session(tests.variant('TT02DEV', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt02-session-01') as r;
select is(((select r ->> 'session_id' from tt02a) = (select r ->> 'session_id' from tt02b))::text, 'true',
  'TT-02 the same idempotency key twice returns the same session');

-- ---------------------------------------------------------------------------- TT-03
select tests.family('TT03DEV', 'dev');
select tests.family('TT03SETA', 'dev');
select tests.family('TT03SETB', 'dev');
insert into training.participants (user_id, code, counterbalance, consented_at)
  values (tests.uid('B'), 'P01', 'AB', now());
insert into training.case_set_members (set_code, variant_id) values ('A', tests.variant('TT03SETA', 'truthful'));
insert into training.case_set_members (set_code, variant_id) values ('B', tests.variant('TT03SETB', 'truthful'));
select pg_temp.tt_act('C');
create temp table tt03a on commit drop as select training.start_session(tests.variant('TT03DEV', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt03-nonpart-01') as r;
create temp table tt03b on commit drop as select tests.error(format('select training.start_session(%L, %L, %L, %L, false, %L)',
  tests.variant('TT03SETA', 'truthful'), 'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'),
  'tt03-nonpart-02')) as v;
select pg_temp.tt_act('B');
create temp table tt03c on commit drop as select tests.error(format('select training.start_session(%L, %L, %L, %L, false, %L)',
  tests.variant('TT03SETA', 'truthful'), 'practice', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'),
  'tt03-part-practice')) as v;
create temp table tt03d on commit drop as select tests.error(format('select training.start_session(%L, %L, %L, %L, true, %L)',
  tests.variant('TT03SETA', 'truthful'), 'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'),
  'tt03-part-voice')) as v;
create temp table tt03e on commit drop as select training.start_session(tests.variant('TT03SETA', 'truthful'), 'assessment',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt03-part-pre') as r;
select pg_temp.tt_act('');
select is(array[(select r ->> 'phase' from tt03a), (select v from tt03b), (select v from tt03c), (select v from tt03d),
                (select r ->> 'phase' from tt03e)],
  array['practice', 'AR007: KPI-1 case-set variants are test cases for participants only',
        'AR007: pre and post tests run in assessment mode, in text', 'AR007: pre and post tests run in assessment mode, in text',
        'pre'],
  'TT-03 the phase is derived (SG4-10): a non-participant session is practice; a case-set variant for a '
  || 'non-participant, the participant''s own pre-test variant in practice mode, or with voice, are each '
  || 'AR007 (X-08); the participant''s pre-test variant in assessment mode, in text, is pre');

-- ---------------------------------------------------------------------------- TT-04
select pg_temp.tt_act('D');
select tests.family('TT04DEV', 'dev');
create temp table tt04 on commit drop as select n,
  (training.start_session(tests.variant('TT04DEV', case when n % 2 = 0 then 'truthful' else 'deceptive' end), 'practice',
     tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt04-session-' || n) ->> 'session_id') as sid
  from generate_series(1, 5) n;
create temp table tt04six on commit drop as select tests.error(format(
  'select training.start_session(%L, %L, %L, %L, false, %L)', tests.variant('TT04DEV', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), 'tt04-session-6')) as v;
select pg_temp.tt_act('');
select pg_temp.tt_backdate('D');  -- frees D's quota for later sections; see pg_temp.tt_backdate
select is(array[(select count(*)::text from tt04 where sid is not null), (select v from tt04six)],
  array['5', 'AR040: daily session quota reached'],
  'TT-04 a sixth session in a day, with text_sessions_per_user_day = 5, is refused (AR040)');

-- ---------------------------------------------------------------------------- TT-05
-- the owner is C, not B: B becomes a KPI-1 participant in TT-03 (practice before the pre-tests is AR007
-- for a participant, SG4-10), so a fresh plain practice session here uses an actor outside that concern.
select tests.family('TT05DEV', 'dev');
create temp table tt05owner on commit drop as select pg_temp.tt_finalized('C', 'TT05DEV', 'tt05-owner-01') as trial;
select pg_temp.tt_act('A');
create temp table tt05other on commit drop as select tests.error(format('select training.issue_access_ticket(%L, %L)',
  'sse', (select trial from tt05owner))) as v;
select pg_temp.tt_act('C');
create temp table tt05voice on commit drop as select tests.error(format('select training.issue_access_ticket(%L, %L)',
  'voice', (select trial from tt05owner))) as v;
create temp table tt05badkind on commit drop as select tests.error(format('select training.issue_access_ticket(%L, %L)',
  'not-a-kind', (select trial from tt05owner))) as v;
create temp table tt05sse on commit drop as select training.issue_access_ticket('sse', (select trial from tt05owner)) as tok;
select pg_temp.tt_act('');
select is(array[(select v from tt05other), (select v from tt05voice), (select v from tt05badkind),
                (select (tok ~ '^[0-9a-f]{64}$')::text from tt05sse)],
  array['AR040: ticket refused', 'AR040: ticket refused', 'AR040: ticket refused', 'true'],
  'TT-05 a ticket for another actor''s trial, a voice ticket for a finalized trial, and an unknown kind are '
  || 'each refused (AR040); an SSE ticket for the actor''s finalized trial whose debrief is not yet published '
  || 'is a 64-hex token (D9, SG3-18)');

-- ---------------------------------------------------------------------------- TT-06
select tests.family('TT06DEV', 'dev');
select pg_temp.tt_act('C');
create temp table tt06trial on commit drop as select (training.start_session(tests.variant('TT06DEV', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), true, 'tt06-voice-01') ->> 'trial_id')::uuid as trial;
create temp table tt06tok1 on commit drop as select training.issue_access_ticket('voice', (select trial from tt06trial)) as tok;
create temp table tt06ticket1 on commit drop as select (training.redeem_access_ticket((select tok from tt06tok1), 'voice')
  ->> 'ticket_id')::uuid as ticket;
select tests.as_role('arena_subject', format('select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))',
  (select ticket from tt06ticket1), tests.uid('C'), (select trial from tt06trial), 'practice'));
create temp table tt06res1 on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, %L, null)', 'tt06-voice-res-1', 'global', 'voice_session', 'voice.session',
  (select trial from tt06trial))) as r;
create temp table tt06open1 on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.open_voice_session(%L, %L))', (select ticket from tt06ticket1), (select (r ->> 'id')::uuid from tt06res1)))
  #>> '{}' as session;
create temp table tt06open on commit drop as select tests.error(format('select training.issue_access_ticket(%L, %L)',
  'voice', (select trial from tt06trial))) as v;
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)',
  (select session from tt06open1), 'tt06-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from tt06res1), 'released'));
create temp table tt06tok2 on commit drop as select training.issue_access_ticket('voice', (select trial from tt06trial)) as tok;
create temp table tt06ticket2 on commit drop as select (training.redeem_access_ticket((select tok from tt06tok2), 'voice')
  ->> 'ticket_id')::uuid as ticket;
select tests.as_role('arena_subject', format('select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))',
  (select ticket from tt06ticket2), tests.uid('C'), (select trial from tt06trial), 'practice'));
create temp table tt06res2 on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, %L, null)', 'tt06-voice-res-2', 'global', 'voice_session', 'voice.session',
  (select trial from tt06trial))) as r;
create temp table tt06open2 on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.open_voice_session(%L, %L))', (select ticket from tt06ticket2), (select (r ->> 'id')::uuid from tt06res2)))
  #>> '{}' as session;
-- close session 2 BEFORE the quota check below, so the next ticket attempt is refused by the quota alone
-- (voice_sessions_per_user_day = 2, already opened twice today), not masked by an open-session refusal too.
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)',
  (select session from tt06open2), 'tt06-done-2'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from tt06res2), 'released'));
create temp table tt06quota on commit drop as select tests.error(format('select training.issue_access_ticket(%L, %L)',
  'voice', (select trial from tt06trial))) as v;
-- a fresh actor (A, untouched by C's exhausted voice quota above) for the no-voice-flag check, so a missing
-- voice flag on the trial is the only thing that can produce this refusal.
select pg_temp.tt_act('A');
select tests.family('TT06TXT', 'dev');
create temp table tt06txt on commit drop as select (training.start_session(tests.variant('TT06TXT', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt06-txt-01') ->> 'trial_id')::uuid as trial;
create temp table tt06novoice on commit drop as select tests.error(format('select training.issue_access_ticket(%L, %L)',
  'voice', (select trial from tt06txt))) as v;
select pg_temp.tt_act('');
select is(array[(select v from tt06open), (select v from tt06quota), (select v from tt06novoice)],
  array['AR040: ticket refused', 'AR040: ticket refused', 'AR040: ticket refused'],
  'TT-06 a voice ticket is refused (AR040) with an open voice session on the trial, above '
  || 'voice_sessions_per_user_day, or on a session without the voice flag');

-- ---------------------------------------------------------------------------- TT-07
select tests.family('TT07DEV', 'dev');
select pg_temp.tt_act('D');
create temp table tt07trial on commit drop as select (training.start_session(tests.variant('TT07DEV', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt07-session-01') ->> 'trial_id')::uuid as trial;
create temp table tt07tok on commit drop as select training.issue_access_ticket('sse', (select trial from tt07trial)) as tok;
select training.redeem_access_ticket((select tok from tt07tok), 'sse');
create temp table tt07twice on commit drop as select tests.error(format('select training.redeem_access_ticket(%L, %L)',
  (select tok from tt07tok), 'sse')) as v;
create temp table tt07tok2 on commit drop as select training.issue_access_ticket('sse', (select trial from tt07trial)) as tok;
-- training.access_tickets carries no append-only trigger (redeemed_at/subject_checked_at are ordinary
-- updates by design); the tamper below is a plain update.
update training.access_tickets set expires_at = now() - interval '1 second'
 where ticket_sha256 = ledger.hash_text((select tok from tt07tok2));
create temp table tt07expired on commit drop as select tests.error(format('select training.redeem_access_ticket(%L, %L)',
  (select tok from tt07tok2), 'sse')) as v;
create temp table tt07tok3 on commit drop as select training.issue_access_ticket('sse', (select trial from tt07trial)) as tok;
select pg_temp.tt_act('C');
create temp table tt07other on commit drop as select tests.error(format('select training.redeem_access_ticket(%L, %L)',
  (select tok from tt07tok3), 'sse')) as v;
select pg_temp.tt_act('D');
create temp table tt07wrongkind on commit drop as select tests.error(format('select training.redeem_access_ticket(%L, %L)',
  (select tok from tt07tok3), 'voice')) as v;
select pg_temp.tt_act('');
select pg_temp.tt_backdate('D');
select is(array[(select v from tt07twice), (select v from tt07expired), (select v from tt07other), (select v from tt07wrongkind)],
  array['AR040: ticket refused', 'AR040: ticket refused', 'AR040: ticket refused', 'AR040: ticket refused'],
  'TT-07 redeeming a ticket twice, after expiry, by another actor, or with the wrong kind, is each refused '
  || '(AR040)');

-- ---------------------------------------------------------------------------- TT-08
select is((select count(*)::text from training.access_tickets where ticket_sha256 = (select tok from tt07tok3)), '0',
  'TT-08 only ticket_sha256 is stored: the raw token text never appears as a stored hash');

-- ---------------------------------------------------------------------------- TT-09
select tests.family('TT09DEV', 'dev');
select pg_temp.tt_act('D');
create temp table tt09trial on commit drop as select (training.start_session(tests.variant('TT09DEV', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), true, 'tt09-session-01') ->> 'trial_id')::uuid as trial;
create temp table tt09tok on commit drop as select training.issue_access_ticket('voice', (select trial from tt09trial)) as tok;
create temp table tt09ticket on commit drop as select (training.redeem_access_ticket((select tok from tt09tok), 'voice')
  ->> 'ticket_id')::uuid as ticket;
select pg_temp.tt_act('D');
create temp table tt09tok2 on commit drop as select training.issue_access_ticket('voice', (select trial from tt09trial)) as tok;
create temp table tt09unredeemed on commit drop as select id as ticket from training.access_tickets
  where ticket_sha256 = ledger.hash_text((select tok from tt09tok2));
select pg_temp.tt_act('');
create temp table tt09before on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))', (select ticket from tt09unredeemed), tests.uid('D'),
  (select trial from tt09trial), 'practice')) as r;
create temp table tt09diffuser on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))', (select ticket from tt09ticket), tests.uid('C'),
  (select trial from tt09trial), 'practice')) as r;
create temp table tt09difftrial on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))', (select ticket from tt09ticket), tests.uid('D'),
  gen_random_uuid(), 'practice')) as r;
create temp table tt09diffmode on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))', (select ticket from tt09ticket), tests.uid('D'),
  (select trial from tt09trial), 'assessment')) as r;
create temp table tt09real on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))', (select ticket from tt09ticket), tests.uid('D'),
  (select trial from tt09trial), 'practice')) as r;
create temp table tt09twice on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))', (select ticket from tt09ticket), tests.uid('D'),
  (select trial from tt09trial), 'practice')) as r;
select is(array[(select r::text from tt09before), (select r::text from tt09diffuser), (select r::text from tt09difftrial),
                (select r::text from tt09diffmode), (select r::text from tt09real), (select r::text from tt09twice)],
  array['false', 'false', 'false', 'false', 'true', 'false'],
  'TT-09 claim_voice_ticket on an unredeemed ticket, with a different user, trial or mode, each answer '
  || 'false; the one call with the correct binding answers true, once, and a second claim on the same '
  || 'ticket then answers false');
select pg_temp.tt_backdate('D');
select pg_temp.tt_act('');

-- ---------------------------------------------------------------------------- TT-10
select tests.family('TT10DEV', 'dev');
create temp table tt10trial on commit drop as select pg_temp.tt_finalized('C', 'TT10DEV', 'tt10-session-01') as trial;
create temp table tt10session on commit drop as select id from training.sessions where trial_id = (select trial from tt10trial);
select tests.as_role('arena_referee', format(
  'insert into training.rubric_scores (session_id, scorer, scorer_ref, clarity_neutrality, response_relevance, '
  || 'evidence_follow_up, alternative_testing, supported_closure, rationale) values (%L, %L, %L, 1, 2, 3, 4, 0, %L) '
  || 'returning jsonb_build_object(%L, true)', (select id from tt10session), 'proxy', 'tt10-rater', '{}'::jsonb, 'ok'));
select is(array[
    (select total::text from training.rubric_scores where session_id = (select id from tt10session)),
    tests.sqlstate(format('insert into training.rubric_scores (session_id, scorer, scorer_ref, clarity_neutrality, '
      || 'response_relevance, evidence_follow_up, alternative_testing, supported_closure, rationale) '
      || 'values (%L, %L, %L, %L, %L, %L, %L, %L, %L)', (select id from tt10session), 'proxy', 'tt10-bad', 5, 0, 0, 0, 0,
      '{}'::jsonb))],
  array[(5 * (1 + 2 + 3 + 4 + 0))::text, '23514'],
  'TT-10 rubric_scores.total = 5 x the sum of the five dimensions; a dimension of 5 is refused (23514)');

-- ---------------------------------------------------------------------------- TT-11
select tests.family('TT11DEV', 'dev');
select pg_temp.tt_act('D');
create temp table tt11trial on commit drop as select (training.start_session(tests.variant('TT11DEV', 'truthful'),
  'practice', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt11-session-01')
  ->> 'trial_id')::uuid as trial;
create temp table tt11session on commit drop as select id from training.sessions where trial_id = (select trial from tt11trial);
select tests.as_role('arena_referee', format(
  'insert into training.rubric_scores (session_id, scorer, scorer_ref, clarity_neutrality, response_relevance, '
  || 'evidence_follow_up, alternative_testing, supported_closure, rationale) values (%L, %L, %L, 2, 2, 2, 2, 2, %L) '
  || 'returning jsonb_build_object(%L, true)', (select id from tt11session), 'proxy', 'tt11-rater', '{}'::jsonb, 'ok'));
create temp table tt11before on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_scores')::text as c;
select tests.exchange((select trial from tt11trial), 'Question 1', '{}'::text[], 'Answer 1');
create temp table tt11wi on commit drop as select (arena.open_work_item((select trial from tt11trial), 'finalize',
  tests.k((select trial from tt11trial), 1, 'finalize', 'tt11')) ->> 'work_item_id')::uuid as wi;
select arena.finalize_trial((select trial from tt11trial), (select wi from tt11wi), jsonb_build_object('label',
  'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low', 'rationale', 'tt11',
  'basis_flag_refs', '[]'::jsonb, 'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb,
  'corroboration_needed', '[]'::jsonb));
create temp table tt11after on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_scores')::text as c;
select pg_temp.tt_act('');
select pg_temp.tt_backdate('D');
select is(array[(select c from tt11before), (select c from tt11after)], array['0', '1'],
  'TT-11 v_my_scores hides a session''s rubric score until the trial ends');

-- ---------------------------------------------------------------------------- TT-12
-- a real debrief, published on C's own finalized session (tt10session, from TT-10), so v_my_debrief's
-- actor-scoping is actually exercised (an empty table would trivially satisfy a bare count = 0 for D too,
-- without ever proving the view excludes another actor's row). publish_debrief does not check
-- arena.actor_id() itself (it is arena_referee's own call, ownership-agnostic by design; the running
-- investigator is never the caller), so it runs here exactly as TT-19 calls it later, with no actor bracket.
create temp table tt12debriefpub on commit drop as select training.publish_debrief((select id from tt10session),
  jsonb_build_object('schema_version', 'debrief.v1', 'session_id', (select id from tt10session)::text,
    'scored', true, 'outcome', jsonb_build_object('role', 'truthful', 'correct_finding', true,
      'committed_label', 'insufficient_evidence', 'resolution', 'tt12'),
    'rubric', '{}'::jsonb, 'scorecards', '{}'::jsonb, 'provenance', '{}'::jsonb)) as r;
select pg_temp.tt_act('D');
create temp table tt12sessions on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_sessions')::text as c;
create temp table tt12sessionsreal on commit drop as select count(*)::text as c from training.sessions
  where user_id = tests.uid('D');
create temp table tt12debriefmine on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_debrief')::text as c;
create temp table tt12study on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_study')::text as c;
select pg_temp.tt_act('C');
create temp table tt12debriefother on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_debrief')::text as c;
select pg_temp.tt_act('');
create temp table tt12none on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_sessions')::text as c;
select is(array[((select c from tt12sessions) = (select c from tt12sessionsreal))::text,
                (select c from tt12debriefmine), (select c from tt12debriefother),
                (select c from tt12study), (select c from tt12none)],
  array['true', '0', '1', '0', '0'],
  'TT-12 v_my_sessions matches D''s own session count exactly (not just a positive number); a debrief '
  || 'published on C''s session is invisible to D''s v_my_debrief and visible (one row) to C''s own; '
  || 'v_my_study is empty for D (not yet a KPI-1 participant); with no actor set, v_my_sessions returns none');

-- ---------------------------------------------------------------------------- TT-13
select tests.family('TT13DEV', 'dev');
select pg_temp.tt_act('D');
create temp table tt13trial on commit drop as select (training.start_session(tests.variant('TT13DEV', 'truthful'),
  'practice', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), true, 'tt13-session-01')
  ->> 'trial_id')::uuid as trial;
create temp table tt13ticket on commit drop as select (training.redeem_access_ticket(
  training.issue_access_ticket('voice', (select trial from tt13trial)), 'voice') ->> 'ticket_id')::uuid as ticket;
select tests.as_role('arena_subject', format('select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))',
  (select ticket from tt13ticket), tests.uid('D'), (select trial from tt13trial), 'practice'));
create temp table tt13res on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, %L, null)', 'tt13-voice-res-01', 'global', 'voice_session', 'voice.session',
  (select trial from tt13trial))) as r;
create temp table tt13open on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.open_voice_session(%L, %L))', (select ticket from tt13ticket), (select (r ->> 'id')::uuid from tt13res)))
  #>> '{}' as session;
select tests.as_role('arena_subject', format('select training.record_voice_exchange(%L, 1::smallint, %L)',
  (select session from tt13open), jsonb_build_array(jsonb_build_object('role', 'investigator', 'text', 'Q1', 'partial', false))));
create temp table tt13mine on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_voice_exchanges')::text as c;
select pg_temp.tt_act('C');
create temp table tt13other on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_voice_exchanges')::text as c;
select pg_temp.tt_act('');
select is(array[(select c from tt13mine), (select c from tt13other),
                (select count(*)::text from arena.v_transcripts where trial_id = (select trial from tt13trial))],
  array['1', '0', '0'],
  'TT-13 D7, D-016: a voice session''s exchanges appear in training.v_my_voice_exchanges for their owner and '
  || 'in no other actor''s view; arena.v_transcripts has no row for a voice session''s trial');
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)',
  (select session from tt13open), 'tt13-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from tt13res), 'released'));
select pg_temp.tt_backdate('D');

-- ---------------------------------------------------------------------------- TT-14
create temp table tt14noactor on commit drop as select tests.error($$ select training.acknowledge('ex4') $$) as v;
select pg_temp.tt_act('D');
create temp table tt14badkind on commit drop as select tests.error($$ select training.acknowledge('terms') $$) as v;
create temp table tt14first on commit drop as select training.acknowledge('ex4') as at;
create temp table tt14second on commit drop as select training.acknowledge('ex4') as at;
create temp table tt14mine on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_acknowledgements')::text as c;
select pg_temp.tt_act('C');
create temp table tt14other on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_acknowledgements')::text as c;
select pg_temp.tt_act('');
select is(array[(select v from tt14noactor), (select v from tt14badkind),
                ((select at from tt14first) = (select at from tt14second))::text, (select c from tt14mine),
                (select c from tt14other)],
  array['AR040: no investigator identity on this request', 'AR007: unknown acknowledgement', 'true', '1', '0'],
  'TT-14 X-15: acknowledge(''ex4'') with no actor is refused (AR040); kind terms is refused (AR007); twice by '
  || 'one actor keeps the first timestamp; v_my_acknowledgements shows one row to that actor and none to '
  || 'another');

-- ---------------------------------------------------------------------------- TT-15, TT-16 (SG4-10, SG3-31, SG3-13)
select tests.family('TT15SETA', 'dev');
select tests.family('TT15SETB', 'dev');
select tests.family('TT15DEV', 'dev');
insert into training.participants (user_id, code, counterbalance, consented_at) values (tests.uid('D'), 'P02', 'AB', now());
insert into training.case_set_members (set_code, variant_id) values ('A', tests.variant('TT15SETA', 'truthful'));
insert into training.case_set_members (set_code, variant_id) values ('A', tests.variant('TT15SETA', 'deceptive'));
insert into training.case_set_members (set_code, variant_id) values ('B', tests.variant('TT15SETB', 'truthful'));
insert into training.case_set_members (set_code, variant_id) values ('B', tests.variant('TT15SETB', 'deceptive'));
select pg_temp.tt_act('D');
-- practice before the pre-tests
create temp table tt15practice0 on commit drop as select tests.error(format(
  'select training.start_session(%L, %L, %L, %L, false, %L)', tests.variant('TT15DEV', 'truthful'), 'practice',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), 'tt15-practice-0')) as v;
-- a post-test before the pre-tests
create temp table tt15post0 on commit drop as select tests.error(format(
  'select training.start_session(%L, %L, %L, %L, false, %L)', tests.variant('TT15SETB', 'truthful'), 'assessment',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), 'tt15-post-0')) as v;
-- both pre-tests. Set A is global across the file (training.case_set_members is append-only and shared):
-- TT-03 already added one set-A member (TT03SETA truthful) for a different participant, so set A now has
-- three members, and D's own pre-test count must reach all three (training._ended_sessions counts per
-- participant, so TT-03's actor B session on it does not count for D).
create temp table tt15pre0 on commit drop as select (training.start_session(tests.variant('TT03SETA', 'truthful'),
  'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-pre-0')
  ->> 'trial_id')::uuid as trial;
create temp table tt15pre1 on commit drop as select (training.start_session(tests.variant('TT15SETA', 'truthful'),
  'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-pre-1')
  ->> 'trial_id')::uuid as trial;
-- a second session on the same pre-test variant
create temp table tt15predup on commit drop as select tests.error(format(
  'select training.start_session(%L, %L, %L, %L, false, %L)', tests.variant('TT15SETA', 'truthful'), 'assessment',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), 'tt15-pre-1-dup')) as v;
create temp table tt15pre2 on commit drop as select (training.start_session(tests.variant('TT15SETA', 'deceptive'),
  'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-pre-2')
  ->> 'trial_id')::uuid as trial;
select pg_temp.tt_finalize((select trial from tt15pre0), 'tt15-pre-0-fin');
select pg_temp.tt_finalize((select trial from tt15pre1), 'tt15-pre-1-fin');
select pg_temp.tt_finalize((select trial from tt15pre2), 'tt15-pre-2-fin');
create temp table tt15pre1phase on commit drop as select phase from training.sessions where trial_id = (select trial from tt15pre1);
create temp table tt15pre2phase on commit drop as select phase from training.sessions where trial_id = (select trial from tt15pre2);
-- the three pre-tests above already used 3 of D's 5-a-day quota; backdate them so the five sessions below
-- (free x3, terminated, voice) can still be created today.
select pg_temp.tt_backdate('D');

-- a post-test attempt now (both pre-tests ended, but no practice sessions at all yet) is still AR007; three
-- free sessions in Assessment mode, one terminated Practice session and one voice Practice session (all
-- ended) do not change that: session_counts excludes mode <> 'practice', status <> 'finalized' and voice,
-- respectively (D-017).
create temp table tt15postearly on commit drop as select tests.error(format(
  'select training.start_session(%L, %L, %L, %L, false, %L)', tests.variant('TT15SETB', 'truthful'), 'assessment',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), 'tt15-post-early')) as v;
select tests.family('TT15FREE', 'dev');
create temp table tt15free1 on commit drop as select (training.start_session(tests.variant('TT15FREE', 'truthful'),
  'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-free-1')
  ->> 'trial_id')::uuid as trial;
select pg_temp.tt_finalize((select trial from tt15free1), 'tt15-free-1-fin');
select tests.family('TT15FREE2', 'dev');
create temp table tt15free2 on commit drop as select (training.start_session(tests.variant('TT15FREE2', 'truthful'),
  'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-free-2')
  ->> 'trial_id')::uuid as trial;
select pg_temp.tt_finalize((select trial from tt15free2), 'tt15-free-2-fin');
select tests.family('TT15FREE3', 'dev');
create temp table tt15free3 on commit drop as select (training.start_session(tests.variant('TT15FREE3', 'truthful'),
  'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-free-3')
  ->> 'trial_id')::uuid as trial;
select pg_temp.tt_finalize((select trial from tt15free3), 'tt15-free-3-fin');
select tests.family('TT15TERM', 'dev');
create temp table tt15term on commit drop as select (training.start_session(tests.variant('TT15TERM', 'truthful'),
  'practice', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-term-1')
  ->> 'trial_id')::uuid as trial;
select arena.submit_question((select trial from tt15term), 0, 'Question 1',
  tests.k((select trial from tt15term), 1, 'question', 'tt15-term'), null);
create temp table tt15termwi on commit drop as select (arena.open_work_item((select trial from tt15term), 'subject_answer',
  tests.k((select trial from tt15term), 1, 'subject_answer', 'tt15-term')) ->> 'work_item_id')::uuid as wi;
select arena.record_subject_turn((select trial from tt15term), (select wi from tt15termwi), '', null,
  '{"passed": false, "rule": "G0_blocked"}'::jsonb);
select tests.family('TT15VOICE', 'dev');
create temp table tt15voice on commit drop as select (training.start_session(tests.variant('TT15VOICE', 'truthful'),
  'practice', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), true, 'tt15-voice-1')
  ->> 'trial_id')::uuid as trial;
-- a voice trial finalizes on its voice exchanges alone (D-016): no turn exists to cite, so the finding
-- cites nothing (both arrays empty) and still reaches finalized.
create temp table tt15vticket on commit drop as select (training.redeem_access_ticket(
  training.issue_access_ticket('voice', (select trial from tt15voice)), 'voice') ->> 'ticket_id')::uuid as ticket;
select tests.as_role('arena_subject', format('select to_jsonb(training.claim_voice_ticket(%L, %L, %L, %L))',
  (select ticket from tt15vticket), tests.uid('D'), (select trial from tt15voice), 'practice'));
create temp table tt15vres on commit drop as select tests.as_role('arena_subject', format(
  'select ops.reserve_voice(%L, %L, %L, %L, %L, null)', 'tt15-voice-res-1', 'global', 'voice_session', 'voice.session',
  (select trial from tt15voice))) as r;
create temp table tt15vopen on commit drop as select tests.as_role('arena_subject', format(
  'select to_jsonb(training.open_voice_session(%L, %L))', (select ticket from tt15vticket), (select (r ->> 'id')::uuid from tt15vres)))
  #>> '{}' as session;
select tests.as_role('arena_subject', format('select training.record_voice_exchange(%L, 1::smallint, %L)',
  (select session from tt15vopen), jsonb_build_array(jsonb_build_object('role', 'investigator', 'text', 'Q1', 'partial', false))));
select tests.as_role('arena_subject', format('select to_jsonb(training.close_voice_session(%L, %L)::text)',
  (select session from tt15vopen), 'tt15-voice-done'));
select tests.as_role('arena_subject', format('select ops.settle_voice_reservation(%L, %L)', (select (r ->> 'id')::uuid from tt15vres), 'released'));
create temp table tt15vwi on commit drop as select (arena.open_work_item((select trial from tt15voice), 'finalize',
  tests.k((select trial from tt15voice), 1, 'finalize', 'tt15-voice-1')) ->> 'work_item_id')::uuid as wi;
select arena.finalize_trial((select trial from tt15voice), (select wi from tt15vwi), jsonb_build_object('label',
  'insufficient_evidence', 'likelihood', 'roughly_even_chance', 'confidence', 'low', 'rationale', 'tt15 voice',
  'basis_flag_refs', '[]'::jsonb, 'cited_turns', '[]'::jsonb, 'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
create temp table tt15study0 on commit drop as select tests.as_role('arena_public',
  'select practice_ended from training.v_my_study')::integer as n;
-- the pre-tests and the five excluded sessions above (free x3, terminated, voice) already used all of D's
-- text_sessions_per_user_day = 5 quota for today; backdate them BEFORE the repeat check below, so that
-- check's refusal is the admission guard's own AR007, not the unrelated daily quota (AR040) masking it.
select pg_temp.tt_backdate('D');
-- repeat the post-test refusal NOW, after the five excluded sessions above actually exist (tt15postearly,
-- captured before any of them existed, only proved the refusal with zero practice sessions at all): this is
-- the check the comment above claims, and the only one that would catch session_counts excluding the wrong
-- thing (mode, status or voice) for one of those five.
create temp table tt15postearly2 on commit drop as select tests.error(format(
  'select training.start_session(%L, %L, %L, %L, false, %L)', tests.variant('TT15SETB', 'truthful'), 'assessment',
  tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), 'tt15-post-early-2')) as v;

-- three finalized text Practice sessions, then the post-tests.
select tests.family('TT15PRAC1', 'dev');
select pg_temp.tt_finalized('D', 'TT15PRAC1', 'tt15-prac-1');
select tests.family('TT15PRAC2', 'dev');
select pg_temp.tt_finalized('D', 'TT15PRAC2', 'tt15-prac-2');
select tests.family('TT15PRAC3', 'dev');
select pg_temp.tt_finalized('D', 'TT15PRAC3', 'tt15-prac-3');
select pg_temp.tt_act('D');
create temp table tt15postv on commit drop as select (training.start_session(tests.variant('TT15SETB', 'truthful'),
  'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-post-1')
  ->> 'phase')::text as phase;
create temp table tt15postd on commit drop as select (training.start_session(tests.variant('TT15SETB', 'deceptive'),
  'assessment', tests.candidate('assistant', 'A1'), tests.candidate('subject', 'S1'), false, 'tt15-post-2')
  ->> 'phase')::text as phase;
create temp table tt15study1 on commit drop as select tests.as_role('arena_public',
  'select practice_ended from training.v_my_study')::integer as n;
select pg_temp.tt_act('');
select is(array[(select v from tt15practice0), (select v from tt15post0), (select v from tt15predup),
                (select phase from tt15pre1phase), (select phase from tt15pre2phase), (select v from tt15postearly),
                (select v from tt15postearly2), (select n::text from tt15study0), (select phase from tt15postv),
                (select phase from tt15postd), (select n::text from tt15study1)],
  array['AR007: a participant practises after both pre-tests',
        'AR007: the post-test follows both pre-tests and three practice sessions',
        'AR007: each test case runs once', 'pre', 'pre',
        'AR007: the post-test follows both pre-tests and three practice sessions',
        'AR007: the post-test follows both pre-tests and three practice sessions', '0', 'post', 'post', '3'],
  'TT-15 SG4-10, SG3-31 protocol for an AB participant: practice before the pre-tests, a post-test before '
  || 'the pre-tests, and a second session on the same pre-test variant are each AR007; both pre-tests end in '
  || 'phase pre; a post-test attempt with three free Assessment-mode sessions, one terminated Practice '
  || 'session and one voice Practice session (all ended) is still AR007, and v_my_study.practice_ended stays '
  || '0 (none of those five count, each excluded by a different session_counts rule); after three finalized '
  || 'text Practice sessions, both post-tests succeed in phase post, and practice_ended is 3');

-- ---------------------------------------------------------------------------- TT-16
select pg_temp.tt_act('D');
create temp table tt16mine on commit drop as select tests.as_role('arena_public',
  $$ select jsonb_build_object('rows', (select count(*) from training.v_my_study),
                               'pre_n', (select array_length(pre_variant_ids, 1) from training.v_my_study),
                               'post_n', (select array_length(post_variant_ids, 1) from training.v_my_study),
                               'tested_n', (select array_length(tested_variant_ids, 1) from training.v_my_study)) $$) as r;
select pg_temp.tt_act('C');
create temp table tt16other on commit drop as select tests.as_role('arena_public',
  'select count(*) from training.v_my_study')::text as c;
select pg_temp.tt_act('');
select is(array[(select r ->> 'rows' from tt16mine), (select r ->> 'pre_n' from tt16mine),
                (select r ->> 'post_n' from tt16mine), (select r ->> 'tested_n' from tt16mine),
                (select c from tt16other)],
  array['1', '3', '3', '5', '0'],
  'TT-16 SG3-13: v_my_study for the participant gives one row with the pre and post variant id sets (set '
  || 'A and B are global and TT-03 added one member to each, so each set has 3 members here) and all five '
  || 'tested variant ids (3 pre, 2 post); for a non-participant it gives none');

-- ---------------------------------------------------------------------------- TT-17
create temp table tt17config on commit drop as select tests.as_role('arena_public',
  $$ select jsonb_build_object('paused', paused, 'text_cap', text_sessions_per_user_day,
                               'voice_cap', voice_sessions_per_user_day) from ops.v_public_config $$) as r;
select is(array[(select (r ? 'paused')::text from tt17config), (select (r ? 'text_cap')::text from tt17config),
                (select (r ? 'voice_cap')::text from tt17config),
                tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_public', 'select count(*) from ops.config')),
                tests.sqlstate(format('select tests.as_role(%L, %L)', 'arena_public', 'select count(*) from training.participants'))],
  array['true', 'true', 'true', '42501', '42501'],
  'TT-17 SG3-13: ops.v_public_config gives arena_public the paused flag and the two daily quotas; ops.config '
  || 'and training.participants are each refused (42501)');

-- ---------------------------------------------------------------------------- TT-18
select tests.family('TT18RET', 'dev');
select tests.family('TT18NEW', 'dev');
do $$
begin
  insert into arena.family_retirements (family_id, superseded_by)
    select (select id from arena.case_families where family_code = 'TT18RET'),
           (select id from arena.case_families where family_code = 'TT18NEW');
end $$;
select is(array[
    (select kpi1_set::text from arena.v_dev_cases where family_code = 'TT15SETA' limit 1),
    (select kpi1_set::text from arena.v_dev_cases where family_code = 'TT15DEV' limit 1),
    (select count(*)::text from arena.v_dev_cases where family_code = 'TT18RET')],
  array['true', 'false', '0'],
  'TT-18 X-08, SG1-11: arena.v_dev_cases.kpi1_set is true for a case-set family and false for an ordinary '
  || 'one; a retired family is absent');

-- ---------------------------------------------------------------------------- TT-19
select pg_temp.tt_act('C');
create temp table tt19debrief on commit drop as select training.publish_debrief(
  (select id from training.sessions where trial_id = (select trial from tt05owner)),
  jsonb_build_object('schema_version', 'debrief.v1', 'session_id',
    (select id from training.sessions where trial_id = (select trial from tt05owner))::text, 'scored', true,
    'outcome', jsonb_build_object('role', 'truthful', 'correct_finding', true, 'committed_label', 'insufficient_evidence',
      'resolution', 'tt19'), 'rubric', '{}'::jsonb, 'scorecards', '{}'::jsonb, 'provenance', '{}'::jsonb)) as r;
create temp table tt19ticket on commit drop as select tests.error(format('select training.issue_access_ticket(%L, %L)',
  'sse', (select trial from tt05owner))) as v;
select pg_temp.tt_act('');
select is((select v from tt19ticket), 'AR040: ticket refused',
  'TT-19 D9: an SSE ticket for an ended trial after its debrief is published is refused (AR040)');

select * from finish();
rollback;
