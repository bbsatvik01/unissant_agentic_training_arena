-- 1100 candidate manifest hash (S2 3.1, 3.2; WP-10). One defect the WP-10 Codex gate found: S2 3.1 stores each
-- candidate version in arena.candidates with its manifest `sha256`, and S2 3.2 defines that hash (drop `sha256` and
-- `frozen_at`, canonical JSON with sorted keys and compact separators, non-ASCII kept, sha256, lowercase hex;
-- arena_core.agents.manifests.manifest_sha256). The column was generated as ledger.hash_jsonb(manifest), the hash
-- of jsonb's own text form (`{"a": 1}` with spaces, keys ordered by length), so no registered candidate could ever
-- carry the manifest hash the prompt builders, the port's runtime check and the roster freeze compute.
--   Fix 1: ledger.canonical_json renders a jsonb value exactly as Python's
--          json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) does for the integer-only
--          JSON a manifest is (S2 3.1: no floats; a fractional number is refused, AR007).
--   Fix 2: arena.manifest_sha256 is S2 3.2's rule; arena.candidates.sha256 is generated from it (PostgreSQL 17
--          SET EXPRESSION), and register_candidate compares and logs that hash. A manifest that carries a `sha256`
--          different from its own S2 3.2 hash is refused (AR007).
-- Gates: supabase/tests/017_candidate_hash.sql CH-01..CH-05; packages/core/tests/agents/test_manifest_sql.py.

create or replace function ledger.canonical_json(p jsonb) returns text
language plpgsql immutable strict set search_path = '' as $$
declare
  v_out text;
begin
  case jsonb_typeof(p)
    when 'object' then
      -- Keys in code point order: the "C" collation compares UTF-8 bytes, which order as code points do.
      select '{' || coalesce(string_agg(to_jsonb(e.key)::text || ':' || ledger.canonical_json(e.value), ','
                                        order by e.key collate "C"), '') || '}'
        into v_out from jsonb_each(p) e;
    when 'array' then
      select '[' || coalesce(string_agg(ledger.canonical_json(e.value), ',' order by e.ord), '') || ']'
        into v_out from jsonb_array_elements(p) with ordinality as e(value, ord);
    when 'number' then
      if p::text !~ '^-?[0-9]+$' then
        raise exception using errcode = 'AR007',
          message = 'canonical JSON holds integers only (S2 3.1: a manifest has no floats)';
      end if;
      v_out := p::text;
    else
      -- Strings (jsonb escapes exactly the characters json.dumps escapes), booleans and null.
      v_out := p::text;
  end case;
  return v_out;
end $$;

create or replace function arena.manifest_sha256(p jsonb) returns text
language sql immutable strict set search_path = '' as $$
  select ledger.hash_text(ledger.canonical_json(p - 'sha256' - 'frozen_at'))
$$;

alter table arena.candidates alter column sha256 set expression as (arena.manifest_sha256(manifest));

-- register_candidate: the 0200 body with the marked changes (`create or replace` keeps its grants).
create or replace function arena.register_candidate(p_kind text, p_name text, p_version text, p_manifest jsonb)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id  uuid;
  v_sha text;
  v_new text;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object'
     or not (p_manifest ?& array['manifest_version', 'candidate_id', 'kind', 'display_name', 'version', 'official',
                                 'transport', 'model', 'prompt', 'tools', 'coaching_policy', 'subject_policy', 'limits',
                                 'repair', 'sampling', 'lineage'])
     or p_manifest ->> 'manifest_version' is distinct from 'manifest.v1'
     or (p_manifest ->> 'kind', p_manifest ->> 'candidate_id', p_manifest ->> 'version')
        is distinct from (p_kind, p_name, p_version)
     or jsonb_typeof(p_manifest -> 'limits') is distinct from 'object'
     or (p_kind = 'assistant' and jsonb_typeof(p_manifest -> 'coaching_policy') is distinct from 'object')
     or (p_kind = 'subject' and jsonb_typeof(p_manifest -> 'subject_policy') is distinct from 'object') then
    raise exception using errcode = 'AR007',
      message = 'manifest must be manifest.v1 with every key, matching kind, candidate_id and version';
  end if;
  v_new := arena.manifest_sha256(p_manifest);  -- changed: S2 3.2's hash (AR007 on a float)
  -- changed: a manifest that states its own hash must state S2 3.2's.
  if jsonb_typeof(p_manifest -> 'sha256') = 'string' and p_manifest ->> 'sha256' <> v_new then
    raise exception using errcode = 'AR007', message = 'manifest sha256 is not its S2 3.2 hash';
  end if;
  select id, sha256 into v_id, v_sha from arena.candidates
   where kind = p_kind and name = p_name and version = p_version;
  if found then
    if v_sha = v_new then
      return v_id;
    end if;
    raise exception using errcode = 'AR003', message = 'candidate version reused with a different manifest';
  end if;
  insert into arena.candidates (kind, name, version, manifest) values (p_kind, p_name, p_version, p_manifest)
    returning id into v_id;
  perform ledger.append_event('candidate_registered', null, null,
    jsonb_build_object('candidate_id', v_id, 'kind', p_kind, 'name', p_name, 'version', p_version,
                       'sha256', v_new));
  return v_id;
end $$;

revoke all on function ledger.canonical_json(jsonb), arena.manifest_sha256(jsonb)
  from public, anon, authenticated, service_role, arena_public, arena_subject, arena_referee;
