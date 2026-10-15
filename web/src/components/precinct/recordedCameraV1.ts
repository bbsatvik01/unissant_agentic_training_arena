/** Frozen sampled-camera interpretation. Invoke only from the existing Controls owner after validation. */
import { PerspectiveCamera, type Camera } from "three";
import type { CameraData } from "../../lib/world/worldEvents";

export function applyRecordedCameraV1(camera: Camera, sample: CameraData): void {
  camera.position.set(...sample.position);
  camera.quaternion.set(...sample.quaternion);
  if (camera instanceof PerspectiveCamera && camera.fov !== sample.fov) {
    camera.fov = sample.fov;
    camera.updateProjectionMatrix();
  }
}
