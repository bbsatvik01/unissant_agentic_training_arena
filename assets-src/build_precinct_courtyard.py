#!/usr/bin/env python3
"""Build a separate original courtyard variant from the recoverable precinct .blend.

Run through the approved Blender launcher only after the parent grants the CPU lane.
Example (staging):
  launch-blender-lts.sh --background --python assets-src/build_precinct_courtyard.py -- \
    --baseline-source /path/to/original/assets-src/northstar-precinct.blend \
    --baseline-manifest /path/to/original/web/public/world/precinct-manifest.json \
    --output-root /path/to/staging --skip-renders
No original source, manifest, runtime, policy or application file is overwritten.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections.abc import Sequence
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from courtyard_layout import PALETTE, REMOVE_PREFIXES, VARIANT_ID, build_manifest, design

ROOT = Path(__file__).resolve().parent
MAX_COMMITTED_BYTES = 5_242_880
MAX_TRIANGLES = 150_000
SRGB_LINEAR_THRESHOLD = 0.04045
SMALL_BEVEL = 0.03


def require(condition: bool, message: object) -> None:
    if not condition:
        raise ValueError(message)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-source", type=Path, default=ROOT / "northstar-precinct.blend")
    parser.add_argument(
        "--baseline-manifest", type=Path, default=ROOT.parent / "web/public/world/precinct-manifest.json"
    )
    parser.add_argument("--output-root", type=Path, default=ROOT.parent)
    parser.add_argument("--skip-renders", action="store_true")
    parser.add_argument("--render-only", action="store_true")
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--threads", type=int, default=1)
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint(obj: bpy.types.Object) -> str:
    data = {
        "type": obj.type,
        "matrix": [list(row) for row in obj.matrix_world],
        "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
    }
    if obj.type == "MESH":
        data["vertices"] = [list(v.co) for v in obj.data.vertices]
        data["polygons"] = [list(p.vertices) for p in obj.data.polygons]
    elif obj.type == "FONT":
        data["body"] = obj.data.body
        data["size"] = obj.data.size
        data["font"] = obj.data.font.name
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def material(name: str, color: str, roughness: float, metallic: float) -> bpy.types.Material:
    srgb = [int(color[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [v / 12.92 if v <= SRGB_LINEAR_THRESHOLD else ((v + 0.055) / 1.055) ** 2.4 for v in srgb]
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*linear, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*linear, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return mat


def make_mesh(
    name: str, vertices: Sequence[Sequence[float]], faces: Sequence[Sequence[int]], collection: bpy.types.Collection
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    return obj


def create_foliage(spec: dict[str, object], collection: bpy.types.Collection) -> bpy.types.Object:
    name = spec["name"]
    # Original low-poly lobed foliage, deterministic geometry without image textures.
    rings, segments = 5, 10
    vertices = [(0, 0, -1)]
    for j in range(1, rings):
        phi = -math.pi / 2 + math.pi * j / rings
        for i in range(segments):
            angle = 2 * math.pi * (i + (j % 2) * 0.5) / segments
            variation = 1 + 0.1 * math.sin(i * 3.7 + j * 1.9)
            vertices.append(
                (
                    math.cos(phi) * math.cos(angle) * variation,
                    math.cos(phi) * math.sin(angle) * variation,
                    math.sin(phi),
                )
            )
    top = len(vertices)
    vertices.append((0, 0, 1))
    faces = [(0, 1 + (i + 1) % segments, 1 + i) for i in range(segments)]
    for j in range(rings - 2):
        first, nxt = 1 + j * segments, 1 + (j + 1) * segments
        faces.extend(
            (first + i, first + (i + 1) % segments, nxt + (i + 1) % segments, nxt + i) for i in range(segments)
        )
    faces.extend((top, top - segments + i, top - segments + (i + 1) % segments) for i in range(segments))
    obj = make_mesh(name, vertices, faces, collection)
    obj.scale = spec["size"]
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def create(spec: dict[str, object], collection: bpy.types.Collection) -> bpy.types.Object:
    name, shape, loc = spec["name"], spec["shape"], spec["loc"]
    if shape == "box":
        x, y, z = [v / 2 for v in spec["size"]]
        obj = make_mesh(
            name,
            [(-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z), (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)],
            [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)],
            collection,
        )
        obj.rotation_euler.z = spec.get("rotation", 0)
        bevel = spec.get("bevel", 0)
        if bevel:
            modifier = obj.modifiers.new("Original dressed stone edge", "BEVEL")
            modifier.width = bevel
            modifier.segments = 2
            obj.modifiers.new("Weighted stone normals", "WEIGHTED_NORMAL")
    elif shape == "cylinder":
        count = spec["sides"]
        vertices = [
            (r * math.cos(i * 2 * math.pi / count), r * math.sin(i * 2 * math.pi / count), z)
            for r, z in [(spec["radius"], -spec["depth"] / 2), (spec["top_radius"], spec["depth"] / 2)]
            for i in range(count)
        ]
        faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
        faces.extend((i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count))
        obj = make_mesh(name, vertices, faces, collection)
        for polygon in list(obj.data.polygons)[2:]:
            polygon.use_smooth = True
    elif shape == "foliage":
        obj = create_foliage(spec, collection)
    elif shape == "text":
        curve = bpy.data.curves.new(name, "FONT")
        curve.body = spec["body"]
        curve.size = spec["font_size"]
        curve.align_x = "CENTER"
        curve.extrude = 0.001
        curve.resolution_u = 2
        # Reuse the original source's already packed permissively licensed DejaVu font.
        font = next((font for font in bpy.data.fonts if "DejaVu" in font.name), None)
        if font is not None:
            curve.font = font
        obj = bpy.data.objects.new(name, curve)
        collection.objects.link(obj)
        obj.rotation_euler = spec["rotation_euler"]
    else:
        message = f"Unsupported original primitive: {shape}"
        raise ValueError(message)
    obj.location = loc
    obj.data.materials.append(bpy.data.materials[spec["material"]])
    obj["courtyard_original_geometry"] = True
    return obj


def camera(
    name: str, position: Sequence[float], target: Sequence[float], collection: bpy.types.Collection, lens: float = 24
) -> bpy.types.Object:
    data = bpy.data.cameras.new(name)
    obj = bpy.data.objects.new(name, data)
    collection.objects.link(obj)
    # Runtime to Blender conversion.
    obj.location = (position[0], -position[2], position[1])
    destination = Vector((target[0], -target[2], target[1]))
    obj.rotation_euler = (destination - obj.location).to_track_quat("-Z", "Y").to_euler()
    data.lens = lens
    data.clip_start = 0.05
    data.clip_end = 180
    return obj


def prepare_export(scene: bpy.types.Scene) -> None:
    for obj in scene.objects:
        if obj.type == "FONT":
            obj.data.extrude = 0
            obj.data.bevel_depth = 0
            obj.data.resolution_u = 2
        for modifier in obj.modifiers:
            if modifier.type == "BEVEL" and modifier.width < SMALL_BEVEL:
                modifier.segments = 1


def export_runtime(scene: bpy.types.Scene, output: Path) -> dict[str, int]:
    """Same lossless evaluated-mesh/material batching as the approved original pipeline."""
    prepare_export(scene)
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    groups, originals = {}, []
    for obj in list(scene.objects):
        if obj.type not in {"MESH", "FONT", "CURVE"} or not len(obj.data.materials):
            continue
        evaluated = obj.evaluated_get(graph)
        mesh = evaluated.to_mesh()
        if mesh is None:
            continue
        mat = obj.data.materials[0]
        group = groups.setdefault(mat.name, {"material": mat, "vertices": [], "faces": [], "smooth": []})
        offset = len(group["vertices"])
        group["vertices"].extend(tuple(obj.matrix_world @ vertex.co) for vertex in mesh.vertices)
        group["faces"].extend(tuple(offset + index for index in polygon.vertices) for polygon in mesh.polygons)
        group["smooth"].extend(polygon.use_smooth for polygon in mesh.polygons)
        evaluated.to_mesh_clear()
        originals.append(obj)
    for obj in originals:
        bpy.data.objects.remove(obj, do_unlink=True)
    for name, group in groups.items():
        obj = make_mesh("Courtyard runtime | " + name, group["vertices"], group["faces"], scene.collection)
        obj.data.materials.append(group["material"])
        for polygon, smooth in zip(obj.data.polygons, group["smooth"], strict=True):
            polygon.use_smooth = smooth
    bpy.ops.object.select_all(action="DESELECT")
    for obj in scene.objects:
        if obj.type == "MESH":
            obj.select_set(True)
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    triangles = sum(sum(len(p.vertices) - 2 for p in obj.data.polygons) for obj in meshes)
    require(triangles < MAX_TRIANGLES, f"Courtyard exceeds existing 150k triangle target: {triangles}")
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_lights=False,
        export_cameras=False,
        export_materials="EXPORT",
        export_extras=False,
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_animations=False,
    )
    return {
        "triangles": triangles,
        "meshMaterialGroups": len(meshes),
        "fileBytes": output.stat().st_size,
        "textures": 0,
        "animations": 0,
        "runtimeLights": 0,
    }


def author_annex(
    scene: bpy.types.Scene, baseline: dict[str, object], args: argparse.Namespace
) -> tuple[dict[str, object], list[dict[str, object]], list[bpy.types.Object]]:
    collection = bpy.data.collections.new("Original HABS-inspired compact courtyard")
    scene.collection.children.link(collection)
    for name, style in PALETTE.items():
        material(name, *style)
    objects = design()
    for spec in objects:
        create(spec, collection)
    bpy.context.view_layer.update()
    for spec in objects:
        if spec["shape"] == "text":
            obj = bpy.data.objects[spec["name"]]
            if obj.dimensions.x > spec["max_width"]:
                obj.scale *= spec["max_width"] / obj.dimensions.x
    manifest = build_manifest(baseline, objects)
    cameras = [
        camera("Courtyard review | " + item["id"], item["position"], item["target"], collection)
        for item in manifest["reviewCameras"]
        if item["id"].startswith("courtyard-")
    ]
    # Separate source-only review light; glTF export never includes lights.
    light_data = bpy.data.lights.new("Courtyard open sky fill", "AREA")
    light_data.energy = 750
    light_data.shape = "RECTANGLE"
    light_data.size = 16
    light_data.size_y = 7
    light_obj = bpy.data.objects.new("Courtyard open sky fill", light_data)
    collection.objects.link(light_obj)
    light_obj.location = (0, -9, 6.5)
    scene.camera = cameras[0]
    scene.render.resolution_x, scene.render.resolution_y = 1440, 900
    scene.render.resolution_percentage = 100
    scene.cycles.samples = max(8, min(64, args.samples))
    scene.cycles.use_denoising = True
    return manifest, objects, cameras


def main() -> None:
    args = arguments()
    source_dir = args.output_root / "assets-src"
    runtime_dir = args.output_root / "web/public/world"
    qa_dir = args.output_root / "qa"
    for folder in (source_dir, runtime_dir, qa_dir):
        folder.mkdir(parents=True, exist_ok=True)
    source_output = source_dir / "northstar-precinct-courtyard.blend"
    manifest_output = runtime_dir / "precinct-courtyard-manifest.json"
    raw_output = qa_dir / "precinct-courtyard-uncompressed.glb"
    require(
        source_output.resolve() != args.baseline_source.resolve()
        and manifest_output.resolve() != args.baseline_manifest.resolve(),
        "Variant must not overwrite original source or manifest",
    )
    before_hashes = {"source": sha(args.baseline_source), "manifest": sha(args.baseline_manifest)}
    baseline = json.loads(args.baseline_manifest.read_text())
    bpy.ops.wm.open_mainfile(filepath=str(args.baseline_source))
    scene = bpy.context.scene
    scene.render.threads_mode = "FIXED"
    scene.render.threads = max(1, min(4, args.threads))
    removed = [obj for obj in scene.objects if obj.name.startswith(REMOVE_PREFIXES)]
    keep = {obj.name: fingerprint(obj) for obj in scene.objects if obj not in removed}
    removed_names = [obj.name for obj in removed]
    for obj in removed:
        bpy.data.objects.remove(obj, do_unlink=True)
    manifest, objects, cameras = author_annex(scene, baseline, args)
    after = {name: fingerprint(bpy.data.objects[name]) for name in keep}
    require(keep == after, "An original working-module source object changed")
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(source_output), compress=True)
    require(source_output.stat().st_size <= MAX_COMMITTED_BYTES, "Editable variant source exceeds 5,242,880-byte cap")
    preservation = {
        "passed": True,
        "variantId": VARIANT_ID,
        "variantSourceSha256": sha(source_output),
        "baselineSourceSha256": before_hashes["source"],
        "baselineManifestSha256": before_hashes["manifest"],
        "retainedObjects": len(keep),
        "retainedObjectFingerprintsUnchanged": True,
        "removedDecorativeObjects": removed_names,
        "retainedObjectFingerprints": keep,
        "addedOriginalObjects": len(objects),
        "runtimeValidated": False,
        "browserRendererValidated": False,
    }
    (qa_dir / "courtyard-module-preservation.json").write_text(json.dumps(preservation, indent=2) + "\n")
    if not args.skip_renders:
        for cam in cameras:
            scene.camera = cam
            scene.render.filepath = str(qa_dir / (cam.name.split(" | ")[-1] + ".png"))
            bpy.ops.render.render(write_still=True)
    if not args.render_only:
        manifest["performance"] = export_runtime(scene, raw_output)
        manifest.pop("assetPending", None)
        manifest_output.write_text(json.dumps(manifest, indent=2) + "\n")
        authoring_identity = {
            "variantId": VARIANT_ID,
            "sourceSha256": sha(source_output),
            "rawRuntimeSha256": sha(raw_output),
            "preCompressionManifestSha256": sha(manifest_output),
            "compressionPending": True,
            "actualRendererValidated": False,
            "note": (
                "Final source/runtime/manifest identity is emitted by validate_courtyard after lossless compression."
            ),
        }
        (qa_dir / "courtyard-authoring-export.json").write_text(json.dumps(authoring_identity, indent=2) + "\n")
    require(
        {"source": sha(args.baseline_source), "manifest": sha(args.baseline_manifest)} == before_hashes,
        "Baseline file was unexpectedly changed",
    )
    sys.stdout.write(
        json.dumps(
            {
                "source": str(source_output),
                "rawRuntime": str(raw_output),
                "manifest": str(manifest_output),
                "compressionRequired": True,
                "originalModuleObjectsPreserved": len(keep),
            },
            indent=2,
        )
        + "\n"
    )
    sys.stdout.flush()


if __name__ == "__main__":
    main()
