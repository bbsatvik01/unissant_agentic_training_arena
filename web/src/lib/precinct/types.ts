/** Metres, with +X east, +Y up and +Z south. Player positions are at their feet. */
export type Vec3 = readonly [number, number, number];

export interface Collider {
  readonly id: string;
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface NavigationNode {
  readonly id: string;
  readonly position: Vec3;
  readonly neighbors: readonly string[];
}

export interface Hotspot {
  readonly id: string;
  readonly label: string;
  readonly room: string;
  readonly position: Vec3;
  readonly radius: number;
}

export type CameraMode = "first" | "third" | "free";

/** Radians; yaw 0 faces north (-Z), positive yaw turns left, positive pitch looks up. */
export interface LookAngles {
  readonly yaw: number;
  readonly pitch: number;
}
