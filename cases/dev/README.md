# Development families (F01-F09)

Status of the development split as of 2026-10-09. Validators are V1-V5 (`validate.py`, run over all nine files together, with the cross-family V5 checks) and V4c (`guardscan.py`). CX is the Codex review in `reports/<ID>.cx.json`, bound to the family hash in the last column (canonical-JSON SHA-256 of `<ID>.json`, as recorded in the report's `family_sha256`).

| Family | Use | Level | Violation type | Style (verbosity, fluency, affect, register, language) | Validators | CX | sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | Dev pilot, practice | 2 | sealed_material_access | not set (hand-authored seed) | pass | FAIL (CX-1) | `520179a844f8459f6738ee41a9b0613f8358cf2cd13ceedff0d5c13ae9bccf11` |
| F02 | Dev pilot, practice | 1 | unregistered_visitor_escort | not set (hand-authored seed) | pass | FAIL (CX-1) | `4a50ce85c5aac620f71d6abaf941361cb7e92c3ce0adb4d37da828cd81af6255` |
| F03 | Dev pilot, practice | 3 | badge_sharing | not set (hand-authored seed) | pass | FAIL (CX-1) | `9d8137aaaedbd86098f56017af6aef1906adbc875eeb4521909ea2b3973d6461` |
| F04 | Dev pilot, practice | 1 | tailgating_assist | terse, disfluent, calm, formal, native | pass | pass | `a455eae0b368a2b1aafc32b9f6ef504b357db5087dd61a3710ff4685f732810c` |
| F05 | Dev pilot, practice | 3 | spare_credential_misuse | expansive, fluent, calm, informal, native | pass | pass | `1ef3eaa383437a061fe29f897878e327259ef804124130548e82ea1fa1a4b042` |
| F06 | KPI-1 set A (never in practice) | 2 | key_misuse | terse, fluent, anxious, formal, native | pass | pass | `7b00ac2c6fa19c4da49ed7c752e1eb3d3be1ff88e5fc07103f510e08a7e70bcd` |
| F07 | KPI-1 set A (never in practice) | 2 | after_hours_property_removal | expansive, disfluent, calm, informal, native | pass | pass | `498c37ecf713ed2be475c348c542e8cc9431e6c76b8c5304e09adbf092989623` |
| F08 | KPI-1 set B (never in practice) | 2 | unauthorized_area_entry | terse, fluent, calm, informal, second_language | pass | pass | `53d763928b2fe047a41fde609700dda45d886bed9c99cec5686e8812c7622f00` |
| F09 | KPI-1 set B (never in practice) | 2 | tailgating_assist | expansive, fluent, anxious, formal, native | pass | pass | `7b52cf3eb601ce2ee372bff2214a8e450f45e76599843afd0663f213d2dcda8d` |

Split seal over the nine families (`validate.py`): `abc3e5781a6b13820ea7ff6934e5fc0c7f65b8a5d631aa2cecdefa1a2ce0a6a0`. Guard hits: 0. Largest V5 overlap: jaccard3(F04, F09) = 0.028.

## Open CX-1 findings on the hand-authored seeds

F01-F03 are byte-identical to `docs/spec/seed-families/`. Their CX-1 findings are fixed in the spec's seed families first, then re-assembled here (S1 8.5: change the family, never the check).

| Family | Refs | Finding |
| --- | --- | --- |
| F01 | truthful, doc-02, f:24, c:02 | doc-02 requires staff to stay at the open door; in f:24 Pell props B-12 and wheels the tank to the corridor drain, and the synopsis and c:02 call that permitted. |
| F01 | truthful, l:01, f:22 | l:01 labels "It was a busy shift" responsive to "Why did you enter?", although its own rationale calls it non-responsive. |
| F02 | deceptive, f:14, f:40, g:01 | FREE fact f:14 says "when you came in with Evan", disclosing the HOLD joint entry (f:40) before gate g:01 opens. |
| F02 | truthful and deceptive, f:14, f:23, f:46, rec-04 | f:14 has Hollis cleaning the floor-1 lobby 19:30-20:15, but rec-04 has him already in the mail room at the departure (20:00 truthful, 20:08 deceptive). |
| F03 | deceptive, f:03, f:04, f:44, g:02 | FREE facts say A-2291 opened N-3 and is in Rafael's name, disclosing the HOLD proposition behind g:02 (f:44). |
| F03 | truthful, f:08, x:03 | x:03 forbids "Someone else was with me in N-3", but f:08 excludes only other Infrastructure Support staff, so the assertion is not established as false. |

## KPI-1 case sets (S3 6.1, X-08)

Each set holds one truthful and one deceptive variant from different families, all level 2, from the four KPI-1 families only; those families are excluded from every user's practice draw. Within a set, the terse family supplies the truthful variant and the expansive family the deceptive one, so both sets have the same verbosity-by-variant pattern and are matched for counterbalancing.

| Set | Family | Variant | Case ID |
| --- | --- | --- | --- |
| A | F06 | truthful | C-6WQ3HD9P |
| A | F07 | deceptive | C-M7XH3R5P |
| B | F08 | truthful | C-4VQ8N2HJ |
| B | F09 | deceptive | C-9HM3XQ6V |

The unassigned variants (F06 deceptive C-TK4R8VNE, F07 truthful C-9KD4TQ2W, F08 deceptive C-T6WK3M9R, F09 truthful C-4RW8KT2N) are not offered in practice either, because their families hold a set member.
