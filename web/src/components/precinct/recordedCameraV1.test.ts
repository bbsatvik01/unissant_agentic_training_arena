import { OrthographicCamera, PerspectiveCamera } from "three";
import { describe, expect, it, vi } from "vitest";
import type { CameraData } from "../../lib/world/worldEvents";
import { applyRecordedCameraV1 } from "./recordedCameraV1";
const first: CameraData = { mode: "first", position: [1, 1.7, -12], quaternion: [0, 0.6, 0, 0.8], fov: 52 };
const second: CameraData = { mode: "third", position: [-4, 2, 3], quaternion: [0, 0, 0, 1], fov: 68 };
describe("frozen camera sample interpretation", () => {
  it("applies exact raw XYZ/XYZW and vertical FOV on forward, held and backward samples", () => {
    const camera = new PerspectiveCamera(); const update = vi.spyOn(camera, "updateProjectionMatrix");
    for (const sample of [first, second, second, first]) {
      const before = structuredClone(sample);
      applyRecordedCameraV1(camera, sample);
      expect(camera.position.toArray()).toEqual(sample.position);
      expect(camera.quaternion.toArray()).toEqual(sample.quaternion);
      expect(camera.fov).toBe(sample.fov); expect(sample).toEqual(before);
    }
    expect(update).toHaveBeenCalledTimes(3);
  });
  it("preserves a nonperspective camera's projection while applying only recorded transforms", () => {
    const camera = new OrthographicCamera(); const matrix = camera.projectionMatrix.clone();
    applyRecordedCameraV1(camera, first);
    expect(camera.position.toArray()).toEqual(first.position); expect(camera.quaternion.toArray()).toEqual(first.quaternion);
    expect(camera.projectionMatrix.equals(matrix)).toBe(true);
  });
});
