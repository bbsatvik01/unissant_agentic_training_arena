/**
 * The 3D world's root (D-020, D-025), loaded lazily as its own chunk: the precinct hub and the interview room in one
 * scene, full-bleed behind the overlay. Physically based lighting with an image-based environment (three's procedural
 * RoomEnvironment, no download), soft shadows, filmic tone mapping and tasteful post-processing, at a quality tier
 * that steps down when frames run over budget (`quality.ts`). A pure function of its props: the world state, the
 * case list and the documents on the evidence wall.
 *
 * `?fps` in the URL turns on frame-interval sampling (S6 10 method: requestAnimationFrame deltas), published on
 * `window.__arenaFps` for measurement, with the tier in use; `?tier=medium|low` pins a tier.
 */
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ACESFilmicToneMapping, PCFShadowMap, PMREMGenerator } from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { COACHES, HUB_STAFF, INVESTIGATOR, subjectPersona } from "../../lib/world/cast";
import type { CaseCard } from "../../lib/world/cases";
import type { ShotName } from "../../lib/world/layout";
import { nextTier, TIERS, WINDOW, type Tier } from "../../lib/world/quality";
import type { WorldState } from "../../lib/world/worldState";
import { preloadAvatar } from "./Avatar";
import { CameraRig } from "./CameraRig";
import { Hub } from "./Hub";
import type { WallDocument } from "./moments";
import { PostFX } from "./PostFX";
import { Room } from "./Room";

export type { WallDocument } from "./moments";

export interface WorldCanvasProps {
  readonly place: "hub" | "room";
  readonly world: WorldState | null;
  readonly cases: readonly CaseCard[];
  readonly recordedCaseId: string;
  readonly focusedCase: string | null;
  readonly documents: readonly WallDocument[];
  /** The subject's display name (picks the persona). */
  readonly subjectName: string;
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
  tier: Tier;
}

declare global {
  interface Window {
    __arenaFps?: FpsSample;
  }
}

const PARAMS = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
const MEASURE = PARAMS.has("fps");
const PINNED_PARAM = PARAMS.get("tier");
const PINNED: Tier | null = PINNED_PARAM === "high" || PINNED_PARAM === "medium" || PINNED_PARAM === "low" ? PINNED_PARAM : null;

/** Frame-interval sampling over a rolling 8 s window. */
function FpsProbe({ tier }: { tier: Tier }) {
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
    window.__arenaFps = { frames: sorted.length, p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) ?? 0, over50: sorted.filter((d) => d > 50).length, tier };
  });
  return null;
}

/** Watches frame intervals and steps the tier down when a window runs over budget (never back up). */
function TierMonitor({ tier, place, onTier }: { tier: Tier; place: "hub" | "room"; onTier: (t: Tier) => void }) {
  const intervals = useRef<number[]>([]);
  const last = useRef<number | null>(null);
  const settleUntil = useRef(0);
  /** Over-budget windows in a row: one slow window (a texture upload, a tab switch) is not enough to step down. */
  const strikes = useRef(0);
  useFrame(() => {
    const now = performance.now();
    // Ignore the first seconds after a change (shader compiles, texture uploads).
    if (now < settleUntil.current) {
      last.current = now;
      return;
    }
    if (last.current !== null) intervals.current.push(now - last.current);
    last.current = now;
    if (intervals.current.length >= WINDOW) {
      const next = nextTier(tier, intervals.current);
      intervals.current = [];
      strikes.current = next === tier ? 0 : strikes.current + 1;
      if (strikes.current >= 2) {
        strikes.current = 0;
        settleUntil.current = now + 2500;
        onTier(next);
      }
    }
  });
  // Loading the room's people and compiling their shaders stalls frames for a few seconds after each move between
  // places; those frames say nothing about the steady-state cost, so the window restarts after a settle period.
  useEffect(() => {
    settleUntil.current = performance.now() + 8000;
    intervals.current = [];
    strikes.current = 0;
  }, [place]);
  return null;
}

/** Image-based lighting from three's procedural room environment (no file is fetched). */
function Environment() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const { gl, scene } = get();
    const pmrem = new PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.3;
    return () => {
      scene.environment = null;
      env.dispose();
      pmrem.dispose();
    };
  }, [get]);
  return null;
}

export default function WorldCanvas(props: WorldCanvasProps) {
  // Medium is the laptop default (60 fps measured on the demo Mac); `?tier=high` adds ambient occlusion and 2x
  // pixel ratio on stronger machines.
  const [tier, setTier] = useState<Tier>(PINNED ?? "medium");
  const settings = TIERS[tier];
  const shot: ShotName = props.place === "hub" ? "hub" : (props.world?.shot ?? "room");
  const persona = subjectPersona(props.subjectName);
  // Load the room's people while the camera is still in the precinct, so nobody pops in mid-flight.
  useEffect(() => {
    preloadAvatar(persona);
    for (const coach of COACHES) preloadAvatar(coach);
    preloadAvatar(INVESTIGATOR);
    preloadAvatar(HUB_STAFF);
  }, [persona]);
  return (
    <Canvas
      shadows={{ type: PCFShadowMap }}
      dpr={[1, settings.dpr]}
      camera={{ fov: 45, near: 0.03, far: 80 }}
      gl={{ antialias: true, powerPreference: "high-performance", toneMapping: ACESFilmicToneMapping, toneMappingExposure: 0.92 }}
      aria-hidden="true"
      onCreated={(st) => {
        // With `?fps`, the scene is published for measurement scripts (never otherwise).
        if (MEASURE) (window as unknown as { __arenaScene?: unknown }).__arenaScene = st.scene;
      }}
    >
      <color attach="background" args={["#1b1c1e"]} />
      <Environment />
      <hemisphereLight args={["#f4f1ea", "#3a3732", 0.35]} />
      <Hub
        cases={props.cases}
        recordedCaseId={props.recordedCaseId}
        focusedCase={props.focusedCase}
        reducedMotion={props.reducedMotion}
        shadows={settings.shadowMap > 0}
        present={props.place === "hub"}
        clock={props.clock}
        still={props.still}
        onOpenCase={props.onOpenCase}
        onFocusCase={props.onFocusCase}
      />
      <Room
        world={props.world}
        documents={props.documents}
        subjectName={props.subjectName}
        clock={props.clock}
        still={props.still}
        reducedMotion={props.reducedMotion}
        showPet={props.showPet}
        shadowMap={settings.shadowMap}
        present={props.place === "room"}
      />
      <CameraRig place={props.place} shot={shot} reducedMotion={props.reducedMotion} {...(props.onArrive === undefined ? {} : { onArrive: props.onArrive })} />
      <PostFX ao={settings.ao} bloom={settings.bloom} />
      {PINNED === null ? <TierMonitor tier={tier} place={props.place} onTier={setTier} /> : null}
      {MEASURE ? <FpsProbe tier={tier} /> : null}
    </Canvas>
  );
}
