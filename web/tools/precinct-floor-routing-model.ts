/** Read-only acceptance calculations. Never imported by production UI. */
import { isAbsolute, resolve } from "node:path";
import { PerspectiveCamera, Vector3 } from "three";

export type Position = { readonly x: number; readonly z: number };
export type Sample = Position & { readonly elapsedMs: number };
export type CameraMode = "first" | "third";
export const FLOOR_DESTINATION = [1.4, 0.015, -7.4] as const;
// Inside the first authored board card, away from the minimap and DOM controls.
export const BOARD_POINT = [4.15, 1.05, -9.63] as const;
export const MATRIX = (["office", "courtyard"] as const).flatMap((scene) =>
  (["first", "third"] as const).map((camera) => ({ scene, camera })));
export const distance = (a: Position, b: Position): number => Math.hypot(a.x - b.x, a.z - b.z);

export function routingOptions(args: readonly string[]) {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(arg);
    if (match?.[1] === undefined || values.has(match[1])) throw new Error(`Invalid or duplicate option: ${arg}`);
    values.set(match[1], match[2] ?? "true");
  }
  for (const key of values.keys()) if (!["url", "out", "dist", "artifact-label", "software", "headed", "slow-start-diagnostic"].includes(key)) throw new Error(`Unknown option: ${key}`);
  for (const flag of ["software", "headed", "slow-start-diagnostic"]) if (values.has(flag) && values.get(flag) !== "true") throw new Error(`Use --${flag} without a value.`);
  const required = (name: string) => { const value = values.get(name); if (value === undefined || value === "" || value === "true") throw new Error(`Missing --${name}=VALUE.`); return value; };
  const url = new URL(required("url"));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new Error("Supply only the credential-free loopback production origin.");
  const output = required("out"), dist = required("dist");
  if (!isAbsolute(output) || !isAbsolute(dist)) throw new Error("--out and --dist must be absolute owned staging paths.");
  for (const path of [output, dist]) if (/(?:^|\/)unissant_agentic_training_arena(?:\/|$)/u.test(resolve(path))) throw new Error("The genuine repository is read-only; use owned staging paths.");
  url.searchParams.set("precinctPerf", "1"); url.searchParams.set("precinctPerfPinned", "1");
  return { url, output: resolve(output), dist: resolve(dist), artifactLabel: required("artifact-label"), software: values.has("software"), headed: values.has("headed"), slowStartDiagnostic: values.has("slow-start-diagnostic") };
}

export function projectTarget(point: readonly [number, number, number], camera: {
  readonly cameraPosition: readonly number[]; readonly cameraQuaternion: readonly number[];
}, mode: CameraMode, rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }) {
  if (camera.cameraPosition.length !== 3 || camera.cameraQuaternion.length !== 4 || ![...point, ...camera.cameraPosition, ...camera.cameraQuaternion, rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) throw new Error("Invalid actual camera or canvas dimensions.");
  // Controls' existing live exploration FOV contract is 66/58. Read-only probe lacks FOV.
  // Source contract tests intentionally fail if that production contract changes.
  const view = new PerspectiveCamera(mode === "first" ? 66 : 58, rect.width / rect.height, 0.08, 120);
  view.position.fromArray(camera.cameraPosition); view.quaternion.fromArray(camera.cameraQuaternion); view.updateMatrixWorld(true);
  const projected = new Vector3(...point).project(view);
  if (projected.z <= -1 || projected.z >= 1 || Math.abs(projected.x) >= 0.96 || Math.abs(projected.y) >= 0.96) throw new Error("Authored target is not safely inside this actual camera frustum; do not substitute guessed clicks.");
  return { x: rect.x + (projected.x + 1) * rect.width / 2, y: rect.y + (1 - projected.y) * rect.height / 2, ndc: projected.toArray() };
}

export function movementEvidence(before: Position, destination: Position, samples: readonly Sample[]) {
  const last = samples.at(-1);
  const intermediates = samples.filter((sample) => distance(sample, before) >= 0.15 && distance(sample, destination) >= 0.15);
  const distinctIntermediatePositions = new Set(intermediates.map((sample) => `${sample.x.toFixed(3)},${sample.z.toFixed(3)}`)).size;
  const displacement = last === undefined ? 0 : distance(before, last);
  const endpointError = last === undefined ? Infinity : distance(last, destination);
  return { displacement, endpointError, distinctIntermediatePositions,
    passed: displacement > 0.75 && endpointError <= 0.12 && distinctIntermediatePositions >= 2 };
}

/** A completed independent functional diagnostic cannot repair a failed cold-entry gate. */
export function routingOutcome(coldEntryPassed: boolean, functionalComplete: boolean): {
  status: "passed" | "functional-completed-cold-start-failed" | "failed"; exitCode: 0 | 1;
} {
  if (!functionalComplete) return { status: "failed", exitCode: 1 };
  return coldEntryPassed ? { status: "passed", exitCode: 0 }
    : { status: "functional-completed-cold-start-failed", exitCode: 1 };
}
