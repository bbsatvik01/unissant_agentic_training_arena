/**
 * The precinct hub (D-020, D-025): an investigations squad room. Plank floor, painted walls, daylight through
 * blinds, ceiling light panels, desks with monitors, filing cabinets and plants, a framed print carrying the
 * DESIGN.md mesh gradient, and on the back wall the cork case board with the practice case files pinned to it.
 * Pointing at a file lifts it; clicking opens the case (the overlay offers the same files as keyboard-operable
 * buttons). A door beside the board leads down the corridor to the interview room.
 */
import { useGSAP } from "@gsap/react";
import type { ThreeEvent } from "@react-three/fiber";
import gsap from "gsap";
import { memo, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Group } from "three";

import { HUB_STAFF } from "../../lib/world/cast";
import type { CaseCard } from "../../lib/world/cases";
import { CASE_BOARD, caseSlot, HUB, HUB_DOOR_X, ROOM, ROOM_SIZE } from "../../lib/world/layout";
import { Avatar } from "./Avatar";
import { brushedSteel, cork, paint, plaster, woodPlanks } from "./materials";
import { BlindWindow, Block, Cabinet, CeilingPanel, Desk, Door, Keyboard, Monitor, OfficeChair, Plant, WallClock } from "./props";
import { caseFileTexture, meshGradientTexture, signTexture } from "./textures";

gsap.registerPlugin(useGSAP);

interface HubProps {
  readonly cases: readonly CaseCard[];
  readonly recordedCaseId: string;
  readonly focusedCase: string | null;
  readonly reducedMotion: boolean;
  readonly shadows: boolean;
  /** The background staff are drawn only while the camera is in the precinct. */
  readonly present: boolean;
  readonly clock: RefObject<number>;
  readonly still: boolean;
  readonly onOpenCase: (caseId: string) => void;
  readonly onFocusCase: (caseId: string | null) => void;
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
      const vars = { z: lifted ? 0.12 : 0, duration: reducedMotion ? 0 : 0.28, ease: "power2.out" };
      gsap.to(g.position, vars);
      gsap.to(g.scale, { x: lifted ? 1.05 : 1, y: lifted ? 1.05 : 1, duration: vars.duration, ease: vars.ease });
    },
    { dependencies: [lifted, reducedMotion] },
  );
  const [x, y, z] = caseSlot(index);
  const tilt = ((index * 37) % 7) / 100 - 0.03;
  return (
    <group position={[x, y, z]} rotation={[0, 0, tilt]}>
      <group ref={group}>
        <mesh
          castShadow
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
          <boxGeometry args={[1.3, 0.81, 0.004]} />
          <meshStandardMaterial map={texture} roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.37, 0.012]} castShadow>
          <sphereGeometry args={[0.022, 14, 10]} />
          <meshStandardMaterial color="#b3261e" roughness={0.35} />
        </mesh>
      </group>
    </group>
  );
}

const DESKS: readonly (readonly [number, number, number])[] = [
  [-4.4, 0.4, 0.25],
  [-4.4, 2.4, Math.PI - 0.25],
  [1.4, 0.9, 0.12],
  [1.4, 2.9, Math.PI + 0.12],
];
/** The desk the detective works at (index into DESKS) and where the chair puts them. */
const STAFF_DESK = DESKS[2] ?? [0, 0, 0];
const STAFF_SEAT: readonly [number, number, number] = [STAFF_DESK[0] + Math.sin(STAFF_DESK[2]) * 0.62, 0, STAFF_DESK[1] + Math.cos(STAFF_DESK[2]) * 0.62];

function HubScene({ cases, recordedCaseId, focusedCase, reducedMotion, shadows, present, clock, still, onOpenCase, onFocusCase }: HubProps) {
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
  const { width: W, depth: D, height: H } = HUB;
  const back = -D / 2;
  const doorW = 1.1;
  const doorH = 2.2;
  // The corridor ends at the interview room's front wall (its door).
  const corridorEnd = ROOM[2] + ROOM_SIZE.depth / 2;
  const corridorLength = back - corridorEnd;
  const cz = back - corridorLength / 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={woodPlanks()} receiveShadow>
        <planeGeometry args={[W, D]} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, 0]} material={plaster("light")}>
        <planeGeometry args={[W, D]} />
      </mesh>
      {/* back wall with the door to the corridor */}
      <Block size={[HUB_DOOR_X - doorW / 2 + W / 2, H, 0.15]} at={[(-W / 2 + HUB_DOOR_X - doorW / 2) / 2, H / 2, back - 0.075]} material={plaster("warm")} />
      <Block size={[W / 2 - HUB_DOOR_X - doorW / 2, H, 0.15]} at={[(HUB_DOOR_X + doorW / 2 + W / 2) / 2, H / 2, back - 0.075]} material={plaster("warm")} />
      <Block size={[doorW, H - doorH, 0.15]} at={[HUB_DOOR_X, (H + doorH) / 2, back - 0.075]} material={plaster("warm")} />
      <Door position={[HUB_DOOR_X, 0, back]} open={1.35} width={1.0} height={doorH} window />
      <mesh position={[HUB_DOOR_X, doorH + 0.32, back + 0.01]}>
        <planeGeometry args={[1.3, 0.24]} />
        <meshStandardMaterial map={sign} roughness={0.6} />
      </mesh>
      {/* wainscot along the back wall */}
      <Block size={[W, 0.9, 0.03]} at={[0, 0.45, back + 0.015]} material={paint("white")} />
      <Block size={[W, 0.04, 0.05]} at={[0, 0.92, back + 0.025]} material={paint("frame")} />
      {/* side walls: windows with blinds on the left, a framed print on the right */}
      <Block size={[0.15, H, D]} at={[-W / 2 - 0.075, H / 2, 0]} material={plaster("light")} />
      <Block size={[0.15, H, D]} at={[W / 2 + 0.075, H / 2, 0]} material={plaster("light")} />
      {[-3, 0, 3].map((z) => (
        <BlindWindow key={z} position={[-W / 2 + 0.02, 1.75, z]} rotation={Math.PI / 2} width={2.0} height={1.6} />
      ))}
      <directionalLight
        position={[-W / 2 - 4, 6, 1]}
        intensity={1.1}
        color="#eaf1ff"
        castShadow={shadows}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-bias={-0.0005}
      />
      <mesh position={[W / 2 - 0.02, 1.8, -1.5]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[2.4, 1.3]} />
        <meshStandardMaterial map={mesh} roughness={0.4} />
      </mesh>
      <Block size={[0.04, 1.4, 2.5]} at={[W / 2 - 0.03, 1.8, -1.5]} material={paint("frame")} />
      <WallClock position={[W / 2 - 0.02, 2.75, 2.2]} rotation={-Math.PI / 2} still={still} />
      {/* the case board: cork in a steel frame, files pinned on it */}
      <mesh position={[bx, by, bz - 0.01]} material={cork()} receiveShadow>
        <boxGeometry args={[CASE_BOARD.width + 0.3, CASE_BOARD.height + 0.3, 0.03]} />
      </mesh>
      {[1, -1].map((s) => (
        <Block key={`bh${String(s)}`} size={[CASE_BOARD.width + 0.42, 0.06, 0.06]} at={[bx, by + s * (CASE_BOARD.height / 2 + 0.18), bz]} material={brushedSteel()} />
      ))}
      {[1, -1].map((s) => (
        <Block key={`bv${String(s)}`} size={[0.06, CASE_BOARD.height + 0.42, 0.06]} at={[bx + s * (CASE_BOARD.width / 2 + 0.18), by, bz]} material={brushedSteel()} />
      ))}
      <mesh position={[bx, by + CASE_BOARD.height / 2 + 0.42, bz + 0.01]}>
        <planeGeometry args={[1.3, 0.24]} />
        <meshStandardMaterial map={boardSign} roughness={0.6} />
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
      {/* the squad room: two desk clusters, chairs, cabinets, plants */}
      {DESKS.map(([x, z, r]) => (
        <group key={`${String(x)}${String(z)}`}>
          <Desk position={[x, 0, z]} rotation={r} width={1.5} depth={0.75} />
          <Monitor position={[x - Math.sin(r) * 0.2, 0.76, z - Math.cos(r) * 0.2]} rotation={r} lit width={0.58} />
          <Keyboard position={[x + Math.sin(r) * 0.1, 0.76, z + Math.cos(r) * 0.1]} rotation={r} />
          <OfficeChair position={[x + Math.sin(r) * 0.7, 0, z + Math.cos(r) * 0.7]} rotation={r + Math.PI} />
        </group>
      ))}
      {present ? (
        <Suspense fallback={null}>
          {/* a detective at work at the far desk */}
          <Avatar
            persona={HUB_STAFF}
            name="hub-staff"
            position={STAFF_SEAT}
            facing={STAFF_DESK[2] + Math.PI}
            pose="typing"
            gaze={[STAFF_DESK[0], 1.0, STAFF_DESK[1] - 0.2]}
            clock={clock}
            still={still}
            shadows={shadows}
          />
        </Suspense>
      ) : null}
      <Cabinet position={[-7.6, 0, -4.8]} rotation={Math.PI / 2} />
      <Cabinet position={[-7.6, 0, -4.2]} rotation={Math.PI / 2} />
      <Cabinet position={[7.6, 0, -4.8]} rotation={-Math.PI / 2} />
      <Plant position={[-5.6, 0, -5.4]} height={1.3} />
      <Plant position={[6.9, 0, -5.3]} height={1.1} />
      <Plant position={[2.4, 0, -5.4]} height={0.9} />
      {[-4, 0, 4].map((x) => [-3, 1, 4].map((z) => <CeilingPanel key={`${String(x)}${String(z)}`} position={[x, H - 0.02, z]} size={[1.2, 0.6]} />))}
      <pointLight position={[-1.6, H - 0.4, -3.4]} intensity={3} distance={8} decay={2} color="#fff6ea" />
      <pointLight position={[4, H - 0.4, 0]} intensity={2.2} distance={8} decay={2} color="#fff6ea" />
      <pointLight position={[-4, H - 0.4, 2]} intensity={1.8} distance={8} decay={2} color="#fff6ea" />
      {/* the corridor to the interview room */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[HUB_DOOR_X, 0.001, cz]} material={woodPlanks()} receiveShadow>
        <planeGeometry args={[1.8, corridorLength]} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[HUB_DOOR_X, 2.7, cz]} material={plaster("light")}>
        <planeGeometry args={[1.8, corridorLength]} />
      </mesh>
      <Block size={[0.1, 2.7, corridorLength]} at={[HUB_DOOR_X - 0.95, 1.35, cz]} material={plaster("warm")} />
      <Block size={[0.1, 2.7, corridorLength]} at={[HUB_DOOR_X + 0.95, 1.35, cz]} material={plaster("warm")} />
      {[0.25, 0.5, 0.75].map((f) => (
        <group key={f}>
          <CeilingPanel position={[HUB_DOOR_X, 2.68, back - corridorLength * f]} size={[0.6, 0.6]} />
          <pointLight position={[HUB_DOOR_X, 2.4, back - corridorLength * f]} intensity={0.9} distance={4} decay={2} color="#fff4e6" />
        </group>
      ))}
    </group>
  );
}

/** The hub's props change only with the case list and focus, so playback in the room never re-renders it. */
export const Hub = memo(HubScene);
