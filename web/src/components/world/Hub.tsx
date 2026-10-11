/**
 * The precinct hub (D-020): a quiet squad room whose back wall carries the case board, the mesh gradient as its
 * only decoration, with the practice case files pinned to it. Pointing at a file lifts it; clicking opens the case
 * (the overlay offers the same files as keyboard-operable buttons). A door beside the board leads down the
 * corridor to the interview room.
 */
import { useGSAP } from "@gsap/react";
import type { ThreeEvent } from "@react-three/fiber";
import gsap from "gsap";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Group } from "three";

import type { CaseCard } from "../../lib/world/cases";
import { CASE_BOARD, caseSlot, HUB_DOOR_X, ROOM, ROOM_SIZE, type Vec3 } from "../../lib/world/layout";
import { PALETTE } from "../../lib/world/palette";
import { Hairline } from "./Hairline";
import { caseFileTexture, meshGradientTexture, signTexture } from "./textures";

gsap.registerPlugin(useGSAP);

interface HubProps {
  readonly cases: readonly CaseCard[];
  readonly recordedCaseId: string;
  readonly focusedCase: string | null;
  readonly reducedMotion: boolean;
  readonly onOpenCase: (caseId: string) => void;
  readonly onFocusCase: (caseId: string | null) => void;
}

function Box({ size, position, color }: { size: Vec3; position: Vec3; color: string }) {
  return (
    <mesh position={position}>
      <boxGeometry args={size} />
      <meshLambertMaterial color={color} />
    </mesh>
  );
}

function CaseFile({ card, index, recorded, focused, reducedMotion, onOpen, onFocus }: {
  card: CaseCard;
  index: number;
  recorded: boolean;
  focused: boolean;
  reducedMotion: boolean;
  onOpen: () => void;
  onFocus: (on: boolean) => void;
}) {
  const group = useRef<Group>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!hover) return;
    document.body.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hover]);
  const texture = useMemo(
    () => caseFileTexture(card.case_id, card.title, `${card.subject.display_name}, ${card.subject.position}`, recorded ? "Recorded run" : null),
    [card, recorded],
  );
  useEffect(() => () => {
    texture.dispose();
  }, [texture]);
  const lifted = hover || focused;
  useGSAP(
    () => {
      const g = group.current;
      if (g === null) return;
      const vars = { z: lifted ? 0.16 : 0, duration: reducedMotion ? 0 : 0.28, ease: "power2.out" };
      gsap.to(g.position, vars);
      gsap.to(g.scale, { x: lifted ? 1.06 : 1, y: lifted ? 1.06 : 1, duration: vars.duration, ease: vars.ease });
    },
    { dependencies: [lifted, reducedMotion] },
  );
  const [x, y, z] = caseSlot(index);
  const tilt = ((index * 37) % 7) / 100 - 0.03;
  return (
    <group position={[x, y, z]} rotation={[0, 0, tilt]}>
      <group ref={group}>
        <mesh
          onPointerOver={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation();
            setHover(true);
            onFocus(true);
          }}
          onPointerOut={() => {
            setHover(false);
            onFocus(false);
          }}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          <planeGeometry args={[1.45, 0.9]} />
          <meshLambertMaterial map={texture} />
        </mesh>
        <mesh position={[0, 0.44, 0.01]}>
          <sphereGeometry args={[0.025, 12, 10]} />
          <meshLambertMaterial color={PALETTE.ink} />
        </mesh>
        <mesh position={[0.03, -0.03, -0.01]}>
          <planeGeometry args={[1.45, 0.9]} />
          <meshBasicMaterial color={PALETTE.ink} transparent opacity={lifted ? 0.16 : 0.08} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
}

function Desk({ x, z, rotation }: { x: number; z: number; rotation: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, rotation, 0]}>
      <Box size={[1.6, 0.05, 0.8]} position={[0, 0.74, 0]} color={PALETTE.canvas} />
      <Box size={[0.05, 0.74, 0.74]} position={[-0.76, 0.37, 0]} color={PALETTE.ink} />
      <Box size={[0.05, 0.74, 0.74]} position={[0.76, 0.37, 0]} color={PALETTE.ink} />
      <mesh position={[0.2, 0.98, -0.15]} rotation={[-0.1, 0, 0]}>
        <boxGeometry args={[0.6, 0.38, 0.03]} />
        <meshLambertMaterial color={PALETTE.ink} />
      </mesh>
      <Box size={[0.3, 0.01, 0.22]} position={[-0.4, 0.77, 0.1]} color={PALETTE.canvasSoft2} />
      <Box size={[0.5, 0.05, 0.48]} position={[0, 0.44, 0.65]} color={PALETTE.body} />
    </group>
  );
}

function HubScene({ cases, recordedCaseId, focusedCase, reducedMotion, onOpenCase, onFocusCase }: HubProps) {
  const mesh = useMemo(() => meshGradientTexture(), []);
  const sign = useMemo(() => signTexture("Interview rooms"), []);
  const boardSign = useMemo(() => signTexture("Open cases"), []);
  useEffect(
    () => () => {
      mesh.dispose();
      sign.dispose();
      boardSign.dispose();
    },
    [mesh, sign, boardSign],
  );
  const [bx, by, bz] = CASE_BOARD.center;
  const doorWidth = 1.4;
  const doorHeight = 2.4;
  const wallZ = -6;
  // The corridor stops short of the room so the room shot (just outside its open front) has a clear view.
  const corridorEnd = ROOM[2] + ROOM_SIZE.depth / 2 + 1.7;
  const corridorLength = wallZ - corridorEnd;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 1]}>
        <planeGeometry args={[20, 16]} />
        <meshLambertMaterial color={PALETTE.floor} />
      </mesh>
      {/* back wall with the door to the corridor */}
      <Box size={[HUB_DOOR_X - doorWidth / 2 + 9, 3.6, 0.12]} position={[(-9 + HUB_DOOR_X - doorWidth / 2) / 2, 1.8, wallZ - 0.06]} color={PALETTE.canvasSoft} />
      <Box size={[9 - HUB_DOOR_X - doorWidth / 2, 3.6, 0.12]} position={[(HUB_DOOR_X + doorWidth / 2 + 9) / 2, 1.8, wallZ - 0.06]} color={PALETTE.canvasSoft} />
      <Box size={[doorWidth, 3.6 - doorHeight, 0.12]} position={[HUB_DOOR_X, (3.6 + doorHeight) / 2, wallZ - 0.06]} color={PALETTE.canvasSoft} />
      <Box size={[doorWidth + 0.1, 0.05, 0.16]} position={[HUB_DOOR_X, doorHeight, wallZ]} color={PALETTE.ink} />
      <mesh position={[HUB_DOOR_X, doorHeight + 0.3, wallZ + 0.01]}>
        <planeGeometry args={[1.5, 0.28]} />
        <meshBasicMaterial map={sign} />
      </mesh>
      {/* side walls */}
      <Box size={[0.12, 3.6, 16]} position={[-9, 1.8, 1]} color={PALETTE.canvasSoft2} />
      <Box size={[0.12, 3.6, 16]} position={[9, 1.8, 1]} color={PALETTE.canvasSoft2} />
      {/* the case board: the mesh gradient at hero scale, files pinned on it */}
      <mesh position={[bx, by, bz]}>
        <planeGeometry args={[CASE_BOARD.width + 0.4, CASE_BOARD.height + 0.4]} />
        <meshBasicMaterial map={mesh} />
        <Hairline size={[CASE_BOARD.width + 0.4, CASE_BOARD.height + 0.4]} />
      </mesh>
      <mesh position={[bx, by + CASE_BOARD.height / 2 + 0.42, bz + 0.01]}>
        <planeGeometry args={[1.5, 0.28]} />
        <meshBasicMaterial map={boardSign} />
      </mesh>
      {cases.map((card, i) => (
        <CaseFile
          key={card.case_id}
          card={card}
          index={i}
          recorded={card.case_id === recordedCaseId}
          focused={focusedCase === card.case_id}
          reducedMotion={reducedMotion}
          onOpen={() => {
            onOpenCase(card.case_id);
          }}
          onFocus={(on) => {
            onFocusCase(on ? card.case_id : null);
          }}
        />
      ))}
      <Desk x={-6.4} z={-3.2} rotation={0.5} />
      <Desk x={6.6} z={-3.4} rotation={-0.5} />
      <Desk x={-6.8} z={0.4} rotation={0.4} />
      {/* corridor to the interview room */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[HUB_DOOR_X, 0.001, wallZ - corridorLength / 2]}>
        <planeGeometry args={[doorWidth, corridorLength]} />
        <meshLambertMaterial color={PALETTE.floor} />
      </mesh>
      <Box size={[0.1, 3, corridorLength]} position={[HUB_DOOR_X - doorWidth / 2 - 0.05, 1.5, wallZ - corridorLength / 2]} color={PALETTE.canvasSoft2} />
      <Box size={[0.1, 3, corridorLength]} position={[HUB_DOOR_X + doorWidth / 2 + 0.05, 1.5, wallZ - corridorLength / 2]} color={PALETTE.canvasSoft2} />
    </group>
  );
}

/** The hub's props change only with the case list and focus, so playback in the room never re-renders it. */
export const Hub = memo(HubScene);
