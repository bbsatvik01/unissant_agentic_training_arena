/** Display-only free inspection. No walking pose, recording clock or case state is accepted. */
import type { Vec3 } from "./types";
export interface InspectionCamera {
  readonly focus: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
}
export interface InspectionInput {
  readonly forward: number;
  readonly strafe: number;
  readonly vertical: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly sprint: boolean;
}
/** Runtime precinct shell bounds. Inspection can cross furniture/walls without moving a walking capsule. */
export const INSPECTION_BOUNDS = { min: [-13.8, 0.3, -35.8] as Vec3, max: [13.8, 3.1, -0.2] as Vec3 };
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const axis = (value: number) => clamp(finite(value), -1, 1);
function offset(camera: InspectionCamera): Vec3 {
  const horizontal = Math.cos(camera.pitch) * camera.distance;
  return [Math.sin(camera.yaw) * horizontal, Math.sin(camera.pitch) * camera.distance, Math.cos(camera.yaw) * horizontal];
}
/** Translate focus with the camera at boundaries, retaining distance and direction without a snap/zero ray. */
function bounded(input: InspectionCamera): InspectionCamera {
  const yaw = finite(input.yaw);
  const camera: InspectionCamera = {
    focus: [finite(input.focus[0]), finite(input.focus[1], 1.65), finite(input.focus[2], -5.6)],
    yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)), pitch: clamp(finite(input.pitch), -1.25, 1.25),
    distance: clamp(finite(input.distance, 3.2), 0.6, 18),
  };
  const delta = offset(camera);
  const focus: Vec3 = [
    clamp(camera.focus[0] + delta[0], INSPECTION_BOUNDS.min[0], INSPECTION_BOUNDS.max[0]) - delta[0],
    clamp(camera.focus[1] + delta[1], INSPECTION_BOUNDS.min[1], INSPECTION_BOUNDS.max[1]) - delta[1],
    clamp(camera.focus[2] + delta[2], INSPECTION_BOUNDS.min[2], INSPECTION_BOUNDS.max[2]) - delta[2],
  ];
  return { ...camera, focus };
}
export function inspectionView(input: InspectionCamera): { readonly position: Vec3; readonly target: Vec3 } {
  const camera = bounded(input); const delta = offset(camera);
  return { position: [camera.focus[0] + delta[0], camera.focus[1] + delta[1], camera.focus[2] + delta[2]], target: camera.focus };
}
/** Seed from the current actual camera direction, keeping its position when already inside the precinct. */
export function createInspectionCamera(position: Vec3, direction: Vec3): InspectionCamera {
  const x = finite(direction[0]); const y = finite(direction[1]); const z = finite(direction[2], -1);
  const length = Math.hypot(x, y, z);
  const forward: Vec3 = length > 0.00001 ? [x / length, y / length, z / length] : [0, 0, -1];
  const distance = 3.2;
  const yaw = Math.atan2(-forward[0], -forward[2]);
  const pitch = clamp(Math.asin(clamp(-forward[1], -1, 1)), -1.25, 1.25);
  const delta = offset({ focus: [0, 0, 0], yaw, pitch, distance });
  return bounded({ focus: [finite(position[0]) - delta[0], finite(position[1], 1.65) - delta[1], finite(position[2], -2.4) - delta[2]], yaw, pitch, distance });
}
/** Pointer drag and wheel deltas change only the inspection view. */
export function adjustInspectionCamera(camera: InspectionCamera, yaw: number, pitch: number, zoom: number): InspectionCamera {
  return bounded({ ...camera, yaw: camera.yaw + finite(yaw), pitch: camera.pitch + finite(pitch), distance: camera.distance + finite(zoom) });
}
/** Keyboard/gamepad rates. Drop long-frame catch-up, normalize diagonal pan, and bound every output. */
export function stepInspectionCamera(input: InspectionCamera, controls: InspectionInput, deltaSeconds: number): InspectionCamera {
  const camera = bounded(input); const seconds = clamp(finite(deltaSeconds), 0, 0.05);
  let forward = axis(controls.forward); let strafe = axis(controls.strafe);
  const length = Math.hypot(forward, strafe);
  if (length > 1) { forward /= length; strafe /= length; }
  const distance = (controls.sprint ? 6 : 2.4) * seconds;
  const focus: Vec3 = [
    camera.focus[0] + (-Math.sin(camera.yaw) * forward + Math.cos(camera.yaw) * strafe) * distance,
    camera.focus[1] + axis(controls.vertical) * distance,
    camera.focus[2] + (-Math.cos(camera.yaw) * forward - Math.sin(camera.yaw) * strafe) * distance,
  ];
  return adjustInspectionCamera({ ...camera, focus }, axis(controls.yaw) * seconds * 1.7, axis(controls.pitch) * seconds * 1.3, 0);
}
