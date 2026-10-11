/**
 * The camera: GSAP flies it between the layout's shots. Opening a case is a choreographed flight from the board,
 * through the door and down the corridor into the interview room (signature moment); inside the room it glides
 * between the room, wall, mirror and table shots as the world's moments call for them. Under reduced motion every
 * move is a cut (S6 6.6: still end state).
 */
import { useFrame, useThree } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useRef } from "react";
import { Vector3 } from "three";

import { FLIGHT_TO_HUB, FLIGHT_TO_ROOM, SHOTS, type ShotName } from "../../lib/world/layout";

interface CameraRigProps {
  readonly place: "hub" | "room";
  readonly shot: ShotName;
  readonly reducedMotion: boolean;
  /** Called whenever the camera has settled in the room (after a flight, a cut, or a glide). */
  readonly onArrive?: () => void;
}

export function CameraRig({ place, shot, reducedMotion, onArrive }: CameraRigProps) {
  const camera = useThree((s) => s.camera);
  const target = useRef(new Vector3(...SHOTS.hub.target));
  const placed = useRef<"hub" | "room" | null>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);

  useEffect(() => {
    const first = placed.current === null;
    const flying = !first && placed.current !== place;
    const path: readonly ShotName[] = flying ? (place === "room" ? FLIGHT_TO_ROOM : FLIGHT_TO_HUB) : [place === "hub" ? "hub" : shot];
    placed.current = place;
    timeline.current?.kill();
    if (first || reducedMotion) {
      const end = SHOTS[path.at(-1) ?? "hub"];
      camera.position.set(...end.position);
      target.current.set(...end.target);
      if (place === "room") onArrive?.();
      return;
    }
    // Any move that ends in the room counts as arriving (a flight, or a glide that replaced an interrupted one);
    // arriving is idempotent for the caller.
    const tl = gsap.timeline(place === "room" && onArrive !== undefined ? { onComplete: onArrive } : {});
    path.forEach((name, i) => {
      const s = SHOTS[name];
      const duration = flying ? (i === 0 ? 0.9 : 1.05) : 1.0;
      const ease = flying ? (i === 0 ? "power2.in" : i === path.length - 1 ? "power2.out" : "none") : "power3.inOut";
      tl.to(camera.position, { x: s.position[0], y: s.position[1], z: s.position[2], duration, ease }, flying ? undefined : 0);
      tl.to(target.current, { x: s.target[0], y: s.target[1], z: s.target[2], duration, ease }, "<");
    });
    timeline.current = tl;
  }, [place, shot, reducedMotion, camera, onArrive]);

  useEffect(
    () => () => {
      timeline.current?.kill();
    },
    [],
  );

  useFrame(() => {
    camera.lookAt(target.current);
  });
  return null;
}
