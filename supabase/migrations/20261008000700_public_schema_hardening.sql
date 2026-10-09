-- 0007 public schema hardening (S4 section 2.1, `public` schema; WI-S4-01).
-- The arena keeps the `public` schema empty. Supabase grants the Data API roles access to every new table,
-- view, sequence and function the migration owner creates there. These are Supabase's documented
-- default-privilege revokes ("Securing your API", Default privileges; Context7 /websites/supabase_guides, fetched
-- 2026-10-09), widened from the listed table and sequence privileges to ALL, so an object created there by
-- accident is reachable by no API role until it is granted. PUBLIC's EXECUTE on new functions is already revoked
-- globally by 0001 (SG3-20). Existing objects keep their grants; the arena creates none in `public` (pgtap and
-- dblink live in `extensions`). Kept out of the six ported drafts (docs/spec/sql/0001-0006) so those stay the
-- drafts unchanged in substance. Gate: supabase/tests/001_capability_matrix.sql CM-21.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, service_role;
