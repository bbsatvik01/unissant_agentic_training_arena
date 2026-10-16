# Upstream seams: 2026-10-15 integration review

Pinned upstream: `693c8c193229ac70754ffaad8335d757ee684a1a`.
UI source preserved before merge: `9cd148b0590b7563d994308b4dcfa3d91e12c0f0`.

The original owner brief explicitly says to merge main into ui-v2 when backend seams appear. This is an ordinary merge of genuine history, separate from the still-pending replacement-branch decision. Backend/source-policy changes come unchanged from main; all UI-authored resolution stays in the permitted web/docs/assets scope. No live model call is required to reconcile or test these contracts.

## Recording and telemetry

- `/api/trials/{id}/recording` keeps its existing path and visibility rules and now exports `arena.recording.v2` from `arena_core.events.load.load_recording`.
- World batches are at most 65,536 request bytes and 1–2,000 events. Each `t_ms` is an integer from 0 through 86,400,000. Kind is pose/camera/input/ui; `data` is a generic JSON object, not a guarantee of our renderable geometry schema.
- Preserve generic accepted data and instructor annotations during import/export. A checked, bounded UI adapter may render only explicitly understood samples. Unknown fields must not become actor behavior, truth/deception signals or evidence.
- Keep legacy v1 playback, reveal/assessment checks, bounded file reads, scene identities, stable ordering and local-only finding refusal. Local world-only capture is a separately declared UI profile; do not assume an empty canonical event ledger is an upstream trial export.
- Do not upload original local finding drafts or silently coerce unsupported timestamps. The transport must prove the upstream time/count/body bounds before sending.
- The handwritten recording model/parser were the two merge conflicts. Both are now resolved with bounded generic telemetry, preserved annotations, explicit UI-world profile narrowing, and legacy v1 compatibility. The original upstream recording tests remain unchanged. Fresh merged strict app/tools, changed lint and 444 focused runtime tests now pass; aggregate coverage/build and actual browser verification remain pending.

Sources: `packages/core/src/arena_core/contracts/routes.py`, `packages/core/src/arena_core/events/load.py`, `packages/core/src/arena_core/db/arena.py`, `services/api/src/arena_api/routes/{turns,world}.py`, `supabase/migrations/20261015000100_ui_v2_seams.sql`.

## Colleague conversation

`GET /api/npc` supplies catalogue IDs, names, roles and voices. `POST /api/npc/chat` accepts `npc_id`, a 1–400-character message and at most 12 prior lines (1–400 characters each). Prior roles accept investigator/user and npc/assistant aliases. The response is `{reply, voice_id}`; rate refusal is 429 and provider unavailability is 503.

The route reads no case, trial or session facts. Preserve that boundary: no assignment, public packet, case answer, hidden label, notebook or interview transcript is added to colleague requests. Existing bounded authored conversation remains useful offline.

**Cost boundary:** the configured free endpoint may fall back to spend-guarded Gemini. The route's existence is not proof that it is free. This cloud task uses synthetic local mocks and must not invoke that fallback without separate cost authorization. Live app integration should expose the configured provider accurately rather than promise free AI conversation.

Sources: `services/api/src/arena_api/routes/npc.py`, `packages/core/src/arena_core/contracts/routes.py`, `packages/core/src/arena_core/npc/`.

## Coach Lab

The three read-only paths now exist. They read the committed development-only registry and do not initiate training, promotion, tournament runs or model calls.

- Versions include `id`, candidate/version, champion/challenger/retired status, parent ID, manifest hash/path, change note, source run, creation time, lesson IDs, optional metrics and verdict.
- Lessons return `{version_id, lessons}` with each original lesson's source IDs and current review status. Do not present rejected/pending material as human-approved guidance.
- Experiments include mode fake/vertex, champion/challenger IDs, before/after metrics, validation series, stop reason and provenance. Fake results must remain labelled. Holdout metrics are not automatically sealed tournament history; absent history stays absent.

The current local demonstration is still labelled fictional. The next adapter must validate these actual response shapes, preserve nullable data and distinguish fake experiments, measured values and missing values. No metric scale, eligibility, promotion or improvement may be invented.

Sources: `services/api/src/arena_api/routes/coach_lab.py`, `packages/core/src/arena_core/coachgym/{registry,playbook}.py`.

## Instructor workspace

These routes live on the **referee origin**, not the trainee API origin. The existing same-origin console bootstrap and CSRF mechanism remain the model. `/api/me` must identify a console profile with the explicit instructor role before class data or mutation controls are enabled.

- Class read: `{trainees}` with user IDs, display names, session/ended/scored counts, nullable mean score/last time, recent sessions and assignments.
- Assignment body: `{user_id, case_id}` only. The local illustrative practice-objective note is not an accepted request field.
- Annotation body: `{t_ms, text}`, integer 0–86,400,000 and 1–2,000 characters. The response contains annotation ID, timestamp, text and creation time; the trainee sees notes in recording v2.
- The class overview does not itself establish a live instructor transcript/camera subscription. Do not reuse an owner-only trainee stream or claim live observation until a supported authorized read path is verified.

Keep disconnected/local-demo states explicit and preserve assessment withholding. No cross-origin credential workaround or permission inference is appropriate.

Sources: `services/referee/src/arena_referee/{identity_dep,instructor}.py`, `services/referee/src/arena_referee/routes/instructor.py`, `web/src/lib/api/{client,console}.ts`, `web/vite.config.ts`.

## Generated contracts and verification

The upstream schema exporter currently registers the existing wire models, but not the four new seam request classes in its `WIRE` map. Do not manually edit generated types/validators or invent generated artifacts. Existing schema-covered requests keep their generated validators; uncovered seam views need narrow checked readers and fixture tests pinned to the actual upstream implementation, with any generator expansion left to the backend team.

Before claiming combined integration: resolve the recording conflicts; prove v1/v2/local-profile round trips and annotation preservation; run strict types/lint and all unchanged web tests/coverage/build; then inspect actual browser movement, station reads, captions/audio cleanup and both world variants. Local mock success does not establish a live paid/provider result.
