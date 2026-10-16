# Office and Courtyard variants

Status: integrated source, actual browser acceptance pending. The original Office remains a recoverable selectable world. The new Courtyard is an original compact adaptation of the publicly documented Old Patent Office Building / HABS DC-130 courtyard-wing arrangement. It is neither an exact historic reconstruction nor a current museum/security plan. Attribution and commercial-use provenance travel with `assets-src/COURTYARD-PROVENANCE.md`; no reference photograph, seal or logo is a runtime asset.

## Geometry and navigation

- Retains the original 28 × 36 m Office, original room/hotspot/station coordinates and training interactions.
- Adds a 28 × 20 m north annex, with an 18 × 8 m courtyard, paired planted circles, colonnade and axial route. Combined bounds: X ±14 m, Z −36 to 20 m.
- Courtyard runtime: 3,167,788 bytes, 121,656 triangles. Editable Blender source: 1,652,324 bytes. These are asset counts, not observed per-frame renderer costs.
- Original runtime and source remain byte-identical. Lossless decoding, module preservation and authored layout reports are archived under `courtyard-asset-proof/`.
- The selected world determines geometry, authored colliders, map extent and navigation input. The reviewer-chair collider is applied after world selection and before the sole movement/crowd controller.
- Polygon navigation is a separate pending delta. The current staged controller still has the validated waypoint route; do not infer navmesh acceptance from the architectural asset.

## Runtime ownership

One existing session/controller, Canvas, movement/camera writer, modal and replay cursor remain. Idle world selection is locked during local capture, armed/active fresh capture, live interview, recording playback and seated interview. A world change remounts scene readiness, expires stale callbacks and clears pending travel. The old world cannot report ready or append samples into the new world's capture.

Scene-ready means the selected geometry actually mounted; it does not promise that every asynchronous avatar or screen has rendered. Renderer failure revokes capture readiness while leaving accessible map/station navigation available.

## Bounded recording identity

The UI-local v2 scene context has exactly six fields: version, scene_id, asset_id, asset_sha256, manifest_sha256 and build_sha256. It is bounded to 512 UTF-8 bytes, fixed known IDs and SHA-256 digests. Crossed, partial, unknown or extra fields refuse import. It cannot select arbitrary URLs. Older recordings without scene identity use the original Office, regardless of the exploration preference.

The two `web/src/lib/world/scene-adapter-*-v2.json` manifests pin actual geometry, authored manifest, effective reviewer overlay, finite procedural body interpreters, actual rig/root/camera application and ten original avatars. Byte-integrity tests verify the shipped dependency identities. This compatibility claim is client-provided metadata, not server authenticity or whole-world fidelity.

Replay holds captured roots and camera samples. Live navigation planning, theme, mutable route composition, original panel layout, monitor animation, original audio and visemes are outside the identity guarantee. Old incompatible identities must be rejected or retain their old interpreter; they must never be silently mapped to changed meaning.

## Capture and speech boundary

Start/Arm/Begin require actual mounted scene readiness. Readiness loss preserves the accepted prefix and original scene tuple, then marks the capture incomplete. Actual started staff audio refuses silent capture; if audio begins during capture, synchronous guards mark it incomplete before further samples. This uses the existing playback activity owner and creates no second audio clock.

Current capture is approximately 10 Hz held camera/root samples plus supported public event projections. It omits original speech/visemes and original panel layout. UI action traces are displayed, not used to execute historical actions. True retry-from-here and a verified winning-coach ghost still require backend/source traces; no result or expert identity is fabricated.

## Acceptance still required

Final aggregate gate, both worlds at 1440 × 900 and 1920 × 1080, world-switch locks, stale-readiness rejection, recorded world selection, real collision/room reachability, speech stop/mute/capture interruption and production renderer profiling. The owner's 60 FPS MacBook Air M5 target is unverified until tested on actual target hardware. Source previews and software-rendered screenshots are not that performance evidence.
