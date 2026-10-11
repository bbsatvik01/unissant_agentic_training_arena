/**
 * Furniture and fixtures shared by the hub and the interview room (D-025): chairs, desks, monitors, ceiling light
 * panels, cabinets, plants, a wall clock, the interview recorder, folders, a camera, doors and windows with blinds.
 * Built from primitives with the PBR materials of `materials.ts`; every piece casts and receives shadows.
 */
import { useFrame } from "@react-three/fiber";
import { useRef, type ReactNode } from "react";
import type { Group, Mesh } from "three";

import type { Vec3 } from "../../lib/world/layout";
import { brushedSteel, emissive, oakLaminate, paint } from "./materials";

type Mat = ReturnType<typeof paint>;

interface Placed {
  readonly position: Vec3;
  readonly rotation?: number;
}

function P({ position, rotation = 0, children }: Placed & { children: ReactNode }) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      {children}
    </group>
  );
}

/** A box mesh with a material, shadowed. */
export function Block({ size, at, material, rot }: { size: Vec3; at: Vec3; material: Mat; rot?: Vec3 }) {
  return (
    <mesh position={at} rotation={(rot ?? [0, 0, 0])} material={material} castShadow receiveShadow>
      <boxGeometry args={size} />
    </mesh>
  );
}

function Leg({ at, height, radius = 0.014 }: { at: Vec3; height: number; radius?: number }) {
  return (
    <mesh position={at} material={brushedSteel()} castShadow>
      <cylinderGeometry args={[radius, radius, height, 10]} />
    </mesh>
  );
}

/** A stackable interview chair: moulded shell on a steel frame. Faces +z at rotation 0 (the seat's front is +z). */
export function Chair(props: Placed & { seat?: number }) {
  const seat = props.seat ?? 0.46;
  return (
    <P {...props}>
      <Block size={[0.46, 0.035, 0.44]} at={[0, seat, 0.02]} material={paint("chair")} />
      <Block size={[0.44, 0.42, 0.03]} at={[0, seat + 0.27, -0.2]} material={paint("chair")} rot={[-0.12, 0, 0]} />
      {[-0.2, 0.2].map((x) =>
        [-0.18, 0.2].map((z) => <Leg key={`${String(x)}${String(z)}`} at={[x, seat / 2, z]} height={seat} />),
      )}
      <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.36, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.12} depthWrite={false} />
      </mesh>
    </P>
  );
}

/** An office chair on a five-star base. */
export function OfficeChair(props: Placed) {
  return (
    <P {...props}>
      <Block size={[0.5, 0.07, 0.48]} at={[0, 0.48, 0]} material={paint("chair")} />
      <Block size={[0.48, 0.55, 0.06]} at={[0, 0.82, -0.24]} material={paint("chair")} rot={[-0.1, 0, 0]} />
      <Leg at={[0, 0.27, 0]} height={0.4} radius={0.03} />
      {[0, 1, 2, 3, 4].map((i) => (
        <Block key={i} size={[0.03, 0.03, 0.3]} at={[Math.sin((i / 5) * Math.PI * 2) * 0.15, 0.05, Math.cos((i / 5) * Math.PI * 2) * 0.15]} material={paint("rubber")} rot={[0, (i / 5) * Math.PI * 2, 0]} />
      ))}
    </P>
  );
}

/** A work desk with an oak top and steel frame. */
export function Desk(props: Placed & { width?: number; depth?: number }) {
  const w = props.width ?? 1.4;
  const d = props.depth ?? 0.7;
  return (
    <P {...props}>
      <Block size={[w, 0.035, d]} at={[0, 0.74, 0]} material={oakLaminate()} />
      <Block size={[0.04, 0.72, d - 0.06]} at={[-w / 2 + 0.05, 0.36, 0]} material={paint("frame")} />
      <Block size={[0.04, 0.72, d - 0.06]} at={[w / 2 - 0.05, 0.36, 0]} material={paint("frame")} />
      <Block size={[w - 0.12, 0.3, 0.02]} at={[0, 0.55, -d / 2 + 0.04]} material={paint("frame")} />
    </P>
  );
}

/** A monitor on a stand; `lit` shows its screen glowing (practical light for bloom). Faces +z. */
export function Monitor(props: Placed & { lit: boolean; width?: number }) {
  const w = props.width ?? 0.56;
  return (
    <P {...props}>
      <Block size={[w, w * 0.6, 0.03]} at={[0, 0.25, 0]} material={paint("monitor")} />
      <mesh position={[0, 0.25, 0.0155]} material={emissive(props.lit ? "screen" : "screenDim")}>
        <planeGeometry args={[w - 0.03, w * 0.6 - 0.03]} />
      </mesh>
      <Block size={[0.04, 0.16, 0.04]} at={[0, 0.06, -0.04]} material={paint("frame")} />
      <Block size={[0.2, 0.012, 0.14]} at={[0, 0.006, -0.03]} material={paint("frame")} />
    </P>
  );
}

/** A keyboard. */
export function Keyboard(props: Placed) {
  return (
    <P {...props}>
      <Block size={[0.42, 0.018, 0.14]} at={[0, 0.009, 0]} material={paint("ink")} />
    </P>
  );
}

/** A recessed ceiling light panel (emissive face, slim frame). Hang it at the ceiling height. */
export function CeilingPanel(props: Placed & { size?: readonly [number, number] }) {
  const [w, d] = props.size ?? [1.2, 0.6];
  return (
    <P {...props}>
      <Block size={[w + 0.06, 0.03, d + 0.06]} at={[0, 0, 0]} material={paint("white")} />
      <mesh position={[0, -0.016, 0]} rotation={[Math.PI / 2, 0, 0]} material={emissive("ceiling")}>
        <planeGeometry args={[w, d]} />
      </mesh>
    </P>
  );
}

/** A four-drawer steel filing cabinet. */
export function Cabinet(props: Placed) {
  return (
    <P {...props}>
      <Block size={[0.46, 1.32, 0.6]} at={[0, 0.66, 0]} material={paint("cabinet")} />
      {[0, 1, 2, 3].map((i) => (
        <Block key={i} size={[0.16, 0.02, 0.03]} at={[0, 0.28 + i * 0.31, 0.31]} material={brushedSteel()} />
      ))}
    </P>
  );
}

/** A potted plant: a ceramic pot and a cluster of leaves. */
export function Plant(props: Placed & { height?: number }) {
  const h = props.height ?? 1.1;
  const leaves = Array.from({ length: 14 }, (_, i) => i);
  return (
    <P {...props}>
      <mesh position={[0, 0.18, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.18, 0.14, 0.36, 20]} />
        <meshStandardMaterial color="#e8e4dc" roughness={0.6} />
      </mesh>
      {leaves.map((i) => {
        const a = (i / leaves.length) * Math.PI * 2 * 2.3;
        const r = 0.05 + (i % 4) * 0.035;
        const y = 0.4 + (i / leaves.length) * (h - 0.45);
        return (
          <mesh key={i} position={[Math.cos(a) * r, y, Math.sin(a) * r]} rotation={[0.6 - (i % 3) * 0.25, a, 0.4]} castShadow>
            <sphereGeometry args={[0.11, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color={i % 2 === 0 ? "#3f6b46" : "#4d7d52"} roughness={0.7} side={2} />
          </mesh>
        );
      })}
    </P>
  );
}

/** A wall clock whose hands follow the local time (decorative; still under reduced motion). Faces +z. */
export function WallClock(props: Placed & { still: boolean }) {
  const minute = useRef<Mesh>(null);
  const hour = useRef<Mesh>(null);
  useFrame(() => {
    const d = new Date();
    const m = d.getMinutes() + d.getSeconds() / 60;
    if (minute.current !== null) minute.current.rotation.z = -(m / 60) * Math.PI * 2;
    if (hour.current !== null) hour.current.rotation.z = -(((d.getHours() % 12) + m / 60) / 12) * Math.PI * 2;
  });
  return (
    <P {...props}>
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.16, 0.03, 32]} />
        <meshStandardMaterial color="#f7f7f5" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0, 0.016]}>
        <torusGeometry args={[0.16, 0.012, 8, 40]} />
        <meshStandardMaterial color="#2a2b2e" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh ref={minute} position={[0, 0, 0.02]}>
        <boxGeometry args={[0.006, 0.12, 0.003]} />
        <meshStandardMaterial color="#1c1c1e" />
      </mesh>
      <mesh ref={hour} position={[0, 0, 0.022]}>
        <boxGeometry args={[0.01, 0.08, 0.003]} />
        <meshStandardMaterial color="#1c1c1e" />
      </mesh>
    </P>
  );
}

/** The interview recorder: a small black unit with a red recording light (bloom picks it up). */
export function Recorder(props: Placed) {
  return (
    <P {...props}>
      <Block size={[0.16, 0.035, 0.1]} at={[0, 0.0175, 0]} material={paint("ink")} />
      <mesh position={[0.055, 0.036, 0.03]} material={emissive("led")}>
        <sphereGeometry args={[0.005, 8, 6]} />
      </mesh>
      <Block size={[0.07, 0.004, 0.05]} at={[-0.025, 0.036, 0]} material={brushedSteel()} />
    </P>
  );
}

/** A stack of manila folders. */
export function FolderStack(props: Placed & { count?: number }) {
  const n = props.count ?? 3;
  return (
    <P {...props}>
      {Array.from({ length: n }, (_, i) => (
        <mesh key={i} position={[(i % 2) * 0.012, 0.006 + i * 0.012, -i * 0.008]} rotation={[0, (i - 1) * 0.06, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.31, 0.01, 0.235]} />
          <meshStandardMaterial color={i % 2 === 0 ? "#d9c08f" : "#cfb47e"} roughness={0.85} />
        </mesh>
      ))}
    </P>
  );
}

/** A paper cup. */
export function Cup(props: Placed) {
  return (
    <P {...props}>
      <mesh position={[0, 0.05, 0]} castShadow>
        <cylinderGeometry args={[0.038, 0.03, 0.1, 18, 1, true]} />
        <meshStandardMaterial color="#f3f1ec" roughness={0.7} side={2} />
      </mesh>
    </P>
  );
}

/** A ceiling-mounted security camera on a short arm. */
export function SecurityCamera(props: Placed) {
  return (
    <P {...props}>
      <Block size={[0.05, 0.12, 0.05]} at={[0, -0.06, 0]} material={paint("white")} />
      <Block size={[0.09, 0.08, 0.2]} at={[0, -0.14, 0.08]} material={paint("white")} rot={[0.35, 0, 0]} />
      <mesh position={[0, -0.17, 0.18]} rotation={[0.35 + Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.025, 0.025, 0.01, 16]} />
        <meshStandardMaterial color="#0d0d0f" roughness={0.1} metalness={0.4} />
      </mesh>
    </P>
  );
}

/** A door in a frame; `open` swings it inward by that many radians. Faces +z. */
export function Door(props: Placed & { open?: number; width?: number; height?: number; window?: boolean }) {
  const w = props.width ?? 0.95;
  const h = props.height ?? 2.1;
  const leaf = useRef<Group>(null);
  return (
    <P {...props}>
      <Block size={[0.05, h + 0.05, 0.12]} at={[-w / 2 - 0.025, h / 2, 0]} material={paint("frame")} />
      <Block size={[0.05, h + 0.05, 0.12]} at={[w / 2 + 0.025, h / 2, 0]} material={paint("frame")} />
      <Block size={[w + 0.1, 0.05, 0.12]} at={[0, h + 0.025, 0]} material={paint("frame")} />
      <group ref={leaf} position={[-w / 2, 0, 0]} rotation={[0, -(props.open ?? 0), 0]}>
        <Block size={[w, h, 0.04]} at={[w / 2, h / 2, 0]} material={paint("door")} />
        {props.window === true ? (
          <mesh position={[w / 2, h * 0.68, 0.021]}>
            <planeGeometry args={[w * 0.35, h * 0.3]} />
            <meshStandardMaterial color="#9fb0c0" roughness={0.05} metalness={0.2} />
          </mesh>
        ) : null}
        <Block size={[0.14, 0.02, 0.05]} at={[w - 0.1, h * 0.48, 0.04]} material={brushedSteel()} />
      </group>
    </P>
  );
}

/** A window with daylight behind horizontal blinds. Faces +z (into the room). */
export function BlindWindow(props: Placed & { width: number; height: number }) {
  const { width: w, height: h } = props;
  const slats = Math.round(h / 0.05);
  return (
    <P {...props}>
      <mesh position={[0, 0, -0.06]} material={emissive("daylight")}>
        <planeGeometry args={[w, h]} />
      </mesh>
      {Array.from({ length: slats }, (_, i) => (
        <mesh key={i} position={[0, h / 2 - (i + 0.5) * (h / slats), 0]} rotation={[0.9, 0, 0]} castShadow>
          <boxGeometry args={[w, 0.042, 0.002]} />
          <meshStandardMaterial color="#ecebe7" roughness={0.6} />
        </mesh>
      ))}
      <Block size={[w + 0.08, 0.05, 0.1]} at={[0, -h / 2 - 0.025, 0]} material={paint("white")} />
      <Block size={[w + 0.08, 0.05, 0.1]} at={[0, h / 2 + 0.025, 0]} material={paint("white")} />
    </P>
  );
}
