"""Read-only source render review; never saves or mutates the authored .blend file."""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

import bpy


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    before = hashlib.sha256(args.source.read_bytes()).hexdigest()
    bpy.ops.wm.open_mainfile(filepath=str(args.source))
    scene = bpy.context.scene
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 1
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 750
    scene.render.resolution_percentage = 100
    scene.cycles.samples = 12
    scene.cycles.use_denoising = True
    for name in ("courtyard-axial", "courtyard-oblique", "courtyard-gallery"):
        scene.camera = bpy.data.objects["Courtyard review | " + name]
        scene.render.filepath = str(args.output_dir / (name + ".png"))
        bpy.ops.render.render(write_still=True)
    if hashlib.sha256(args.source.read_bytes()).hexdigest() != before:
        message = "Source was unexpectedly altered during review rendering"
        raise RuntimeError(message)


if __name__ == "__main__":
    main()
