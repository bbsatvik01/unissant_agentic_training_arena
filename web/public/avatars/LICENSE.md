# Avatars: provenance and licence

The people in the world are characters from the **Microsoft Rocketbox Avatar Library**
(github.com/microsoft/Microsoft-Rocketbox, commit `0943055db6ec570bcef9f2c8b41c9e5467c808f9`, archived 2026-10-02),
released under the MIT licence reproduced below. Nothing here is a likeness of a real person.

| Folder | Source (Assets/Avatars/...) | Plays |
| --- | --- | --- |
| `Male_Adult_05` | Adults/Male_Adult_05 | Jordan Pell (F01) |
| `Female_Adult_14` | Adults/Female_Adult_14 | Mara Quell (F02) |
| `Male_Adult_08` | Adults/Male_Adult_08 | Avery Lindqvist (F03) |
| `Female_Adult_07` | Adults/Female_Adult_07 | Dana Okafor (F04) |
| `Male_Adult_12` | Adults/Male_Adult_12 | Rafael Strand (F05) |
| `Business_Female_01` | Professions/Business_Female_01 | Question desk coach |
| `Business_Male_04` | Professions/Business_Male_04 | Flags desk coach |
| `Business_Female_02` | Professions/Business_Female_02 | Follow-up desk coach |

`clips/` holds six seated motion-capture clips from Assets/Animations/all_animations_max_motextr_static
(`{m,f}_sit_table_breathe_01`, `{m,f}_sit_table_idle_look_around`, `{m,f}_sit_table_gestic_thoughtful`).

## Conversion (2026-10-11)

- `avatar.glb`: `Export/<name>_facial.fbx` parsed with three.js 0.186 `FBXLoader`, keeping the skeleton, the skinned
  mesh and 31 of its morph targets (the 15 Oculus visemes `AA_VI_*`, ARKit `BrowInnerUp`, `BrowOuterUp{Left,Right}`,
  `EyeBlink{Left,Right}`, `EyeLook{Down,In,Out,Up}{Left,Right}`, `JawOpen`, `MouthSmile{Left,Right}`), morph
  normals and textures dropped, root scaled 0.01 (centimetres to metres), exported with `GLTFExporter`, then
  `gltf-transform quantize` and `gltf-transform sparse` (KHR_mesh_quantization and sparse morph accessors; three's
  `GLTFLoader` reads both natively, no decoder or WebAssembly).
- Textures: `Textures/*_{body,head}_{color,normal}.tga` to 1024 px JPEG and `*_opacity_color.tga` to 512 px PNG
  with macOS `sips`; specular maps are not used. The runtime binds them by material name (`*_body`, `*_head`,
  `*_opacity`, `*_glasses`).
- Clips: parsed with `FBXLoader`, facial-bone and scale tracks dropped, positions kept for the root and pelvis only,
  resampled to 15 fps, near-constant tracks reduced to two keys, saved as three.js `AnimationClip` JSON.

## MIT licence (Microsoft Rocketbox)

MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
