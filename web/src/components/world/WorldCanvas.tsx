/**
 * The 3D world's root (D-020), loaded lazily as its own chunk: the precinct hub and the interview room in one
 * scene, lit softly, the camera flying between them. A pure function of its props: the world state, the case list
 * and the documents on the evidence wall.
 *
 * `?fps` in the URL turns on frame-interval sampling (S6 10 method: requestAnimationFrame deltas), published on
 * `window.__arenaFps` for measurement.
 */
import { Canvas, useFrame } from "@react-three/fiber";
import { useRef, type RefObject } from "react";

import type { CaseCard } from "../../lib/world/cases";
import type { ShotName } from "../../lib/world/layout";
import { PALETTE } from "../../lib/world/palette";
import type { WorldState } from "../../lib/world/worldState";
import { CameraRig } from "./CameraRig";
import { Hub } from "./Hub";
import { Room, type WallDocument } from "./Room";

export interface WorldCanvasProps {
  readonly place: "hub" | "room";
  readonly world: WorldState | null;
  readonly cases: readonly CaseCard[];
  readonly recordedCaseId: string;
  readonly focusedCase: string | null;
  readonly documents: readonly WallDocument[];
  readonly clock: RefObject<number>;
  /** Reduced motion or the pause control: every loop stops. */
  readonly still: boolean;
  /** Reduced motion: camera moves become cuts and signature moments show their end state. */
  readonly reducedMotion: boolean;
  readonly showPet: boolean;
  readonly onOpenCase: (caseId: string) => void;
  readonly onFocusCase: (caseId: string | null) => void;
  readonly onArrive?: () => void;
}

interface FpsSample {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  over50: number;
}

declare global {
  interface Window {
    __arenaFps?: FpsSample;
  }
}

/** Frame-interval sampling over a rolling 8 s window. */
function FpsProbe() {
  const deltas = useRef<number[]>([]);
  const last = useRef<number | null>(null);
  useFrame(() => {
    const now = performance.now();
    if (last.current !== null) deltas.current.push(now - last.current);
    last.current = now;
    let total = deltas.current.reduce((a, b) => a + b, 0);
    while (total > 8000 && deltas.current.length > 0) total -= deltas.current.shift() ?? 0;
    const sorted = [...deltas.current].sort((a, b) => a - b);
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    window.__arenaFps = { frames: sorted.length, p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? 0, over50: sorted.filter((d) => d > 50).length };
  });
  return null;
}

const MEASURE = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("fps");

export default function WorldCanvas(props: WorldCanvasProps) {
  const shot: ShotName = props.place === "hub" ? "hub" : (props.world?.shot ?? "room");
  return (
    <Canvas flat dpr={[1, 1.75]} camera={{ fov: 42, near: 0.05, far: 80 }} gl={{ antialias: true, powerPreference: "high-performance" }} aria-hidden="true">
      <color attach="background" args={[PALETTE.canvasSoft]} />
      <fog attach="fog" args={[PALETTE.canvasSoft, 16, 42]} />
      <hemisphereLight args={[PALETTE.canvas, PALETTE.observation, 2.4]} />
      <directionalLight position={[4, 8, 6]} intensity={1.3} />
      <directionalLight position={[-6, 4, -10]} intensity={0.35} />
      <Hub
        cases={props.cases}
        recordedCaseId={props.recordedCaseId}
        focusedCase={props.focusedCase}
        reducedMotion={props.reducedMotion}
        onOpenCase={props.onOpenCase}
        onFocusCase={props.onFocusCase}
      />
      <Room world={props.world} documents={props.documents} clock={props.clock} still={props.still} reducedMotion={props.reducedMotion} showPet={props.showPet} />
      <CameraRig place={props.place} shot={shot} reducedMotion={props.reducedMotion} {...(props.onArrive === undefined ? {} : { onArrive: props.onArrive })} />
      {MEASURE ? <FpsProbe /> : null}
    </Canvas>
  );
}
