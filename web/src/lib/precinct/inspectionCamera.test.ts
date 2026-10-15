import { describe, expect, it } from "vitest";
import { adjustInspectionCamera, createInspectionCamera, INSPECTION_BOUNDS, inspectionView, stepInspectionCamera, type InspectionInput } from "./inspectionCamera";
const NONE: InspectionInput = { forward: 0, strafe: 0, vertical: 0, yaw: 0, pitch: 0, sprint: false };
describe("independently movable bounded inspection camera", () => {
  it("seeds the exact current camera and pans its focus independently in all three axes", () => {
    const initial = createInspectionCamera([8.65, 1.41, -12.31], [0, -0.15, -1]);
    const view = inspectionView(initial); expect(view.position[0]).toBeCloseTo(8.65); expect(view.position[1]).toBeCloseTo(1.41); expect(view.position[2]).toBeCloseTo(-12.31);
    const forward = inspectionView(stepInspectionCamera(initial, { ...NONE, forward: 1 }, 0.05));
    expect(forward.position[2]).toBeCloseTo(view.position[2] - 0.12); expect(forward.target[2]).toBeCloseTo(view.target[2] - 0.12);
    const rightUp = inspectionView(stepInspectionCamera(initial, { ...NONE, strafe: 1, vertical: 1 }, 0.05));
    expect(rightUp.position[0]).toBeCloseTo(view.position[0] + 0.12); expect(rightUp.position[1]).toBeCloseTo(view.position[1] + 0.12);
  });
  it("orbits around the independently moved focus, zooms, and bounds pitch/distance", () => {
    const initial = createInspectionCamera([0, 1.65, -12], [0, 0, -1]);
    const turned = stepInspectionCamera(initial, { ...NONE, yaw: 1, pitch: 1 }, 0.05);
    expect(turned.yaw).toBeCloseTo(0.085); expect(turned.pitch).toBeCloseTo(0.065);
    expect(inspectionView(turned).target).toEqual(initial.focus);
    const zoom = adjustInspectionCamera(initial, 0, 0, -1); expect(zoom.distance).toBe(2.2);
    const far = adjustInspectionCamera(initial, 1000, 1000, 1000); expect(far.distance).toBe(18); expect(far.pitch).toBe(1.25); expect(Math.abs(far.yaw)).toBeLessThanOrEqual(Math.PI);
    const near = adjustInspectionCamera(initial, 0, -1000, -1000); expect(near.distance).toBe(0.6); expect(near.pitch).toBe(-1.25);
  });
  it("bounds movement across the whole precinct, normalizes diagonals, and supports faster inspection", () => {
    const initial = createInspectionCamera([0, 1.65, -12], [0, 0, -1]);
    const straight = inspectionView(stepInspectionCamera(initial, { ...NONE, forward: 1 }, 0.05));
    const diagonal = inspectionView(stepInspectionCamera(initial, { ...NONE, forward: 1, strafe: 1 }, 0.05));
    expect(Math.hypot(diagonal.position[0], diagonal.position[2] + 12)).toBeCloseTo(Math.abs(straight.position[2] + 12));
    expect(inspectionView(stepInspectionCamera(initial, { ...NONE, forward: 1, sprint: true }, 0.05)).position[2]).toBeCloseTo(-12.3);
    let current = initial;
    for (let frame = 0; frame < 1000; frame += 1) current = stepInspectionCamera(current, { ...NONE, forward: 1, strafe: 1, vertical: 1, sprint: true }, 0.05);
    const end = inspectionView(current).position;
    end.forEach((value, index) => { expect(value).toBeGreaterThanOrEqual((INSPECTION_BOUNDS.min[index] ?? 0) - 1e-10); expect(value).toBeLessThanOrEqual((INSPECTION_BOUNDS.max[index] ?? 0) + 1e-10); });
    expect(end[0]).toBeCloseTo(13.8); expect(end[1]).toBeCloseTo(3.1); expect(end[2]).toBeCloseTo(-35.8);
  });
  it("sanitizes invalid input, drops catch-up time, and does not mutate its input state", () => {
    const initial = createInspectionCamera([0, 1.65, -12], [0, 0, 0]); const original = structuredClone(initial);
    expect(stepInspectionCamera(initial, { ...NONE, forward: 1 }, 100)).toEqual(stepInspectionCamera(initial, { ...NONE, forward: 1 }, 0.05));
    for (const value of [NaN, Infinity, -Infinity]) {
      const bad = createInspectionCamera([value, value, value], [value, value, value]);
      const result = inspectionView(adjustInspectionCamera(bad, value, value, value));
      expect([...result.position, ...result.target].every(Number.isFinite)).toBe(true);
      // Zero input preserves geometry; adding a neutral delta canonicalizes signed zero angles.
      expect(stepInspectionCamera(initial, { ...NONE, forward: value, strafe: value, vertical: value, yaw: value, pitch: value }, value)).toEqual({ ...initial, yaw: 0, pitch: 0 });
    }
    expect(initial).toEqual(original);
  });
});
