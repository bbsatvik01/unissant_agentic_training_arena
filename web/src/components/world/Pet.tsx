/**
 * The coach companion (S6 6.3, 03-ui-direction 1.1): a small rounded character on the table, posed by
 * `petStateFor` through the world state. Its states show the session's work, never anyone's demeanor; it has no sad
 * or impatient pose. `still` motion (reduced motion, pause control) shows each pose without any loop or burst.
 * Decorative: the room's caption carries its state in words.
 */
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group } from "three";

import type { PetPose } from "../../lib/companion/fsm";
import type { Vec3 } from "../../lib/world/layout";
import { PALETTE } from "../../lib/world/palette";

interface PetProps {
  readonly position: Vec3;
  readonly pose: PetPose;
  /** Yaw the companion turns to when it notices something (toward the evidence wall and mirror). */
  readonly noticeYaw: number;
}

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * Math.min(1, rate * dt);
}

export function Pet({ position, pose, noticeYaw }: PetProps) {
  const body = useRef<Group>(null);
  const eyes = useRef<Group>(null);
  const started = useRef({ state: pose.state, at: 0 });

  useFrame((frame, delta) => {
    const t = frame.clock.elapsedTime;
    if (started.current.state !== pose.state) started.current = { state: pose.state, at: t };
    const since = t - started.current.at;
    const animate = pose.motion !== "still";
    const dt = animate ? delta : 1;
    const g = body.current;
    if (g === null) return;
    let y = 0;
    let yaw = -0.5;
    let pitch = 0;
    let squash = 1;
    switch (pose.state) {
      case "idle":
        squash = 1 + (animate ? Math.sin(t * 2) * 0.03 : 0);
        break;
      case "listening":
        yaw = -0.2;
        pitch = 0.18;
        break;
      case "thinking":
        pitch = -0.2;
        yaw = -0.5 + (animate ? Math.sin(t * 1.4) * 0.25 : 0);
        break;
      case "noticing":
        yaw = noticeYaw;
        y = animate ? Math.max(0, Math.sin(Math.min(since, 0.5) * Math.PI * 2)) * 0.03 : 0;
        break;
      case "encouraging":
        pitch = animate && since < 1.2 ? Math.sin(since * Math.PI * 3.3) * 0.3 : 0.1;
        break;
      case "celebrating":
        y = animate && since < 0.8 ? Math.sin((since / 0.8) * Math.PI) * 0.07 : 0;
        break;
      case "sleeping":
        pitch = 0.25;
        squash = 0.92;
        break;
    }
    g.position.y = approach(g.position.y, y, animate ? 30 : 1, dt);
    g.rotation.y = approach(g.rotation.y, yaw, 6, dt);
    g.rotation.x = approach(g.rotation.x, pitch, 8, dt);
    g.scale.y = approach(g.scale.y, squash, 10, dt);
    const e = eyes.current;
    if (e !== null) {
      const blink = animate && pose.state !== "sleeping" && t % 4.2 < 0.12;
      const closed = pose.state === "sleeping" || blink;
      e.scale.y = approach(e.scale.y, closed ? 0.15 : 1, 25, dt);
      e.position.y = pose.state === "thinking" ? 0.087 : 0.075;
    }
  });

  return (
    <group position={position}>
      <mesh position={[0, 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.075, 24]} />
        <meshBasicMaterial color={PALETTE.ink} transparent opacity={0.1} depthWrite={false} />
      </mesh>
      <group ref={body}>
        <mesh position={[0, 0.062, 0]} scale={[1, 0.88, 0.95]}>
          <sphereGeometry args={[0.07, 24, 18]} />
          <meshLambertMaterial color={PALETTE.canvasSoft2} />
        </mesh>
        {[-0.034, 0.034].map((x) => (
          <mesh key={x} position={[x, 0.122, -0.005]} rotation={[0, 0, x > 0 ? -0.35 : 0.35]}>
            <coneGeometry args={[0.018, 0.04, 10]} />
            <meshLambertMaterial color={PALETTE.ink} />
          </mesh>
        ))}
        <group ref={eyes} position={[0, 0.075, 0.06]}>
          {[-0.022, 0.022].map((x) => (
            <mesh key={x} position={[x, 0, 0]}>
              <sphereGeometry args={[0.0095, 10, 8]} />
              <meshBasicMaterial color={PALETTE.ink} />
            </mesh>
          ))}
        </group>
      </group>
    </group>
  );
}
