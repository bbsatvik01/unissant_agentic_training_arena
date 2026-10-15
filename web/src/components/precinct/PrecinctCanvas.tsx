import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ACESFilmicToneMapping, Group, Light, Mesh, PerspectiveCamera, PMREMGenerator, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { controllerDeadzone, EYE_HEIGHT, findWaypointRoute, hasLineOfSight, inputMovement, isWalkable, MAX_FRAME_SECONDS, moveWithCollisions, nearestHotspot, turn, WALK_SPEED } from "../../lib/precinct/movement";
import { advanceCadence } from "../../lib/precinct/cadence";
import { interviewCamera, INVESTIGATOR_SEAT } from "../../lib/precinct/interviewStage";
import { seatedNavigation, type ExplorationPose } from "../../lib/precinct/seatedNavigation";
import type { WorkStyle } from "../../lib/agent-work/model";
import type { CameraMode, LookAngles, Vec3 } from "../../lib/precinct/types";
import { INVESTIGATOR } from "../../lib/world/cast";
import { nextTier, WINDOW, type Tier } from "../../lib/world/quality";
import { WalkingAvatar } from "./WalkingAvatar";
import { PrecinctStaff } from "./PrecinctStaff";
import { PrecinctInterviewCast } from "./PrecinctInterviewCast";
import { ObservationWorkScreens } from "./ObservationWorkScreens";
import { PresentedEvidencePaper } from "./PresentedEvidencePaper";
import type { PrecinctCameraSample, PrecinctInterviewScene } from "./interviewScene";
import type { PlayerPose, PrecinctManifest, TravelCommand } from "./sceneTypes";

export interface PrecinctCanvasProps {
  readonly manifest: PrecinctManifest;
  readonly active: boolean;
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly cameraMode: CameraMode;
  readonly tier: Tier;
  readonly onTierChange: (tier: Tier) => void;
  readonly travel: RefObject<TravelCommand | null>;
  readonly onPose: (pose: PlayerPose) => void;
  readonly onInteract: (id: string) => void;
  readonly onReady: () => void;
  readonly interview?: PrecinctInterviewScene | null;
  readonly onInspectEvidence?: () => void;
  readonly onExpandMonitor?: (style: WorkStyle) => void;
  /** Actual camera samples only; the parent owns any recording and canonical timestamps. */
  readonly onCameraSample?: (sample: PrecinctCameraSample) => void;
}

const SPAWN: Vec3 = [0, 0, -2.4];
const CONTROL_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function uiTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input,textarea,select,button,a,[contenteditable]:not([contenteditable=false]),[role=dialog],[role=slider],[role=textbox]") !== null;
}

function connectedGamepad(): Gamepad | null {
  try {
    return navigator.getGamepads().find((pad) => pad !== null && pad.connected) ?? null;
  } catch {
    // The API can be unavailable or disabled by the browser's permissions policy.
    return null;
  }
}

function Architecture({ onReady }: { readonly onReady: () => void }) {
  const invalidate = useThree((state) => state.invalidate);
  const gltf = useLoader(GLTFLoader, "/world/precinct.glb", (loader) => {
    loader.setMeshoptDecoder(MeshoptDecoder);
  });
  const scene = useMemo(() => {
    const copy = gltf.scene.clone(true);
    copy.traverse((object) => {
      if (object instanceof Mesh) { object.castShadow = false; object.receiveShadow = true; }
      if (object instanceof Light) object.visible = false;
    });
    return copy;
  }, [gltf.scene]);
  const rendered = useRef(false);
  const ready = useRef(false);
  useFrame(() => {
    // Frame callbacks run before rendering. Wait for the following frame so the loaded scene
    // has actually appeared, rather than declaring readiness in its mount effect.
    if (rendered.current && !ready.current) { ready.current = true; onReady(); }
    rendered.current = true;
    if (!ready.current) invalidate();
  });
  return <primitive object={scene} dispose={null} />;
}

function Environment() {
  const get = useThree((state) => state.get);
  useEffect(() => {
    const { gl, scene } = get();
    const previous = scene.environment;
    const intensity = scene.environmentIntensity;
    const pmrem = new PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const target = pmrem.fromScene(room, 0.04);
    scene.environment = target.texture;
    scene.environmentIntensity = 0.45;
    return () => {
      scene.environment = previous; scene.environmentIntensity = intensity;
      target.dispose(); room.dispose(); pmrem.dispose();
    };
  }, [get]);
  return null;
}

/** Lower rendering cost before changing the world or its controls. */
function AdaptiveQuality({ tier, onChange }: { readonly tier: Tier; readonly onChange: (tier: Tier) => void }) {
  const get = useThree((state) => state.get);
  const intervals = useRef<number[]>([]);
  useEffect(() => {
    const context = get().gl.getContext();
    const debug = context.getExtension("WEBGL_debug_renderer_info");
    const renderer: unknown = debug === null ? "" : context.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    if (typeof renderer === "string" && /swiftshader|llvmpipe|software/i.test(renderer) && tier !== "low") onChange("low");
  }, [get, onChange, tier]);
  useFrame((_state, delta) => {
    if (tier === "low") return;
    intervals.current.push(delta * 1000);
    if (intervals.current.length >= WINDOW) {
      const next = nextTier(tier, intervals.current);
      intervals.current = [];
      if (next !== tier) onChange(next);
    }
  });
  return null;
}

/** The existing avatar accepts a numeric speed. Sample changed speed at 10 Hz, never every frame. */
function MovingBody({ speed, still }: { readonly speed: RefObject<number>; readonly still: boolean }) {
  const [sample, setSample] = useState(0);
  const last = useRef({ elapsed: 0, speed: 0 });
  useFrame((_frame, delta) => {
    const value = still ? 0 : speed.current;
    const previous = last.current;
    const stopped = value === 0 && previous.speed !== 0;
    const cadence = advanceCadence(previous.elapsed, delta);
    last.current.elapsed = cadence.elapsed;
    if ((stopped || cadence.due) && Math.abs(value - previous.speed) > 0.025) {
      last.current = { elapsed: 0, speed: value };
      setSample(value);
    }
  });
  return <WalkingAvatar persona={INVESTIGATOR} position={[0, 0, 0]} yaw={0} speed={sample} still={still} />;
}

export function Controls(props: PrecinctCanvasProps) {
  const canvas = useThree((state) => state.gl.domElement);
  const position = useRef<Vec3>(SPAWN);
  const look = useRef<LookAngles>({ yaw: 0, pitch: 0 });
  const orbit = useRef({ yaw: 0, pitch: 0.22, distance: 3.2 });
  const wasFree = useRef(false);
  const savedExploration = useRef<ExplorationPose | null>(null);
  const seated = props.interview?.present === true && props.interview.seated;
  const drag = useRef<readonly [number, number] | null>(null);
  const keys = useRef(new Set<string>());
  const path = useRef<readonly Vec3[]>([]);
  const routeIndex = useRef(0);
  const arrivalYaw = useRef<number | null>(null);
  const manualLook = useRef(0);
  const lastEmit = useRef(0);
  const emittedPose = useRef<PlayerPose | null>(null);
  const nearest = useRef<string | null>(null);
  const walking = useRef<Group>(null);
  const speed = useRef(0);
  const lastButton = useRef(false);
  const live = useRef(props);
  const focus = useMemo(() => new Vector3(), []);
  useEffect(() => { live.current = props; }, [props]);

  useEffect(() => {
    const previousTabIndex = canvas.getAttribute("tabindex");
    canvas.setAttribute("tabindex", "0");
    const isSeated = () => live.current.interview?.present === true && live.current.interview.seated;
    const free = () => live.current.paused && live.current.cameraMode === "free";
    const canControl = () => live.current.active && (!live.current.paused || free());
    const clear = () => { keys.current.clear(); path.current = []; drag.current = null; };
    const keydown = (event: KeyboardEvent) => {
      if (event.code === "Escape") { clear(); return; }
      if (!canControl() || uiTarget(event.target) || !CONTROL_KEYS.has(event.code)) return;
      if (event.code.startsWith("Arrow")) event.preventDefault();
      if (isSeated() && !free()) return;
      keys.current.add(event.code);
      if (event.code === "KeyE" && !event.repeat && !live.current.paused && nearest.current !== null) live.current.onInteract(nearest.current);
    };
    const keyup = (event: KeyboardEvent) => { keys.current.delete(event.code); };
    const mouse = (event: MouseEvent) => {
      if (!canControl()) return;
      if (free() && drag.current !== null) {
        const [x, y] = drag.current;
        orbit.current.yaw -= (event.clientX - x) * 0.006;
        orbit.current.pitch = Math.max(-0.25, Math.min(1.1, orbit.current.pitch + (event.clientY - y) * 0.006));
        drag.current = [event.clientX, event.clientY];
      } else if (!isSeated() && !live.current.paused && document.pointerLockElement === canvas) {
        look.current = turn(look.current, -event.movementX * 0.002, -event.movementY * 0.002);
        manualLook.current = 1.5;
      }
    };
    const down = (event: MouseEvent) => {
      if (!canControl()) return;
      canvas.focus({ preventScroll: true });
      if (free()) {
        if (event.button === 0 || event.button === 2) { drag.current = [event.clientX, event.clientY]; event.preventDefault(); }
      } else if (!isSeated() && event.button === 2) {
        event.preventDefault();
        try { void Promise.resolve(canvas.requestPointerLock()).catch(() => { /* Arrow keys remain available. */ }); }
        catch { /* Pointer lock is optional; keyboard and click navigation still work. */ }
      }
    };
    const up = () => { drag.current = null; };
    const wheel = (event: WheelEvent) => {
      if (!canControl() || !free()) return;
      event.preventDefault();
      orbit.current.distance = Math.max(0.8, Math.min(12, orbit.current.distance + event.deltaY * 0.006));
    };
    const context = (event: Event) => { if (canControl()) event.preventDefault(); };
    const focusIn = (event: FocusEvent) => { if (uiTarget(event.target)) clear(); };
    const visibility = () => { if (document.hidden) clear(); };
    const lockChange = () => { if (document.pointerLockElement !== canvas) keys.current.clear(); };
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", clear);
    document.addEventListener("mousemove", mouse); window.addEventListener("mouseup", up); document.addEventListener("focusin", focusIn);
    document.addEventListener("visibilitychange", visibility); document.addEventListener("pointerlockchange", lockChange);
    canvas.addEventListener("mousedown", down); canvas.addEventListener("contextmenu", context); canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      if (previousTabIndex === null) canvas.removeAttribute("tabindex");
      else canvas.setAttribute("tabindex", previousTabIndex);
      window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", clear);
      document.removeEventListener("mousemove", mouse); window.removeEventListener("mouseup", up); document.removeEventListener("focusin", focusIn);
      document.removeEventListener("visibilitychange", visibility); document.removeEventListener("pointerlockchange", lockChange);
      canvas.removeEventListener("mousedown", down); canvas.removeEventListener("contextmenu", context); canvas.removeEventListener("wheel", wheel);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
  }, [canvas]);

  useEffect(() => {
    if (!props.active || props.paused || seated) {
      keys.current.clear(); path.current = []; drag.current = null;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    if (props.active && (!props.paused || props.cameraMode === "free") && !uiTarget(document.activeElement)) canvas.focus({ preventScroll: true });
  }, [props.active, props.paused, props.cameraMode, seated, canvas]);

  useFrame((state, dt) => {
    const camera = state.camera;
    const p = live.current;
    const seconds = Number.isFinite(dt) ? Math.max(0, Math.min(dt, MAX_FRAME_SECONDS)) : 0;
    const isSeated = p.interview?.present === true && p.interview.seated;
    const transition = seatedNavigation(savedExploration.current, { position: position.current, look: look.current }, isSeated);
    savedExploration.current = transition.saved;
    if (transition.changed) {
      position.current = transition.pose.position; look.current = transition.pose.look;
      keys.current.clear(); path.current = []; routeIndex.current = 0; arrivalYaw.current = null;
      drag.current = null; speed.current = 0; manualLook.current = 0; nearest.current = null;
      p.travel.current = null; wasFree.current = false; emittedPose.current = null;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    // Commands queued while a seated interview owns input cannot execute on exit.
    if (isSeated) p.travel.current = null;
    const free = p.paused && p.cameraMode === "free";
    const mode = p.cameraMode === "free" && !free ? "first" : p.cameraMode;
    const canWalk = !isSeated && p.active && !p.paused && !document.hidden && document.hasFocus() && !uiTarget(document.activeElement);
    const canInspect = p.active && free && !document.hidden && document.hasFocus() && !uiTarget(document.activeElement);
    if (free && !wasFree.current) orbit.current = { yaw: isSeated ? 0 : look.current.yaw, pitch: 0.22, distance: isSeated ? 2.5 : 3.2 };
    wasFree.current = free;
    manualLook.current = Math.max(0, manualLook.current - seconds);

    // Paused or modal exploration never consumes commands or moves the trainee.
    const command = p.travel.current;
    if (command !== null && !isSeated && p.active && !p.paused) {
      p.travel.current = null;
      canvas.focus({ preventScroll: true });
      routeIndex.current = 0;
      if (command.instant && isWalkable(command.position, p.manifest.colliders)) {
        position.current = command.position; look.current = { yaw: command.yaw, pitch: 0 }; path.current = []; arrivalYaw.current = null;
      } else {
        path.current = findWaypointRoute(position.current, command.position, p.manifest.navigationNodes, p.manifest.colliders) ?? [];
        arrivalYaw.current = command.yaw;
      }
    }

    let forward = 0; let strafe = 0;
    let sprint = false;
    const pad = connectedGamepad();
    const pressed = pad?.buttons[0]?.pressed ?? false;
    if (canWalk || canInspect) {
      forward = Number(keys.current.has("KeyW")) - Number(keys.current.has("KeyS"));
      strafe = Number(keys.current.has("KeyD")) - Number(keys.current.has("KeyA"));
      let yawInput = Number(keys.current.has("ArrowLeft")) - Number(keys.current.has("ArrowRight"));
      let pitchInput = Number(keys.current.has("ArrowUp")) - Number(keys.current.has("ArrowDown"));
      sprint = keys.current.has("ShiftLeft") || keys.current.has("ShiftRight");
      if (pad !== null) {
        const [x, y] = controllerDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
        const [rx, ry] = controllerDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
        forward -= y; strafe += x; yawInput -= rx; pitchInput -= ry;
        sprint ||= pad.buttons[10]?.pressed ?? false;
      }
      if (canWalk) {
        look.current = turn(look.current, yawInput * seconds * 1.7, pitchInput * seconds * 1.3);
        if (yawInput !== 0 || pitchInput !== 0) manualLook.current = 1.5;
        if (pressed && !lastButton.current && nearest.current !== null) p.onInteract(nearest.current);
      } else {
        orbit.current.yaw += (yawInput - strafe) * seconds * 1.7;
        orbit.current.pitch = Math.max(-0.25, Math.min(1.1, orbit.current.pitch + pitchInput * seconds * 1.3));
        orbit.current.distance = Math.max(0.8, Math.min(12, orbit.current.distance - forward * seconds * 3));
      }
    }
    // Latch even while paused/focused, so a held button cannot fire upon resuming.
    lastButton.current = pressed;
    const before = position.current;
    if (canWalk && (forward !== 0 || strafe !== 0)) {
      path.current = []; arrivalYaw.current = null;
      position.current = moveWithCollisions(before, inputMovement(forward, strafe, look.current.yaw, sprint, seconds), p.manifest.colliders);
    } else if (canWalk) {
      const target = path.current[routeIndex.current];
      if (target !== undefined) {
        const dx = target[0] - before[0]; const dz = target[2] - before[2]; const distance = Math.hypot(dx, dz);
        if (distance > 0.00001) {
          const length = Math.min(distance, WALK_SPEED * seconds);
          position.current = moveWithCollisions(before, [dx / distance * length, 0, dz / distance * length], p.manifest.colliders);
          if (!p.reducedMotion && manualLook.current === 0) look.current = { ...look.current, yaw: Math.atan2(-dx, -dz) };
          if (length > 0 && Math.hypot(position.current[0] - before[0], position.current[2] - before[2]) < 0.000001) path.current = [];
        }
        if (Math.hypot(target[0] - position.current[0], target[2] - position.current[2]) < 0.0001) {
          routeIndex.current += 1;
          if (routeIndex.current >= path.current.length && arrivalYaw.current !== null) {
            look.current = { ...look.current, yaw: arrivalYaw.current }; arrivalYaw.current = null;
          }
        }
      }
    }
    speed.current = canWalk && seconds > 0 ? Math.hypot(position.current[0] - before[0], position.current[2] - before[2]) / seconds : 0;
    const [x, y, z] = position.current;
    focus.set(x, y + EYE_HEIGHT, z);
    const anchor = isSeated ? interviewCamera(p.cameraMode, p.paused, orbit.current) : null;
    if (anchor !== null) {
      camera.position.set(...anchor.position); focus.set(...anchor.target); camera.lookAt(focus);
    } else if (free) {
      const angle = orbit.current;
      const distance = angle.distance * Math.cos(angle.pitch);
      const safe = moveWithCollisions(position.current, [Math.sin(angle.yaw) * distance, 0, Math.cos(angle.yaw) * distance], p.manifest.colliders, 0.15);
      camera.position.set(safe[0], Math.max(y + 0.45, Math.min(y + 2.85, y + EYE_HEIGHT + Math.sin(angle.pitch) * angle.distance)), safe[2]);
      camera.lookAt(focus);
    } else if (mode === "third") {
      const offset: Vec3 = [Math.sin(look.current.yaw) * 2.8, 0, Math.cos(look.current.yaw) * 2.8];
      const safe = moveWithCollisions(position.current, offset, p.manifest.colliders, 0.15);
      camera.position.set(safe[0], y + 2.15, safe[2]);
      const pitch = look.current.pitch;
      focus.add(new Vector3(-Math.sin(look.current.yaw) * Math.cos(pitch) * 2, Math.sin(pitch) * 2 - 0.08, -Math.cos(look.current.yaw) * Math.cos(pitch) * 2));
      camera.lookAt(focus);
    } else {
      camera.position.set(x, y + EYE_HEIGHT, z); camera.rotation.set(look.current.pitch, look.current.yaw, 0, "YXZ");
    }
    const fov = anchor?.fov ?? (mode === "first" ? 66 : 58);
    if (camera instanceof PerspectiveCamera && camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    if (walking.current !== null) { walking.current.position.set(x, y, z); walking.current.rotation.y = look.current.yaw; }
    const visibleHotspots = p.manifest.hotspots.filter((hotspot) => hasLineOfSight(position.current, [hotspot.position[0], y, hotspot.position[2]], p.manifest.colliders, 0.02));
    nearest.current = isSeated ? null : nearestHotspot(position.current, visibleHotspots)?.id ?? null;
    // R3F resets its absolute clock when switching demand/always. A delta cadence
    // keeps minimap and input state responsive immediately after closing a panel.
    const emission = advanceCadence(lastEmit.current, dt);
    lastEmit.current = emission.elapsed;
    if (emission.due || transition.changed) {
      if (p.onCameraSample !== undefined && camera instanceof PerspectiveCamera) {
        const quaternion = camera.quaternion.clone().normalize();
        p.onCameraSample({ mode: anchor?.mode ?? mode, position: camera.position.toArray(), quaternion: quaternion.toArray(), fov: camera.fov });
      }
      const shownPosition = isSeated ? INVESTIGATOR_SEAT.position : position.current;
      const shownYaw = isSeated ? 0 : look.current.yaw;
      const previous = emittedPose.current;
      if (previous === null || previous.position !== shownPosition || previous.yaw !== shownYaw || Math.abs(previous.speed - speed.current) > 0.01 || previous.hotspot !== nearest.current) {
        const next = { position: shownPosition, yaw: shownYaw, speed: speed.current, hotspot: nearest.current };
        emittedPose.current = next;
        p.onPose(next);
      }
    }
  });

  const bodyVisible = !seated && (props.cameraMode === "third" || (props.cameraMode === "free" && props.paused));
  return <>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, -18]} onPointerDown={(event) => {
      if (seated || !props.active || props.paused || event.button !== 0 || document.pointerLockElement === canvas) return;
      canvas.focus({ preventScroll: true });
      const destination: Vec3 = [event.point.x, 0, event.point.z];
      path.current = findWaypointRoute(position.current, destination, props.manifest.navigationNodes, props.manifest.colliders) ?? [];
      routeIndex.current = 0; arrivalYaw.current = null;
    }}>
      <planeGeometry args={[28, 36]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
    {bodyVisible ? <group ref={walking}><Suspense fallback={null}><MovingBody speed={speed} still={props.paused || !props.active || props.reducedMotion} /></Suspense></group> : null}
  </>;
}

export default function PrecinctCanvas(props: PrecinctCanvasProps) {
  const interview = props.interview;
  const sceneMoving = interview?.present === true && !props.paused && !interview.work.paused && !props.reducedMotion;
  return <Canvas frameloop={(props.active && (!props.paused || props.cameraMode === "free")) || sceneMoving ? "always" : "demand"} tabIndex={0} camera={{ position: [0, EYE_HEIGHT, -2.4], fov: 66, near: 0.08, far: 120 }} dpr={props.tier === "high" ? [1, 1.75] : props.tier === "medium" ? [1, 1.25] : 0.75} gl={{ antialias: false, powerPreference: "high-performance", toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1.1 }} aria-label={interview?.present === true && interview.seated ? "Seated interview. Use the interview controls to ask or leave. While paused in free camera: drag or arrows orbit, wheel or W/S zoom." : "Explorable precinct. WASD walks, arrows look, E interacts. Paused inspection: drag or arrows orbit, wheel or W/S zoom."}>
    <color attach="background" args={["#d5dfe0"]} /><fog attach="fog" args={["#d5dfe0", 55, 100]} />
    <AdaptiveQuality tier={props.tier} onChange={props.onTierChange} /><Environment /><hemisphereLight args={["#f8f6ee", "#70797b", 1.6]} />
    <directionalLight position={[-12, 16, 6]} intensity={3} color="#fff1d5" />
    <pointLight position={[0, 3, -6]} intensity={45} distance={18} color="#ffe5c2" />
    {props.tier !== "low" ? <><pointLight position={[0, 3, -17]} intensity={25} distance={15} color="#f3eddf" /><pointLight position={[0, 3, -29]} intensity={25} distance={15} color="#f3eddf" /></> : null}
    <Suspense fallback={null}><Architecture onReady={props.onReady} /></Suspense>
    <PrecinctStaff paused={props.paused || !props.active} reducedMotion={props.reducedMotion} tier={props.tier} />
    {interview?.present === true ? <>
      <PrecinctInterviewCast state={interview.cast} subjectName={interview.subjectName} clock={interview.clock} paused={props.paused || interview.work.paused} reducedMotion={props.reducedMotion} tier={props.tier} view={interview.seated ? props.cameraMode : "third"} present location={interview.location} />
      <ObservationWorkScreens frame={interview.work} assessment={interview.cast?.mode === "assessment"} tier={props.tier} interactive={props.active} {...(props.onExpandMonitor === undefined ? {} : { onExpand: props.onExpandMonitor })} />
      {interview.evidence == null ? null : <PresentedEvidencePaper source={interview.evidence} interactive={props.active} {...(props.onInspectEvidence === undefined ? {} : { onInspect: props.onInspectEvidence })} />}
    </> : null}
    <Controls {...props} />
  </Canvas>;
}
