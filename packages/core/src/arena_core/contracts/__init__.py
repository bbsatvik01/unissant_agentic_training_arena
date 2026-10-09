"""Shared contracts (WP-02): the one Pydantic definition of every shape that crosses a boundary.

Model-facing output schemas (S2 4, 6.8, 7): `findings.Finding`, `coaching.CoachingCard` (card.v1),
`coaching.DeepUpdate` (deep.v1), `coaching.FinalFinding` (final.v1), `subject.SubjectTurn` (subject.v1),
`referee.RefereeSubjectReport` (ref_subj.v5), `referee.RefereeAssistantReport` (ref_asst.v2). Stored shapes:
`coaching.StoredCard`, `findings.StoredFinding`, `coaching.StoredDeepUpdate`. Wire shapes (S5 6, S6 5): the event
frames (`events`), the training and tournament wire cards, the trial snapshot (`snapshot`), `debrief.v1`
(`debrief`), the review tasks (`review`) and the REST bodies and route table (`routes`). `citations` is the one
quote predicate (S2 4.4.1, D6); `adapter` is S3 1.3.1-1.3.2's reading of the stored shapes. `export` writes every
schema to `contracts/*.schema.json` deterministically.
"""
