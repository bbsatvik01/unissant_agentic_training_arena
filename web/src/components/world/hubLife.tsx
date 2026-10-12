/**
 * Small signs of life in the precinct (stage 5): a desk phone whose message light pulses, monitors whose glow drifts
 * as if their pages scrolled, and now and then an officer walking down the corridor beyond the open door. Each is a
 * handful of vertices and one material; all of it holds still under reduced motion or the pause control (a lit
 * phone light, steady screens, nobody in the corridor).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { MeshBasicMaterial, MeshStandardMaterial, type Group, type Mesh } from "three";

import type { Vec3 } from "../../lib/world/layout";
import { paint } from "./materials";
import { Block } from "./props";

/** A desk phone with a message light that pulses slowly. */
export function DeskPhone({ position, rotation, still }: { position: Vec3; rotation: number; still: boolean }) {
  const led = useRef<MeshStandardMaterial>(null);
  useFrame(({ clock }) => {
    // On for half a second in every two: a message is waiting. Steady when motion is off.
    if (led.current !== null) led.current.emissiveIntensity = still || clock.elapsedTime % 2 < 0.5 ? 3 : 0.15;
  });
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <Block size={[0.2, 0.05, 0.17]} at={[0, 0.025, 0]} material={paint("ink")} />
      <Block size={[0.06, 0.04, 0.17]} at={[-0.06, 0.07, 0]} material={paint("ink")} />
      <mesh position={[0.07, 0.052, 0.055]}>
        <boxGeometry args={[0.014, 0.006, 0.014]} />
        <meshStandardMaterial ref={led} color="#000000" emissive="#ff9f0a" emissiveIntensity={3} roughness={1} />
      </mesh>
    </group>
  );
}

/** A faint layer over a lit screen whose brightness drifts, each screen on its own phase. */
export function ScreenGlow({ position, rotation, width, phase, still }: { position: Vec3; rotation: number; width: number; phase: number; still: boolean }) {
  const material = useRef<MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const m = material.current;
    if (m === null) return;
    if (still) {
      m.opacity = 0.04;
      return;
    }
    const t = clock.elapsedTime + phase;
    // Two slow waves: the glow of a page being read, never a flicker.
    m.opacity = 0.03 + 0.025 * (0.5 + 0.5 * Math.sin(t * 0.7)) + 0.015 * (0.5 + 0.5 * Math.sin(t * 2.3 + phase));
  });
  return (
    <mesh position={position} rotation={[0, rotation, 0]}>
      <planeGeometry args={[width - 0.03, width * 0.6 - 0.03]} />
      <meshBasicMaterial ref={material} color="#dfe9ff" transparent opacity={0.04} depthWrite={false} />
    </mesh>
  );
}

/** How often an officer walks down the corridor, and for how long. */
export const PASS_EVERY_S = 26;
export const PASS_FOR_S = 7;

/** Where the officer is at `t` seconds: 0..1 along the corridor while passing, or null when nobody is there. */
export function passAt(t: number): number | null {
  const into = t % PASS_EVERY_S;
  return into < PASS_FOR_S ? into / PASS_FOR_S : null;
}

/** An officer in uniform walking the corridor from its far end toward a side door, seen through the open door. */
export function CorridorPasser({ x, from, to, still }: { x: number; from: number; to: number; still: boolean }) {
  const group = useRef<Group>(null);
  const head = useRef<Mesh>(null);
  const uniform = useMemo(() => new MeshStandardMaterial({ color: "#1d2a44", roughness: 0.8 }), []);
  const skin = useMemo(() => new MeshStandardMaterial({ color: "#8a6a55", roughness: 0.7 }), []);
  useFrame(({ clock }) => {
    const g = group.current;
    if (g === null) return;
    const f = still ? null : passAt(clock.elapsedTime + 9);
    g.visible = f !== null;
    if (f === null) return;
    g.position.z = from + (to - from) * f;
    // A walking bob and a slight sway, two steps a second.
    g.position.y = Math.abs(Math.sin(clock.elapsedTime * Math.PI * 2)) * 0.035;
    g.rotation.z = Math.sin(clock.elapsedTime * Math.PI * 2) * 0.02;
    if (head.current !== null) head.current.rotation.y = Math.sin(clock.elapsedTime * 0.8) * 0.15;
  });
  return (
    <group ref={group} position={[x, 0, from]} visible={false}>
      <mesh position={[0, 0.98, 0]} material={uniform} castShadow>
        <capsuleGeometry args={[0.2, 0.75, 4, 10]} />
      </mesh>
      <mesh position={[0, 0.42, 0]} material={uniform}>
        <boxGeometry args={[0.34, 0.84, 0.22]} />
      </mesh>
      <mesh ref={head} position={[0, 1.62, 0]} material={skin}>
        <sphereGeometry args={[0.11, 12, 10]} />
      </mesh>
      <mesh position={[0, 1.72, 0]} material={uniform}>
        <cylinderGeometry args={[0.12, 0.12, 0.05, 12]} />
      </mesh>
    </group>
  );
}
