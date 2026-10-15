# Directional observation glazing

Original runtime geometry adds one two-triangle plane to the existing authored viewing opening. Its opaque metallic front faces the interview room; its back is culled, so the observation room retains its original tinted viewing pane. Existing door vision glazing, source GLB/Blender geometry, frames, collision and navigation remain unchanged. Mount `ObservationGlazing` once beside `Architecture` inside the existing precinct Canvas.

This is a stylized directional material treatment using the existing local room environment, not a real-time reflected camera or a physical/security/privacy guarantee. No render target, shader compiler hook, network, world clock, truth/persona input or per-frame state is added. All geometry and code are original project work; the existing Three.js license applies.

Pending: strict types/lint/tests, verify both room viewpoints in actual WebGL, and confirm frames/paper/screens remain unobscured. Do not claim acceptance before those checks. The pure regression covers plane side, aperture and depth offset, not final rasterization.
