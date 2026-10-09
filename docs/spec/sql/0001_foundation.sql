-- =============================================================================
-- 0001_foundation.sql  (DRAFT v2.7, spec S4; applied only to throwaway local PostgreSQL 17.11 containers)
-- Schemas, runtime roles, revoke-all, shared helpers, append-only trigger.
-- Requirements: SCN-5, SCN-9, SCN-12, BKO-9, EVL-10, KPI-5 (isolation by construction).
--
-- Adapted from TechnoMile supabase/migrations/20260927000100_foundation.sql lines 19-69
-- (roles NOLOGIN in git, revoke from Supabase API roles, default-privilege revokes,
-- money domain, tg_forbid_mutation) and 20260927000700_grants.sql lines 16-18 (revoke-all
-- before any grant).
--
-- Exposure: none of the six schemas is listed in the Supabase Data API "Exposed schemas"
-- setting, and the Data API is disabled if the project allows it (S4 section 2.1). The browser
-- never talks to Postgres or Supabase Auth (C-03). Runtime services run as separate local
-- processes (D-011), each connecting with its own credential: arena_public, arena_subject or
-- arena_referee (owner's Supabase project through the Supavisor pooler, username
-- "<role>.<project-ref>", or a local `supabase start` database for development).
-- No runtime use of service_role.
--
-- Error codes (SQLSTATE class AR):
--   AR001 wrong state            AR002 stale transcript version   AR003 work item / key mismatch
--   AR004 no open question       AR005 not a requestable record   AR006 release limit
--   AR007 invalid payload        AR010 append-only / immutable     AR020 reveal precondition
--   AR021 seal mismatch          AR040 caller, ticket, quota or resume refused
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- Roles. NOLOGIN here; the owner enables LOGIN and sets each password outside git
-- (a secret write that needs explicit owner authorization). NOINHERIT: no role
-- receives privileges through membership.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'arena_public') then
    create role arena_public nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'arena_subject') then
    create role arena_subject nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'arena_referee') then
    create role arena_referee nologin noinherit;
  end if;
end $$;

create schema if not exists arena;     -- public tier: cases (no role), trials, transcripts, projections
create schema if not exists subject;   -- subject-private tier
create schema if not exists sealed;    -- evaluator-only tier
create schema if not exists ledger;    -- hash chain, commitments, execution records, adjudications, manifests
create schema if not exists training;  -- investigator sessions, rubric scores, voice sessions
create schema if not exists ops;       -- budget, prices, model calls, trace mirror, keep-alive

revoke all on schema arena, subject, sealed, ledger, training, ops
  from public, anon, authenticated, service_role;

-- Default privileges (SG3-20). PostgreSQL gives PUBLIC EXECUTE on every new function, and a per-schema
-- ALTER DEFAULT PRIVILEGES cannot subtract that global default (PostgreSQL 17 docs, ALTER DEFAULT
-- PRIVILEGES). This global form covers every function the migration owner creates from now on, in any
-- schema, so a helper added later is executable by no one until it is granted. PUBLIC has no default
-- privilege on tables or sequences, so nothing else needs revoking; the capability test (S4 section 10)
-- catches any grant that is not on the allowlist. Extensions the tests need (pgtap, dblink) are created
-- before the migrations.
alter default privileges revoke execute on functions from public;

-- -----------------------------------------------------------------------------
-- Money: numeric, never float. The CHECK rejects NaN (it compares greater than every
-- number and would defeat any cap) and negatives. TechnoMile 20260927000100 lines 51-52.
-- -----------------------------------------------------------------------------
create domain ops.usd as numeric(14, 6)
  constraint usd_finite_nonnegative check (value <> 'NaN'::numeric and value >= 0);

create domain arena.sha256_hex as text
  constraint sha256_hex_shape check (value ~ '^[0-9a-f]{64}$');

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function arena.tg_forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'AR010',
    message = format('%s.%s is append-only (%s refused)', tg_table_schema, tg_table_name, tg_op);
end $$;

-- Hex sha256 of a text value. Canonical payloads are jsonb rendered by jsonb_out (keys
-- sorted, fixed spacing), so every hash in this schema is recomputable inside Postgres.
create or replace function ledger.hash_text(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

create or replace function ledger.hash_jsonb(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p, 'null'::jsonb)::text, 'UTF8')), 'hex')
$$;

-- Ledger writes require READ COMMITTED: row locks taken FOR UPDATE then serialize
-- writers, and a SERIALIZABLE caller cannot replay a stale snapshot.
-- TechnoMile 20260927000600_run_ledger_rpcs.sql lines 20-27.
create or replace function ledger.require_read_committed() returns void
language plpgsql set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'AR001',
      message = format('arena writes require READ COMMITTED, not %s', current_setting('transaction_isolation'));
  end if;
end $$;

-- Investigator identity for projection views. arena-api's identity layer resolves the request to
-- an allowlisted user (an auth.users row) and runs set_config('arena.actor_id', <user id>, true)
-- inside each request transaction (transaction-mode pooling allows transaction-local settings
-- only). Local default: S5 section 10's dev identity middleware (ARENA_ENV=local, 127.0.0.1, a
-- configured email). Hosted variant (WP-33): the IAP JWT mapped to the same allowlist. Unset
-- means no actor: views return no investigator rows (fail closed).
create or replace function arena.actor_id() returns uuid
language sql stable set search_path = '' as $$
  select nullif(current_setting('arena.actor_id', true), '')::uuid
$$;

revoke all on function arena.tg_forbid_mutation(), ledger.hash_text(text), ledger.hash_jsonb(jsonb),
  ledger.require_read_committed(), arena.actor_id()
  from public, anon, authenticated, service_role;
-- actor_id() is called inside the projection views read by arena_public.
grant usage on schema arena to arena_public;
grant execute on function arena.actor_id() to arena_public;
