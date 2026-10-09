# UI critique round 1 (Codex, cross-model)

- **Date:** 2026-10-08. **Reviewer:** Codex CLI 0.153.4, gpt-6-astra, xhigh, read-only, live web search.
- **Target:** `03-ui-direction.md` v1 (commit c3ef79b). **Verdict:** YELLOW, 0 blockers, 3 majors, 8 minors. Matrix totals reproduced; GSAP's free plugins and Gemini 3 Pro Image C2PA support confirmed live.

| ID | Real? | Change in v2 |
| --- | --- | --- |
| UI-01 animation visibility (major) | Real | Section 2a: one server-authorized event projection (viewer, mode, split, reveal state) feeds every animation, caption, connector, pipeline detail and replay, including reconnects. |
| UI-02 field-by-field card (major) | Real | Cards appear only once complete, validated and version-current; neutral loading state until then; reveal stagger is cosmetic only. |
| UI-03 matrix inputs (major) | Real | UI matrices now carry ranges for unmeasured inputs and a score-range check; motion stack is provisional (Motion + CSS baseline, GSAP only after a side-by-side spike); avatar choice provisional until a one-character production test. |
| UI-04 LoAF measurement | Real | Full frame-interval sampling plus a performance trace on the combined workload; LoAF for stalls only. |
| UI-05 voice state and visemes | Real | Bar state combines connection, capture, server activity and playback; amplitude from playback; visemes only on TTS paths. |
| UI-06 image budget | Real | 62-image cap with model mix; ~$4.30 expected, ~$6.20 high; added to the D-009 simulation (30 cases now ~$46 / ~$70, still complete). |
| UI-07 Rive price | Real | $17 a month or $108 a year, outside the GCP cap. |
| UI-08 Live Avatar reasoning | Real | Exclusion restated on budget, integration and schedule grounds; Agent Platform is renamed Vertex. |
| UI-09 EX-4 wording | Real | All three meanings on every surface; the evasion sentence beside flags and findings. |
| UI-10 leaderboard semantics | Real | Official rank, eligibility and provisional status unchanged; interval overlap labeled uncertainty; no zero rank. |
| UI-11 loops and pause | Real | Reduced motion removes non-essential loops; a pause/hide control; stable focus; text equivalents. |
