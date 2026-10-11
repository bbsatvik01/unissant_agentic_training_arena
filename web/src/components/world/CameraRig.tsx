/**
 * The camera (D-020, D-025). Opening a case is a choreographed GSAP flight from the case board, through the door,
 * down the corridor and into the interview room (signature moment). Inside the room the camera works like a film
 * edit: each new shot is a cut, then a slow push-in drift, with each shot's own lens (a longer one for the close-up).
 * Under reduced motion every move is a cut with no drift (S6 6.6: still end state).
 */
import { useFrame, useThree } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useRef } from "react";
import { PerspectiveCamera, Vector3 } from "three";

import { FLIGHT_TO_HUB, FLIGHT_TO_ROOM, SHOTS, type Shot, type ShotName } from "../../lib/world/layout";

interface CameraRigProps {
  readonly place: "hub" | "room";
  readonly shot: ShotName;
  readonly reducedMotion: boolean;
  /** Called whenever the camera has settled in the room (after a flight, a cut, or a glide). */
  readonly onArrive?: () => void;
}

/** How far back from the framed position a cut starts before its push-in drift (fraction of the distance). */
const DRIFT = 0.07;
const DRIFT_S = 6;

export function CameraRig({ place, shot, reducedMotion, onArrive }: CameraRigProps) {
  const camera = useThree((s) => s.camera);
  const target = useRef(new Vector3(...SHOTS.hub.target));
  const lens = useRef({ fov: SHOTS.hub.fov });
  const placed = useRef<"hub" | "room" | null>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);

  useEffect(() => {
    const first = placed.current === null;
    const flying = !first && placed.current !== place;
    placed.current = place;
    timeline.current?.kill();
    const settle = place === "room" ? onArrive : undefined;
    const cut = (s: Shot) => {
      camera.position.set(...s.position);
      target.current.set(...s.target);
      lens.current.fov = s.fov;
    };
    if (!flying) {
      const s = SHOTS[place === "hub" ? "hub" : shot];
      if (first || reducedMotion) {
        cut(s);
        settle?.();
        return;
      }
      // A cut, then a slow push-in toward the framed position.
      const start = new Vector3(...s.position).sub(new Vector3(...s.target)).multiplyScalar(1 + DRIFT).add(new Vector3(...s.target));
      camera.position.copy(start);
      target.current.set(...s.target);
      lens.current.fov = s.fov;
      const tl = gsap.timeline(settle === undefined ? {} : { onStart: settle });
      tl.to(camera.position, { x: s.position[0], y: s.position[1], z: s.position[2], duration: DRIFT_S, ease: "sine.out" });
      timeline.current = tl;
      return;
    }
    const path: readonly ShotName[] = place === "room" ? FLIGHT_TO_ROOM : FLIGHT_TO_HUB;
    if (reducedMotion) {
      cut(SHOTS[path.at(-1) ?? "hub"]);
      settle?.();
      return;
    }
    const tl = gsap.timeline(settle === undefined ? {} : { onComplete: settle });
    path.forEach((name, i) => {
      const s = SHOTS[name];
      const duration = i === 0 ? 0.9 : 1.1;
      const ease = i === 0 ? "power2.in" : i === path.length - 1 ? "power2.out" : "none";
      tl.to(camera.position, { x: s.position[0], y: s.position[1], z: s.position[2], duration, ease });
      tl.to(target.current, { x: s.target[0], y: s.target[1], z: s.target[2], duration, ease }, "<");
      tl.to(lens.current, { fov: s.fov, duration, ease }, "<");
    });
    timeline.current = tl;
  }, [place, shot, reducedMotion, camera, onArrive]);

  useEffect(
    () => () => {
      timeline.current?.kill();
    },
    [],
  );

  useFrame((frame) => {
    const cam = frame.camera;
    if (cam instanceof PerspectiveCamera && Math.abs(cam.fov - lens.current.fov) > 0.01) {
      cam.fov = lens.current.fov;
      cam.updateProjectionMatrix();
    }
    cam.lookAt(target.current);
  });
  return null;
}
