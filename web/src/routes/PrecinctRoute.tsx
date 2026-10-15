import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { Link } from "react-router";
import { actualPrecinctWorld, PRECINCT_WORLDS, type KnownPrecinctWorld } from "../lib/precinct/knownWorlds";
import { navigatedPrecinctManifest } from "../lib/precinct/knownWorldNavigation";
import { PrecinctNavigationStatus } from "../components/precinct/PrecinctNavigationStatus";
import { precinctAsset, precinctMinimapFrame } from "../lib/precinct/worldVariant";
import { createSceneReadiness, reportSceneUnavailable } from "../lib/precinct/sceneReadiness";
import { selectPrecinctWorld, type PrecinctWorldId, type SceneChangeState } from "../lib/precinct/sceneSelection";
import { PrecinctWorldSelector } from "../components/precinct/PrecinctWorldSelector";
import { localStaffPlaybackActivity } from "../lib/precinct/localStaffPlaybackActivity";
import { SILENT_CAPTURE_AUDIO_REASON } from "../lib/world/captureAudioBoundary";
import { createMountedSceneContext, KNOWN_REPLAY_SCENES, recordingScene } from "../lib/world/sceneContext";
import { EX4_TEXT } from "../lib/copy/ex4";
import { usePrecinctNpcController } from "../hooks/usePrecinctNpcController";
import { useDialogGamepad } from "../hooks/useDialogGamepad";
import { usePrecinctGamepadShortcuts } from "../hooks/usePrecinctGamepadShortcuts";
import { PrecinctSpeechCaption } from "../components/precinct/PrecinctSpeechCaption";
import { ReceptionBriefingPanel } from "../components/precinct/ReceptionBriefingPanel";
import { PrecinctDeskPanel } from "../components/precinct/PrecinctDeskPanel";
import { PrecinctTrainingContent, type StationReplayRequest } from "./precinct/PrecinctTrainingContent";
import { usePrecinctStations } from "./precinct/usePrecinctStations";
import { usePrecinctBoardSurfaces } from "./precinct/usePrecinctBoardSurfaces";
import { projectDebriefWall } from "../lib/precinct/debriefWall";
import { TRAINING_STATION_PANELS, TRAINING_STATION_TITLES, trainingStationForPanel, type TrainingStationId } from "../lib/precinct/stationSources";
import type { DossierUiEvent } from "../components/precinct/DossierPanel";
import { usePrecinctSession } from "./precinct/usePrecinctSession";
import { usePrecinctNotebook } from "./precinct/usePrecinctNotebook";
import { nextCameraMode } from "../lib/precinct/movement";
import type { CameraMode, Vec3 } from "../lib/precinct/types";
import type { Tier } from "../lib/world/quality";
import { STATIONS, type PlayerPose, type TravelCommand } from "../components/precinct/sceneTypes";
import { RenderBoundary } from "../components/precinct/RenderBoundary";
import { InterviewStationPanel } from "../components/precinct/InterviewStationPanel";
import { ObservationStationPanel } from "../components/precinct/ObservationStationPanel";
import { AgentWorkMonitor } from "../components/agent-work/AgentWorkMonitor";
import { CaptureStatus } from "../components/precinct/CaptureStatus";
import { recordedEvidencePresentation } from "./precinct/recordedEvidencePresentation";
import { FreshCapturePanel } from "../components/precinct/FreshCapturePanel";
import { recordingJson } from "../lib/world/recordingFiles";
import { captureDossierNotebook } from "./precinct/captureDossierNotebook";
import { evidenceTableInputs } from "./precinct/captureEvidenceTable";
import { SessionRecordingsPanel } from "../components/precinct/SessionControlPanel";
import { ReplayTheaterPanel } from "../components/precinct/ReplayTheaterPanel";
import { RecordedWorldStatePanel } from "../components/precinct/RecordedWorldStatePanel";
import { useLocalWorldCapture } from "./precinct/useLocalWorldCapture";
import { SessionDebriefPanel } from "../components/precinct/SessionDebriefPanel";
import type { PrecinctCameraSample } from "../components/precinct/interviewScene";
import { STYLE_NAMES, type WorkStyle } from "../lib/agent-work/model";
import { publicEvidenceSource, publicEvidenceSources, type EvidenceTableAction, type PublicEvidenceRef } from "../lib/precinct/evidenceTable";
import { orientationProgress } from "../lib/precinct/orientationProgress";
import { projectReviewerV2 } from "../lib/precinct/proceduralReviewerV2";
import type { ActorCapture } from "../lib/precinct/proceduralActors";
import { projectInterviewCast } from "../lib/precinct/interviewStage";
import { canStartInterview, startPreparedInterview, type InterviewStartKind } from "../lib/precinct/interviewStart";
import { usePrecinctWorkFrame } from "./precinct/usePrecinctWorkFrame";
import { useInterviewStationUi } from "./precinct/useInterviewStationUi";
import { useOrientationHandoff } from "./precinct/useOrientationHandoff";
import { PrecinctThemeControl, type PrecinctTheme } from "../components/precinct/PrecinctThemeControl";
import "../styles/precinct.css";
import "../styles/precinct-interview-route.css";
import "../styles/precinct-replay-route.css";
import "../styles/precinct-theme.css";

const PrecinctCanvas = lazy(() => import("../components/precinct/PrecinctCanvas"));
const INITIAL_POSE: PlayerPose = { position: [0, 0, -2.4], yaw: 0, speed: 0, hotspot: null };

function Symbol({ name }: { readonly name: "compass" | "settings" | "arrow" | "close" | "map" }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.5">
    {name === "compass" ? <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></> : null}
    {name === "settings" ? <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="currentColor" /><circle cx="15" cy="17" r="2" fill="currentColor" /></> : null}
    {name === "arrow" ? <path d="M4 12h15m-6-6 6 6-6 6" /> : null}
    {name === "close" ? <path d="m6 6 12 12M6 18 18 6" /> : null}
    {name === "map" ? <><path d="m3 5 6-2 6 3 6-2v15l-6 2-6-3-6 2zM9 3v15M15 6v15" /></> : null}
  </svg>;
}

function Modal({ title, onClose, children, status, wide = false, captionTarget }: { readonly captionTarget: (target: HTMLDivElement | null) => void; readonly status: React.ReactNode; readonly title: string; readonly onClose: () => void; readonly children: React.ReactNode; readonly wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useDialogGamepad(dialog, onClose, title);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return <dialog className={`precinct-dialog${wide ? " precinct-dialog--interview" : ""}`} ref={dialog} aria-labelledby="station-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div className="precinct-dialog-title"><div><span className="precinct-kicker">INVESTIGATION TRAINING CENTER</span><h2 id="station-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close panel"><Symbol name="close" /></button></div><div className="precinct-caption-slot" ref={captionTarget} /></header>
    <p className="precinct-note">Controller: D-pad or left stick moves focus, A activates, and B goes back or closes this panel. Text entry and native pickers use the browser’s standard controls.</p>
    {status}
    {children}
  </dialog>;
}

function Minimap({ world, pose, onMap }: { readonly world: KnownPrecinctWorld; readonly pose: PlayerPose; readonly onMap: () => void }) {
  const frame = precinctMinimapFrame(world.manifest);
  return <button className="precinct-minimap" onClick={onMap} aria-label="Open precinct map and fast travel">
    <span className="map-north">N ↑</span><svg viewBox={frame.viewBox} aria-hidden="true">
      <rect {...frame.footprint} fill="#d6d8cf" rx="0.3" />
      {world.authored.rooms.map((room) => <rect key={room.id} x={room.bounds.min[0]} y={room.bounds.min[2]} width={(room.bounds.max[0] ?? 0) - (room.bounds.min[0] ?? 0)} height={(room.bounds.max[2] ?? 0) - (room.bounds.min[2] ?? 0)} fill={room.id === "corridor" || room.id === "lobby" ? "#f5f4e9" : "#aebbb5"} stroke="#f5f4e9" strokeWidth="0.25" />)}
      {STATIONS.map((station) => <circle key={station.id} cx={station.anchor[0]} cy={station.anchor[2]} r="0.35" fill="#697d72" />)}
      <g transform={`translate(${String(pose.position[0])} ${String(pose.position[2])}) rotate(${String(-pose.yaw * 180 / Math.PI)})`}><circle r="1.1" fill="#153e36" stroke="#fff" strokeWidth="0.3" /><path d="m0-1.9-.7 1h1.4z" fill="#153e36" /></g>
    </svg><span><Symbol name="map" /> PRECINCT MAP <kbd>M</kbd></span>
  </button>;
}

export type InterviewRouteEvent =
  | { readonly type: "intercom.call" | "seat.enter" | "seat.exit" }
  | { readonly type: "interview.tab"; readonly tab: string }
  | { readonly type: "evidence.table"; readonly action: EvidenceTableAction }
  | { readonly type: "question.source"; readonly source: PublicEvidenceRef; readonly question: string };
export interface InterviewEventContext {
  readonly caseId: string | null;
  readonly sessionKey: string;
  readonly t_ms: number;
}

/** Invoked only by interaction/camera callbacks, never while rendering. */
function readInterviewContext(caseId: string | null, sessionKey: string, clock: React.RefObject<number>): InterviewEventContext {
  return { caseId, sessionKey, t_ms: clock.current };
}

export interface PrecinctRouteProps {
  /** Ordered dossier events stay parent-owned. No network or automatic persistence is added here. */
  readonly onDossierUiEvent?: (event: DossierUiEvent, context: { readonly caseId: string; readonly sessionKey: string }) => void;
  /** Optional parent capture only; no global journal, storage, or network is installed here. */
  readonly onInterviewUiEvent?: (event: InterviewRouteEvent, context: InterviewEventContext) => void;
  readonly onCameraSample?: (sample: PrecinctCameraSample, context: InterviewEventContext) => void;
}

export function PrecinctRoute({ onDossierUiEvent, onInterviewUiEvent, onCameraSample }: PrecinctRouteProps = {}) {
  const [worldPreference, setWorldPreference] = useState<PrecinctWorldId>("office");
  const staffSpeechActive = useSyncExternalStore(localStaffPlaybackActivity.subscribe, localStaffPlaybackActivity.getSnapshot, localStaffPlaybackActivity.getServerSnapshot);
  const captureScene = useMemo(() => createMountedSceneContext(), []);
  const npcController = usePrecinctNpcController();
  const [checkedIn, setCheckedIn] = useState(false);
  const [briefedScope, setBriefedScope] = useState<{ readonly scope: string; readonly owner: object } | null>(null);
  const [reviewedScope, setReviewedScope] = useState<{ readonly scope: string; readonly owner: object } | null>(null);
  const [entered, setEntered] = useState(false);
  const [renderState, setRenderState] = useState<{ readonly scope: object | null; readonly flat: boolean; readonly ready: boolean }>({ scope: null, flat: false, ready: false });
  const [poseState, setPoseState] = useState<{ readonly scope: object | null; readonly pose: PlayerPose }>({ scope: null, pose: INITIAL_POSE });
  const [paused, setPaused] = useState(false);
  const [cameraState, setCameraState] = useState<{ readonly scope: object | null; readonly mode: CameraMode }>({ scope: null, mode: "first" });
  const [freshCaptureError, setFreshCaptureError] = useState<string | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const [captionTarget, setCaptionTarget] = useState<HTMLDivElement | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [replayCameraChoice, setReplayCameraChoice] = useState<{ readonly scope: string; readonly free: boolean } | null>(null);
  const [expandedMonitor, setExpandedMonitor] = useState<WorkStyle | null>(null);
  const monitorOrigin = useRef<HTMLElement | null>(null);
  const monitorReturn = useRef<WorkStyle | null>(null);
  const expandedContent = useRef<HTMLDivElement>(null);
  const observationContent = useRef<HTMLDivElement>(null);
  const deferredTravel = useRef<{ readonly command: TravelCommand; readonly hotspot: string | null } | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [largeText, setLargeText] = useState(false);
  const [theme, setTheme] = useState<PrecinctTheme>("office");
  const [contrast, setContrast] = useState(false);
  const [tier, setTier] = useState<Tier>("medium");
  const travel = useRef<TravelCommand | null>(null);
  const open = useCallback((id: string) => { setExpandedMonitor(null); setPanel(id); }, []);
  const close = useCallback(() => {
    if (expandedMonitor !== null) { monitorReturn.current = expandedMonitor; setExpandedMonitor(null); }
    else setPanel(null);
  }, [expandedMonitor]);
  const expandMonitor = useCallback((style: WorkStyle) => {
    const active = document.activeElement;
    monitorOrigin.current = active instanceof HTMLElement && active.closest("dialog") !== null ? active : null;
    setPanel("observation"); setExpandedMonitor(style);
  }, []);
  useLayoutEffect(() => {
    if (expandedMonitor !== null) { expandedContent.current?.focus({ preventScroll: true }); return; }
    const style = monitorReturn.current;
    if (style === null) return;
    const origin = monitorOrigin.current;
    const target = origin?.isConnected === true ? origin : observationContent.current?.querySelector<HTMLButtonElement>(`button[aria-label="Expand ${STYLE_NAMES[style]}"]`);
    target?.focus({ preventScroll: true }); monitorOrigin.current = null; monitorReturn.current = null;
  }, [expandedMonitor]);
  // Both authored variants keep these two protected room bounds identical. This avoids a
  // second session owner when the existing recording chooses its actual architecture below.
  const practiceRoom = [...PRECINCT_WORLDS.office.authored.rooms].reverse().find((candidate) => poseState.pose.position[0] >= (candidate.bounds.min[0] ?? 0) && poseState.pose.position[0] <= (candidate.bounds.max[0] ?? 0) && poseState.pose.position[2] >= (candidate.bounds.min[2] ?? 0) && poseState.pose.position[2] <= (candidate.bounds.max[2] ?? 0));
  const session = usePrecinctSession({ reducedMotion, paused, captureScene, audioInRoom: practiceRoom?.id === "interview" || practiceRoom?.id === "observation" });
  const recordedWorldId = recordingScene(session.recording?.scene_context)?.worldId;
  const actualWorldId = actualPrecinctWorld(worldPreference, session.source === "recording", recordedWorldId);
  const world = PRECINCT_WORLDS[actualWorldId];
  const raw = world.authored;
  const manifest = world.manifest;
  const sceneScope = useMemo(() => createSceneReadiness(actualWorldId), [actualWorldId]);
  useLayoutEffect(() => {
    sceneScope.activate();
    return () => { sceneScope.expire(); captureScene.set(null); travel.current = null; deferredTravel.current = null; };
  }, [sceneScope, captureScene]);
  const pose = poseState.scope === sceneScope ? poseState.pose : INITIAL_POSE;
  const cameraMode = cameraState.scope === sceneScope ? cameraState.mode : "first";
  const setCameraMode = useCallback((next: SetStateAction<CameraMode>) => {
    if (!sceneScope.isActive()) return;
    setCameraState((previous) => {
      const mode = previous.scope === sceneScope ? previous.mode : "first";
      return { scope: sceneScope, mode: typeof next === "function" ? next(mode) : next };
    });
  }, [sceneScope]);
  const setPose = useCallback((next: PlayerPose) => { if (sceneScope.isActive()) setPoseState({ scope: sceneScope, pose: next }); }, [sceneScope]);
  const flatView = renderState.scope === sceneScope && renderState.flat;
  const ready = renderState.scope === sceneScope && renderState.ready;
  const geometryReady = ready && !flatView;
  const sceneIdentity = KNOWN_REPLAY_SCENES.find((item) => item.worldId === actualWorldId && item.assetUrl === precinctAsset(manifest));
  const captureSceneReady = geometryReady && sceneIdentity !== undefined;
  const onReady = useCallback(() => {
    if (!sceneScope.markReady()) return;
    setRenderState({ scope: sceneScope, ready: true, flat: false });
    captureScene.set(sceneIdentity?.context ?? null);
  }, [sceneScope, sceneIdentity, captureScene]);
  const onUnavailable = useCallback(() => {
    reportSceneUnavailable(sceneScope, () => {
      captureScene.set(null);
      setRenderState({ scope: sceneScope, ready: true, flat: true });
    });
  }, [sceneScope, captureScene]);
  const resume = useCallback(() => { setPaused(false); setCameraMode((mode) => mode === "free" ? "first" : mode); }, [setCameraMode]);
  const hotspot = manifest.hotspots.find((item) => item.id === pose.hotspot);
  const room = [...raw.rooms].reverse().find((candidate) => pose.position[0] >= (candidate.bounds.min[0] ?? 0) && pose.position[0] <= (candidate.bounds.max[0] ?? 0) && pose.position[2] >= (candidate.bounds.min[2] ?? 0) && pose.position[2] <= (candidate.bounds.max[2] ?? 0));
  const localCapture = useLocalWorldCapture(session.packet, session.source, paused || session.freshCapture.state.phase === "armed" || !captureSceneReady, captureScene);
  const sceneClock = localCapture.localClock ?? session.clock;
  const capturedWorld = session.playback.capturedWorld;
  const worldReplay = session.source === "recording" && session.recording?.format === "arena.recording.v2";
  const legacyReplay = session.source === "recording" && session.recording?.format === "arena.recording.v1";
  const navigationStatus = navigatedPrecinctManifest(manifest, worldReplay ? "sampled-replay" : legacyReplay ? "legacy-replay" : "live").navigationStatus;
  const navigationFallback = navigationStatus?.context === "live" && (navigationStatus.player.mode === "graph" || navigationStatus.staff.mode === "graph");
  const freeReplayCamera = replayCameraChoice?.scope === session.sessionKey && replayCameraChoice.free;
  const controllerPause = useCallback(() => { if (paused) resume(); else setPaused(true); }, [paused, resume]);
  const controllerCamera = useCallback(() => {
    if (flatView) return;
    if (worldReplay) setReplayCameraChoice({ scope: session.sessionKey, free: !freeReplayCamera });
    else if (session.source !== "recording") setCameraMode((mode) => nextCameraMode(mode, paused));
  }, [flatView, worldReplay, session.sessionKey, session.source, freeReplayCamera, paused, setCameraMode]);
  const controllerMap = useCallback(() => { open("map"); }, [open]);
  usePrecinctGamepadShortcuts(entered && panel === null, controllerPause, controllerCamera, controllerMap);
  const freshBinding = session.freshCapture.binding;
  const captureSink = freshBinding ?? (localCapture.snapshot.status === "recording" ? localCapture.controller : null);
  const panelCapture = session.freshCapture.state.phase === "recording" ? freshBinding : localCapture.snapshot.status === "recording" ? localCapture.controller : null;
  const capturedPanel = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = capturedPanel.current; capturedPanel.current = panel;
    if (panelCapture === null) return;
    if (previous !== null && previous !== panel) panelCapture.ui({ action: "panel", panel_id: previous, open: false });
    if (panel !== null) panelCapture.ui({ action: "panel", panel_id: panel, open: true });
  }, [panel, panelCapture]);
  const exportFreshCapture = () => {
    if (session.assessmentActive) return;
    const result = session.freshCapture.exportRecording();
    if (!result.ok) { setFreshCaptureError(result.errors.join("; ")); return; }
    try {
      const text = recordingJson(result.recording);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url;
      anchor.download = result.recording.client_capture?.status === "complete" ? "arena-client-text.v2.json" : "arena-client-text-incomplete.v2.json";
      anchor.click(); URL.revokeObjectURL(url); setFreshCaptureError(null);
    } catch { setFreshCaptureError("The capture could not be exported safely. Its accepted samples remain in this tab."); }
  };
  const freshCapturePanel = <><FreshCapturePanel state={session.freshCapture.state} canArm={!staffSpeechActive && captureSceneReady && session.canStart && session.packetState === "ready" && session.source === "idle" && !session.sound}
    assessmentActive={session.assessmentActive} onArm={() => { if (localStaffPlaybackActivity.getSnapshot()) { setFreshCaptureError(SILENT_CAPTURE_AUDIO_REASON); return; } if (!captureSceneReady || !sceneScope.isReady()) { setFreshCaptureError("Wait for a verified, rendered scene before arming capture."); return; } localCapture.controller.stop(); if (!session.freshCapture.arm()) setFreshCaptureError("Choose a public packet and a new silent text run before arming."); else setFreshCaptureError(null); }}
    onStop={session.freshCapture.stop} onExport={exportFreshCapture} error={freshCaptureError} />{staffSpeechActive ? <p>{SILENT_CAPTURE_AUDIO_REASON}</p> : null}</>;
  const notebookScope = JSON.stringify([session.source === "idle" ? "browser-preparation" : session.me?.user_id ?? "browser-preparation", session.source, session.sessionKey]);
  const notebook = usePrecinctNotebook({ packet: session.packet, released: session.released, scope: notebookScope, readOnly: session.source === "recording", caseId: session.selectedCase?.case_id ?? null, source: session.source, runKey: session.source === "live" && session.live.phase === "running" ? session.sessionKey : null });
  const orientationContext = { caseId: session.selectedCase?.case_id ?? null, userId: session.me?.user_id ?? null, source: session.source, runKey: session.source === "live" && session.live.phase === "running" ? session.sessionKey : null };
  const preparationProgress = useOrientationHandoff(orientationContext);
  const preparationOwner = useMemo(() => ({ userId: orientationContext.userId, caseId: orientationContext.caseId }), [orientationContext.userId, orientationContext.caseId]);
  const briefingScope = JSON.stringify([orientationContext.userId, notebookScope]);
  const reviewScope = JSON.stringify([orientationContext.userId, notebook.key]);
  const briefed = session.selectedCase !== null && ((briefedScope?.scope === briefingScope && briefedScope.owner === preparationOwner) || preparationProgress.offer?.briefed === true);
  const fileReviewed = !notebook.readOnly && (preparationProgress.offer?.fileReviewed === true || (session.packet !== null && reviewedScope?.scope === reviewScope && reviewedScope.owner === preparationOwner));
  const interviewScope = JSON.stringify([orientationContext.userId, session.selectedCase?.case_id ?? null, session.source, session.sessionKey]);
  const publicSources = useMemo(() => publicEvidenceSources(session.documents, session.released), [session.documents, session.released]);
  const interviewUi = useInterviewStationUi(interviewScope, publicSources, session.source === "recording", preparationProgress.offer?.roomScope ?? interviewScope);
  const presentedEvidence = worldReplay ? recordedEvidencePresentation(capturedWorld, publicSources) : session.source === "recording" || interviewUi.state.table.scope !== interviewScope ? null : publicEvidenceSource(interviewUi.state.table.presented, publicSources);
  const presentationPaused = paused || (session.source === "recording" && !session.playback.playing);
  // The session facade includes pending assessment intent before the first snapshot arrives.
  const assessment = session.assessmentActive;
  const station = STATIONS.find((item) => item.id === panel || item.id === manifest.hotspots.find((item) => item.id === panel)?.room);
  const trainingStation = trainingStationForPanel(panel, station?.id);
  const stations = usePrecinctStations({ caseId: session.selectedCase?.case_id ?? null, panel: trainingStation, assessmentActive: assessment, paused });
  const boardSurfaces = usePrecinctBoardSurfaces(session);
  const debriefWall = useMemo(() => projectDebriefWall({ scope: interviewScope, recorded: session.source === "recording", assessment, debrief: session.debrief, view: session.view }), [interviewScope, session.source, assessment, session.debrief, session.view]);
  const openTrainingStation = (kind: TrainingStationId) => { open(TRAINING_STATION_PANELS[kind]); };
  const publicView = useMemo(() => assessment && session.view !== null && session.view.mode !== "assessment" ? { ...session.view, mode: "assessment" as const } : session.view, [assessment, session.view]);
  const work = usePrecinctWorkFrame(interviewScope, { view: publicView, arrivals: session.arrivals, clock: sceneClock, paused: presentationPaused || flatView, reducedMotion, referee: session.referee, assessment, recorded: session.source === "recording" });
  const reviewer = projectReviewerV2(work.frame, assessment, !assessment && session.view?.status === "ended" && session.debrief !== null && session.view.debriefReady === session.debrief.session_id);
  const rawCast = projectInterviewCast(session.world);
  const cast = rawCast === null || !assessment ? rawCast : { ...rawCast, mode: "assessment" as const, coaches: [] };
  const interviewRoom = room?.id === "interview" || room?.id === "observation";
  const present = interviewRoom && session.selectedCase !== null && (interviewUi.state.called || session.view !== null);
  const sampleWork = work.sample;
  const eventContext = useCallback(() => readInterviewContext(session.selectedCase?.case_id ?? null, session.sessionKey, sceneClock), [session.selectedCase, session.sessionKey, sceneClock]);
  const interviewEvent = useCallback((event: InterviewRouteEvent) => { onInterviewUiEvent?.(event, eventContext()); }, [onInterviewUiEvent, eventContext]);
  const localCameraSample = localCapture.onCameraSample;
  const cameraSample = useCallback((sample: PrecinctCameraSample) => { if (!geometryReady || !sceneScope.isReady()) return; if (freshBinding !== null) freshBinding.camera(sample); else localCameraSample(sample); onCameraSample?.(sample, eventContext()); }, [geometryReady, sceneScope, freshBinding, localCameraSample, onCameraSample, eventContext]);
  const advanceLocalFrame = localCapture.beforeFrame;
  const sinceWorkSample = useRef(0);
  useLayoutEffect(() => { sinceWorkSample.current = 0; }, [advanceLocalFrame, sampleWork]);
  const beforeFrame = useCallback((deltaSeconds: number) => {
    if (!geometryReady || !sceneScope.isReady()) return;
    advanceLocalFrame();
    sinceWorkSample.current += deltaSeconds;
    if (sinceWorkSample.current >= 0.1) { sinceWorkSample.current %= 0.1; sampleWork(); }
  }, [geometryReady, sceneScope, advanceLocalFrame, sampleWork]);
  const rawActorCapture = !geometryReady ? undefined : session.freshCapture.state.phase === "recording" && freshBinding !== null
    ? { scope: session.sessionKey, onActorSample: freshBinding.pose } : localCapture.actorCapture;
  const actorCaptureScope = rawActorCapture?.scope;
  const actorCaptureWriter = rawActorCapture?.onActorSample;
  // Sample counts and ordinary UI renders do not end an actor's capture lifetime. The
  // sampler emits absence on callback replacement, so depend on the stable writer/scope.
  const actorCapture = useMemo<ActorCapture | undefined>(() => actorCaptureScope === undefined || actorCaptureWriter === undefined ? undefined : {
    scope: `${actualWorldId}:${actorCaptureScope}`,
    onActorSample: (sample) => { if (sceneScope.isReady()) actorCaptureWriter(sample); },
  }, [actualWorldId, actorCaptureScope, actorCaptureWriter, sceneScope]);
  const captureInput = freshBinding?.input ?? localCapture.onControlInput;
  const controlInput = useCallback((sample: Parameters<typeof captureInput>[0]) => { if (geometryReady && sceneScope.isReady()) captureInput(sample); }, [captureInput, geometryReady, sceneScope]);
  const onPose = useCallback((next: PlayerPose) => {
    if (!sceneScope.isActive()) return;
    setPose(next);
    // Controls has just restored its saved walking pose. Only the NEXT frame receives the new travel.
    const pending = deferredTravel.current;
    if (pending !== null && !interviewUi.state.seated) { deferredTravel.current = null; travel.current = pending.command; }
  }, [interviewUi.state.seated, sceneScope, setPose]);
  useLayoutEffect(() => { deferredTravel.current = null; }, [interviewScope]);
  const startInterview = (kind: InterviewStartKind) => {
    if (!canStartInterview(session, kind)) return;
    if (kind === "assessment" || (kind === "resume" && session.live.resumable?.mode === "assessment")) stations.pauseDrill();
    if (kind === "resume" || session.source === "recording") preparationProgress.controller.clear();
    else if (session.source === "idle") preparationProgress.controller.arm(orientationContext, { briefed, fileReviewed }, interviewScope);
    else if (preparationProgress.offer?.runKey != null) preparationProgress.controller.clear();
    localCapture.controller.stop();
    startPreparedInterview(session, notebook, kind);
  };
  const evidenceAction = (action: EvidenceTableAction) => {
    const before = interviewUi.actions.getSnapshot().table;
    if (interviewUi.actions.evidence(action)) {
      const plan = evidenceTableInputs(before, interviewUi.actions.getSnapshot().table, action, true, publicSources);
      if (plan.ok) { if (plan.inputs.length > 0) captureSink?.inputs(plan.inputs); }
      else { session.freshCapture.stop(); localCapture.controller.stop(); setCaptureError("Evidence capture stopped: this public source cannot be represented unambiguously. Earlier samples remain exportable."); }
      interviewEvent({ type: "evidence.table", action });
    }
  };
  const inspectPresentedEvidence = () => {
    if (presentedEvidence === null) return;
    if (interviewUi.actions.tab("evidence")) interviewEvent({ type: "interview.tab", tab: "evidence" });
    open("interview");
  };
  const useEvidenceQuestion = (question: string, source: PublicEvidenceRef) => {
    if (session.source !== "live" || session.backend !== "connected" || session.questionReason !== null || session.isVoice || publicEvidenceSource(source, publicSources) === null) return;
    session.updateDraft(question); interviewEvent({ type: "question.source", question, source });
  };
  const seat = () => {
    if (!interviewUi.state.called && session.view === null) return;
    setCameraMode("first"); interviewUi.actions.sit(); setPanel(null); interviewEvent({ type: "seat.enter" });
  };
  const leaveSeat = () => { if (interviewUi.actions.leave()) interviewEvent({ type: "seat.exit" }); };
  const selectPublicCase = session.selectCase;
  const selectCase = useCallback((caseId: string) => {
    localCapture.controller.stop(); setBriefedScope(null); setReviewedScope(null); preparationProgress.controller.clear(); selectPublicCase(caseId);
  }, [selectPublicCase, preparationProgress.controller, localCapture.controller]);
  const dossierEvent = useCallback((event: DossierUiEvent) => {
    if (session.packet === null) return;
    onDossierUiEvent?.(event, { caseId: session.packet.case_id, sessionKey: session.sessionKey });
    if (captureSink === null) return;
    captureDossierNotebook(captureSink, event, session.packet.case_id);
    if (event.type === "page.open") captureSink.ui({ action: "file_page", file_id: "dossier", page: ["overview", "documents", "subject", "evidence", "timeline", "notebook"].indexOf(event.page) + 1 });
    if (event.type === "source.open") {
      captureSink.ui({ action: "file_page", file_id: event.source.id, page: 1 });
      if (publicSources.filter((item) => item.ref.id === event.source.id).length === 1) captureSink.input({ action: "evidence", operation: "inspect", record_id: event.source.id });
      else { session.freshCapture.stop(); localCapture.controller.stop(); setCaptureError("Evidence capture stopped because a public source ID is ambiguous. Earlier samples remain exportable."); }
    }
  }, [onDossierUiEvent, session.packet, session.sessionKey, captureSink, publicSources, session.freshCapture, localCapture.controller]);
  const saveRecording = (value: NonNullable<typeof session.recording>, name: string) => {
    try {
      const text = recordingJson(value);
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
      setCaptureError(null);
    } catch { setCaptureError("The recording could not be exported safely. Captured samples remain in this tab."); }
  };
  const exportCapture = () => {
    if (session.assessmentActive) return;
    const result = localCapture.local?.exportRecording();
    if (result?.ok !== true) { setCaptureError(result?.errors.join("; ") ?? "Choose a public packet and start local capture first."); return; }
    saveRecording(result.recording, localCapture.snapshot.status === "blocked" ? "arena-local-world-incomplete.v2.json" : "arena-local-world.v2.json");
  };
  const beforeRecording = (): boolean => {
    if (session.assessmentActive) return false;
    notebook.discardPreparation(); preparationProgress.controller.clear(); stations.pauseDrill(); localCapture.controller.stop(); session.freshCapture.stop();
    return true;
  };
  const reviewCapture = () => {
    if (!beforeRecording()) return;
    const result = localCapture.local?.exportRecording();
    if (result?.ok !== true) { setCaptureError(result?.errors.join("; ") ?? "No local capture is available."); return; }
    session.loadCaptureRecording(result.recording); setPanel("debrief_replay");
  };
  const recordingControls = {
    ...session,
    loadBundledRecording: async () => { if (beforeRecording()) await session.loadBundledRecording(); },
    loadCoachedRecording: async () => { if (beforeRecording()) await session.loadCoachedRecording(); },
    importRecording: async (file: File) => { if (beforeRecording()) await session.importRecording(file); },
    loadLocalRecording: async (trialId: string) => { if (session.backend === "connected" && trialId.trim() !== "" && beforeRecording()) await session.loadLocalRecording(trialId); },
  };
  const replayFromStation = (request: StationReplayRequest) => {
    if (session.assessmentActive) return;
    if (request.kind === "local") {
      if (session.backend !== "connected" || request.trialId.trim() === "") return;
      void recordingControls.loadLocalRecording(request.trialId);
    } else if (request.tape === "coached") void recordingControls.loadCoachedRecording();
    else void recordingControls.loadBundledRecording();
    open("debrief_replay");
  };
  const go = useCallback((index: number) => {
    const destination = STATIONS[index];
    if (destination === undefined) return;
    const command: TravelCommand = { position: destination.anchor, yaw: destination.yaw, instant: true };
    const targetHotspot = manifest.hotspots.find((item) => item.room === destination.id)?.id ?? null;
    if (!flatView && (interviewUi.state.seated || deferredTravel.current !== null)) {
      deferredTravel.current = { command, hotspot: targetHotspot }; travel.current = null;
      if (interviewUi.actions.leave()) interviewEvent({ type: "seat.exit" });
    } else travel.current = command;
    setEntered(true); setExpandedMonitor(null); setPanel(null); resume();
    if (flatView) { interviewUi.actions.leave(); setPose({ position: destination.anchor, yaw: destination.yaw, speed: 0, hotspot: targetHotspot }); }
  }, [flatView, resume, interviewUi.state.seated, interviewUi.actions, interviewEvent, manifest, setPose]);

  const travelToHotspot = useCallback((id: string) => {
    const target = manifest.hotspots.find((item) => item.id === id);
    if (target === undefined) return;
    const index = STATIONS.findIndex((item) => item.id === target.room);
    if (index >= 0) { go(index); return; }
    // Corridor landmarks have their own clear manifest anchor, outside the ten room shortcuts.
    const position: Vec3 = [target.position[0], 0, target.position[2]];
    const authored = raw.hotspots.find((item) => item.id === id);
    const yaw = authored === undefined ? 0 : Math.atan2(position[0] - (authored.lookAt[0] ?? 0), position[2] - (authored.lookAt[2] ?? 0));
    const command: TravelCommand = { position, yaw, instant: true };
    if (!flatView && (interviewUi.state.seated || deferredTravel.current !== null)) {
      deferredTravel.current = { command, hotspot: id }; travel.current = null;
      if (interviewUi.actions.leave()) interviewEvent({ type: "seat.exit" });
    } else travel.current = command;
    setEntered(true); setExpandedMonitor(null); setPanel(null); resume();
    if (flatView) { interviewUi.actions.leave(); setPose({ position, yaw, speed: 0, hotspot: id }); }
  }, [go, flatView, resume, interviewUi.state.seated, interviewUi.actions, interviewEvent, manifest, raw, setPose]);
  const inWorldSessionStation = trainingStation !== null || ["board_wall", "dossier", "interview", "observation", "debrief"].includes(station?.id ?? "");
  const staffStation = station?.id === "lobby" ? "reception" : station?.id === "briefing" ? "briefing" : station?.id === "open_office" ? "office" : null;
  const orientation = orientationProgress({ checkedIn, briefed, fileReviewed, source: session.source, running: session.live.phase === "running", hasView: session.view !== null, atInterviewCap: session.view?.status === "cap_reached", findingCommitted: session.view?.committedFinding != null, debriefPublished: session.debriefReady });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[role=dialog],dialog")) return;
      if (event.repeat || !entered) return;
      if (event.code === "KeyE" && flatView && !paused && panel === null && pose.hotspot !== null) setPanel(pose.hotspot);
      if (event.code === "KeyV" && !flatView) setCameraMode((mode) => nextCameraMode(mode, paused));
      if (event.code === "KeyM") setPanel((current) => current === "map" ? null : "map");
      if (event.code === "Escape") { if (panel !== null) close(); else if (paused) resume(); else setPaused(true); }
      const index = STATIONS.findIndex((item) => event.key === item.key);
      if (index >= 0 && panel === null) go(index);
    };
    window.addEventListener("keydown", listener);
    return () => { window.removeEventListener("keydown", listener); };
  }, [entered, paused, panel, go, resume, flatView, pose.hotspot, close, setCameraMode]);

  const sceneChangeState: SceneChangeState = {
    captureActive: localCapture.snapshot.status === "recording" || session.freshCapture.state.phase === "armed" || session.freshCapture.state.phase === "recording",
    replayActive: session.source === "recording", sessionActive: session.source === "live", seated: interviewUi.state.seated,
  };
  const selectWorld = (requested: PrecinctWorldId) => {
    const next = selectPrecinctWorld(worldPreference, requested, sceneChangeState);
    if (next === worldPreference) return;
    // Revoke before changing the world. Subscribers fail an active journal incomplete if an
    // embedding ever forces replacement; an orderly stop must not disguise a scene mismatch.
    sceneScope.expire(); captureScene.set(null); travel.current = null; deferredTravel.current = null;
    setWorldPreference(next);
  };
  const captureStatus = <><CaptureStatus fresh={session.freshCapture.state} local={localCapture.snapshot} modal={panel !== null} />{captureError !== null ? <p role="alert" className={panel === null ? "precinct-capture-error" : "precinct-capture-error precinct-capture-error--modal"}>{captureError}</p> : null}</>;

  const walkingCaptureStatus = panel === null ? captureStatus : null;
  const inspecting = !flatView && (worldReplay ? freeReplayCamera : session.source !== "recording" && paused && cameraMode === "free");

  return <div data-theme={theme} className={`precinct-root${largeText ? " large-text" : ""}${contrast ? " high-contrast" : ""}`}>
    <div className="precinct-stage"><RenderBoundary key={actualWorldId} onUnavailable={onUnavailable} fallback={<div className="precinct-flat-view" role="img" aria-label="Original precinct lobby preview" />}><Suspense fallback={<div className="precinct-loading">Opening the precinct…</div>}><PrecinctCanvas key={actualWorldId} boardSurfaces={boardSurfaces.model} debriefWall={debriefWall} manifest={manifest} legacyReplay={legacyReplay} active={entered && panel === null} paused={paused} cameraMode={cameraMode} reducedMotion={reducedMotion} tier={tier} onTierChange={setTier} travel={travel} onPose={onPose} onInteract={open} onReady={onReady} interview={{ cast, subjectName: session.subjectName, clock: sceneClock, work: work.frame, reviewer, assessmentActive: assessment, present, seated: interviewUi.state.seated, location: room?.id === "observation" ? "observation" : "interview", evidence: presentedEvidence }} onInspectEvidence={inspectPresentedEvidence} onExpandMonitor={expandMonitor} onCameraSample={cameraSample} onBeforeFrame={beforeFrame} onControlInput={controlInput}
      {...(actorCapture === undefined ? {} : { actorCapture })}
      {...(worldReplay ? { replayActors: capturedWorld.actors, replayCamera: { ownership: freeReplayCamera ? "free" as const : "recorded" as const, sample: capturedWorld.camera } } : {})} /></Suspense></RenderBoundary></div>
    <div className="precinct-vignette" />
    {flatView ? <div className="precinct-render-notice" role="status" aria-label="Rendering status">3D rendering is unavailable on this device. Use the map or number keys to visit each station.</div> : null}
    {!flatView && panel !== "settings" && navigationFallback ? <div className="precinct-render-notice"><PrecinctNavigationStatus status={navigationStatus} /></div> : null}
    <header className="precinct-header">
      <Link className="precinct-brand" to="/" aria-label="Arena precinct home"><span className="brand-emblem"><Symbol name="compass" /></span><span>ARENA<small>INVESTIGATION TRAINING</small></span></Link>
      <div className="precinct-location"><span className="live-dot" />WASHINGTON, DC <span>/</span> {entered ? room?.name ?? "Investigation Hall" : "NORTHSTAR PRECINCT"}</div>
      <div className="precinct-header-actions"><span className="local-badge">LOCAL TRAINING</span><button className="icon-button" aria-label="Comfort and accessibility settings" onClick={() => { setPanel("settings"); }}><Symbol name="settings" /></button></div>
    </header>

    {!entered ? <section className="precinct-welcome" aria-labelledby="welcome-title"><div className="welcome-rule" /><span className="precinct-kicker">YOUR NEXT CHAPTER BEGINS WITH A QUESTION</span><h1 id="welcome-title">Start your shift.</h1><p>A place to practice listening, follow the evidence,<br />and make a finding you can support.</p><div className="welcome-actions"><button className="precinct-primary" disabled={!ready} onClick={() => { setEntered(true); travel.current = {position: [0,0,-4.2],yaw:0,instant:reducedMotion}; }}>{ready ? "Enter the precinct" : "Preparing the precinct…"}<Symbol name="arrow" /></button><button className="precinct-text-button" disabled={!ready} onClick={() => { setEntered(true); }}>Skip arrival</button></div><div className="welcome-meta"><span>01 / ORIENTATION</span><span>EXPLORE AT YOUR OWN PACE</span></div></section> : <>
      <section className="precinct-objective" aria-label="Current objective"><span className="precinct-kicker">ON YOUR SHIFT</span><h1>{orientation.title}</h1><p>{orientation.description}</p><div className="shift-progress" role="progressbar" aria-label="Orientation progress" aria-valuemin={0} aria-valuemax={6} aria-valuenow={orientation.completed}><span style={{ width: `${String((orientation.completed) / 6 * 100)}%` }} /></div><small>STEPS COMPLETE <span>{orientation.completed} OF 6</span></small></section>
      <Minimap world={world} pose={pose} onMap={() => { setPanel("map"); }} />
      {panel === null ? <div className="precinct-conversation-hud">{walkingCaptureStatus}<div className="precinct-caption-slot" ref={setCaptionTarget} />
      {hotspot !== undefined && !paused ? <button className="precinct-interact" onClick={() => { setPanel(hotspot.id); }}><kbd>E</kbd><span>{hotspot.label}</span><Symbol name="arrow" /></button> : null}
      {interviewUi.state.seated ? <div className="precinct-seat-controls"><button type="button" onClick={() => { open("interview"); }}>Interview controls</button><button type="button" onClick={leaveSeat}>Leave interview seat</button><button type="button" onClick={() => { go(6); }}>Visit observation room</button></div> : null}
      </div> : null}
      <div className="precinct-controls">{flatView ? <><span><kbd>1–0</kbd> Visit a station</span><span><kbd>M</kbd> Directory</span><span><kbd>E</kbd> Open station</span></> : inspecting ? <><span><kbd>W A S D</kbd> / left stick · Pan camera</span><span>Arrows, drag / right stick · Orbit</span><span><kbd>Q E</kbd> / L1 R1 · Height</span><span>Wheel · Zoom</span><span><kbd>Shift</kbd> / left-stick press · Faster</span></> : worldReplay ? <><span>Recorded camera</span><span>Choose free inspection in Replay Theater or press the right stick</span></> : <><span><kbd>W A S D</kbd> Walk</span><span><kbd>↔ ↕</kbd> Look</span><span>Right-click mouse look</span><span><kbd>V</kbd> {cameraMode === "first" ? "First person" : cameraMode === "third" ? "Third person" : "Free camera"}</span><span><kbd>Shift</kbd> Sprint</span></>}</div>
      <button className="precinct-pause" onClick={() => { if (paused) resume(); else setPaused(true); }}>{paused ? "Resume exploration" : "Pause"}<kbd>Esc</kbd></button>
    </>}
    {paused && panel === null ? <div className="precinct-paused"><span>EXPLORATION PAUSED</span><h2>Take your time.</h2><p>{worldReplay ? "Choose recorded or free inspection in Replay Theater, or resume when you’re ready." : "Press V to change the camera, or resume when you’re ready."}</p><button className="precinct-primary" onClick={resume}>Resume<Symbol name="arrow" /></button></div> : null}
    <PrecinctSpeechCaption caption={assessment && session.speechCaption?.role === "coach" ? null : session.speechCaption} target={captionTarget}
      announce={session.speechCaption?.role === "coach" || !(station?.id === "interview" && expandedMonitor === null && interviewUi.state.tab === "transcript")} />
    <footer className="precinct-ground-rule">{EX4_TEXT}</footer>

    {panel === "map" ? <Modal captionTarget={setCaptionTarget} status={captureStatus} title="Find your way." onClose={close}><p className="panel-lead">Every part of your training has a place here. Walk there, or choose a station to fast travel.</p><div className="station-directory">{STATIONS.map((item, index) => <button key={item.id} onClick={() => { go(index); }}><kbd>{item.key}</kbd><span><strong>{item.label}</strong><small>{item.description}</small></span><Symbol name="arrow" /></button>)}</div></Modal> : null}
    {panel === "settings" ? <Modal captionTarget={setCaptionTarget} status={captureStatus} title="Make yourself comfortable." onClose={close}><p className="panel-lead">Your pace. Your point of view.</p><PrecinctThemeControl value={theme} onChange={setTheme} /><PrecinctWorldSelector value={worldPreference} state={sceneChangeState} onChange={selectWorld} />{navigationStatus === undefined ? null : <PrecinctNavigationStatus status={navigationStatus} />}<div className="precinct-settings"><label><span>Reduced motion<small>Steady cameras and still background gestures</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => { setReducedMotion(event.target.checked); }} /></label><label><span>Larger text<small>More readable panels and subtitles</small></span><input type="checkbox" checked={largeText} onChange={(event) => { setLargeText(event.target.checked); }} /></label><label><span>High contrast<small>Opaque, clearly separated interface surfaces</small></span><input type="checkbox" checked={contrast} onChange={(event) => { setContrast(event.target.checked); }} /></label><label><span>Rendering quality<small>Rendering can step down automatically for smoother movement</small></span><select value={tier} onChange={(event) => { const value = event.target.value; if (value === "high" || value === "medium" || value === "low") setTier(value); }}><option value="low">Low</option><option value="medium">Balanced</option><option value="high">High</option></select></label></div><p className="precinct-note">Keyboard-only: WASD moves, arrow keys look, E interacts, V changes camera, M opens the map. Number keys 1–0 fast travel. A connected controller uses the sticks to move/look and A to interact. Start pauses/resumes, View opens the map, and right-stick press changes the live camera or switches v2 recorded/free inspection. In dialogs, D-pad/left stick moves focus, A activates and B goes back. Paused or replay free inspection: WASD/left stick pans the camera, arrows/drag/right stick orbits, Q/E or L1/R1 changes height, the wheel zooms, and Shift/left-stick press moves faster. Replay camera ownership is selected in Replay Theater.</p></Modal> : null}
    {panel !== null && panel !== "map" && panel !== "settings" ? <Modal captionTarget={setCaptionTarget} status={captureStatus} title={expandedMonitor === null ? trainingStation === null ? station?.label ?? manifest.hotspots.find((item) => item.id === panel)?.label ?? "Precinct station" : TRAINING_STATION_TITLES[trainingStation] : STYLE_NAMES[expandedMonitor]} onClose={close} wide={station?.id === "interview" || station?.id === "observation" || station?.id === "debrief" || expandedMonitor !== null}>{trainingStation !== null ? <>
      <PrecinctTrainingContent recognition={boardSurfaces.recognitionSink} kind={trainingStation} session={session} stations={stations} assessmentActive={assessment} motionOff={reducedMotion || paused} onSelectCase={selectCase} onNavigate={openTrainingStation} onReplay={replayFromStation} onDesk={() => { travelToHotspot("personal_dossier"); }} />
      {trainingStation !== "cases" || session.selectedCase === null ? null : <p className="precinct-note" role="status">{session.packetState === "loading" ? "Opening the selected public packet…" : session.packetState === "ready" ? "Your public packet is ready at your desk." : "This public packet is unavailable. Choose another case or check the explicitly connected local backend."}</p>}
    </> : staffStation !== null ? <ReceptionBriefingPanel key={briefingScope} station={staffStation} assignment={session.selectedCase} controller={npcController} checkedIn={checkedIn} briefed={briefed} onCheckIn={() => { setCheckedIn(true); }} onBriefed={() => { if (session.selectedCase !== null) setBriefedScope({ scope: briefingScope, owner: preparationOwner }); }} onTravel={travelToHotspot} /> : station?.id === "dossier" ? <><PrecinctDeskPanel key={notebook.key} session={session} notebook={notebook} {...(session.source === "recording" ? { recordedNotebook: <RecordedWorldStatePanel world={capturedWorld} notebookOnly /> } : {})} reviewed={fileReviewed} onReviewed={() => { if (session.packetState === "ready" && session.packet !== null && !notebook.readOnly) setReviewedScope({ scope: reviewScope, owner: preparationOwner }); }} onChooseCase={() => { setPanel("case_board"); }} onUiEvent={dossierEvent} {...(session.source === "recording" ? {} : { onPresentEvidence: (source: PublicEvidenceRef) => { evidenceAction({ type: "present", source }); } })} /><div className="precinct-interview-links"><button type="button" onClick={() => { travelToHotspot("interview"); }}>Visit interview room</button></div></> : station?.id === "interview" ? <>
      {freshCapturePanel}
      <InterviewStationPanel key={interviewScope} session={{ ...session, view: publicView, playback: { ...session.playback, seekTo: (time) => { session.playback.seekTo(time); sampleWork(true); } } }} still={reducedMotion || presentationPaused} tab={interviewUi.state.tab} onTabChange={(tab) => { if (interviewUi.actions.tab(tab)) interviewEvent({ type: "interview.tab", tab }); }} citation={interviewUi.state.citation} onCite={(turn, quote) => { interviewUi.actions.cite(turn, quote); }} evidenceScope={interviewScope} evidenceState={interviewUi.state.table} onEvidenceAction={evidenceAction} onUseEvidenceQuestion={useEvidenceQuestion} freshRecordId={session.world?.wall.find(item => item.fresh)?.record_id ?? null} startInterview={startInterview} called={interviewUi.state.called} seated={interviewUi.state.seated} onCallSubject={session.packetState === "ready" && session.packet?.case_id === session.selectedCase?.case_id ? () => { if (interviewUi.actions.call()) interviewEvent({ type: "intercom.call" }); } : null} onSit={seat} onExitSeat={leaveSeat} />
      {session.source === "recording" ? <RecordedWorldStatePanel world={capturedWorld} /> : null}
      <div className="precinct-interview-links"><button type="button" onClick={() => { go(6); }}>Visit observation room</button><button type="button" onClick={() => { go(7); }}>Recorded runs and published debrief</button></div>
    </> : station?.id === "observation" ? <>
      <div ref={observationContent} hidden={expandedMonitor !== null}><ObservationStationPanel frame={work.frame} assessment={assessment} onExpandMonitor={expandMonitor} onReturnToInterview={() => { go(5); }} />{flatView ? <p className="precinct-note">The accessible view shows the current public events and seeks. Decorative motion between events is paused without the 3D renderer.</p> : null}</div>
      {expandedMonitor === null ? null : <div className="precinct-full-monitor" ref={expandedContent} tabIndex={-1} aria-label={`${STYLE_NAMES[expandedMonitor]} expanded`}><AgentWorkMonitor frame={work.frame} style={expandedMonitor} size="full" onStyleChange={setExpandedMonitor} /><button type="button" className="precinct-secondary" onClick={close}>Back to four screens</button></div>}
    </> : station?.id === "debrief" ? <>
      {freshCapturePanel}
      {assessment && <p className="panel-lead">Recorded runs and review are withheld during assessment. Loading another recording, exporting and coaching review remain unavailable until this run publishes its debrief. Explicitly close the assessment view to leave it.</p>}
      {!assessment && <fieldset className="precinct-replay-loads"><legend>Choose a recorded run</legend><SessionRecordingsPanel session={recordingControls} /></fieldset>}
      <ReplayTheaterPanel recording={assessment && session.recording?.snapshot.mode !== "assessment" ? null : session.recording} playback={{ ...session.playback, seekTo: (time) => { session.playback.seekTo(time); sampleWork(true); } }}
        paused={paused} freeCamera={freeReplayCamera} onFreeCamera={(free) => { setReplayCameraChoice({ scope: session.sessionKey, free }); }}
        importDisabled={assessment} onImport={(file) => { void recordingControls.importRecording(file); }} onExport={assessment || session.recording === null ? null : () => { if (!session.assessmentActive && session.recording !== null) saveRecording(session.recording, "arena-recording.json"); }}
        loading={session.recordingState === "loading"} error={session.recordingError}
        {...(session.source === "idle" && session.packet !== null && session.freshCapture.state.phase !== "armed" ? { capture: { controller: { ...localCapture.controller, start: () => {
          if (localStaffPlaybackActivity.getSnapshot()) { setCaptureError(SILENT_CAPTURE_AUDIO_REASON); return false; }
          if (!captureSceneReady || !sceneScope.isReady()) { setCaptureError("Wait for a verified, rendered scene before starting capture."); return false; }
          setCaptureError(null); return localCapture.controller.start();
        } }, snapshot: localCapture.snapshot, onExport: exportCapture } } : {})} />
      {session.source === "idle" ? <><button type="button" disabled={localCapture.snapshot.status !== "recording"} onClick={() => {
        if (session.packet !== null) captureDossierNotebook(localCapture.controller, { type: "notebook.carry", document: notebook.snapshot.document }, session.packet.case_id);
      }}>Include the current public notebook in capture</button><p>Local world capture is a new offline run with a zero clock and public opening packet. It contains no interview, finding or score. Backend world-event writes remain disabled. A separately armed fresh silent text run uses actual client arrival timing.</p><button type="button" disabled={localCapture.snapshot.count === 0} onClick={reviewCapture}>Review this local capture</button></> : session.source === "recording" ? <button type="button" onClick={() => { localCapture.controller.stop(); session.stopSession(); }}>Return to public opening packet for a new local capture</button> : <p>Fresh text capture must be armed before starting a new silent run. Mid-run arming and backend world-event writes are unavailable.</p>}
      <div className="precinct-interview-links"><button type="button" onClick={() => { go(5); }}>Visit interview room for playback controls</button></div>
      <SessionDebriefPanel debrief={assessment ? null : session.debrief} view={session.view} recorded={session.source === "recording"} recording={session.recording}
        onReplayFromTurn={(time) => { session.playback.pause(); session.playback.seekTo(time); sampleWork(true); setPanel("interview"); }}
        onOpenFreshPractice={() => { if (!session.assessmentActive) { localCapture.controller.stop(); session.stopSession(); setPanel("case_board"); } }} />
    </> : <><span className="station-tag">PRECINCT ORIENTATION</span><p className="panel-lead">{station?.description ?? "Welcome to the investigation training center."}</p><p>This station is being brought into the world. The existing interview, recorded runs, and training tools remain available below.</p></>}<div className="station-actions">{inWorldSessionStation ? null : <Link className="precinct-primary" to="/session">Open training session<Symbol name="arrow" /></Link>}<Link className="precinct-secondary" to="/trust/methodology">Trust & methodology</Link></div><aside className="precinct-safety"><strong>Evidence first. Always.</strong><p>Nervousness, demeanor, accent and stress are never evidence.</p><p>{EX4_TEXT}</p></aside></Modal> : null}
  </div>;
}
