import json
import sys
import time
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))

from manifest_tools import finalize_manifest

TINY_BEVEL_WIDTH = 0.03

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "web/public/world"
START = time.time()
bpy.ops.wm.open_mainfile(filepath=str(ROOT / "northstar-precinct.blend"))
scene = bpy.context.scene
# Recover seat collision from editable source object transforms, even for earlier source revisions.
chair_colliders = []
for ob in scene.objects:
    if ob.name.startswith("Chair seat"):
        x, y = ob.location.x, ob.location.y
        chair_colliders.append(
            {
                "id": "chair-" + str(len(chair_colliders) + 1),
                "kind": "furniture",
                "min": [x - 0.37, 0, -y - 0.37],
                "max": [x + 0.37, 1.1, -y + 0.37],
            }
        )
# Snapshot evaluated meshes in one dependency-graph pass and batch by material.
# This avoids thousands of operator/dependency-graph updates.
# Flatten submillimeter text depth and simplify tiny bevels for the runtime mesh.
for ob in scene.objects:
    if ob.type == "FONT":
        ob.data.extrude = 0
        ob.data.bevel_depth = 0
        ob.data.resolution_u = 2
    for mod in ob.modifiers:
        if mod.type == "BEVEL" and mod.width < TINY_BEVEL_WIDTH:
            mod.segments = 1
bpy.context.view_layer.update()
deps = bpy.context.evaluated_depsgraph_get()
groups = {}
originals = []
for ob in list(scene.objects):
    if ob.type not in {"MESH", "FONT", "CURVE"} or not len(ob.data.materials):
        continue
    ev = ob.evaluated_get(deps)
    me = ev.to_mesh()
    if not me:
        continue
    material = ob.data.materials[0]
    g = groups.setdefault(material.name, {"material": material, "vertices": [], "faces": [], "smooth": []})
    offset = len(g["vertices"])
    matrix = ob.matrix_world
    g["vertices"].extend(tuple(matrix @ v.co) for v in me.vertices)
    g["faces"].extend(tuple(offset + i for i in p.vertices) for p in me.polygons)
    g["smooth"].extend(p.use_smooth for p in me.polygons)
    ev.to_mesh_clear()
    originals.append(ob)
for ob in originals:
    bpy.data.objects.remove(ob, do_unlink=True)
for name, g in groups.items():
    me = bpy.data.meshes.new("Runtime " + name)
    me.from_pydata(g["vertices"], [], g["faces"])
    me.update()
    me.materials.append(g["material"])
    ob = bpy.data.objects.new("Precinct | " + name, me)
    bpy.context.collection.objects.link(ob)
    for p, smooth in zip(me.polygons, g["smooth"], strict=True):
        p.use_smooth = smooth
bpy.ops.object.select_all(action="DESELECT")
for ob in scene.objects:
    if ob.type == "MESH":
        ob.select_set(True)
mesh_count = sum(o.type == "MESH" for o in scene.objects)
triangles = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in scene.objects if o.type == "MESH")
bpy.ops.export_scene.gltf(
    filepath=str(OUT / "precinct.glb"),
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
size = (OUT / "precinct.glb").stat().st_size

p = OUT / "precinct-manifest.json"
m = json.loads(p.read_text())
m.pop("assetPending", None)
m.pop("source", None)
m["asset"] = "precinct.glb"
m["sourceFile"] = "assets-src/northstar-precinct.blend"
m["performance"] = {
    "triangles": triangles,
    "meshMaterialGroups": mesh_count,
    "fileBytes": size,
    "textures": 0,
    "animations": 0,
    "runtimeLights": 0,
}
m["lighting"]["disableShadowCastingMaterials"] = ["White acoustic ceiling"]
m["lighting"]["fixtureIntensityUnits"] = "relative point intensity; use up to 4 near the player"
m["colliders"] = [c for c in m["colliders"] if not c["id"].startswith("chair-")] + chair_colliders

# Rebuild graph without re-numbering existing collider identifiers.
old_colliders = m["colliders"]
m["colliders"] = []
m = finalize_manifest(m)
m["colliders"] = old_colliders
m["version"] = "1.0.0"
p.write_text(json.dumps(m, indent=2))
sys.stdout.write(f"EXPORTED {m['performance']}\n")
sys.stdout.flush()
