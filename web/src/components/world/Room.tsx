/**
 * The interview room (D-020, D-025): a believable municipal interview room. Vinyl tile floor, painted walls with
 * acoustic panels, ceiling light panels, an oak-topped table with the recorder and case folders, the subject seated
 * across from the investigator's empty chair, the evidence whiteboard where records pin themselves, and the one-way
 * mirror onto the observation room where three coaches work at their desks. Everything here is drawn from the world
 * state; nothing reads session data directly (FE-SSE-7).
 */
import { Suspense, useMemo, type RefObject } from "react";
import { Object3D } from "three";

import { COACHES, INVESTIGATOR, subjectPersona } from "../../lib/world/cast";
import {
  COACH_DESKS,
  evidenceSlot,
  FOLDER_SPOT,
  inRoom,
  INVESTIGATOR_EYES,
  INVESTIGATOR_SEAT,
  MIRROR,
  PET_SPOT,
  ROOM,
  ROOM_DOOR_X,
  ROOM_SIZE,
  SUBJECT_SEAT,
  TABLE,
  type Vec3,
} from "../../lib/world/layout";
import type { CoachPose, WorldState } from "../../lib/world/worldState";
import { Avatar } from "./Avatar";
import { acousticFabric, brushedSteel, oakLaminate, oneWayGlass, paint, plaster, vinylFloor } from "./materials";
import { EvidenceWall, Seal, Thread, type WallDocument } from "./moments";
import { Pet } from "./Pet";
import { Block, CeilingPanel, Chair, Cup, Desk, Door, FolderStack, Keyboard, Monitor, Recorder, SecurityCamera, WallClock } from "./props";

interface RoomProps {
  readonly world: WorldState | null;
  readonly documents: readonly WallDocument[];
  readonly subjectName: string;
  readonly clock: RefObject<number>;
  readonly still: boolean;
  readonly reducedMotion: boolean;
  /** The viewer can hide the companion (S6 6.3). */
  readonly showPet: boolean;
  /** Shadow map size for the quality tier, 0 for none. */
  readonly shadowMap: number;
  /** People are drawn only while the camera is in the room (they are behind walls from the hub). */
  readonly present: boolean;
}

const W = ROOM_SIZE.width;
const D = ROOM_SIZE.depth;
const H = ROOM_SIZE.height;
const BACK = -D / 2;

function Shell() {
  const mL = MIRROR.center[0] - MIRROR.width / 2;
  const mR = MIRROR.center[0] + MIRROR.width / 2;
  const mB = MIRROR.center[1] - MIRROR.height / 2;
  const mT = MIRROR.center[1] + MIRROR.height / 2;
  const doorW = 1.0;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={vinylFloor()} receiveShadow>
        <planeGeometry args={[W, D]} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, 0]} material={plaster("light")} receiveShadow>
        <planeGeometry args={[W, D]} />
      </mesh>
      {/* back wall, cut around the mirror */}
      <Block size={[mL + W / 2, H, 0.12]} at={[(-W / 2 + mL) / 2, H / 2, BACK - 0.06]} material={plaster("light")} />
      <Block size={[W / 2 - mR, H, 0.12]} at={[(mR + W / 2) / 2, H / 2, BACK - 0.06]} material={plaster("light")} />
      <Block size={[MIRROR.width, mB, 0.12]} at={[MIRROR.center[0], mB / 2, BACK - 0.06]} material={plaster("light")} />
      <Block size={[MIRROR.width, H - mT, 0.12]} at={[MIRROR.center[0], (H + mT) / 2, BACK - 0.06]} material={plaster("light")} />
      {/* side walls with acoustic panels */}
      <Block size={[0.12, H, D]} at={[-W / 2 - 0.06, H / 2, 0]} material={plaster("warm")} />
      <Block size={[0.12, H, D]} at={[W / 2 + 0.06, H / 2, 0]} material={plaster("warm")} />
      {[-1.6, 0, 1.6].map((z) => (
        <Block key={`l${String(z)}`} size={[0.05, 1.2, 1.2]} at={[-W / 2 + 0.03, 1.55, z]} material={acousticFabric()} />
      ))}
      {[-1.6, 0, 1.6].map((z) => (
        <Block key={`r${String(z)}`} size={[0.05, 1.2, 1.2]} at={[W / 2 - 0.03, 1.55, z]} material={acousticFabric()} />
      ))}
      {/* front wall with the door to the corridor */}
      <Block size={[ROOM_DOOR_X - doorW / 2 + W / 2, H, 0.12]} at={[(-W / 2 + ROOM_DOOR_X - doorW / 2) / 2, H / 2, D / 2 + 0.06]} material={plaster("light")} />
      <Block size={[W / 2 - ROOM_DOOR_X - doorW / 2, H, 0.12]} at={[(ROOM_DOOR_X + doorW / 2 + W / 2) / 2, H / 2, D / 2 + 0.06]} material={plaster("light")} />
      <Block size={[doorW, H - 2.1, 0.12]} at={[ROOM_DOOR_X, (H + 2.1) / 2, D / 2 + 0.06]} material={plaster("light")} />
      <Door position={[ROOM_DOOR_X, 0, D / 2]} rotation={Math.PI} open={-1.3} width={0.95} window />
      {/* skirting */}
      <Block size={[W, 0.1, 0.02]} at={[0, 0.05, BACK + 0.01]} material={paint("frame")} />
      <Block size={[0.02, 0.1, D]} at={[-W / 2 + 0.01, 0.05, 0]} material={paint("frame")} />
      <Block size={[0.02, 0.1, D]} at={[W / 2 - 0.01, 0.05, 0]} material={paint("frame")} />
      {/* ceiling fixtures: light panels, a vent, the camera in the corner; a clock on the side wall */}
      <CeilingPanel position={[0, H - 0.02, 0.1]} size={[1.2, 0.6]} />
      <CeilingPanel position={[-1.9, H - 0.02, -1.6]} size={[0.6, 0.6]} />
      <CeilingPanel position={[1.9, H - 0.02, 1.6]} size={[0.6, 0.6]} />
      <Block size={[0.5, 0.02, 0.3]} at={[1.6, H - 0.012, -0.6]} material={paint("white")} />
      <SecurityCamera position={[W / 2 - 0.25, H, D / 2 - 0.25]} rotation={-2.4} />
      <WallClock position={[W / 2 - 0.02, 2.3, -1.6]} rotation={-Math.PI / 2} still={false} />
    </group>
  );
}

function Table() {
  const [x, y, z] = TABLE.center;
  return (
    <group>
      <Block size={[TABLE.width, 0.04, TABLE.depth]} at={[x, y, z]} material={oakLaminate()} />
      <Block size={[TABLE.width - 0.1, 0.06, 0.03]} at={[x, y - 0.05, z - TABLE.depth / 2 + 0.06]} material={paint("frame")} />
      <Block size={[TABLE.width - 0.1, 0.06, 0.03]} at={[x, y - 0.05, z + TABLE.depth / 2 - 0.06]} material={paint("frame")} />
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${String(sx)}${String(sz)}`} position={[x + sx * (TABLE.width / 2 - 0.07), y / 2, z + sz * (TABLE.depth / 2 - 0.07)]} material={brushedSteel()} castShadow>
            <cylinderGeometry args={[0.025, 0.025, y, 12]} />
          </mesh>
        )),
      )}
      <Recorder position={[0.45, y + 0.02, -0.05]} rotation={0.3} />
      <FolderStack position={[FOLDER_SPOT[0], y + 0.02, FOLDER_SPOT[2]]} rotation={0.15} count={3} />
      <Cup position={[0.68, y + 0.02, -0.28]} />
      {/* the investigator's notepad and pen */}
      <Block size={[0.21, 0.008, 0.29]} at={[0.25, y + 0.024, 0.28]} material={paint("white")} rot={[0, -0.12, 0]} />
      <Block size={[0.008, 0.008, 0.14]} at={[0.4, y + 0.028, 0.26]} material={paint("ink")} rot={[0, 0.3, 0]} />
    </group>
  );
}

function Mirror() {
  const [x, y, z] = MIRROR.center;
  return (
    <group>
      <mesh position={[x, y, z]} material={oneWayGlass()}>
        <planeGeometry args={[MIRROR.width, MIRROR.height]} />
      </mesh>
      {[1, -1].map((s) => (
        <Block key={`h${String(s)}`} size={[MIRROR.width + 0.1, 0.05, 0.14]} at={[x, y + s * (MIRROR.height / 2 + 0.025), z]} material={brushedSteel()} />
      ))}
      {[1, -1].map((s) => (
        <Block key={`v${String(s)}`} size={[0.05, MIRROR.height + 0.1, 0.14]} at={[x + s * (MIRROR.width / 2 + 0.025), y, z]} material={brushedSteel()} />
      ))}
    </group>
  );
}

/** Where a coach looks: the monitor while working, the subject through the glass otherwise. */
function coachGaze(desk: Vec3, pose: CoachPose): Vec3 {
  if (pose === "typing" || pose === "thinking") return inRoom([desk[0], 0.98, desk[2] + 0.75]);
  return inRoom([SUBJECT_SEAT[0], 1.2, SUBJECT_SEAT[2]]);
}

function ObservationRoom({ world, clock, still, shadows }: { world: WorldState | null; clock: RefObject<number>; still: boolean; shadows: boolean }) {
  const coaches = world?.coaches ?? [];
  const depth = 3.6;
  const x0 = -0.3;
  const x1 = 3.2;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[(x0 + x1) / 2, 0.001, BACK - depth / 2]} material={vinylFloor()} receiveShadow>
        <planeGeometry args={[x1 - x0, depth]} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[(x0 + x1) / 2, H, BACK - depth / 2]} material={plaster("dim")}>
        <planeGeometry args={[x1 - x0, depth]} />
      </mesh>
      <Block size={[x1 - x0, H, 0.1]} at={[(x0 + x1) / 2, H / 2, BACK - depth]} material={plaster("dim")} />
      <Block size={[0.1, H, depth]} at={[x0, H / 2, BACK - depth / 2]} material={plaster("dim")} />
      <Block size={[0.1, H, depth]} at={[x1, H / 2, BACK - depth / 2]} material={plaster("dim")} />
      <CeilingPanel position={[1.45, H - 0.02, BACK - 2.4]} size={[1.2, 0.3]} />
      <pointLight position={[1.45, H - 0.4, BACK - 1.4]} intensity={1.4} distance={5} decay={2} color="#f3f1ea" />
      {COACH_DESKS.map((desk, i) => {
        const pose = coaches[i]?.pose ?? "away";
        const persona = COACHES[i];
        const working = pose === "typing" || pose === "thinking";
        return (
          <group key={desk.join(",")}>
            <Desk position={[desk[0], 0, desk[2] + 0.62]} width={0.9} depth={0.55} />
            <Monitor position={[desk[0], 0.76, desk[2] + 0.78]} rotation={Math.PI} lit={working} width={0.5} />
            <Keyboard position={[desk[0], 0.76, desk[2] + 0.48]} />
            <Chair position={desk} />
            {pose === "away" || persona === undefined ? null : (
              <Suspense fallback={null}>
                <Avatar persona={persona} name={persona.name} position={desk} facing={0} pose={pose} gaze={coachGaze(desk, pose)} clock={clock} still={still} shadows={shadows} />
              </Suspense>
            )}
          </group>
        );
      })}
    </group>
  );
}

export function Room({ world, documents, subjectName, clock, still, reducedMotion, showPet, shadowMap, present }: RoomProps) {
  const flag = world?.flag ?? null;
  const highlightIndex = flag?.conflictRecord == null ? -1 : documents.findIndex((d) => d.id === flag.conflictRecord);
  const shadows = shadowMap > 0;
  const persona = subjectPersona(subjectName);
  const keyTarget = useMemo(() => {
    const o = new Object3D();
    o.position.set(0, 0.6, -0.3);
    return o;
  }, []);
  return (
    <group position={ROOM}>
      <Shell />
      <Table />
      <Chair position={SUBJECT_SEAT} />
      <Chair position={INVESTIGATOR_SEAT} rotation={Math.PI} />
      <EvidenceWall documents={documents} clock={clock} motionOff={reducedMotion} highlight={highlightIndex < 0 ? null : (flag?.conflictRecord ?? null)} />
      <Mirror />
      <ObservationRoom world={present ? world : null} clock={clock} still={still} shadows={shadows} />
      {world === null || !present ? null : (
        <Suspense fallback={null}>
          {/* the investigator's own seat, seen from behind in the over-the-shoulder shot */}
          <Avatar
            persona={INVESTIGATOR}
            name="investigator"
            position={INVESTIGATOR_SEAT}
            facing={Math.PI}
            pose={world.investigator.speech === null ? "listening" : "speaking"}
            speech={world.investigator.speech}
            gaze={inRoom([SUBJECT_SEAT[0], 1.2, SUBJECT_SEAT[2]])}
            clock={clock}
            still={still}
            shadows={shadows}
          />
        </Suspense>
      )}
      {world === null || !present ? null : (
        <Suspense fallback={null}>
          <Avatar
            persona={persona}
            name={subjectName}
            position={SUBJECT_SEAT}
            facing={0}
            pose={world.subject.pose}
            speech={world.subject.speech}
            gaze={inRoom(INVESTIGATOR_EYES)}
            clock={clock}
            still={still}
            shadows={shadows}
          />
        </Suspense>
      )}
      {world?.seal == null ? null : <Seal key={world.seal.hash} at={world.seal.at} clock={clock} motionOff={reducedMotion} />}
      {highlightIndex < 0 ? null : <Thread from={evidenceSlot(highlightIndex)} reducedMotion={reducedMotion} />}
      {world === null || !showPet ? null : <Pet position={PET_SPOT} pose={world.pet} noticeYaw={-2.4} clock={clock} />}
      {/* key light from the main ceiling panel, soft-shadowed; warm fills from the corner panels */}
      <primitive object={keyTarget} />
      <spotLight
        position={[0.1, H - 0.05, 0.5]}
        target={keyTarget}
        angle={1.1}
        penumbra={0.9}
        intensity={11}
        distance={10}
        decay={2}
        castShadow={shadows}
        shadow-mapSize-width={shadowMap > 0 ? shadowMap : 512}
        shadow-mapSize-height={shadowMap > 0 ? shadowMap : 512}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        color="#fff6ea"
      />
      <pointLight position={[-1.9, H - 0.25, -1.6]} intensity={1.1} distance={5} decay={2} color="#fff4e6" />
      <pointLight position={[1.9, H - 0.25, 1.6]} intensity={1.1} distance={5} decay={2} color="#fff4e6" />
    </group>
  );
}
