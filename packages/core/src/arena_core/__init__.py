"""arena_core: shared types and boot checks for every arena role (S5 1).

WP-01 ships `config` (the S5 1.3 boot checks every role runs before anything else). WP-08 adds
`scenario` (the deterministic S1 scenario engine: family source model, assembler, validators, relay test,
seed sampler, authoring brief, ingest bundle), `ids` (canonical JSON and sha256) and the
`sanitize_untrusted_text` half of `agents.fence`. The other subpackages listed in S5's module map
(providers, spend, agents, turns, events, voice, observability, db, safety) exist as empty, importable
stubs so later work packages fill them in without re-laying out the tree; see each subpackage's
docstring for which WP owns it.
"""
