"""The agent port: one typed path for every model call (S5 3).

`port.AgentPort` (policy, input bound, reserve, dispatch, attempts, settle), `vertex` (the only google.genai importer),
`fake` (zero spend, every test and ARENA_MODEL_MODE=fake), `mode` (adapter selection) and `smoke` (the owner's one
paid connectivity check; never run by a test).
"""
