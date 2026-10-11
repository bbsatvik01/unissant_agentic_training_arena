/**
 * The interview room (D-020): the table with the subject across from the investigator's seat, the evidence wall
 * where records pin themselves as they are released, the one-way mirror into the observation room where the coach
 * desks work, the companion on the table, and the seal stamped on the case folder when the finding is committed.
 * Everything here is drawn from the world state; nothing reads session data directly (FE-SSE-7).
 */
import { useGSAP } from "@gsap/react";
import { useFrame } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { QuadraticBezierCurve3, Vector3, type Group, type Mesh, type MeshBasicMaterial } from "three";

import {
  COACH_DESKS,
  EVIDENCE_WALL,
  evidenceSlot,
  FOLDER_SPOT,
  MIRROR,
  PET_SPOT,
  ROOM,
  ROOM_SIZE,
  SUBJECT_SEAT,
  TABLE,
  type Vec3,
} from "../../lib/world/layout";
import { PALETTE } from "../../lib/world/palette";
import type { WorldState } from "../../lib/world/worldState";
import { Figure } from "./Figure";
import { Hairline } from "./Hairline";
import { Pet } from "./Pet";
import { paperTexture } from "./textures";

gsap.registerPlugin(useGSAP);

export interface WallDocument {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  /** When it was released on the session clock; null for a document on file from the start. */
  readonly releasedAt: number | null;
}

interface RoomProps {
  readonly world: WorldState | null;
  readonly documents: readonly WallDocument[];
  readonly clock: RefObject<number>;
  readonly still: boolean;
  readonly reducedMotion: boolean;
}

const COACH_LOOKS = [
  { skin: PALETTE.skin[1], cloth: PALETTE.cloth[2], hair: PALETTE.ink },
  { skin: PALETTE.skin[3], cloth: PALETTE.cloth[3], hair: PALETTE.cloth[2] },
  { skin: PALETTE.skin[2], cloth: PALETTE.cloth[1], hair: PALETTE.ink },
] as const;
const SUBJECT_LOOK = { skin: PALETTE.skin[0], cloth: PALETTE.cloth[0], hair: PALETTE.cloth[2] } as const;

function Box({ size, position, color, edges = false }: { size: Vec3; position: Vec3; color: string; edges?: boolean }) {
  return (
    <mesh position={position}>
      <boxGeometry args={size} />
      <meshLambertMaterial color={color} />
      {edges ? <Hairline size={size} /> : null}
    </mesh>
  );
}

function Shell() {
  const { width, depth, height } = ROOM_SIZE;
  const back = -depth / 2;
  const mirrorLeft = MIRROR.center[0] - MIRROR.width / 2;
  const mirrorRight = MIRROR.center[0] + MIRROR.width / 2;
  const mirrorBottom = MIRROR.center[1] - MIRROR.height / 2;
  const mirrorTop = MIRROR.center[1] + MIRROR.height / 2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshLambertMaterial color={PALETTE.floor} />
      </mesh>
      {/* back wall around the mirror */}
      <Box size={[mirrorLeft + width / 2, height, 0.1]} position={[(-width / 2 + mirrorLeft) / 2, height / 2, back - 0.05]} color={PALETTE.canvasSoft} />
      <Box size={[width / 2 - mirrorRight, height, 0.1]} position={[(mirrorRight + width / 2) / 2, height / 2, back - 0.05]} color={PALETTE.canvasSoft} />
      <Box size={[MIRROR.width, mirrorBottom, 0.1]} position={[MIRROR.center[0], mirrorBottom / 2, back - 0.05]} color={PALETTE.canvasSoft} />
      <Box size={[MIRROR.width, height - mirrorTop, 0.1]} position={[MIRROR.center[0], (height + mirrorTop) / 2, back - 0.05]} color={PALETTE.canvasSoft} />
      {/* side walls */}
      <Box size={[0.1, height, depth]} position={[-width / 2 - 0.05, height / 2, 0]} color={PALETTE.canvasSoft2} />
      <Box size={[0.1, height, depth]} position={[width / 2 + 0.05, height / 2, 0]} color={PALETTE.canvasSoft2} />
      {/* skirting hairline */}
      <Box size={[width, 0.06, 0.02]} position={[0, 0.03, back + 0.01]} color={PALETTE.hairlineStrong} />
    </group>
  );
}

function Table() {
  const [x, y, z] = TABLE.center;
  return (
    <group>
      <mesh position={[x, y, z]}>
        <boxGeometry args={[TABLE.width, 0.05, TABLE.depth]} />
        <meshLambertMaterial color={PALETTE.canvas} />
        <Hairline size={[TABLE.width, 0.05, TABLE.depth]} />
      </mesh>
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${String(sx)}${String(sz)}`} position={[x + sx * (TABLE.width / 2 - 0.08), y / 2, z + sz * (TABLE.depth / 2 - 0.08)]}>
            <cylinderGeometry args={[0.022, 0.022, y, 8]} />
            <meshLambertMaterial color={PALETTE.ink} />
          </mesh>
        )),
      )}
      <mesh position={[x, 0.004, z]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[TABLE.width + 0.3, TABLE.depth + 0.3]} />
        <meshBasicMaterial color={PALETTE.ink} transparent opacity={0.05} depthWrite={false} />
      </mesh>
      {/* investigator's empty chair and notepad */}
      <Box size={[0.5, 0.05, 0.48]} position={[TABLE.center[0], 0.44, 1.3]} color={PALETTE.ink} />
      <Box size={[0.22, 0.006, 0.3]} position={[0.55, 0.768, 0.45]} color={PALETTE.canvas} edges />
    </group>
  );
}

/**
 * Drive a paused GSAP timeline from the session clock, so playback pause, speed and scrub move the moment with
 * everything else; with motion off it shows its end state.
 */
function useClockTimeline(timeline: RefObject<gsap.core.Timeline | null>, clock: RefObject<number>, at: number | null, motionOff: boolean) {
  useFrame(() => {
    const tl = timeline.current;
    if (tl === null || at === null) return;
    const elapsed = motionOff ? tl.duration() : (clock.current - at) / 1000;
    tl.time(Math.max(0, Math.min(tl.duration(), elapsed)));
  });
}

function Paper({ slot, doc, clock, motionOff, highlighted }: { slot: Vec3; doc: WallDocument; clock: RefObject<number>; motionOff: boolean; highlighted: boolean }) {
  const flight = useRef<Group>(null);
  const lift = useRef<Group>(null);
  const pin = useRef<Mesh>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  const texture = useMemo(() => paperTexture(doc.id, doc.title, doc.note), [doc.id, doc.title, doc.note]);
  useEffect(() => () => {
    texture.dispose();
  }, [texture]);
  // Evidence released (signature moment): the record flies from the table to its slot and is pinned, on the
  // session clock from its release. A document on file from the start is simply there.
  useGSAP(
    () => {
      const g = flight.current;
      const p = pin.current;
      if (g === null || p === null || doc.releasedAt === null) return;
      const tl = gsap.timeline({ paused: true });
      tl.from(g.position, { x: TABLE.center[0] - 0.3, y: 1.05, z: TABLE.center[2] - 0.2, duration: 1.15, ease: "power3.out" })
        .from(g.rotation, { x: -1.35, y: 0.5, z: 0.5, duration: 1.15, ease: "power3.out" }, 0)
        .from(g.scale, { x: 0.55, y: 0.55, z: 0.55, duration: 0.7, ease: "power2.out" }, 0)
        .fromTo(p.position, { z: 0.3 }, { z: 0.012, duration: 0.22, ease: "power4.in" }, 1.05)
        .to(g.rotation, { z: 0.035, duration: 0.12, yoyo: true, repeat: 1, ease: "sine.inOut" }, 1.27);
      timeline.current = tl;
      return () => {
        timeline.current = null;
      };
    },
    { dependencies: [doc.releasedAt] },
  );
  useClockTimeline(timeline, clock, doc.releasedAt, motionOff);
  useGSAP(
    () => {
      const g = lift.current;
      if (g === null) return;
      const s = highlighted ? 1.12 : 1;
      if (motionOff) g.scale.set(s, s, 1);
      else gsap.to(g.scale, { x: s, y: s, duration: 0.35, ease: "power2.out" });
    },
    { dependencies: [highlighted, motionOff] },
  );
  return (
    <group ref={flight} position={slot}>
      <group ref={lift}>
        <mesh>
          <planeGeometry args={[0.36, 0.48]} />
          <meshLambertMaterial map={texture} />
        </mesh>
        {highlighted ? (
          <mesh position={[0, 0, -0.002]}>
            <planeGeometry args={[0.4, 0.52]} />
            <meshBasicMaterial color={PALETTE.link} />
          </mesh>
        ) : null}
        <mesh ref={pin} position={[0, 0.2, 0.012]}>
          <sphereGeometry args={[0.014, 10, 8]} />
          <meshLambertMaterial color={PALETTE.ink} />
        </mesh>
      </group>
    </group>
  );
}

function EvidenceWall({ documents, clock, motionOff, highlight }: { documents: readonly WallDocument[]; clock: RefObject<number>; motionOff: boolean; highlight: string | null }) {
  const [cx, cy, cz] = EVIDENCE_WALL.center;
  return (
    <group>
      <mesh position={[cx, cy, cz]}>
        <planeGeometry args={[EVIDENCE_WALL.width + 0.25, EVIDENCE_WALL.height + 0.25]} />
        <meshLambertMaterial color={PALETTE.canvas} />
        <Hairline size={[EVIDENCE_WALL.width + 0.25, EVIDENCE_WALL.height + 0.25]} />
      </mesh>
      {documents.map((doc, i) => (
        <Paper key={doc.id} slot={evidenceSlot(i)} doc={doc} clock={clock} motionOff={motionOff} highlighted={doc.id === highlight} />
      ))}
    </group>
  );
}

function Mirror() {
  const [x, y, z] = MIRROR.center;
  return (
    <group>
      <mesh position={[x, y, z]}>
        <planeGeometry args={[MIRROR.width, MIRROR.height]} />
        <meshBasicMaterial color={PALETTE.glass} transparent opacity={0.28} depthWrite={false} />
      </mesh>
      {/* a soft reflection band across the glass */}
      <mesh position={[x - 0.3, y + 0.15, z + 0.005]} rotation={[0, 0, 0.5]}>
        <planeGeometry args={[0.25, MIRROR.height * 1.3]} />
        <meshBasicMaterial color={PALETTE.canvas} transparent opacity={0.16} depthWrite={false} />
      </mesh>
      <Box size={[MIRROR.width + 0.08, 0.04, 0.06]} position={[x, y - MIRROR.height / 2, z + 0.02]} color={PALETTE.ink} />
      <Box size={[MIRROR.width + 0.08, 0.04, 0.06]} position={[x, y + MIRROR.height / 2, z + 0.02]} color={PALETTE.ink} />
      <Box size={[0.04, MIRROR.height, 0.06]} position={[x - MIRROR.width / 2, y, z + 0.02]} color={PALETTE.ink} />
      <Box size={[0.04, MIRROR.height, 0.06]} position={[x + MIRROR.width / 2, y, z + 0.02]} color={PALETTE.ink} />
    </group>
  );
}

function Desk({ position, active }: { position: Vec3; active: boolean }) {
  const [x, , z] = position;
  return (
    <group>
      <Box size={[0.8, 0.04, 0.5]} position={[x, 0.72, z + 0.42]} color={PALETTE.canvasSoft2} />
      <Box size={[0.04, 0.72, 0.46]} position={[x - 0.36, 0.36, z + 0.42]} color={PALETTE.ink} />
      <Box size={[0.04, 0.72, 0.46]} position={[x + 0.36, 0.36, z + 0.42]} color={PALETTE.ink} />
      <mesh position={[x, 0.92, z + 0.6]} rotation={[-0.15, Math.PI, 0]}>
        <boxGeometry args={[0.42, 0.27, 0.02]} />
        <meshBasicMaterial color={active ? PALETTE.canvas : PALETTE.body} />
      </mesh>
      <Box size={[0.02, 0.12, 0.02]} position={[x, 0.78, z + 0.62]} color={PALETTE.ink} />
    </group>
  );
}

function ObservationRoom({ world, clock, still }: { world: WorldState | null; clock: RefObject<number>; still: boolean }) {
  const back = -ROOM_SIZE.depth / 2;
  const coaches = world?.coaches ?? [];
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[1.5, 0.001, back - 2]}>
        <planeGeometry args={[3.8, 4]} />
        <meshLambertMaterial color={PALETTE.observation} />
      </mesh>
      <Box size={[3.8, ROOM_SIZE.height, 0.1]} position={[1.5, ROOM_SIZE.height / 2, back - 4]} color={PALETTE.observation} />
      <Box size={[0.1, ROOM_SIZE.height, 4]} position={[-0.4, ROOM_SIZE.height / 2, back - 2]} color={PALETTE.observation} />
      <Box size={[0.1, ROOM_SIZE.height, 4]} position={[3.4, ROOM_SIZE.height / 2, back - 2]} color={PALETTE.observation} />
      {COACH_DESKS.map((desk, i) => {
        const coach = coaches[i];
        const pose = coach?.pose ?? "away";
        return (
          <group key={desk.join(",")}>
            <Desk position={desk} active={pose === "typing" || pose === "thinking"} />
            {pose === "away" ? null : (
              <Figure
                position={desk}
                look={COACH_LOOKS[i % COACH_LOOKS.length] ?? COACH_LOOKS[0]}
                pose={pose}
                clock={clock}
                still={still}
                phase={i * 1.3}
                holdsCard={pose === "handing"}
              />
            )}
          </group>
        );
      })}
    </group>
  );
}

/** Contradiction noticed (signature moment): a thread from the cited record on the wall to the subject's seat. */
function Thread({ from, reducedMotion }: { from: Vec3; reducedMotion: boolean }) {
  const material = useRef<MeshBasicMaterial>(null);
  const curve = useMemo(() => {
    const to = new Vector3(SUBJECT_SEAT[0], 1.2, SUBJECT_SEAT[2]);
    const start = new Vector3(...from);
    const mid = start.clone().add(to).multiplyScalar(0.5);
    mid.y = Math.max(start.y, to.y) + 0.25;
    return new QuadraticBezierCurve3(start, mid, to);
  }, [from]);
  useGSAP(() => {
    if (material.current === null || reducedMotion) return;
    gsap.from(material.current, { opacity: 0, duration: 0.6, ease: "power2.out" });
  });
  return (
    <mesh>
      <tubeGeometry args={[curve, 40, 0.006, 6, false]} />
      <meshBasicMaterial ref={material} color={PALETTE.link} transparent opacity={0.9} />
    </mesh>
  );
}

/** Finding committed (signature moment): the seal is stamped on the case folder, on the session clock. */
function Seal({ at, clock, motionOff }: { at: number | null; clock: RefObject<number>; motionOff: boolean }) {
  const stamp = useRef<Group>(null);
  const mark = useRef<Mesh>(null);
  const timeline = useRef<gsap.core.Timeline | null>(null);
  useGSAP(
    () => {
      const s = stamp.current;
      const m = mark.current;
      if (s === null || m === null) return;
      if (at === null) {
        s.visible = false;
        return;
      }
      const tl = gsap.timeline({ paused: true });
      tl.fromTo(s.position, { y: 0.7 }, { y: 0.05, duration: 0.55, ease: "power4.in" })
        .fromTo(m.scale, { x: 0.01, y: 0.01, z: 0.01 }, { x: 1, y: 1, z: 1, duration: 0.18, ease: "back.out(3)" }, 0.55)
        .to(s.scale, { y: 0.85, duration: 0.08, yoyo: true, repeat: 1 }, 0.55)
        .to(s.position, { y: 0.8, duration: 0.6, ease: "power2.out" }, 0.9)
        .set(s, { visible: false });
      timeline.current = tl;
      return () => {
        timeline.current = null;
      };
    },
    { dependencies: [at] },
  );
  useClockTimeline(timeline, clock, at, motionOff);
  const [x, y, z] = FOLDER_SPOT;
  return (
    <group position={[x, y, z]}>
      <mesh ref={mark} position={[0.02, 0.004, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.045, 0.06, 32]} />
        <meshBasicMaterial color={PALETTE.ink} />
      </mesh>
      <group ref={stamp} position={[0.02, 0.7, 0.02]}>
        <mesh position={[0, 0.03, 0]}>
          <cylinderGeometry args={[0.06, 0.06, 0.04, 24]} />
          <meshLambertMaterial color={PALETTE.ink} />
        </mesh>
        <mesh position={[0, 0.12, 0]}>
          <cylinderGeometry args={[0.018, 0.022, 0.14, 12]} />
          <meshLambertMaterial color={PALETTE.ink} />
        </mesh>
        <mesh position={[0, 0.21, 0]}>
          <sphereGeometry args={[0.035, 16, 12]} />
          <meshLambertMaterial color={PALETTE.ink} />
        </mesh>
      </group>
    </group>
  );
}

export function Room({ world, documents, clock, still, reducedMotion }: RoomProps) {
  const flag = world?.flag ?? null;
  const highlightIndex = flag?.conflictRecord == null ? -1 : documents.findIndex((d) => d.id === flag.conflictRecord);
  return (
    <group position={ROOM}>
      <Shell />
      <Table />
      <EvidenceWall documents={documents} clock={clock} motionOff={reducedMotion} highlight={highlightIndex < 0 ? null : (flag?.conflictRecord ?? null)} />
      <Mirror />
      <ObservationRoom world={world} clock={clock} still={still} />
      <Figure position={SUBJECT_SEAT} look={SUBJECT_LOOK} pose={world?.subject.pose ?? "idle"} speech={world?.subject.speech ?? null} clock={clock} still={still} />
      {/* the case folder */}
      <mesh position={[FOLDER_SPOT[0], FOLDER_SPOT[1] - 0.002, FOLDER_SPOT[2]]}>
        <boxGeometry args={[0.3, 0.008, 0.22]} />
        <meshLambertMaterial color={PALETTE.canvasSoft2} />
        <Hairline size={[0.3, 0.008, 0.22]} />
      </mesh>
      {world?.seal == null ? null : <Seal key={world.seal.hash} at={world.seal.at} clock={clock} motionOff={reducedMotion} />}
      {highlightIndex < 0 ? null : <Thread from={evidenceSlot(highlightIndex)} reducedMotion={reducedMotion} />}
      {world === null ? null : <Pet position={PET_SPOT} pose={world.pet} noticeYaw={-2.4} />}
      <pointLight position={[0.2, 2.7, 0.4]} intensity={0.6} distance={8} decay={1.5} />
    </group>
  );
}
