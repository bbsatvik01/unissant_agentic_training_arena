import { navigatedPrecinctManifest } from "../../lib/precinct/knownWorldNavigation";
import { planNavigationRoute } from "../../lib/precinct/worldNavigation";
import { precinctAsset, precinctPointerFloor } from "../../lib/precinct/worldVariant";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { ACESFilmicToneMapping, Group, Light, Mesh, PerspectiveCamera, PMREMGenerator, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { controllerDeadzone, EYE_HEIGHT, hasLineOfSight, inputMovement, isWalkable, MAX_FRAME_SECONDS, moveWithCollisions, nearestHotspot, PLAYER_RADIUS, turn, WALK_SPEED } from "../../lib/precinct/movement";
import { adjustInspectionCamera, createInspectionCamera, inspectionView, stepInspectionCamera, type InspectionCamera } from "../../lib/precinct/inspectionCamera";
import { moveWithPeople, type CrowdState } from "../../lib/precinct/crowdNavigation";
import { advanceStaffCrowd, createStaffCrowd, staffCrowdPeople } from "../../lib/precinct/staffCrowd";
import { advanceCadence } from "../../lib/precinct/cadence";
import { interviewCamera, INVESTIGATOR_SEAT } from "../../lib/precinct/interviewStage";
import { seatedNavigation, type ExplorationPose } from "../../lib/precinct/seatedNavigation";
import type { WorkStyle } from "../../lib/agent-work/model";
import type { CameraMode, LookAngles, Vec3 } from "../../lib/precinct/types";
import type { ActorCapture, ReplayCamera } from "../../lib/precinct/proceduralActors";
import type { WalkingTravel } from "../../lib/precinct/proceduralWalkingV1";
import { isWorldEvent, type InputData, type PoseData } from "../../lib/world/worldEvents";
import { reviewerForSceneV2, withheldObservationActorsV2 } from "../../lib/precinct/proceduralReviewerV2";
import { PrecinctReviewPanel, ReviewPanelChairV2 } from "./PrecinctReviewPanel";
import { PrecinctActorReplay } from "./PrecinctActorReplay";
import { applyRecordedCameraV1 } from "./recordedCameraV1";
import { nextTier, WINDOW, type Tier } from "../../lib/world/quality";
import { WalkingAvatar } from "./WalkingAvatar";
import { PrecinctStaff } from "./PrecinctStaff";
import { StaffSpeechFrameInvalidation } from "./StaffSpeechFrameInvalidation";
import { localStaffPlaybackActivity, staffSpeechNeedsFrames } from "../../lib/precinct/localStaffPlaybackActivity";
import { PrecinctInterviewCast } from "./PrecinctInterviewCast";
import { ObservationWorkScreens } from "./ObservationWorkScreens";
import { PresentedEvidencePaper } from "./PresentedEvidencePaper";
import { PrecinctBoardSurfaces } from "./PrecinctBoardSurfaces";
import { ObservationGlazing } from "./ObservationGlazing";
import { DebriefWallScreen } from "./DebriefWallScreen";
import type { BoardSurfaceModel } from "../../lib/precinct/boardSurfaces";
import type { DebriefWall } from "../../lib/precinct/debriefWall";
import type { PrecinctCameraSample, PrecinctInterviewScene } from "./interviewScene";
import type { PlayerPose, PrecinctManifest, TravelCommand } from "./sceneTypes";

export interface PrecinctCanvasProps {
  /** Narrow public snapshots. Source and publication gates remain route-owned. */
  readonly boardSurfaces?: BoardSurfaceModel | null;
  readonly debriefWall?: DebriefWall | null;
  readonly manifest: PrecinctManifest;
  /** Validated v1 playback retains its original graph behavior. V2 is captured-root driven. */
  readonly legacyReplay?: boolean;
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
  readonly actorCapture?: ActorCapture;
  /** Existing frame loop only. Advance a route-owned local capture clock before actual samples. */
  readonly onBeforeFrame?: (deltaSeconds: number) => void;
  /** Only accepted controls from the existing handlers, never native form/dialog text input. */
  readonly onControlInput?: (sample: Extract<InputData, { readonly action: "key" | "click" }>) => void;
  /** Undefined is live. An explicit map, including an empty map, owns all actor display. */
  readonly replayActors?: ReadonlyMap<string, PoseData>;
  readonly replayCamera?: ReplayCamera;
}

const SPAWN: Vec3 = [0, 0, -2.4];
const CONTROL_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyQ", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

function uiTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest("input,textarea,select,button,a,[contenteditable]:not([contenteditable=false]),[role=dialog],[role=slider],[role=textbox]") !== null;
}

type ControlInputCallback = NonNullable<PrecinctCanvasProps["onControlInput"]>;
function releaseControls(keys: Set<string>, owners: Map<string, ControlInputCallback>, emit: boolean): void {
  if (emit) for (const key of keys) owners.get(key)?.({ action: "key", key, pressed: false });
  keys.clear(); owners.clear();
}

function connectedGamepad(): Gamepad | null {
  try {
    return navigator.getGamepads().find((pad) => pad !== null && pad.connected) ?? null;
  } catch {
    // The API can be unavailable or disabled by the browser's permissions policy.
    return null;
  }
}

function Architecture({ asset, onReady }: { readonly asset: string; readonly onReady: () => void }) {
  const invalidate = useThree((state) => state.invalidate);
  const gltf = useLoader(GLTFLoader, asset, (loader) => {
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

export function Controls(props: PrecinctCanvasProps & { readonly crowd?: RefObject<CrowdState> }) {
  const pointerFloor = precinctPointerFloor(props.manifest);
  const canvas = useThree((state) => state.gl.domElement);
  const position = useRef<Vec3>(SPAWN);
  const look = useRef<LookAngles>({ yaw: 0, pitch: 0 });
  const inspection = useRef<InspectionCamera | null>(null);
  const savedExploration = useRef<ExplorationPose | null>(null);
  const replayActive = props.replayActors !== undefined;
  const freeInspection = replayActive ? props.replayCamera?.ownership === "free" : props.paused && props.cameraMode === "free";
  const seated = props.interview?.present === true && props.interview.seated;
  const drag = useRef<readonly [number, number] | null>(null);
  const keys = useRef(new Set<string>());
  const keyOwners = useRef(new Map<string, ControlInputCallback>());
  const path = useRef<readonly Vec3[]>([]);
  const routeIndex = useRef(0);
  const arrivalYaw = useRef<number | null>(null);
  const manualLook = useRef(0);
  const lastEmit = useRef(0);
  const emittedPose = useRef<PlayerPose | null>(null);
  const nearest = useRef<string | null>(null);
  const walking = useRef<Group>(null);
  const speed = useRef(0);
  const bodyTravel = useRef<WalkingTravel>({ distance: 0, speed: 0 });
  const replaying = useRef(false);
  const lastButton = useRef(false);
  const live = useRef(props);
  const focus = useMemo(() => new Vector3(), []);
  useEffect(() => { live.current = props; }, [props]);

  useEffect(() => {
    const previousTabIndex = canvas.getAttribute("tabindex");
    canvas.setAttribute("tabindex", "0");
    const isSeated = () => live.current.interview?.present === true && live.current.interview.seated;
    const inReplay = () => live.current.replayActors !== undefined;
    const free = () => inReplay() ? live.current.replayCamera?.ownership === "free" : live.current.paused && live.current.cameraMode === "free";
    const canControl = () => live.current.active && !document.hidden && document.hasFocus() && !uiTarget(document.activeElement) && (inReplay() ? free() : !live.current.paused || free());
    const clear = () => { releaseControls(keys.current, keyOwners.current, live.current.replayActors === undefined); path.current = []; drag.current = null; };
    const keydown = (event: KeyboardEvent) => {
      if (event.code === "Escape") { clear(); return; }
      if (!canControl() || uiTarget(event.target) || !CONTROL_KEYS.has(event.code)) return;
      if (event.code.startsWith("Arrow")) event.preventDefault();
      if ((isSeated() || event.code === "KeyQ") && !free()) return;
      if (!keys.current.has(event.code) && !inReplay() && !free()) {
        const callback = live.current.onControlInput;
        if (callback !== undefined) { keyOwners.current.set(event.code, callback); callback({ action: "key", key: event.code, pressed: true }); }
      }
      keys.current.add(event.code);
      if (!inReplay() && !free() && event.code === "KeyE" && !event.repeat && !live.current.paused && nearest.current !== null) live.current.onInteract(nearest.current);
    };
    const keyup = (event: KeyboardEvent) => {
      if (keys.current.delete(event.code) && !inReplay()) keyOwners.current.get(event.code)?.({ action: "key", key: event.code, pressed: false });
      keyOwners.current.delete(event.code);
    };
    const mouse = (event: MouseEvent) => {
      if (!canControl()) return;
      if (free() && drag.current !== null) {
        const [x, y] = drag.current;
        if (inspection.current !== null) inspection.current = adjustInspectionCamera(inspection.current, -(event.clientX - x) * 0.006, (event.clientY - y) * 0.006, 0);
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
        live.current.onControlInput?.({ action: "click", target: "precinct:look", button: event.button });
        try { void Promise.resolve(canvas.requestPointerLock()).catch(() => { /* Arrow keys remain available. */ }); }
        catch { /* Pointer lock is optional; keyboard and click navigation still work. */ }
      }
    };
    const up = () => { drag.current = null; };
    const wheel = (event: WheelEvent) => {
      if (!canControl() || !free()) return;
      event.preventDefault();
      if (inspection.current !== null) inspection.current = adjustInspectionCamera(inspection.current, 0, 0, event.deltaY * 0.006);
    };
    const context = (event: Event) => { if (canControl()) event.preventDefault(); };
    const focusIn = (event: FocusEvent) => { if (uiTarget(event.target)) clear(); };
    const visibility = () => { if (document.hidden) clear(); };
    const lockChange = () => { if (document.pointerLockElement !== canvas) releaseControls(keys.current, keyOwners.current, live.current.replayActors === undefined); };
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
    if (!props.active || props.paused || seated || replayActive) {
      releaseControls(keys.current, keyOwners.current, live.current.replayActors === undefined); path.current = []; drag.current = null;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    if (props.active && (!props.paused || props.cameraMode === "free") && !uiTarget(document.activeElement)) canvas.focus({ preventScroll: true });
  }, [props.active, props.paused, props.cameraMode, replayActive, freeInspection, seated, canvas]);

  useFrame((state, dt) => {
    const camera = state.camera;
    const p = live.current;
    p.onBeforeFrame?.(Number.isFinite(dt) ? Math.max(0, dt) : 0);
    const seconds = Number.isFinite(dt) ? Math.max(0, Math.min(dt, MAX_FRAME_SECONDS)) : 0;
    const replay = p.replayActors !== undefined;
    const pad = connectedGamepad();
    // The sole camera writer owns inspection too; no live navigation or canonical clock is mutated.
    const applyInspection = () => {
      inspection.current ??= createInspectionCamera(camera.position.toArray(), camera.getWorldDirection(new Vector3()).toArray());
      if (p.active && !document.hidden && document.hasFocus() && !uiTarget(document.activeElement)) {
        let forward = Number(keys.current.has("KeyW")) - Number(keys.current.has("KeyS"));
        let strafe = Number(keys.current.has("KeyD")) - Number(keys.current.has("KeyA"));
        let vertical = Number(keys.current.has("KeyE")) - Number(keys.current.has("KeyQ"));
        let yaw = Number(keys.current.has("ArrowLeft")) - Number(keys.current.has("ArrowRight"));
        let pitch = Number(keys.current.has("ArrowUp")) - Number(keys.current.has("ArrowDown"));
        let sprint = keys.current.has("ShiftLeft") || keys.current.has("ShiftRight");
        if (pad !== null) {
          const [x, y] = controllerDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
          const [rx, ry] = controllerDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
          forward -= y; strafe += x; yaw -= rx; pitch -= ry;
          vertical += Number(pad.buttons[5]?.pressed ?? false) - Number(pad.buttons[4]?.pressed ?? false);
          sprint ||= pad.buttons[10]?.pressed ?? false;
        }
        inspection.current = stepInspectionCamera(inspection.current, { forward, strafe, vertical, yaw, pitch, sprint }, dt);
      }
      const view = inspectionView(inspection.current);
      camera.position.set(...view.position); camera.lookAt(...view.target);
    };
    if (replay !== replaying.current) {
      releaseControls(keys.current, keyOwners.current, live.current.replayActors === undefined); path.current = []; routeIndex.current = 0; arrivalYaw.current = null;
      drag.current = null; speed.current = 0; bodyTravel.current = { distance: 0, speed: 0 };
      p.travel.current = null; nearest.current = null; inspection.current = null;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      replaying.current = replay;
    }
    if (replay) {
      // Existing Controls remains the only camera writer. Replay never executes recorded input.
      p.travel.current = null;
      lastButton.current = pad?.buttons[0]?.pressed ?? false;
      const override = p.replayCamera;
      const freeView = override?.ownership === "free";
      const sample = override?.sample;
      const validSample = sample != null && isWorldEvent({ t_ms: 0, kind: "camera", data: sample });
      if (!freeView) {
        inspection.current = null;
        if (validSample) applyRecordedCameraV1(camera, sample);
        return;
      }
      applyInspection();
      return;
    }
    const isSeated = p.interview?.present === true && p.interview.seated;
    const transition = seatedNavigation(savedExploration.current, { position: position.current, look: look.current }, isSeated);
    savedExploration.current = transition.saved;
    if (transition.changed) {
      position.current = transition.pose.position; look.current = transition.pose.look;
      releaseControls(keys.current, keyOwners.current, live.current.replayActors === undefined); path.current = []; routeIndex.current = 0; arrivalYaw.current = null;
      drag.current = null; speed.current = 0; manualLook.current = 0; nearest.current = null;
      p.travel.current = null; inspection.current = null; emittedPose.current = null;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    // Commands queued while a seated interview owns input cannot execute on exit.
    if (isSeated) p.travel.current = null;
    const free = p.paused && p.cameraMode === "free";
    const mode = p.cameraMode === "free" && !free ? "first" : p.cameraMode;
    const canWalk = !isSeated && p.active && !p.paused && !document.hidden && document.hasFocus() && !uiTarget(document.activeElement);
    if (!free) inspection.current = null;
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
        path.current = planNavigationRoute(position.current, command.position, p.manifest, p.manifest.playerNavigationMesh) ?? [];
        arrivalYaw.current = command.yaw;
      }
    }

    let forward = 0; let strafe = 0;
    let sprint = false;
    const pressed = pad?.buttons[0]?.pressed ?? false;
    if (canWalk) {
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
      look.current = turn(look.current, yawInput * seconds * 1.7, pitchInput * seconds * 1.3);
      if (yawInput !== 0 || pitchInput !== 0) manualLook.current = 1.5;
      if (pressed && !lastButton.current && nearest.current !== null) p.onInteract(nearest.current);
    }
    // Latch even while paused/focused, so a held button cannot fire upon resuming.
    lastButton.current = pressed;
    const before = position.current;
    const people = p.crowd === undefined ? [] : staffCrowdPeople(p.crowd.current);
    if (canWalk && (forward !== 0 || strafe !== 0)) {
      path.current = []; arrivalYaw.current = null;
      position.current = moveWithPeople(before, inputMovement(forward, strafe, look.current.yaw, sprint, seconds), p.manifest.colliders, people, PLAYER_RADIUS);
    } else if (canWalk) {
      const target = path.current[routeIndex.current];
      if (target !== undefined) {
        const dx = target[0] - before[0]; const dz = target[2] - before[2]; const distance = Math.hypot(dx, dz);
        if (distance > 0.00001) {
          const length = Math.min(distance, WALK_SPEED * seconds);
          position.current = moveWithPeople(before, [dx / distance * length, 0, dz / distance * length], p.manifest.colliders, people, PLAYER_RADIUS);
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
    bodyTravel.current = { distance: canWalk ? Math.hypot(position.current[0] - before[0], position.current[2] - before[2]) : 0, speed: speed.current };
    if (p.crowd !== undefined) p.crowd.current = advanceStaffCrowd(p.crowd.current, p.manifest, {
      tier: p.tier, delta: seconds, paused: p.paused || !p.active || document.hidden, reducedMotion: p.reducedMotion,
      replay: false, playerPosition: isSeated ? INVESTIGATOR_SEAT.position : position.current,
    });
    const [x, y, z] = position.current;
    focus.set(x, y + EYE_HEIGHT, z);
    const anchor = isSeated && !free ? interviewCamera(p.cameraMode, p.paused) : null;
    if (anchor !== null) {
      camera.position.set(...anchor.position); focus.set(...anchor.target); camera.lookAt(focus);
    } else if (free) {
      applyInspection();
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
    if (!free && camera instanceof PerspectiveCamera && camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    if (walking.current !== null) { walking.current.position.set(x, y, z); walking.current.rotation.y = look.current.yaw; }
    const visibleHotspots = p.manifest.hotspots.filter((hotspot) => hasLineOfSight(position.current, [hotspot.position[0], y, hotspot.position[2]], p.manifest.colliders, 0.02));
    nearest.current = isSeated ? null : nearestHotspot(position.current, visibleHotspots)?.id ?? null;
    // R3F resets its absolute clock when switching demand/always. A delta cadence
    // keeps minimap and input state responsive immediately after closing a panel.
    const emission = advanceCadence(lastEmit.current, dt);
    lastEmit.current = emission.elapsed;
    if (emission.due || transition.changed) {
      if (!free && p.onCameraSample !== undefined && camera instanceof PerspectiveCamera) {
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
  }, -2);

  const bodyVisible = props.replayActors === undefined && !seated && (props.cameraMode === "third" || (props.cameraMode === "free" && props.paused));
  return <>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={pointerFloor.center} onPointerDown={(event) => {
      if (props.replayActors !== undefined || seated || !props.active || props.paused || event.button !== 0 || document.pointerLockElement === canvas) return;
      canvas.focus({ preventScroll: true });
      props.onControlInput?.({ action: "click", target: "precinct:floor", button: event.button });
      const destination: Vec3 = [event.point.x, 0, event.point.z];
      path.current = planNavigationRoute(position.current, destination, props.manifest, props.manifest.playerNavigationMesh) ?? [];
      routeIndex.current = 0; arrivalYaw.current = null;
    }}>
      <planeGeometry args={[...pointerFloor.size]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
    {props.replayActors === undefined && !seated && (bodyVisible || props.actorCapture !== undefined) ? <group ref={walking} visible={bodyVisible}>
      <Suspense fallback={null}><WalkingAvatar travel={bodyTravel} still={props.paused || !props.active || props.reducedMotion} {...(props.actorCapture === undefined ? {} : { actorCapture: props.actorCapture })} /></Suspense>
    </group> : null}
  </>;
}

export default function PrecinctCanvas(props: PrecinctCanvasProps) {
  const crowd = useRef(createStaffCrowd(props.tier));
  const playingStaffAudio = useSyncExternalStore(localStaffPlaybackActivity.subscribe, localStaffPlaybackActivity.getSnapshot, localStaffPlaybackActivity.getServerSnapshot);
  const interview = props.interview;
  // Append runtime chair/person collision after the route selects its world manifest.
  const navigationContext = props.replayActors !== undefined ? "sampled-replay" : props.legacyReplay === true ? "legacy-replay" : "live";
  const sceneManifest = useMemo(() => navigatedPrecinctManifest(props.manifest, navigationContext), [props.manifest, navigationContext]);
  const assessment = interview?.work.assessment === true || interview?.cast?.mode === "assessment";
  const reviewer = reviewerForSceneV2(interview?.reviewer, interview?.assessmentActive === true, assessment);
  const withheldActors = withheldObservationActorsV2(interview?.reviewer, interview?.assessmentActive === true, assessment);
  const replay = props.replayActors !== undefined;
  const actorCapture = !replay && props.actorCapture !== undefined ? { actorCapture: props.actorCapture } : {};
  const recordedCamera = props.replayCamera?.sample;
  const hiddenActors = new Set<string>();
  if (props.replayCamera?.ownership === "recorded" && recordedCamera?.mode === "first") {
    for (const id of ["investigator:walking", "investigator:seated"]) {
      const actor = props.replayActors?.get(id);
      if (actor !== undefined && Math.hypot(recordedCamera.position[0] - actor.position[0], recordedCamera.position[2] - actor.position[2]) < 0.6) hiddenActors.add(id);
    }
  }
  const sceneMoving = interview?.present === true && !props.paused && !interview.work.paused && !props.reducedMotion;
  const staffSpeechMoving = staffSpeechNeedsFrames(playingStaffAudio, props.paused, props.reducedMotion, replay);
  return <Canvas frameloop={replay || (props.active && (!props.paused || props.cameraMode === "free")) || sceneMoving || staffSpeechMoving ? "always" : "demand"} tabIndex={0} camera={{ position: [0, EYE_HEIGHT, -2.4], fov: 66, near: 0.08, far: 120 }} dpr={props.tier === "high" ? [1, 1.75] : props.tier === "medium" ? [1, 1.25] : 0.75} gl={{ antialias: false, powerPreference: "high-performance", toneMapping: ACESFilmicToneMapping, toneMappingExposure: 1.1 }} aria-label={interview?.present === true && interview.seated ? "Seated interview. Use the interview controls to ask or leave. Paused free camera: WASD pans, Q/E lowers/raises, arrows or drag orbit, wheel zooms, Shift moves faster." : "Explorable precinct. WASD walks, arrows look, E interacts. Paused free inspection: WASD pans, Q/E lowers/raises, arrows or drag orbit, wheel zooms, Shift moves faster."}>
    <StaffSpeechFrameInvalidation moving={staffSpeechMoving} />
    <color attach="background" args={["#d5dfe0"]} /><fog attach="fog" args={["#d5dfe0", 55, 100]} />
    <AdaptiveQuality tier={props.tier} onChange={props.onTierChange} /><Environment /><hemisphereLight args={["#f8f6ee", "#70797b", 1.6]} />
    <directionalLight position={[-12, 16, 6]} intensity={3} color="#fff1d5" />
    <pointLight position={[0, 3, -6]} intensity={45} distance={18} color="#ffe5c2" />
    {props.tier !== "low" ? <><pointLight position={[0, 3, -17]} intensity={25} distance={15} color="#f3eddf" /><pointLight position={[0, 3, -29]} intensity={25} distance={15} color="#f3eddf" /></> : null}
    <Suspense fallback={null}><Architecture asset={precinctAsset(props.manifest)} onReady={props.onReady} /></Suspense>
    <ObservationGlazing />
    <ReviewPanelChairV2 />
    {props.boardSurfaces == null ? null : <PrecinctBoardSurfaces model={props.boardSurfaces} interactive={props.active && !props.paused && !replay} onOpen={props.onInteract} />}
    {props.debriefWall == null ? null : <DebriefWallScreen model={props.debriefWall} interactive={props.active && !props.paused && !replay} onOpen={() => { props.onInteract("debrief_replay"); }} />}
    {props.replayActors === undefined ? <PrecinctStaff crowd={crowd} paused={props.paused || !props.active} speechPaused={props.paused} reducedMotion={props.reducedMotion} tier={props.tier} {...actorCapture} />
      : <PrecinctActorReplay actors={props.replayActors} tier={props.tier} hiddenActors={hiddenActors} withheldActors={withheldActors} />}
    {interview?.present === true ? <>
      {replay ? null : <PrecinctInterviewCast {...actorCapture} state={interview.cast} subjectName={interview.subjectName} clock={interview.clock} paused={props.paused || interview.work.paused} reducedMotion={props.reducedMotion} tier={props.tier} view={interview.seated ? props.cameraMode : "third"} present investigatorPresent={interview.seated} location={interview.location} />}
      {replay ? null : <PrecinctReviewPanel {...actorCapture} lifecycle={reviewer} clock={interview.clock} still={props.paused || interview.work.paused || props.reducedMotion} tier={props.tier} />}
      <ObservationWorkScreens frame={interview.work} assessment={interview.cast?.mode === "assessment"} tier={props.tier} interactive={props.active && !replay} {...(props.onExpandMonitor === undefined ? {} : { onExpand: props.onExpandMonitor })} />
      {interview.evidence == null ? null : <PresentedEvidencePaper source={interview.evidence} interactive={props.active && !replay} {...(props.onInspectEvidence === undefined ? {} : { onInspect: props.onInspectEvidence })} />}
    </> : null}
    <Controls {...props} manifest={sceneManifest} crowd={crowd} />
  </Canvas>;
}
