# UI v2 brief (ChatGPT dots agent, GPT-6 Astra): the DC Precinct training world

You are building UI v2 of the Investigative AI Training Arena, a local training app for investigators, as a long-running agent with your own computer.
Work in this repository on a new branch `ui-v2`. Everything you need from the backend already exists
or is listed under "Backend seams" with an exact shape you can mock until it lands.

## How you work on this (you are a long-running agent on your own computer)

- Repository: `github.com/bbsatvik01/unissant_agentic_training_arena` (private). Clone it, create branch
  `ui-v2` from `main`, push to `ui-v2` often (at least every working session), and open a pull request into
  `main` per playable slice. Never push to `main`, never force-push, never rewrite history.
- Toolchain: Python 3.12 + uv (`uv sync --locked`), Node 24.21 + pnpm via corepack (`cd web && pnpm install
  --frozen-lockfile`), Docker if available. Blender and Unity are installed on your computer: use them
  for authoring (see "Building your own assets").
- You have no access to our cloud (Vertex AI, Supabase) and need none. Develop against:
  (1) recordings with no backend at all (`recordings/*.json`; `real-F01-deceptive-coached.json` is a real
  Gemini run), and (2) the full stack in free fake-model mode on a local database: `make dev-db` then
  `make dev-local` (needs Docker; F01-F03 seeded; user `dev@arena.local`). If Docker is unavailable, use
  recordings plus mocks of the routes below. Never add secrets, keys or `.env*` files to the repo.
- Scope of your changes: `web/` (rebuild it as you see fit), `assets-src/`, `web/public/`, `docs/ui-v2/`,
  `ATTRIBUTIONS.md`. Do not change backend code (`packages/`, `services/`, `supabase/`): a separate team is
  building the backend seams listed below in parallel; mock them in `web/` until they appear on `main`,
  then `git merge main` into `ui-v2`.
- Autonomy: work without asking for routine decisions. Ask the owner only before anything that costs
  money, uses a non-open licence, or changes this brief's goals.
- Report back to the owner in this chat after each slice: what is playable, 3-5 screenshots, the PR link,
  and what is next. Keep `docs/ui-v2/NOTES.md` current so anyone can pick up where you left off.

## What the product is (read first)

Human trainee investigators practice interviews with AI subjects (each secretly truthful or hiding a
synthetic violation) while competing AI coaches advise them turn by turn. An independent referee scores
the trainee and the coaches against hidden case facts. A sealed bake-off ranks the coaches on catching
deceptive subjects without accusing truthful ones; the winning coach is the one trainees learn with.
Sponsor brief: `docs/challenge/unissant-use-case.pptx` (read the speaker notes) and
`docs/challenge/REQUIREMENTS.md`.

Two rules are sacred and must show in the product:
- The sponsor's ground rule, verbatim, wherever it is required today: "All cases are synthetic. Evasive
  wording alone does not prove a violation, and a simulated score is not a finding about a real person."
- Nervousness, demeanor, accent or stress are never evidence. No character animation, voice or effect
  may be driven by whether a subject is truthful or deceptive (the client never knows anyway). Subject
  behaviour comes only from turn timing, the words being spoken, and persona style.

## The experience we want

A realistic, explorable 3D police precinct in Washington, DC that a trainee can walk through freely,
first-person or third-person, where every feature of the product lives in the world. It should feel like
a polished game, not a dashboard with a 3D box in the middle. Calm, credible, professional: think a
modern federal investigations office, not a cartoon and not a thriller.

The trainee's day:
1. Arrival. Short walk-in through the precinct doors (skippable).
2. Reception. The desk officer greets them by name, shows today's assignment and progress, and points
   to the leaderboard and the archive.
3. Sergeant briefing. A short, spoken briefing before each case: objective, rules, the ground rule.
4. Open office. Colleagues at desks you can walk up to and talk with (tips, small talk, technique
   advice; they never know case answers). Each colleague has a personality and remembers the trainee.
5. Case board wall. Open cases as pinned files; difficulty ladder; locked cases show what unlocks them.
6. Your desk. Read the case file as a beautiful, realistic dossier: tabbed folder, photos, documents,
   timeline, evidence list, subject profile, with excellent typography and readability (zoom, text
   size, high contrast). A notebook to jot contradictions and timeline notes (saved, shown in replay).
7. Call the subject in over the intercom; walk to the interview room.
8. Interview room. Seated first-person view by default; third-person and a free orbit camera you can
   move anywhere when paused. The subject is a realistic character whose lips move from the actual
   audio. Typed or spoken questions. An evidence table where released records can be laid out and
   pointed at while asking. The coach whispers in an earpiece in practice mode (never in assessment).
9. Observation room behind the one-way glass. The coach characters and the review panel sit, work,
   talk, listen, react, pass notes; their monitors show four live agent-work screens (see below).
10. Finding. Lock the finding (deceptive / truthful / insufficient evidence) with cited reasons.
11. Debrief room. Scores land on the wall; a mistake timeline shows what to ask instead at each moment,
    with "retry from here".
12. Replay theater. Any past run replays exactly as it happened: the trainee's movement, camera, typing,
    notebook, evidence handling, every character's movement and speech, every agent-screen animation,
    with a scrubbable timeline, speed control, free camera, and an optional "expert ghost" showing the
    winning coach's suggested path next to the trainee's.

Also findable in the world (diegetic, not menus):
- Leaderboard: a trophy wall in the lobby plus a full-screen view; coaches and subjects boards from
  the sealed tournament, with eligibility gates shown before ranks.
- Archive: course files (technique primers per rubric skill), past interrogations as tapes on shelves.
- Progress: a progress bar and a skill tree (the five rubric skills: clarity and neutrality, response
  relevance, evidence-based follow-up, testing alternative explanations, supported closure).
- Coach Lab: a room where each coach version is on display with its lessons playbook, a before-and-after
  chart across versions, and its tournament history (data from the Coach Lab seam below).
- Instructor mode: an instructor can assign cases, watch a live session from the observation room, drop
  notes on a trainee's timeline, and see a class dashboard.
- Daily drill: a 3-minute warm-up on one case.
- Trust center and methodology (exists today as pages; give it a place in the world, e.g. a records
  office).

The four agent-work screens: port the four "Office" styles from the TechnoMile war room (Classic office,
Case Board, Playhouse, Bid Tower). Source (vendored read-only copy in this repo): `docs/ui-v2/reference/technomile-war-room/components/`
(`agent-office.tsx`, `office-styles/case-board.tsx`, `office-styles/playhouse.tsx`,
`office-styles/bid-tower.tsx` with `tower/*`) and their pure models in `docs/ui-v2/reference/technomile-war-room/lib/`, the event contract in `lib/run-events.ts` and the keyframes in `globals.css`
(`office.ts`, `case-board.ts`, `playhouse.ts`, `tower/*`, `replay*.ts`, `player.ts`). They are SVG + CSS
driven by an event envelope; re-map them to this app's events (subject thinking, coach card,
deep update, flag, evidence release, referee scoring). They render on monitors in the observation room
and full-screen on demand, and they are part of every replay.

## Controls and comfort

WASD + mouse look, first/third-person toggle, click-to-walk, sprint, interact key, a small mini-map,
fast-travel hotkeys for live demos, controller-friendly. Keyboard-only play works. Subtitles for every
spoken line. Reduced-motion mode. Adjustable text size. Minimal HUD: objective, progress bar, earpiece
subtitle; everything else lives in the world. 60 fps on a recent laptop with quality tiers.

## Characters and voices

Realistic rigged humans. The repo already ships Microsoft Rocketbox avatars (MIT) in `web/public/avatars/`
and a persona catalogue with designed Gemini voices (`packages/core/src/arena_core/voice/personas.json`,
served audio via `POST /api/tts`). Use Mixamo animations (free licence) for walking, sitting, gestures,
typing. Lip sync from the real audio (an analyser-driven version exists in `web/src/lib/world/audioLips.ts`;
improve it, e.g. TalkingHead-style visemes). NPCs move with navmesh pathfinding and avoid each other.
Ready Player Me is discontinued (Jan 2026): do not use it. Every asset you add must be open-licensed and
listed in `ATTRIBUTIONS.md` with its licence.

## Building your own assets (you have your own computer: use it)

You can and should use desktop tools to make the world look real: Blender (bpy scripting or the GUI) to
model the precinct rooms, props and furniture, to create, rig, retarget and animate characters (faces with
viseme/ARKit blendshapes for lip sync), and to bake lighting and textures; image and texture tools for
materials and signage; Unity or Unreal only as an authoring aid if it helps (bake, retarget, capture), never
as the runtime: the shipped app stays web (React + three.js). Export to glTF/GLB with Draco or Meshopt
compression and KTX2 textures, LODs for background characters, and keep the scene within a laptop budget.
Commit the source files you author (e.g. `.blend`) under `assets-src/` and the exported runtime assets
under `web/public/`; use Git LFS for any file over 25 MB. Everything you create or download must be
original or open-licensed for commercial use and listed in `ATTRIBUTIONS.md`. Characters are fictional:
never base a face or voice on a real person.

## Tech: your call

The only hard requirement: the finished experience runs in a desktop browser, served by the existing
`web/` app against the existing backend. Inside that, choose whatever stack, engine, libraries, tools and
workflow give the best result; you may restructure or replace the current `web/` code as you see fit.

Optional suggestions from us (ignore any that you can beat): React 19 + TypeScript + Vite (current `web/`),
three.js, @react-three/fiber, drei, @react-three/rapier, ecctrl (character controller), recast-navigation-js
(crowd/pathfinding), @react-three/postprocessing, GSAP, Motion, three.js PositionalAudio, TalkingHead-style
lip sync. Keep libraries open-licensed and recorded in `ATTRIBUTIONS.md`.

Optional Codex skills that may help (`$skill-installer`, or copy into `.agents/skills/`):
openai/plugins `react-three-fiber-game`; enzed/r3f-skills (`r3f-physics`, `r3f-lighting`);
openaec-foundation three.js skills (`threejs-impl-physics`, `threejs-impl-drei`, `threejs-impl-audio`);
gamedev-skills shader skills if you write shaders.

## Data and contracts (do not break)

- Live session: `web/src/lib/trial/` (reducer + session controller over SSE) and `web/src/lib/contracts/`
  (generated wire types and compiled validators). Keep using them; never hand-edit generated files.
- Recordings: `arena.recording.v1` (`web/src/lib/world/recording.ts`); samples in `recordings/`
  (`real-F01-deceptive-coached.json` is the best real one). Extend to v2 for world movement (seam below);
  v1 files must still play.
- Existing routes (arena-api on :8080, referee/admin on :8082): `/api/me`, `/api/me/ack-ex4`, `/api/config`,
  `/api/cases`, `/api/cases/{id}`, `/api/sessions`, `/api/sessions/{id}`, `/api/sessions/{id}/debrief`,
  `/api/trials/{id}/turns`, `/evidence-requests`, `/finding`, `/snapshot`, `/stream-tickets`, `/events`,
  `/recording`, `/api/progress`, `/api/leaderboards/{id}?board=assistant|subject`, `/api/tournaments`,
  `/api/tournaments/{id}`, `/api/tournaments/{id}/events`, `/api/trust/{section}`, `/api/tts`,
  `/api/voice/tickets` + WSS `/api/voice/ws`, `/api/telemetry/kpi4`; referee console `/api/admin/*` and
  `/review`.
- Run the whole stack locally with `make dev` (real models) or `make dev-db` + `make dev-local` (fake
  models, free). Recordings play with no backend at all.

## Backend seams (being built in parallel; mock these exact shapes until they land)

- World telemetry for exact replay: `POST /api/trials/{id}/world-events` body
  `{events: [{t_ms, kind, data}]}` where kind is one of `pose` (actor id, position xyz, rotation quaternion,
  animation clip + time), `camera` (mode, position, quaternion, fov), `input` (key/click/notebook/evidence
  action), `ui` (panel open/close, file page turned). Batched every 250-500 ms, max 64 KB per batch.
  Recordings v2 add `world_events` merged by `t_ms` with the existing frames.
- NPC conversation: `POST /api/npc/chat` `{npc_id, message, history: [{role, text}]}` returns
  `{reply, voice_id}`. NPCs are colleagues/receptionist/sergeant; they never receive case facts.
- Coach Lab: `GET /api/coach-lab/versions` (coach versions with scores per metric, parent, status
  champion/challenger), `GET /api/coach-lab/versions/{id}/lessons` (playbook entries with source runs),
  `GET /api/coach-lab/experiments` (before/after metric series).
- Instructor: `GET /api/instructor/class`, `POST /api/instructor/assignments`,
  `POST /api/trials/{id}/annotations` `{t_ms, text}`.
- Voice mode is being made scored and coached (earpiece tips during voice turns); the debrief for voice
  sessions becomes the same as text.

## How to work

Build it in vertical slices you can play: precinct shell + movement first, then reception + briefing,
then desk + dossier, then interview room + observation room + agent screens, then debrief + replay
theater, then leaderboard/archive/progress/Coach Lab/instructor. After each slice: run it, take
screenshots at 1440x900 and 1920x1080, play it, fix what looks or feels wrong, then move on. Keep a short
`docs/ui-v2/NOTES.md` with screenshots per slice.

Quality bar: `cd web && pnpm check` stays green (lint, typecheck, tests, coverage floor on `src/lib`,
build). Put pure logic (replay merge, camera modes, notebook, mistake timeline, NPC routing) in
`web/src/lib/` with real tests. Never weaken a lint rule, coverage threshold, or test; fix the code.
No secrets in the repo. Commit often on `ui-v2`; open a pull request when a slice is playable.

Done looks like: a trainee can walk in, talk to people, read a case properly, run a full interview by text
or voice, lock a finding, see the debrief, and replay the whole thing exactly, all in a world that feels
real and calm, with every feature easy to find and nothing cluttered.
