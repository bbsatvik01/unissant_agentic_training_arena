/**
 * The signature moments that happen on the evidence wall and the table (D-020): records flying onto the wall and
 * pinning themselves, the thread from a conflicting record to the subject's seat, the seal stamped on the case folder.
 * Paper flights and the seal run on the session clock (pause, speed and scrub move them).
 */
import { useGSAP } from "@gsap/react";
import { useFrame } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { QuadraticBezierCurve3, Vector3, type Group, type Mesh, type MeshBasicMaterial } from "three";

import { EVIDENCE_WALL, evidenceSlot, FOLDER_SPOT, SUBJECT_SEAT, TABLE, type Vec3 } from "../../lib/world/layout";
import { PALETTE } from "../../lib/world/palette";
import { brushedSteel } from "./materials";
import { paperTexture, scoreCardTexture } from "./textures";

gsap.registerPlugin(useGSAP);

export interface WallDocument {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  /** When it was released on the session clock; null for a document on file from the start. */
  readonly releasedAt: number | null;
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
          <meshStandardMaterial map={texture} roughness={0.92} />
        </mesh>
        {highlighted ? (
          <mesh position={[0, 0, -0.002]}>
            <planeGeometry args={[0.4, 0.52]} />
            <meshBasicMaterial color={PALETTE.link} />
          </mesh>
        ) : null}
        <mesh ref={pin} position={[0, 0.2, 0.012]}>
          <sphereGeometry args={[0.014, 10, 8]} />
          <meshStandardMaterial color={PALETTE.ink} roughness={0.45} />
        </mesh>
      </group>
    </group>
  );
}

export function EvidenceWall({ documents, clock, motionOff, highlight }: { documents: readonly WallDocument[]; clock: RefObject<number>; motionOff: boolean; highlight: string | null }) {
  const [cx, cy, cz] = EVIDENCE_WALL.center;
  return (
    <group>
      {/* a whiteboard in a brushed-steel frame */}
      <mesh position={[cx, cy, cz]} receiveShadow>
        <boxGeometry args={[EVIDENCE_WALL.width + 0.25, EVIDENCE_WALL.height + 0.25, 0.02]} />
        <meshStandardMaterial color="#f4f4f2" roughness={0.25} metalness={0} />
      </mesh>
      {[1, -1].map((side) => (
        <mesh key={`h${String(side)}`} position={[cx, cy + side * (EVIDENCE_WALL.height / 2 + 0.135), cz + 0.012]} material={brushedSteel()}>
          <boxGeometry args={[EVIDENCE_WALL.width + 0.3, 0.025, 0.035]} />
        </mesh>
      ))}
      {[1, -1].map((side) => (
        <mesh key={`v${String(side)}`} position={[cx + side * (EVIDENCE_WALL.width / 2 + 0.14), cy, cz + 0.012]} material={brushedSteel()}>
          <boxGeometry args={[0.025, EVIDENCE_WALL.height + 0.3, 0.035]} />
        </mesh>
      ))}
      <mesh position={[cx, cy - EVIDENCE_WALL.height / 2 - 0.17, cz + 0.04]} material={brushedSteel()}>
        <boxGeometry args={[EVIDENCE_WALL.width * 0.6, 0.02, 0.06]} />
      </mesh>
      {documents.map((doc, i) => (
        <Paper key={doc.id} slot={evidenceSlot(i)} doc={doc} clock={clock} motionOff={motionOff} highlighted={doc.id === highlight} />
      ))}
    </group>
  );
}

/** Contradiction noticed (signature moment): a thread from the cited record on the wall to the subject's seat. */
export function Thread({ from, reducedMotion }: { from: Vec3; reducedMotion: boolean }) {
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
export function Seal({ at, clock, motionOff }: { at: number | null; clock: RefObject<number>; motionOff: boolean }) {
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
          <meshStandardMaterial color={PALETTE.ink} roughness={0.45} />
        </mesh>
        <mesh position={[0, 0.12, 0]}>
          <cylinderGeometry args={[0.018, 0.022, 0.14, 12]} />
          <meshStandardMaterial color={PALETTE.ink} roughness={0.45} />
        </mesh>
        <mesh position={[0, 0.21, 0]}>
          <sphereGeometry args={[0.035, 16, 12]} />
          <meshStandardMaterial color={PALETTE.ink} roughness={0.45} />
        </mesh>
      </group>
    </group>
  );
}


export interface ScoreCard {
  readonly label: string;
  readonly title: string;
  readonly score: string;
}

function ScorePin({ card, at, index, motionOff }: { card: ScoreCard; at: Vec3; index: number; motionOff: boolean }) {
  const group = useRef<Group>(null);
  const texture = useMemo(() => scoreCardTexture(card.label, card.title, card.score), [card.label, card.title, card.score]);
  useEffect(() => () => {
    texture.dispose();
  }, [texture]);
  useGSAP(() => {
    const g = group.current;
    if (g === null || motionOff) return;
    gsap.from(g.position, { y: TABLE.center[1] + 0.3, z: TABLE.center[2], x: TABLE.center[0], duration: 1.0, delay: 0.35 + index * 0.22, ease: "power3.out" });
    gsap.from(g.rotation, { x: -1.2, z: 0.4, duration: 1.0, delay: 0.35 + index * 0.22, ease: "power3.out" });
    gsap.from(g.scale, { x: 0.4, y: 0.4, z: 0.4, duration: 0.6, delay: 0.35 + index * 0.22, ease: "power2.out" });
  });
  return (
    <group ref={group} position={at}>
      <mesh castShadow>
        <boxGeometry args={[0.6, 0.4, 0.006]} />
        <meshStandardMaterial map={texture} roughness={0.8} />
      </mesh>
      <mesh position={[0, 0.17, 0.006]}>
        <sphereGeometry args={[0.016, 10, 8]} />
        <meshStandardMaterial color={PALETTE.ink} roughness={0.45} />
      </mesh>
    </group>
  );
}

/** The debrief scene's board: the total and the five dimension scores pin themselves over the evidence wall. */
export function DebriefBoard({ cards, motionOff }: { cards: readonly ScoreCard[]; motionOff: boolean }) {
  const [cx, cy, cz] = EVIDENCE_WALL.center;
  return (
    <group>
      {cards.map((card, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        return <ScorePin key={card.label} card={card} index={i} motionOff={motionOff} at={[cx - 0.7 + col * 0.7, cy + 0.3 - row * 0.5, cz + 0.06]} />;
      })}
    </group>
  );
}
