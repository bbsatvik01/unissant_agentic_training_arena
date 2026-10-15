import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import raw from "../../public/world/precinct-manifest.json";
import { EX4_TEXT } from "../lib/copy/ex4";
import { usePrecinctNpcController } from "../hooks/usePrecinctNpcController";
import { ReceptionBriefingPanel } from "../components/precinct/ReceptionBriefingPanel";
import { PrecinctDeskPanel } from "../components/precinct/PrecinctDeskPanel";
import { PrecinctCaseChoicePanel } from "../components/precinct/PrecinctCaseChoicePanel";
import type { DossierUiEvent } from "../components/precinct/DossierPanel";
import { usePrecinctSession } from "./precinct/usePrecinctSession";
import { usePrecinctNotebook } from "./precinct/usePrecinctNotebook";
import { nextCameraMode } from "../lib/precinct/movement";
import type { CameraMode, Vec3 } from "../lib/precinct/types";
import type { Tier } from "../lib/world/quality";
import { STATIONS, type PlayerPose, type PrecinctManifest, type TravelCommand } from "../components/precinct/sceneTypes";
import { RenderBoundary } from "../components/precinct/RenderBoundary";
import { InterviewStationPanel } from "../components/precinct/InterviewStationPanel";
import { ObservationStationPanel } from "../components/precinct/ObservationStationPanel";
import { AgentWorkMonitor } from "../components/agent-work/AgentWorkMonitor";
import { SessionRecordingsPanel } from "../components/precinct/SessionControlPanel";
import { SessionDebriefPanel } from "../components/precinct/SessionDebriefPanel";
import type { PrecinctCameraSample } from "../components/precinct/interviewScene";
import { STYLE_NAMES, type WorkStyle } from "../lib/agent-work/model";
import { publicEvidenceSource, publicEvidenceSources, type EvidenceTableAction, type PublicEvidenceRef } from "../lib/precinct/evidenceTable";
import { orientationProgress } from "../lib/precinct/orientationProgress";
import { projectInterviewCast } from "../lib/precinct/interviewStage";
import { canStartInterview, startPreparedInterview, type InterviewStartKind } from "../lib/precinct/interviewStart";
import { usePrecinctWorkFrame } from "./precinct/usePrecinctWorkFrame";
import { useInterviewStationUi } from "./precinct/useInterviewStationUi";
import { useOrientationHandoff } from "./precinct/useOrientationHandoff";
import "../styles/precinct.css";
import "../styles/precinct-interview-route.css";

const PrecinctCanvas = lazy(() => import("../components/precinct/PrecinctCanvas"));
const xyz = (value: readonly number[]): Vec3 => [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0];
const MANIFEST: PrecinctManifest = {
  colliders: raw.colliders.map((collider) => ({ ...collider, min: xyz(collider.min), max: xyz(collider.max) })),
  hotspots: raw.hotspots.map((hotspot) => ({ ...hotspot, position: xyz(hotspot.position) })),
  navigationNodes: raw.navigationNodes.map((node) => ({ ...node, position: xyz(node.position) })),
};
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

function Modal({ title, onClose, children, wide = false }: { readonly title: string; readonly onClose: () => void; readonly children: React.ReactNode; readonly wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
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
    <header><div><span className="precinct-kicker">INVESTIGATION TRAINING CENTER</span><h2 id="station-title">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close panel"><Symbol name="close" /></button></header>
    {children}
  </dialog>;
}

function Minimap({ pose, onMap }: { readonly pose: PlayerPose; readonly onMap: () => void }) {
  return <button className="precinct-minimap" onClick={onMap} aria-label="Open precinct map and fast travel">
    <span className="map-north">N ↑</span><svg viewBox="-15 -37 30 38" aria-hidden="true">
      <rect x="-14" y="-36" width="28" height="36" fill="#d6d8cf" rx="0.3" />
      {raw.rooms.map((room) => <rect key={room.id} x={room.bounds.min[0]} y={room.bounds.min[2]} width={(room.bounds.max[0] ?? 0) - (room.bounds.min[0] ?? 0)} height={(room.bounds.max[2] ?? 0) - (room.bounds.min[2] ?? 0)} fill={room.id === "corridor" || room.id === "lobby" ? "#f5f4e9" : "#aebbb5"} stroke="#f5f4e9" strokeWidth="0.25" />)}
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
  const npcController = usePrecinctNpcController();
  const [checkedIn, setCheckedIn] = useState(false);
  const [briefedScope, setBriefedScope] = useState<{ readonly scope: string; readonly owner: object } | null>(null);
  const [reviewedScope, setReviewedScope] = useState<{ readonly scope: string; readonly owner: object } | null>(null);
  const [entered, setEntered] = useState(false);
  const [ready, setReady] = useState(false);
  const [flatView, setFlatView] = useState(false);
  const [pose, setPose] = useState<PlayerPose>(INITIAL_POSE);
  const [paused, setPaused] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>("first");
  const [panel, setPanel] = useState<string | null>(null);
  const [expandedMonitor, setExpandedMonitor] = useState<WorkStyle | null>(null);
  const monitorOrigin = useRef<HTMLElement | null>(null);
  const monitorReturn = useRef<WorkStyle | null>(null);
  const expandedContent = useRef<HTMLDivElement>(null);
  const observationContent = useRef<HTMLDivElement>(null);
  const deferredTravel = useRef<{ readonly command: TravelCommand; readonly hotspot: string | null } | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [largeText, setLargeText] = useState(false);
  const [contrast, setContrast] = useState(false);
  const [tier, setTier] = useState<Tier>("medium");
  const travel = useRef<TravelCommand | null>(null);
  const onReady = useCallback(() => { setReady(true); }, []);
  const onUnavailable = useCallback(() => { setFlatView(true); setReady(true); }, []);
  const resume = useCallback(() => { setPaused(false); setCameraMode((mode) => mode === "free" ? "first" : mode); }, []);
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
  const hotspot = MANIFEST.hotspots.find((item) => item.id === pose.hotspot);
  const room = [...raw.rooms].reverse().find((candidate) => pose.position[0] >= (candidate.bounds.min[0] ?? 0) && pose.position[0] <= (candidate.bounds.max[0] ?? 0) && pose.position[2] >= (candidate.bounds.min[2] ?? 0) && pose.position[2] <= (candidate.bounds.max[2] ?? 0));
  const session = usePrecinctSession({ reducedMotion, paused, audioInRoom: room?.id === "interview" || room?.id === "observation" });
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
  const presentedEvidence = session.source === "recording" || interviewUi.state.table.scope !== interviewScope ? null : publicEvidenceSource(interviewUi.state.table.presented, publicSources);
  const presentationPaused = paused || (session.source === "recording" && !session.playback.playing);
  // The session facade includes pending assessment intent before the first snapshot arrives.
  const assessment = session.assessmentActive;
  const publicView = useMemo(() => assessment && session.view !== null && session.view.mode !== "assessment" ? { ...session.view, mode: "assessment" as const } : session.view, [assessment, session.view]);
  const work = usePrecinctWorkFrame(interviewScope, { view: publicView, arrivals: session.arrivals, clock: session.clock, paused: presentationPaused || flatView, reducedMotion, referee: session.referee, assessment, recorded: session.source === "recording" });
  const rawCast = projectInterviewCast(session.world);
  const cast = rawCast === null || !assessment ? rawCast : { ...rawCast, mode: "assessment" as const, coaches: [] };
  const interviewRoom = room?.id === "interview" || room?.id === "observation";
  const present = interviewRoom && session.selectedCase !== null && (interviewUi.state.called || session.view !== null);
  const sampleWork = work.sample;
  const eventContext = useCallback(() => readInterviewContext(session.selectedCase?.case_id ?? null, session.sessionKey, session.clock), [session.selectedCase, session.sessionKey, session.clock]);
  const interviewEvent = useCallback((event: InterviewRouteEvent) => { onInterviewUiEvent?.(event, eventContext()); }, [onInterviewUiEvent, eventContext]);
  const cameraSample = useCallback((sample: PrecinctCameraSample) => { sampleWork(); onCameraSample?.(sample, eventContext()); }, [sampleWork, onCameraSample, eventContext]);
  const onPose = useCallback((next: PlayerPose) => {
    setPose(next);
    // Controls has just restored its saved walking pose. Only the NEXT frame receives the new travel.
    const pending = deferredTravel.current;
    if (pending !== null && !interviewUi.state.seated) { deferredTravel.current = null; travel.current = pending.command; }
  }, [interviewUi.state.seated]);
  useLayoutEffect(() => { deferredTravel.current = null; }, [interviewScope]);
  const startInterview = (kind: InterviewStartKind) => {
    if (!canStartInterview(session, kind)) return;
    if (kind === "resume" || session.source === "recording") preparationProgress.controller.clear();
    else if (session.source === "idle") preparationProgress.controller.arm(orientationContext, { briefed, fileReviewed }, interviewScope);
    else if (preparationProgress.offer?.runKey != null) preparationProgress.controller.clear();
    startPreparedInterview(session, notebook, kind);
  };
  const evidenceAction = (action: EvidenceTableAction) => {
    if (interviewUi.actions.evidence(action)) interviewEvent({ type: "evidence.table", action });
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
    setBriefedScope(null); setReviewedScope(null); preparationProgress.controller.clear(); selectPublicCase(caseId);
  }, [selectPublicCase, preparationProgress.controller]);
  const dossierEvent = useCallback((event: DossierUiEvent) => {
    if (session.packet !== null) onDossierUiEvent?.(event, { caseId: session.packet.case_id, sessionKey: session.sessionKey });
  }, [onDossierUiEvent, session.packet, session.sessionKey]);
  const station = STATIONS.find((item) => item.id === panel || item.id === MANIFEST.hotspots.find((item) => item.id === panel)?.room);
  const go = useCallback((index: number) => {
    const destination = STATIONS[index];
    if (destination === undefined) return;
    const command: TravelCommand = { position: destination.anchor, yaw: destination.yaw, instant: true };
    const targetHotspot = MANIFEST.hotspots.find((item) => item.room === destination.id)?.id ?? null;
    if (!flatView && (interviewUi.state.seated || deferredTravel.current !== null)) {
      deferredTravel.current = { command, hotspot: targetHotspot }; travel.current = null;
      if (interviewUi.actions.leave()) interviewEvent({ type: "seat.exit" });
    } else travel.current = command;
    setEntered(true); setExpandedMonitor(null); setPanel(null); resume();
    if (flatView) { interviewUi.actions.leave(); setPose({ position: destination.anchor, yaw: destination.yaw, speed: 0, hotspot: targetHotspot }); }
  }, [flatView, resume, interviewUi.state.seated, interviewUi.actions, interviewEvent]);

  const travelToHotspot = useCallback((id: string) => {
    const target = MANIFEST.hotspots.find((item) => item.id === id);
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
  }, [go, flatView, resume, interviewUi.state.seated, interviewUi.actions, interviewEvent]);
  const inWorldSessionStation = ["board_wall", "dossier", "interview", "observation", "debrief"].includes(station?.id ?? "");
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
  }, [entered, paused, panel, go, resume, flatView, pose.hotspot, close]);

  return <div className={`precinct-root${largeText ? " large-text" : ""}${contrast ? " high-contrast" : ""}`}>
    <div className="precinct-stage"><RenderBoundary onUnavailable={onUnavailable} fallback={<div className="precinct-flat-view" role="img" aria-label="Original precinct lobby preview" />}><Suspense fallback={<div className="precinct-loading">Opening the precinct…</div>}><PrecinctCanvas manifest={MANIFEST} active={entered && panel === null} paused={paused} cameraMode={cameraMode} reducedMotion={reducedMotion} tier={tier} onTierChange={setTier} travel={travel} onPose={onPose} onInteract={open} onReady={onReady} interview={{ cast, subjectName: session.subjectName, clock: session.clock, work: work.frame, present, seated: interviewUi.state.seated, location: room?.id === "observation" ? "observation" : "interview", evidence: presentedEvidence }} onInspectEvidence={inspectPresentedEvidence} onExpandMonitor={expandMonitor} onCameraSample={cameraSample} /></Suspense></RenderBoundary></div>
    <div className="precinct-vignette" />
    {flatView ? <div className="precinct-render-notice" role="status">3D rendering is unavailable on this device. Use the map or number keys to visit each station.</div> : null}
    <header className="precinct-header">
      <Link className="precinct-brand" to="/" aria-label="Arena precinct home"><span className="brand-emblem"><Symbol name="compass" /></span><span>ARENA<small>INVESTIGATION TRAINING</small></span></Link>
      <div className="precinct-location"><span className="live-dot" />WASHINGTON, DC <span>/</span> {entered ? room?.name ?? "Investigation Hall" : "NORTHSTAR PRECINCT"}</div>
      <div className="precinct-header-actions"><span className="local-badge">LOCAL TRAINING</span><button className="icon-button" aria-label="Comfort and accessibility settings" onClick={() => { setPanel("settings"); }}><Symbol name="settings" /></button></div>
    </header>

    {!entered ? <section className="precinct-welcome" aria-labelledby="welcome-title"><div className="welcome-rule" /><span className="precinct-kicker">YOUR NEXT CHAPTER BEGINS WITH A QUESTION</span><h1 id="welcome-title">Start your shift.</h1><p>A place to practice listening, follow the evidence,<br />and make a finding you can support.</p><div className="welcome-actions"><button className="precinct-primary" disabled={!ready} onClick={() => { setEntered(true); travel.current = {position: [0,0,-4.2],yaw:0,instant:reducedMotion}; }}>{ready ? "Enter the precinct" : "Preparing the precinct…"}<Symbol name="arrow" /></button><button className="precinct-text-button" disabled={!ready} onClick={() => { setEntered(true); }}>Skip arrival</button></div><div className="welcome-meta"><span>01 / ORIENTATION</span><span>EXPLORE AT YOUR OWN PACE</span></div></section> : <>
      <section className="precinct-objective" aria-label="Current objective"><span className="precinct-kicker">ON YOUR SHIFT</span><h1>{orientation.title}</h1><p>{orientation.description}</p><div className="shift-progress" role="progressbar" aria-label="Orientation progress" aria-valuemin={0} aria-valuemax={6} aria-valuenow={orientation.completed}><span style={{ width: `${String((orientation.completed) / 6 * 100)}%` }} /></div><small>STEPS COMPLETE <span>{orientation.completed} OF 6</span></small></section>
      <Minimap pose={pose} onMap={() => { setPanel("map"); }} />
      {hotspot !== undefined && panel === null && !paused ? <button className="precinct-interact" onClick={() => { setPanel(hotspot.id); }}><kbd>E</kbd><span>{hotspot.label}</span><Symbol name="arrow" /></button> : null}
      {interviewUi.state.seated && panel === null ? <div className="precinct-seat-controls"><button type="button" onClick={() => { open("interview"); }}>Interview controls</button><button type="button" onClick={leaveSeat}>Leave interview seat</button><button type="button" onClick={() => { go(6); }}>Visit observation room</button></div> : null}
      <div className="precinct-controls">{flatView ? <><span><kbd>1–0</kbd> Visit a station</span><span><kbd>M</kbd> Directory</span><span><kbd>E</kbd> Open station</span></> : <><span><kbd>W A S D</kbd> Walk</span><span><kbd>↔ ↕</kbd> Look</span><span>Right-click mouse look</span><span><kbd>V</kbd> {cameraMode === "first" ? "First person" : cameraMode === "third" ? "Third person" : "Free camera"}</span><span><kbd>Shift</kbd> Sprint</span></>}</div>
      <button className="precinct-pause" onClick={() => { if (paused) resume(); else setPaused(true); }}>{paused ? "Resume exploration" : "Pause"}<kbd>Esc</kbd></button>
    </>}
    {paused && panel === null ? <div className="precinct-paused"><span>EXPLORATION PAUSED</span><h2>Take your time.</h2><p>Press V to change the camera, or resume when you’re ready.</p><button className="precinct-primary" onClick={resume}>Resume<Symbol name="arrow" /></button></div> : null}
    <footer className="precinct-ground-rule">{EX4_TEXT}</footer>

    {panel === "map" ? <Modal title="Find your way." onClose={close}><p className="panel-lead">Every part of your training has a place here. Walk there, or choose a station to fast travel.</p><div className="station-directory">{STATIONS.map((item, index) => <button key={item.id} onClick={() => { go(index); }}><kbd>{item.key}</kbd><span><strong>{item.label}</strong><small>{item.description}</small></span><Symbol name="arrow" /></button>)}</div></Modal> : null}
    {panel === "settings" ? <Modal title="Make yourself comfortable." onClose={close}><p className="panel-lead">Your pace. Your point of view.</p><div className="precinct-settings"><label><span>Reduced motion<small>Steady cameras and still background gestures</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => { setReducedMotion(event.target.checked); }} /></label><label><span>Larger text<small>More readable panels and subtitles</small></span><input type="checkbox" checked={largeText} onChange={(event) => { setLargeText(event.target.checked); }} /></label><label><span>High contrast<small>Opaque, clearly separated interface surfaces</small></span><input type="checkbox" checked={contrast} onChange={(event) => { setContrast(event.target.checked); }} /></label><label><span>Rendering quality<small>Rendering can step down automatically for smoother movement</small></span><select value={tier} onChange={(event) => { const value = event.target.value; if (value === "high" || value === "medium" || value === "low") setTier(value); }}><option value="low">Low</option><option value="medium">Balanced</option><option value="high">High</option></select></label></div><p className="precinct-note">Keyboard-only: WASD moves, arrow keys look, E interacts, V changes camera, M opens the map. Number keys 1–0 fast travel. A connected controller uses the sticks to move/look and A to interact.</p></Modal> : null}
    {panel !== null && panel !== "map" && panel !== "settings" ? <Modal title={expandedMonitor === null ? station?.label ?? MANIFEST.hotspots.find((item) => item.id === panel)?.label ?? "Precinct station" : STYLE_NAMES[expandedMonitor]} onClose={close} wide={station?.id === "interview" || station?.id === "observation" || expandedMonitor !== null}>{staffStation !== null ? <ReceptionBriefingPanel key={briefingScope} station={staffStation} assignment={session.selectedCase} controller={npcController} checkedIn={checkedIn} briefed={briefed} onCheckIn={() => { setCheckedIn(true); }} onBriefed={() => { if (session.selectedCase !== null) setBriefedScope({ scope: briefingScope, owner: preparationOwner }); }} onTravel={travelToHotspot} /> : station?.id === "dossier" ? <><PrecinctDeskPanel key={notebook.key} session={session} notebook={notebook} reviewed={fileReviewed} onReviewed={() => { if (session.packetState === "ready" && session.packet !== null && !notebook.readOnly) setReviewedScope({ scope: reviewScope, owner: preparationOwner }); }} onChooseCase={() => { setPanel("case_board"); }} onUiEvent={dossierEvent} {...(session.source === "recording" ? {} : { onPresentEvidence: (source: PublicEvidenceRef) => { evidenceAction({ type: "present", source }); } })} /><div className="precinct-interview-links"><button type="button" onClick={() => { travelToHotspot("interview"); }}>Visit interview room</button></div></> : station?.id === "board_wall" ? <PrecinctCaseChoicePanel session={session} onSelect={selectCase} onDesk={() => { travelToHotspot("personal_dossier"); }} /> : station?.id === "interview" ? <>
      <InterviewStationPanel key={interviewScope} session={{ ...session, view: publicView, playback: { ...session.playback, seekTo: (time) => { session.playback.seekTo(time); work.sample(true); } } }} still={reducedMotion || presentationPaused} tab={interviewUi.state.tab} onTabChange={(tab) => { if (interviewUi.actions.tab(tab)) interviewEvent({ type: "interview.tab", tab }); }} citation={interviewUi.state.citation} onCite={(turn, quote) => { interviewUi.actions.cite(turn, quote); }} evidenceScope={interviewScope} evidenceState={interviewUi.state.table} onEvidenceAction={evidenceAction} onUseEvidenceQuestion={useEvidenceQuestion} freshRecordId={session.world?.wall.find(item => item.fresh)?.record_id ?? null} startInterview={startInterview} called={interviewUi.state.called} seated={interviewUi.state.seated} onCallSubject={session.packetState === "ready" && session.packet?.case_id === session.selectedCase?.case_id ? () => { if (interviewUi.actions.call()) interviewEvent({ type: "intercom.call" }); } : null} onSit={seat} onExitSeat={leaveSeat} />
      <div className="precinct-interview-links"><button type="button" onClick={() => { go(6); }}>Visit observation room</button><button type="button" onClick={() => { go(7); }}>Recorded runs and published debrief</button></div>
    </> : station?.id === "observation" ? <>
      <div ref={observationContent} hidden={expandedMonitor !== null}><ObservationStationPanel frame={work.frame} assessment={assessment} onExpandMonitor={expandMonitor} onReturnToInterview={() => { go(5); }} />{flatView ? <p className="precinct-note">The accessible view shows the current public events and seeks. Decorative motion between events is paused without the 3D renderer.</p> : null}</div>
      {expandedMonitor === null ? null : <div className="precinct-full-monitor" ref={expandedContent} tabIndex={-1} aria-label={`${STYLE_NAMES[expandedMonitor]} expanded`}><AgentWorkMonitor frame={work.frame} style={expandedMonitor} size="full" onStyleChange={setExpandedMonitor} /><button type="button" className="precinct-secondary" onClick={close}>Back to four screens</button></div>}
    </> : station?.id === "debrief" ? assessment ? <p className="panel-lead">Assessment in progress. Recorded runs and review are withheld until this run publishes its debrief.</p> : <>
      <SessionRecordingsPanel session={session} />
      <div className="precinct-interview-links"><button type="button" onClick={() => { go(5); }}>Visit interview room for playback controls</button></div>
      <SessionDebriefPanel debrief={session.debrief} view={session.view} recorded={session.source === "recording"} />
    </> : <><span className="station-tag">PRECINCT ORIENTATION</span><p className="panel-lead">{station?.description ?? "Welcome to the investigation training center."}</p><p>This station is being brought into the world. The existing interview, recorded runs, and training tools remain available below.</p></>}<div className="station-actions">{inWorldSessionStation ? null : <Link className="precinct-primary" to="/session">Open training session<Symbol name="arrow" /></Link>}<Link className="precinct-secondary" to="/trust/methodology">Trust & methodology</Link></div><aside className="precinct-safety"><strong>Evidence first. Always.</strong><p>Nervousness, demeanor, accent and stress are never evidence.</p><p>{EX4_TEXT}</p></aside></Modal> : null}
  </div>;
}
