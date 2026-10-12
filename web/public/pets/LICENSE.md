# Companion pet: provenance and licence

`cat.glb` is the Cat from **"Animated Animales Low Poly" (Animal Pack Vol.2) by Quaternius**, published on
OpenGameArt.org (opengameart.org/content/animated-animales-low-poly, file `Animal Pack Vol.2 by @Quaternius.zip`,
downloaded 2026-10-11) under **CC0 1.0 Universal** (public domain dedication; no attribution required, credited here
anyway).

Conversion: `FBX/Cat.fbx` parsed with three.js 0.186 `FBXLoader`; its Phong materials (which carry no colour in the FBX)
replaced by standard materials in the pack preview's colours (Grey #36373a, White #f1f0ec, Pink #e7a2b3); its two clips (`Idle`, `Walking`) kept and renamed without the armature
prefix; exported to binary glTF with `GLTFExporter`. The companion's states are posed procedurally on top of `Idle`.
