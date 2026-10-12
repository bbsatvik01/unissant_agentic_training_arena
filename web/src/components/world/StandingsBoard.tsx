/**
 * The standings board on the precinct's back wall, between the case board and the corridor door (S6 4.10, the
 * arena's signature moment): a selected tournament's standings go up once the arena has its board. Sealed before
 * reveal (no numbers, FE-LB-5); when the board changes (the reveal), it turns over on its vertical axis once, a
 * departure-board flip, and with motion off it is simply there. Pointing at it lifts it a little; clicking opens
 * the arena panel, which carries the same board in full, keyboard-operable.
 */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "three";

import { standingsKey, type Standings } from "../../lib/arena/standings";
import type { Vec3 } from "../../lib/world/layout";
import { standingsTexture } from "./textures";

/** The board's width and height in metres (the texture's 1200 x 650 aspect). */
export const STANDINGS_SIZE = [2.1, 1.1375] as const;

/** How long the reveal flip takes, in seconds. */
export const FLIP_S = 0.9;

/** The board's turn about its vertical axis `t` seconds into the flip: from edge-on (pi / 2) to flat (0), eased
 * out, and flat from `FLIP_S` on. */
export function flipAt(t: number): number {
  if (t >= FLIP_S) return 0;
  const x = Math.max(0, t) / FLIP_S;
  return (Math.PI / 2) * (1 - x) ** 3;
}

export function StandingsBoard({ standings, position, rotation, still, onOpen }: { standings: Standings; position: Vec3; rotation: number; still: boolean; onOpen: () => void }) {
  // Keyed on what the board says, so a re-read of the same board neither redraws nor turns it over.
  const key = standingsKey(standings);
  const map = useMemo(() => standingsTexture(JSON.parse(key) as Standings), [key]);
  useEffect(
    () => () => {
      map.dispose();
    },
    [map],
  );
  const turn = useRef<Group>(null);
  // When the flip began (the clock's time at the next frame after the board changed), null when at rest.
  const flipFrom = useRef<number | null>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    flipFrom.current = -1;
  }, [key]);
  useFrame(({ clock }) => {
    const g = turn.current;
    if (g === null) return;
    if (still || flipFrom.current === null) {
      g.rotation.y = 0;
      flipFrom.current = null;
    } else {
      if (flipFrom.current < 0) flipFrom.current = clock.elapsedTime;
      const t = clock.elapsedTime - flipFrom.current;
      g.rotation.y = flipAt(t);
      if (t >= FLIP_S) flipFrom.current = null;
    }
    g.position.z = hover && !still ? 0.03 : 0;
  });
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <group ref={turn}>
        <mesh
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHover(true);
            document.body.style.cursor = "pointer";
          }}
          onPointerOut={() => {
            setHover(false);
            document.body.style.cursor = "";
          }}
        >
          <planeGeometry args={[STANDINGS_SIZE[0], STANDINGS_SIZE[1]]} />
          <meshStandardMaterial map={map} roughness={0.45} />
        </mesh>
      </group>
    </group>
  );
}
