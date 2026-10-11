/**
 * A seated, stylised figure built from primitives: the subject across the table and the coaches in the observation
 * room. Poses are lifecycle and work states only (idle, listening, thinking, speaking; typing, handing, pointing);
 * there is no demeanor pose and no colour or motion that reads as one (PRB-4). Speaking is driven by the streamed
 * text cadence (`mouthAt`) on the session clock. Under reduced motion or the pause control every loop stops and
 * each pose is shown still, a speaking figure with a fixed open mouth as its static marker (FE-AV-4).
 */
import { useFrame } from "@react-three/fiber";
import { useRef, type RefObject } from "react";
import type { Group, Mesh } from "three";

import { mouthAt } from "../../lib/world/cadence";
import type { Vec3 } from "../../lib/world/layout";
import { PALETTE } from "../../lib/world/palette";
import type { CoachPose, FigurePose, Speech } from "../../lib/world/worldState";

export type AnyPose = FigurePose | CoachPose;

interface Look {
  readonly skin: string;
  readonly cloth: string;
  readonly hair: string;
}

interface FigureProps {
  readonly position: Vec3;
  readonly facing?: number;
  readonly look: Look;
  readonly pose: AnyPose;
  readonly speech?: Speech | null;
  /** The session clock in ms, read every frame (the mouth follows the line being spoken). */
  readonly clock: RefObject<number>;
  readonly still: boolean;
  /** A seed so figures do not breathe in step. */
  readonly phase?: number;
  /** Where the hand holds a card while handing it over. */
  readonly holdsCard?: boolean;
}

/** Arm reach (rotation about x at the shoulder) for each pose: right arm, left arm. */
const ARMS: Readonly<Record<AnyPose, readonly [number, number]>> = {
  idle: [-0.85, -0.85],
  listening: [-0.95, -0.95],
  thinking: [-2.35, -0.85],
  speaking: [-1.05, -0.9],
  away: [-0.85, -0.85],
  typing: [-1.2, -1.2],
  handing: [-1.55, -0.9],
  pointing: [-2.7, -0.85],
};

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * Math.min(1, rate * dt);
}

export function Figure({ position, facing = 0, look, pose, speech = null, clock, still, phase = 0, holdsCard = false }: FigureProps) {
  const upper = useRef<Group>(null);
  const head = useRef<Group>(null);
  const mouth = useRef<Mesh>(null);
  const right = useRef<Group>(null);
  const left = useRef<Group>(null);
  const card = useRef<Mesh>(null);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime + phase;
    const dt = still ? 1 : delta;
    const loop = still ? 0 : 1;
    const [rTarget, lTarget] = ARMS[pose];
    if (right.current !== null) {
      const typing = pose === "typing" ? Math.sin(t * 14) * 0.08 * loop : 0;
      right.current.rotation.x = approach(right.current.rotation.x, rTarget + typing, 6, dt);
      right.current.rotation.z = approach(right.current.rotation.z, pose === "thinking" ? 0.55 : 0.08, 6, dt);
    }
    if (left.current !== null) {
      const typing = pose === "typing" ? Math.sin(t * 14 + 1.7) * 0.08 * loop : 0;
      left.current.rotation.x = approach(left.current.rotation.x, lTarget + typing, 6, dt);
    }
    if (upper.current !== null) {
      const lean = pose === "listening" ? 0.09 : pose === "typing" ? 0.12 : pose === "handing" ? 0.1 : 0;
      upper.current.rotation.x = approach(upper.current.rotation.x, lean, 4, dt);
      upper.current.scale.y = 1 + Math.sin(t * 1.6) * 0.012 * loop;
    }
    if (head.current !== null) {
      const tiltZ = pose === "listening" ? 0.1 : pose === "thinking" ? -0.08 : 0;
      const tiltX = pose === "thinking" ? -0.16 : pose === "typing" ? 0.22 : 0;
      const nod = pose === "speaking" ? Math.sin(t * 5.5) * 0.035 * loop : Math.sin(t * 0.7) * 0.015 * loop;
      head.current.rotation.z = approach(head.current.rotation.z, tiltZ, 4, dt);
      head.current.rotation.x = approach(head.current.rotation.x, tiltX + nod, 6, dt);
    }
    if (mouth.current !== null) {
      let open = 0;
      if (pose === "speaking") open = still || speech === null ? 0.5 : mouthAt(speech.text, clock.current - speech.startedAt);
      mouth.current.scale.y = approach(mouth.current.scale.y, 1 + open * 3.2, 18, dt);
    }
    if (card.current !== null) card.current.visible = holdsCard;
  });

  return (
    <group position={position} rotation={[0, facing, 0]}>
      {/* seat contact shadow */}
      <mesh position={[0, 0.005, 0.05]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.42, 32]} />
        <meshBasicMaterial color={PALETTE.ink} transparent opacity={0.07} depthWrite={false} />
      </mesh>
      {/* chair */}
      <mesh position={[0, 0.44, -0.02]}>
        <boxGeometry args={[0.5, 0.05, 0.48]} />
        <meshLambertMaterial color={PALETTE.ink} />
      </mesh>
      <mesh position={[0, 0.78, -0.25]}>
        <boxGeometry args={[0.48, 0.62, 0.04]} />
        <meshLambertMaterial color={PALETTE.ink} />
      </mesh>
      {[-0.21, 0.21].map((x) =>
        [-0.2, 0.18].map((z) => (
          <mesh key={`${String(x)}${String(z)}`} position={[x, 0.21, z]}>
            <cylinderGeometry args={[0.015, 0.015, 0.42, 6]} />
            <meshLambertMaterial color={PALETTE.ink} />
          </mesh>
        )),
      )}
      {/* thighs */}
      {[-0.1, 0.1].map((x) => (
        <mesh key={x} position={[x, 0.53, 0.14]} rotation={[Math.PI / 2, 0, 0]}>
          <capsuleGeometry args={[0.075, 0.28, 4, 10]} />
          <meshLambertMaterial color={PALETTE.cloth[1]} />
        </mesh>
      ))}
      <group ref={upper} position={[0, 0.5, 0]}>
        <mesh position={[0, 0.33, 0]}>
          <capsuleGeometry args={[0.17, 0.3, 6, 16]} />
          <meshLambertMaterial color={look.cloth} />
        </mesh>
        <group ref={right} position={[0.215, 0.52, 0]}>
          <mesh position={[0, -0.22, 0]}>
            <capsuleGeometry args={[0.05, 0.36, 4, 10]} />
            <meshLambertMaterial color={look.cloth} />
          </mesh>
          <mesh position={[0, -0.44, 0]}>
            <sphereGeometry args={[0.048, 12, 10]} />
            <meshLambertMaterial color={look.skin} />
          </mesh>
          <mesh ref={card} position={[0, -0.5, 0.04]} rotation={[Math.PI / 2, 0, 0]} visible={false}>
            <boxGeometry args={[0.16, 0.11, 0.004]} />
            <meshLambertMaterial color={PALETTE.canvas} />
          </mesh>
        </group>
        <group ref={left} position={[-0.215, 0.52, 0]}>
          <mesh position={[0, -0.22, 0]}>
            <capsuleGeometry args={[0.05, 0.36, 4, 10]} />
            <meshLambertMaterial color={look.cloth} />
          </mesh>
          <mesh position={[0, -0.44, 0]}>
            <sphereGeometry args={[0.048, 12, 10]} />
            <meshLambertMaterial color={look.skin} />
          </mesh>
        </group>
        <mesh position={[0, 0.6, 0]}>
          <cylinderGeometry args={[0.05, 0.06, 0.08, 10]} />
          <meshLambertMaterial color={look.skin} />
        </mesh>
        <group ref={head} position={[0, 0.74, 0]}>
          <mesh>
            <sphereGeometry args={[0.13, 24, 18]} />
            <meshLambertMaterial color={look.skin} />
          </mesh>
          <mesh position={[0, 0.018, -0.012]} rotation={[-0.35, 0, 0]}>
            <sphereGeometry args={[0.137, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.5]} />
            <meshLambertMaterial color={look.hair} />
          </mesh>
          {[-0.045, 0.045].map((x) => (
            <mesh key={x} position={[x, 0.012, 0.118]}>
              <sphereGeometry args={[0.014, 10, 8]} />
              <meshBasicMaterial color={PALETTE.ink} />
            </mesh>
          ))}
          <mesh ref={mouth} position={[0, -0.055, 0.121]}>
            <boxGeometry args={[0.046, 0.01, 0.01]} />
            <meshBasicMaterial color={PALETTE.ink} />
          </mesh>
        </group>
      </group>
    </group>
  );
}
