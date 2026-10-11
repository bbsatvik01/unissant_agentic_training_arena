-- 013_ledger_chain.sql (sql/TESTS.md section 13; SCN-10, BKO-9; WP-04b). No dblink.
begin;
\ir harness/fixtures.psql
select plan(8);
select tests.users();

-- a scripted flow: two candidates, a tournament, a full exchange, a finalize and an adjudication, so the
-- chain carries more than one event type (candidate_registered, tournament_created, roster_frozen,
-- subject_answered, trial_finalized, validity_adjudicated, ...).
create temp table lc on commit drop as select tests.tournament('dev', array['interactive']) as tour;
create temp table lct on commit drop as select tests.trial((select tour from lc), 3) as trial;
select tests.as_role('arena_public', format('select arena.start_trial(%L)', (select trial from lct)));
select tests.exchange((select trial from lct), 'Question 1', '{}'::text[], 'Answer 1');
create temp table lcwi on commit drop as
  select (arena.open_work_item((select trial from lct), 'finalize', tests.k((select trial from lct), 1, 'finalize', 'lc'))
          ->> 'work_item_id')::uuid as wi;
select arena.finalize_trial((select trial from lct), (select wi from lcwi), jsonb_build_object('label', 'insufficient_evidence',
  'likelihood', 'roughly_even_chance', 'confidence', 'low', 'rationale', 'lc', 'basis_flag_refs', '[]'::jsonb,
  'cited_turns', jsonb_build_array(1), 'cited_records', '[]'::jsonb, 'corroboration_needed', '[]'::jsonb));
select ledger.adjudicate_validity((select trial from lct), 'valid', 'lc reason', null, 'lcreviewer', 'lc-adj-key-001');

-- ---------------------------------------------------------------------------- LC-01
select is(ledger.verify_chain(), null, 'LC-01 after the scripted flow, verify_chain() is null (the chain is intact)');

-- ---------------------------------------------------------------------------- LC-02
create temp table lcev on commit drop as select seq, prev_sha256, sha256 from ledger.events order by seq;
select is(array[
    (select count(*)::text from lcev),
    (select min(seq)::text from lcev),
    (select max(seq)::text from lcev),
    (select bool_and(e.prev_sha256 = p.sha256)::text
       from lcev e join lcev p on p.seq = e.seq - 1)],
  array[(select max(seq)::text from lcev), '1', (select max(seq)::text from lcev), 'true'],
  'LC-02 each event''s prev_sha256 equals the previous event''s sha256; seq starts at 1 and has no gap '
  || '(row count equals the max seq)');

-- ---------------------------------------------------------------------------- LC-03
select is(array[(select seq from ledger.chain_head where id)::text, (select head_sha256 from ledger.chain_head where id)],
  array[(select max(seq)::text from lcev), (select sha256 from lcev where seq = (select max(seq) from lcev))],
  'LC-03 chain_head equals the last event (seq and sha256)');

-- ---------------------------------------------------------------------------- LC-04
select is(array[
    tests.sqlstate(format('update ledger.events set payload = %L where seq = 1', '{}'::jsonb)),
    tests.sqlstate(format('delete from ledger.events where seq = 1'))],
  array['AR010', 'AR010'],
  'LC-04 update and delete on ledger.events are each refused (AR010)');

-- ---------------------------------------------------------------------------- LC-05
create temp table lc05seq on commit drop as select min(seq) as seq from lcev where seq > 1;
do $$
begin
  alter table ledger.events disable trigger events_append_only;
  update ledger.events set payload = payload || '{"lc05_tamper": true}'::jsonb
   where seq = (select seq from pg_temp.lc05seq);
  alter table ledger.events enable trigger events_append_only;
end $$;
create temp table lc05broken on commit drop as select ledger.verify_chain() as v;
do $$
begin
  alter table ledger.events disable trigger events_append_only;
  update ledger.events set payload = payload - 'lc05_tamper' where seq = (select seq from pg_temp.lc05seq);
  alter table ledger.events enable trigger events_append_only;
end $$;
select is(array[(select v::text from lc05broken), (select ledger.verify_chain() is null)::text],
  array[(select seq::text from lc05seq), 'true'],
  'LC-05 tamper fixture: a payload edit (trigger disabled) makes verify_chain() return that seq; restoring '
  || 'the payload makes the chain verify again');

-- ---------------------------------------------------------------------------- LC-06
create temp table lc06seq on commit drop as
  select seq as gap, (select min(seq) from lcev where seq > (select min(seq) from lcev where seq > 1)) as after_gap
    from lcev where seq = (select min(seq) from lcev where seq > 1);
do $$
begin
  alter table ledger.events disable trigger events_append_only;
  delete from ledger.events where seq = (select gap from pg_temp.lc06seq);
  alter table ledger.events enable trigger events_append_only;
end $$;
select is(ledger.verify_chain()::text, (select after_gap::text from lc06seq),
  'LC-06 tamper fixture: a row deletion (trigger disabled) makes verify_chain() return the first seq after '
  || 'the gap');

-- ---------------------------------------------------------------------------- LC-07
select is((select count(*)::text from ledger.events where payload ?| array['role', 'answer', 'utterance', 'question', 'facts']),
  '0',
  'LC-07 no ledger payload carries the key role, answer, utterance, question or facts (hashes only)');

-- ---------------------------------------------------------------------------- LC-08
create temp table lc08a on commit drop as select ledger.event_digest(repeat('0', 64), 1, 'tournament_created',
  (select tour from lc), null, null, '{"name": "x"}'::jsonb, 1234567890) as h;
set local timezone = 'UTC';
create temp table lc08b on commit drop as select ledger.event_digest(repeat('0', 64), 1, 'tournament_created',
  (select tour from lc), null, null, '{"name": "x"}'::jsonb, 1234567890) as h;
set local timezone = 'America/New_York';
create temp table lc08c on commit drop as select ledger.event_digest(repeat('0', 64), 1, 'tournament_created',
  (select tour from lc), null, null, '{"name": "x"}'::jsonb, 1234567890) as h;
select is(array[(select h from lc08b), (select h from lc08c)], array[(select h from lc08a), (select h from lc08a)],
  'LC-08 the event digest is independent of the session TimeZone (recomputed under UTC and America/New_York)');

select * from finish();
rollback;
