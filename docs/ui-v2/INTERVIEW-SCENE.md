# Interview and observation scene ownership

`PrecinctCanvas` remains the only Canvas, and its existing Controls remains the only camera writer. `PrecinctRoute` owns one canonical session, one notebook, native modal focus and explicit room intent. The legacy `/session` route, trial reducer, SSE controller and generated contracts remain intact.

## Seating and navigation

Calling the subject and sitting are explicit room actions. They neither start a session nor request speech. Seating selects first-person. Controls saves the exact walking foot position/look, clears held keys, drag and queued routes, and suppresses walking/click-to-walk. Exiting restores that exact snapshot before a newly requested destination is consumed on the next frame. A one-slot pending destination is latest-wins. Paused free orbit uses the same camera writer. Input focus remains with native forms.

A new same-user, same-case interview preserves call/seat intent and already-earned briefing/review milestones only through an explicitly accepted preparation handoff. It survives that start's failure/retry, binds to the first actual running ID, and never silently imports state into Resume, playback, another case/user or a later run. Public table refs, tabs and citations still reset at actual run boundaries. Preparation notes require a separate explicit carry action.

## Physical agent screens

The authored room contains one physical monitor. A single atlas holds all four styles at [11, 1.12, -16.787], rotation [0, pi, 0], size 0.616 × 0.352 m, immediately ahead of its existing glass and inside the bezel. Its bottom is above the worktop. The atlas is generated atomically from one WorkFrame. High/medium/low budgets are 1024×576 at 4 Hz, 768×432 at 2 Hz and 512×288 at 1 Hz. Paused seeks/accessibility changes repaint once.

The existing camera's 10 Hz reporting cadence samples the canonical session clock for monitor geometry; no second clock or interval is introduced. Local SVG decoding is latest-wins, cancels stale callbacks and disposes owned textures. Assessment immediately remounts the material before a stale practice decode can appear. Each physical quadrant and its keyboard button opens the same native modal. Escape first exits expansion and restores its exact invoking button.

## Public evidence on the table

The physical paper cover contains only an explicitly presented, currently available public source's kind, exact ID and display title. The original full text stays in EvidencePanel. Selecting a source alone does not present it; clear, source revocation and run replacement remove it. V1 recordings show no invented table-handling history. See [cover geometry and boundaries](PRESENTED-EVIDENCE-SCENE.md).

## Verification

The focused scene run passed strict types/lint, 74/74 tests and 100% coverage of its two new pure modules (20 statements, 34 branches, 6 functions, 13 lines). Tests cover camera ownership/restoration, input cancellation, focus, deterministic atlas/UV mapping, assessment withholding and texture cancellation/disposal. The route's strict checks pass, but its focused runtime run retained unchanged timeout failures during cloud stalls. No complete slice-four pass is claimed before the combined gate and real browser review. See [current verification](INTERVIEW-OBSERVATION-QA.md).
