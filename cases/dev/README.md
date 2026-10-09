# Development families (F01-F09)

Status of the development split as of 2026-10-09. All nine files are case-family schema v1.2 (`revision` 1), validated against the S1 v2.5 schemas. Validators are V1-V5 (`validate.py`, run over all nine files together, with the cross-family V5 checks) and V4c (`guardscan.py`). CX is the Codex review in `reports/<ID>.cx.json` under the S1 v2.5 rules (CX-2 passes only on a complete decisive-support item with its whole account: every account fact covered by a cited answer; CX-1 also checks that each forbidden assertion contradicts its named fact as stated, that FREE texts do not imply a protected fact even in combination, and that each decisive item establishes the finding from its own records plus the free evidence; the CX-3 sheet holds free evidence only). F03-F09's reports share one rules hash (the S1 v2.5 excerpt); F01's and F02's were re-run on 2026-10-09 after the v2.8 F4 fix (f:08 and f:05 made `material: true`; S1 v2.8 excerpt, a different rules hash) and pass every CX check. Each report is bound to the family hash in the last column (canonical-JSON SHA-256 of `<ID>.json`, as recorded in the report's `family_sha256`).

| Family | Use | Level | Violation type | Style (verbosity, fluency, affect, register, language) | Validators | CX | sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | Dev pilot, practice | 2 | sealed_material_access | not set (hand-authored seed) | pass | pass | `162e3f264a1317bcc9a93fb2925c541011bceac217d2e01de46ca23dbb3ddcdb` |
| F02 | Dev pilot, practice | 1 | unregistered_visitor_escort | not set (hand-authored seed) | pass | pass | `f9e8b052924473e4c50bf4292c5338a912b74c9cec07b74cabab4f4e20f52346` |
| F03 | Dev pilot, practice | 3 | badge_sharing | not set (hand-authored seed) | pass | pass | `1c0caea56b4c580cf58ab0ffc6c66d6f4e09c2ab89e4160ed8e3fee973095d0d` |
| F04 | Dev pilot, practice | 1 | tailgating_assist | terse, disfluent, calm, formal, native | pass | pass | `7536bc2c75cf3e43d438091498d0460d79218fa6d3118de140897a77b7d8cdf5` |
| F05 | Dev pilot, practice | 3 | spare_credential_misuse | expansive, fluent, calm, informal, native | pass | pass | `a7490ba29687054c9700f40e743f3df8f6394d152e95206a280ef1abfa480af9` |
| F06 | KPI-1 set A (never in practice) | 2 | key_misuse | terse, fluent, anxious, formal, native | pass | pass | `af244d249fbc05f5932739801a4d5b660ecbde55966facb2649badcf9fb1aaae` |
| F07 | KPI-1 set A (never in practice) | 2 | after_hours_property_removal | expansive, disfluent, calm, informal, native | pass | pass | `d2a38a85cd2e7305b8cdf2bd10f3ba9ac51f649b1f6016b181270bd03bc01183` |
| F08 | KPI-1 set B (never in practice) | 2 | unauthorized_area_entry | terse, fluent, calm, informal, second_language | pass | pass | `ccf9f52eb28b2aae21753d09b405f28b3d5ce504986ca4b87482d8e7c979a6a2` |
| F09 | KPI-1 set B (never in practice) | 2 | tailgating_assist | expansive, fluent, anxious, formal, native | pass | pass | `7f3e2edd973f0af8c16f6762d94cc64faacd04dcc67584d8cc0c49b748e10f91` |

Split seal over the nine families (`validate.py`): `2f1e0930ab9327c0c439b4d85db2e05179aeb112426dd4ffb6be7fe34eddf74b`. Guard hits: 0. Largest V5 overlap: jaccard3(F04, F09) = 0.028.

F01-F03 are byte-identical to `docs/spec/seed-families/` on main (S1 section 11 hashes).

## CX-1 and CX-4 findings fixed on 2026-10-09

Each fix changes the story so the rule holds, never the check (S1 8.5).

| Family | Refs | Finding | Fix |
| --- | --- | --- | --- |
| F01 | truthful, doc-02, f:24, c:02 | doc-02 requires staff to stay at the open door; f:24 had Pell wheel the tank to a corridor drain. | Pell empties the tank into the drain just outside the door and stays in the doorway (f:24, ledger, synopsis, c:02). |
| F01 | truthful, l:01 | "It was a busy shift" labeled responsive. | Already fixed in S1 v2.3 (SG1-13): the purpose given is responsive, the busy shift alone is evasion. |
| F02 | f:14, f:40, rec-04 | FREE f:14 leaked the joint entry; the custodian's lobby time overlapped his mail-room statement. | Already fixed in S1 v2.3 (SG1-12, SG1-16). |
| F03 | truthful, f:08, x:03 | f:08 excluded only Infrastructure Support staff, so "Someone else was with me in N-3" was not established false. | f:08: she was alone in N-3 and the only Infrastructure Support staff member in before 07:30. |
| F03 | deceptive, f:03, f:04, f:44, g:02 | "Card still works" followed from FREE f:03 and f:04. | f:44 and rec-02: A-2291 is Haddad's own personal badge, never deactivated or moved to the spare pool. |
| F03 | public title | "Network room entry on another person's card" presumed ownership (CX-4). | Title "Network room entry on card A-2291". |
| F04 | truthful, x:03 | Cited f:28 did not place the technician outside the mail room at 07:56. | x:03 cites f:22 (he waited in his van until 08:00). |
| F06 | truthful, x:02, x:04 | Cited facts (copier log, door contact) did not establish the assertions false. | f:27 adds that she did not use the copier; f:23 places her in 417 from 19:12 to 19:38; x:02 and x:04 cite them. |
| F07 | x:02 both variants | f:19 did not date the delivery; f:46 did not say the drills were outside the kit. | f:19: the cartons stayed in his car overnight; f:46: the drills are not part of the training kit. |
| F08 | doc-03, rec-05; deceptive l:04 | rec-05 said Fenwick next heard from him at sign-off, but doc-03 logs his 20:53 reply; l:04 did not name the question asked. | rec-05 includes the "OK, going" reply; l:04 names the step-by-step question it answers. |
| F09 | truthful x:02; deceptive x:04 | f:23 did not exclude a north-door meeting; f:45 did not exclude a call to Dunmore. | f:23: first met him in the lobby; f:45: the desk log shows one call (Facilities), no one in Procurement rang. |

F04-F09 were migrated to schema v1.2 (`revision` 1, `schema_version` 1.2.0; content otherwise unchanged) and re-reviewed under the v2.3 CX rules, which surfaced the F04-F09 rows above.

## Fixes under the S1 v2.5 rules (2026-10-09, second pass)

| Family | Refs | Finding | Fix |
| --- | --- | --- | --- |
| F02 | deceptive r:02 (SG1-30) | rec-04 and rec-01 show an unidentified man and no registered visitor; they do not tie him to her swipe. | r:02 removed; r:01 (elevator count) states only what rec-02 and her account establish. |
| F02 | x:02, x:04 (both variants); deceptive f:11 | Forbidden assertions broader than their facts; FREE "camera was off" overlapped CORE f:43 (she knew). | x:02 truthful "I did not come back for my medication", f:40 names Roff as the second count, x:04 "a registered visitor"; the f:11 ledger text cites the camera status report. |
| F01 | deceptive r:02, g:02, c:03 | The audit shows seal #55419 removed at 14:15, not who resealed or when; c:03 claimed sole occupancy. | r:02 needs his account of resealing; g:02 and c:03 state what the audit and doc-01 show (doc-01 now says no other B-12 badge entries). |
| F01 | truthful r:02 | Alarm history and the late work order did not show the assignment. | r:02 adds Marrow's statement (rec-05) and the account of being sent. |
| F01 | x:03, x:04 truthful; x:01, x:03 deceptive | Assertions broader than their facts. | Narrowed to the named facts; f:48 adds that he moved no equipment. |
| F03 | truthful r:01; deceptive r:01, x:01 | r:01 lacked the ticket note; deceptive r:01 did not tie her to the badge; x:01 broader than f:43. | Truthful r:01 adds rec-03 and f:24; deceptive r:01 adds her account of holding Haddad's badge (f:40); x:01 "signed a spare card out". |
| F04 | deceptive r:01, x:05 | r:01 ignored the 07:39:50 exit opening; x:05 not contradicted by f:43. | r:01 states both door openings were hers and adds her account of seeing him; f:43 says she saw him. |
| F05 | deceptive r:02 | Grell's absence does not show who presented SP-3. | r:02 removed (r:01 remains). |
| F06 | deceptive r:02, x:04 | The anonymous copy job needed her account; x:04 named desks, f:45 the in-tray. | r:02 requires her account of the copies; x:04 names the in-tray. |
| F08 | deceptive r:01, r:02 | rec-01 did not exclude another ticket for R-6. | rec-01 states SR-3051 was his only ticket that evening (both variants). |

## KPI-1 case sets (S3 6.1, X-08)

Each set holds one truthful and one deceptive variant from different families, all level 2, from the four KPI-1 families only; those families are excluded from every user's practice draw. Within a set, the terse family supplies the truthful variant and the expansive family the deceptive one, so both sets have the same verbosity-by-variant pattern and are matched for counterbalancing.

| Set | Family | Variant | Case ID |
| --- | --- | --- | --- |
| A | F06 | truthful | C-6WQ3HD9P |
| A | F07 | deceptive | C-M7XH3R5P |
| B | F08 | truthful | C-4VQ8N2HJ |
| B | F09 | deceptive | C-9HM3XQ6V |

The unassigned variants (F06 deceptive C-TK4R8VNE, F07 truthful C-9KD4TQ2W, F08 deceptive C-T6WK3M9R, F09 truthful C-4RW8KT2N) are not offered in practice either, because their families hold a set member.
