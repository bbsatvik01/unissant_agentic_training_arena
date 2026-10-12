/**
 * The coach companion (S6 6.3, 03-ui-direction 1.1): a small tuxedo cat on the table (Quaternius "Animal Pack
 * Vol.2", CC0; `public/pets/LICENSE.md`), posed by `petStateFor` through the world state, the same state machine as
 * before. Its idle clip breathes; the states add a lean toward the investigator (listening), a slow head sway
 * (thinking), a turn and small hop toward the wall and the mirror (noticing), a nod (encouraging), a hop
 * (celebrating) and a curled-down rest (sleeping). Its states show the session's work, never anyone's demeanor; it
 * has no sad or impatient pose. With motion off it holds each pose still. Decorative: the caption carries its state
 * in words.
 */
import { useFrame, useLoader } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { AnimationMixer, Bone, Mesh, Quaternion, type Group, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

import type { PetPose } from "../../lib/companion/fsm";
import type { Vec3 } from "../../lib/world/layout";

interface PetProps {
  readonly position: Vec3;
  readonly pose: PetPose;
  /** Yaw the companion turns to when it notices something (toward the evidence wall and mirror). */
  readonly noticeYaw: number;
  /** The session clock in ms: one-shots play on it, so playback pause and speed carry them. */
  readonly clock: RefObject<number>;
}

const URL = "/pets/cat.glb";
/** The model is in centimetres-ish units and faces +x: scale it to a small cat and turn it to face +z. */
const SCALE = 0.00055;
const FACE_Z = -Math.PI / 2;

function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * Math.min(1, rate * dt);
}

export function Pet({ position, pose, noticeYaw, clock }: PetProps) {
  const gltf = useLoader(GLTFLoader, URL);
  const scene = useMemo(() => {
    const root = cloneSkinned(gltf.scene);
    root.traverse((o: Object3D) => {
      if (o instanceof Mesh) {
        const m = o as Mesh;
        m.castShadow = true;
        m.frustumCulled = false;
      }
    });
    return root;
  }, [gltf]);
  const mixer = useMemo(() => new AnimationMixer(scene), [scene]);
  const bones = useMemo(() => {
    const find = (n: string) => {
      const o = scene.getObjectByName(n);
      return o instanceof Bone ? (o as Bone) : null;
    };
    return { head: find("Bone003"), tail: find("Bone005") };
  }, [scene]);
  useEffect(() => {
    const idle = gltf.animations.find((a) => a.name === "Idle");
    if (idle !== undefined) mixer.clipAction(idle).play();
    return () => {
      mixer.stopAllAction();
    };
  }, [gltf, mixer]);

  const body = useRef<Group>(null);
  const base = useRef(new Map<Bone, Quaternion>());
  const started = useRef({ state: pose.state, at: 0 });
  const live = useRef({ mixer, bones, pose, noticeYaw, clock });
  useEffect(() => {
    live.current = { mixer, bones, pose, noticeYaw, clock };
  });

  useFrame((frame, delta) => {
    const { mixer: mx, bones: b, pose: p, noticeYaw: notice, clock: c } = live.current;
    const animate = p.motion !== "still";
    // Restore the clip's pose before advancing it, so the head and tail additions below never accumulate.
    for (const [bone, q] of base.current) bone.quaternion.copy(q);
    mx.update(animate && p.state !== "sleeping" ? Math.min(delta, 0.1) : 0);
    for (const bone of [b.head, b.tail]) {
      if (bone === null) continue;
      const q = base.current.get(bone);
      if (q === undefined) base.current.set(bone, bone.quaternion.clone());
      else q.copy(bone.quaternion);
    }
    const t = frame.clock.elapsedTime;
    if (started.current.state !== p.state) started.current = { state: p.state, at: c.current };
    const since = (c.current - started.current.at) / 1000;
    const dt = animate ? delta : 1;
    const g = body.current;
    if (g === null) return;
    let y = 0;
    let yaw = -0.5;
    let pitch = 0;
    let headPitch = 0;
    let headYaw = 0;
    let crouch = 1;
    switch (p.state) {
      case "idle":
        break;
      case "listening":
        yaw = -0.15;
        headPitch = 0.15;
        break;
      case "thinking":
        headYaw = animate ? Math.sin(t * 1.3) * 0.3 : 0.2;
        headPitch = -0.2;
        break;
      case "noticing":
        yaw = notice;
        y = animate ? Math.max(0, Math.sin(Math.min(since, 0.5) * Math.PI * 2)) * 0.03 : 0;
        break;
      case "encouraging":
        headPitch = animate && since < 1.2 ? Math.sin(since * Math.PI * 3.3) * 0.35 : 0.15;
        break;
      case "celebrating":
        y = animate && since < 0.8 ? Math.sin((since / 0.8) * Math.PI) * 0.06 : 0;
        break;
      case "sleeping":
        crouch = 0.7;
        headPitch = 0.45;
        pitch = 0.05;
        break;
    }
    g.position.y = approach(g.position.y, y, animate ? 30 : 1, dt);
    g.rotation.y = approach(g.rotation.y, yaw, 6, dt);
    g.rotation.x = approach(g.rotation.x, pitch, 8, dt);
    g.scale.y = approach(g.scale.y, crouch, 6, dt);
    // The head and tail bones add to the clip's pose each frame (the clip rewrites them first).
    if (b.head !== null) {
      b.head.rotation.z += headPitch;
      b.head.rotation.y += headYaw;
    }
    if (b.tail !== null && animate && (p.state === "encouraging" || p.state === "celebrating")) b.tail.rotation.x += Math.sin(t * 9) * 0.35;
  });

  return (
    <group position={position}>
      <mesh position={[0, 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.1, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.12} depthWrite={false} />
      </mesh>
      <group ref={body}>
        <primitive object={scene} scale={SCALE} rotation={[0, FACE_Z, 0]} />
      </group>
    </group>
  );
}
