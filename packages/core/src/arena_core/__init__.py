"""arena_core: shared types and boot checks for every arena role (S5 1).

WP-01 ships only `config` (the S5 1.3 boot checks every role runs before anything else). The other
subpackages listed in S5's module map (providers, spend, agents, turns, events, voice, observability,
db, safety) exist as empty, importable stubs so later work packages fill them in without re-laying out
the tree; see each subpackage's docstring for which WP owns it.
"""
