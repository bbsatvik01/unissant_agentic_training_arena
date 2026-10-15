# Neutral seated interview cast

The interview and observation cast uses the existing MIT Microsoft Rocketbox avatars and original procedural motion. No new character asset, external animation, paid service or model is required. Characters are fictional. Truth, deception, outcome, score, nervousness, accent and stress are never animation inputs.

## Authored placement

The interview table is centered at [8.7, 0.76, -13.2], with a 0.7975 m upper surface. The investigator seat is [8.65, 0, -12.22], facing north; the subject seat is [8.65, 0, -14.18], facing south. Observation seats are at X 6.2, 8.1 and 10, Z -17.5. Cushion tops are 0.52 m. The seated rig fits the pelvis to 0.62 m and solves two-link legs from actual bone lengths while preserving floor contact. Hands rest neutrally on the lap.

The scene receives only the public cast projection, public subject name, canonical clock, presentation controls and the shared agent-work frame. It never receives a recording, evaluator answer, hidden case data or debrief. Public persona and turn lifecycle select neutral pose variants. Actual audio is the sole mouth-motion input; silence, pause and reduced motion close the mouth. There is no transcript-derived lip animation.

## Ownership and budgets

Each actor clones its scene, skeleton, materials and texture objects. Shared loader geometry and images remain owned by the loader. Cleanup deduplicates owned resources, and automatic primitive disposal is disabled to protect shared geometry. Actors suspend independently. High/medium/low procedural updates use 60/30/15 Hz, with shadows only on High. This is not a claim of GPU mesh LODs or measured 60fps.

All driven bones reset before each deterministic pose. Public name/time-derived blink and breathing repeat at the same supplied time. Future exact replay must apply captured root transforms and a versioned reproducible body pose, never rerun navigation or invent missing speech.

## Verification

Focused strict lint and complete-app types passed. The original cast run passed 18/18 tests; its pure stage model reached 100% coverage (60 statements, 44 branches, 12 functions, 51 lines). CPU rig checks preserved ankle floor heights for five representative avatars. The subsequent pinned-Node scene run passed all 74 scene/cast/monitor tests. The later actual browser captures verify seated placement and chair/table clearance at both resolutions. The first-person camera frames toward [8.65, 1.12, -14.12] while the actor gaze anchor remains [8.65, 1.36, -14.12]. Decoded-audio mouth behavior, hardware FPS and the final combined gate remain unverified. See [current verification](INTERVIEW-OBSERVATION-QA.md).
