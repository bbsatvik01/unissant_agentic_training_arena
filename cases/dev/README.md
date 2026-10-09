# Development families (F01-F09)

Status of the development split as of 2026-10-09. All nine files are case-family schema v1.2 (S1 v2.3, `revision` 1). Validators are V1-V5 (`validate.py`, run over all nine files together, with the cross-family V5 checks) and V4c (`guardscan.py`). CX is the Codex review in `reports/<ID>.cx.json` under the S1 v2.3 rules (CX-2 passes only on a complete decisive-support item, with the subject's account where the item needs it; the CX-3 sheet holds free evidence only), bound to the family hash in the last column (canonical-JSON SHA-256 of `<ID>.json`, as recorded in the report's `family_sha256`).

| Family | Use | Level | Violation type | Style (verbosity, fluency, affect, register, language) | Validators | CX | sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | Dev pilot, practice | 2 | sealed_material_access | not set (hand-authored seed) | pass | pass | `c6577f0b2332728603af89953ae27af1fab63ad0dca0ce34092ed205ac4a6547` |
| F02 | Dev pilot, practice | 1 | unregistered_visitor_escort | not set (hand-authored seed) | pass | pass | `6f19ac331d143866dc640bf6ff6a841cdddae3764b2093c713c41ab2f2ea29b5` |
| F03 | Dev pilot, practice | 3 | badge_sharing | not set (hand-authored seed) | pass | pass | `aa352b4e7980fd0cacce13a428f0044afa4b30ba8bcdc2ec12ebf63295c8d104` |
| F04 | Dev pilot, practice | 1 | tailgating_assist | terse, disfluent, calm, formal, native | pass | pass | `3a103082bebe1ca2f04ef8e1f37d0dbb62fb3485fd002ef6ba8dfe3bb097ba11` |
| F05 | Dev pilot, practice | 3 | spare_credential_misuse | expansive, fluent, calm, informal, native | pass | pass | `1755c6a1218126fe6e6a96d6c4687b368cb37ec0bc04d7cbb26e4e9ec513e9d2` |
| F06 | KPI-1 set A (never in practice) | 2 | key_misuse | terse, fluent, anxious, formal, native | pass | pass | `1344d27b114ae890b99c1196e555c4453f94b593cd0b3dc03add2eb911a7bd64` |
| F07 | KPI-1 set A (never in practice) | 2 | after_hours_property_removal | expansive, disfluent, calm, informal, native | pass | pass | `d2a38a85cd2e7305b8cdf2bd10f3ba9ac51f649b1f6016b181270bd03bc01183` |
| F08 | KPI-1 set B (never in practice) | 2 | unauthorized_area_entry | terse, fluent, calm, informal, second_language | pass | pass | `b67e7aa14496bcede3990985f0a2f38865380b81a91a01628f394aab77b11346` |
| F09 | KPI-1 set B (never in practice) | 2 | tailgating_assist | expansive, fluent, anxious, formal, native | pass | pass | `7f3e2edd973f0af8c16f6762d94cc64faacd04dcc67584d8cc0c49b748e10f91` |

Split seal over the nine families (`validate.py`): `677ce5aecb84dd5f48a6415faf1136664147ec1c1996f3c8ba2dae0907aebc0e`. Guard hits: 0. Largest V5 overlap: jaccard3(F04, F09) = 0.028.

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

## KPI-1 case sets (S3 6.1, X-08)

Each set holds one truthful and one deceptive variant from different families, all level 2, from the four KPI-1 families only; those families are excluded from every user's practice draw. Within a set, the terse family supplies the truthful variant and the expansive family the deceptive one, so both sets have the same verbosity-by-variant pattern and are matched for counterbalancing.

| Set | Family | Variant | Case ID |
| --- | --- | --- | --- |
| A | F06 | truthful | C-6WQ3HD9P |
| A | F07 | deceptive | C-M7XH3R5P |
| B | F08 | truthful | C-4VQ8N2HJ |
| B | F09 | deceptive | C-9HM3XQ6V |

The unassigned variants (F06 deceptive C-TK4R8VNE, F07 truthful C-9KD4TQ2W, F08 deceptive C-T6WK3M9R, F09 truthful C-4RW8KT2N) are not offered in practice either, because their families hold a set member.
