import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster, Vector3 } from "three";
import { PRECINCT_WORLDS } from "../src/lib/precinct/knownWorlds.ts";
import { precinctPointerFloor } from "../src/lib/precinct/worldVariant.ts";

describe("click-only precinct floor", () => {
  it("wires the Controls floor to its original transparent material and pointer handler", () => {
    // Wiring guard only. The tests below exercise the pinned Three raycaster itself.
    const source = readFileSync(new URL("../src/components/precinct/PrecinctCanvas.tsx", import.meta.url), "utf8");
    const start = source.indexOf("export function Controls(");
    const end = source.indexOf("export default function PrecinctCanvas(");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const controls = source.slice(start, end);
    expect(controls).toContain("position={pointerFloor.center} onPointerDown={(event) => {");
    expect(controls).toContain("<planeGeometry args={[...pointerFloor.size]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />");
    const floorStart = controls.indexOf("    <mesh rotation={[-Math.PI / 2, 0, 0]} position={pointerFloor.center} onPointerDown={(event) => {");
    const floorEnd = controls.indexOf("    </mesh>", floorStart);
    expect(floorStart).toBeGreaterThanOrEqual(0);
    expect(floorEnd).toBeGreaterThan(floorStart);
    const floor = controls.slice(floorStart, floorEnd);
    expect(floor).toContain("<planeGeometry args={[...pointerFloor.size]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />");
    expect(floor).not.toMatch(/\bvisible\s*=\s*\{\s*false\s*\}/);
    expect(floor).toContain("if (props.replayActors !== undefined || seated || !props.active || props.paused || event.button !== 0 || document.pointerLockElement === canvas) return;");
    expect(floor).toContain('props.onControlInput?.({ action: "click", target: "precinct:floor", button: event.button });');
    expect(floor).toContain("path.current = planNavigationRoute(position.current, destination, props.manifest, props.manifest.playerNavigationMesh) ?? [];");
  });

  it.each((["office", "courtyard"] as const).flatMap((world) => [
    { world, name: "first person", origin: [2, 1.65, -4.2] as const },
    { world, name: "third person", origin: [2, 2.15, -1.4] as const },
  ]))("preserves the actual $world floor hit and UV from $name", ({ world, origin }) => {
    const pointerFloor = precinctPointerFloor(PRECINCT_WORLDS[world].manifest);
    const geometry = new PlaneGeometry(...pointerFloor.size);
    const previous = new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const hidden = new MeshBasicMaterial({ visible: false });
    const floor = new Mesh(geometry, previous);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(...pointerFloor.center);
    floor.updateMatrixWorld(true);
    const ray = new Raycaster(new Vector3(...origin), new Vector3(0, -0.4, -1).normalize());
    try {
      const before = ray.intersectObject(floor, false);
      floor.material = hidden;
      const after = ray.intersectObject(floor, false);
      expect(floor.visible).toBe(true);
      expect(floor.material.visible).toBe(false);
      expect(before).toHaveLength(1);
      expect(after).toHaveLength(1);
      const original = before[0], actual = after[0];
      if (original === undefined || actual === undefined) throw new Error("Expected a floor intersection");
      expect(actual.object).toBe(floor);
      expect(actual.distance).toBeCloseTo(original.distance, 12);
      expect(actual.point.distanceTo(original.point)).toBeLessThan(1e-12);
      expect(actual.point.y).toBeCloseTo(0.015, 12);
      expect(actual.uv?.toArray()).toEqual(original.uv?.toArray());
    } finally {
      geometry.dispose(); previous.dispose(); hidden.dispose();
    }
  });
});
