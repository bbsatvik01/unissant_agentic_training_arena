# Northstar Investigation Training Precinct

An original, single-storey Washington, DC-inspired investigation training environment, modeled specifically for this project. The architecture, furnishings, reception feature, mission boards, desks, chair assemblies, archive cases, signage layout, sculptural awards, lights, map diagram, foliage, civic facade, and row-house streetscape are authored from geometric primitives and custom meshes in the included Blender Python script. No third-party models, stock textures, downloaded photos, real agency insignia, or fictional character faces are included. The streetscape is a fictional setting inspired by DC architectural types, not a geographic reconstruction or a real agency facility.

The generated scene and source are intended for modification and commercial integration in the commissioning user's training application. Text uses the installed DejaVu Sans typeface, including its Bold face for important wayfinding, converted to mesh in the runtime GLB. The self-contained Blender file packs those font faces for editable signage. DejaVu changes are public domain; the underlying Bitstream Vera font has a permissive commercial-use license. Its required notices and license are included in FONT_LICENSE.txt. No font attribution is required in the game UI; retain the supplied license with distributed source/assets.

## Deliverables

- northstar-precinct.blend: editable semantic source, materials, packed typeface, lights, and two eye-level cameras
- build_precinct.py + manifest_tools.py: reproducible scene, renders, optimized GLB, and runtime manifest
- export_runtime.py: quick runtime export from the saved .blend, without rerendering
- ../web/public/world/precinct.glb: static material-batched runtime scene
- ../web/public/world/precinct-manifest.json: rooms, hotspots, collision AABBs, portal graph, spawn, and lighting guidance
- lobby-preview.png + corridor-preview.png: eye-level Cycles review renders
- validate_manifest.py + validation-report.json: runtime/nav validation and its latest measured result

## Rebuild

The signage readability rebuild was verified with Blender 4.3.2. Run these commands from the repository root. `blender` means your installed Blender executable; use its full local path if it is not on PATH.

    blender --background --threads 6 --factory-startup --python assets-src/build_precinct.py
    python assets-src/validate_manifest.py

For a fast source/GLB/manifest rebuild while keeping the existing preview renders:

    blender --background --threads 6 --factory-startup --python assets-src/build_precinct.py -- --skip-renders
    python assets-src/validate_manifest.py

For a runtime-only export from the editable, packed Blender source:

    blender --background --threads 6 --python assets-src/export_runtime.py
    python assets-src/validate_manifest.py

Every path is resolved relative to the script, so invocation from another working directory also works. Both exporters write `web/public/world/precinct.glb` and set the manifest's `asset` field to `precinct.glb`, matching the app's loading URL. The validator reads the integrated runtime files and writes its report only to `assets-src/validation-report.json`.

The scripts use only the Python standard library and Blender bpy/mathutils; there are no network dependencies. The supplied `.blend` packs DejaVu Sans, so runtime-only export does not require a system font installation. A full rebuild searches the usual Linux DejaVu Sans location; on another system, set `ARENA_DEJAVU_FONT` to the installed DejaVuSans.ttf file before invoking Blender. If that font is absent, Blender's bundled font is used and lettering will differ. Use the packed-source export for identical lettering without installing any fonts.

The complete build is authoritative for navigation metadata. A runtime-only export preserves that metadata and refreshes chair bounds from the editable source. After moving architectural walls, desks, or other major furniture, update the corresponding source definitions and run the complete build; editing the Blender geometry alone does not automatically regenerate all navigation data.

Validation checks reciprocal graph links, connected navigation, capsule-clear paths and hotspots, furniture/wall separation, matching manifest statistics, file/triangle budgets, and the canonical runtime filename. It does not replace browser/playtesting verification.

## Coordinate and integration contract

Authoring uses meters, Blender +Z up and +Y north. GLB/Three.js uses meters, +Y up and -Z north. Convert authoring [x, y, z] to runtime [x, z, -y]. The level spans X -14 to +14, runtime Z -36 to 0. Interior floor is Y 0.02; ceiling is Y 3.5. Spawn is [0, 1.65, -2.4], looking toward [0, 1.65, -10].

The corridor has a nominal 4.6 m clear width. All eight side-room door portals are 2.05 m wide and 2.5 m high, with door leaves parked away from the opening. The door graph is explicit, and level floors have no steps. Corridor door signs face the corridor. Use a 0.28 m player collision radius and 1.65 m eye height. Clamp player X/Z to walkBounds and collide against colliders; do not use furniture visuals as a floor-height source. Room anchors are on the floor, while hotspot positions use eye height.

Collider schema: {id, min:[x,y,z], max:[x,y,z], kind}. Hotspot schema: {id, label, room, position:[x,y,z], radius, lookAt, kind}. Navigation schema: navigationNodes:[{id, position:[x,y,z], neighbors:string[]}]. Door portals also include their room connection, clear dimensions, and floor walkCenter.

Materials are batched into one mesh per material, with readable names. There are no image textures or animation clips. Fine geometry, typography, and architectural reveals are retained. GLB contains no imported lights: use the provided lighting block for renderer-controlled illumination. Emissive light diffuser surfaces and monitor graphics are already modeled. Enable a hemisphere fill and a single sun key, then optionally use only the nearest 2–4 local ceiling fixtures as point lights. Set castShadow=false for material/mesh “White acoustic ceiling” so the closed ceiling remains visible without cancelling the runtime's directional key. No transmissive renderer extension is required; glass is conventional transparent PBR material.

The room IDs are lobby, board_wall, corridor, open_office, dossier, briefing, interview, observation, debrief, coach_lab, and records. The coach_lab contains a separate instructor console hotspot. Career awards sit at the north end of the corridor and have their own trophies hotspot. Room labels and scenario panels are fictional placeholders, authored for this scene.

## Verified runtime budget

The final runtime scene is approximately 5.67 MB, with 116,267 triangles across 38 material groups. The packed editable source is approximately 1.24 MB. Both are below the 25 MB per-file target. See validation-report.json for exact measured counts and navigation checks. The source retains editable lettering and richer bevels; the GLB uses planar typography and single-segment bevels on tiny edges for efficient rendering.


## Signage readability revision

Important wayfinding uses larger, width-fitted DejaVu Sans Bold vector lettering on the original plaques. The change preserves all collider and navigation coordinates and adds no image texture or runtime font dependency. The existing FONT_LICENSE.txt notice also covers the Bold face. For a full rebuild, ARENA_DEJAVU_SIGN_FONT can point to DejaVuSans-Bold.ttf; by default it is searched beside ARENA_DEJAVU_FONT. If unavailable, the ordinary configured font is used; use the packed-source exporter for identical lettering. See ../docs/ui-v2/signage-readability-review.md for the measured diagnosis and verification status.
