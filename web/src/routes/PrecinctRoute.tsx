import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
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
import "../styles/precinct.css";

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

function Modal({ title, onClose, children }: { readonly title: string; readonly onClose: () => void; readonly children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="precinct-dialog" ref={dialog} aria-labelledby="station-title" onCancel={onClose}>
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

export interface PrecinctRouteProps {
  /** Ordered dossier events stay parent-owned. No network or automatic persistence is added here. */
  readonly onDossierUiEvent?: (event: DossierUiEvent, context: { readonly caseId: string; readonly sessionKey: string }) => void;
}

export function PrecinctRoute({ onDossierUiEvent }: PrecinctRouteProps = {}) {
  const npcController = usePrecinctNpcController();
  const [checkedIn, setCheckedIn] = useState(false);
  const [briefedScope, setBriefedScope] = useState<string | null>(null);
  const [reviewedScope, setReviewedScope] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [ready, setReady] = useState(false);
  const [flatView, setFlatView] = useState(false);
  const [pose, setPose] = useState<PlayerPose>(INITIAL_POSE);
  const [paused, setPaused] = useState(false);
  const [cameraMode, setCameraMode] = useState<CameraMode>("first");
  const [panel, setPanel] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [largeText, setLargeText] = useState(false);
  const [contrast, setContrast] = useState(false);
  const [tier, setTier] = useState<Tier>("medium");
  const travel = useRef<TravelCommand | null>(null);
  const onReady = useCallback(() => { setReady(true); }, []);
  const onUnavailable = useCallback(() => { setFlatView(true); setReady(true); }, []);
  const resume = useCallback(() => { setPaused(false); setCameraMode((mode) => mode === "free" ? "first" : mode); }, []);
  const open = useCallback((id: string) => { setPanel(id); }, []);
  const close = useCallback(() => { setPanel(null); }, []);
  const hotspot = MANIFEST.hotspots.find((item) => item.id === pose.hotspot);
  const room = [...raw.rooms].reverse().find((candidate) => pose.position[0] >= (candidate.bounds.min[0] ?? 0) && pose.position[0] <= (candidate.bounds.max[0] ?? 0) && pose.position[2] >= (candidate.bounds.min[2] ?? 0) && pose.position[2] <= (candidate.bounds.max[2] ?? 0));
  const session = usePrecinctSession({ reducedMotion, paused, audioInRoom: room?.id === "interview" || room?.id === "observation" });
  const notebookScope = JSON.stringify([session.source === "idle" ? "browser-preparation" : session.me?.user_id ?? "browser-preparation", session.source, session.sessionKey]);
  const notebook = usePrecinctNotebook({ packet: session.packet, released: session.released, scope: notebookScope, readOnly: session.source === "recording", caseId: session.selectedCase?.case_id ?? null, source: session.source, runKey: session.source === "live" && session.live.phase === "running" ? session.sessionKey : null });
  const briefed = session.selectedCase !== null && briefedScope === notebookScope;
  const fileReviewed = session.packet !== null && reviewedScope === notebook.key && !notebook.readOnly;
  const selectPublicCase = session.selectCase;
  const selectCase = useCallback((caseId: string) => {
    setBriefedScope(null); setReviewedScope(null); selectPublicCase(caseId);
  }, [selectPublicCase]);
  const dossierEvent = useCallback((event: DossierUiEvent) => {
    if (session.packet !== null) onDossierUiEvent?.(event, { caseId: session.packet.case_id, sessionKey: session.sessionKey });
  }, [onDossierUiEvent, session.packet, session.sessionKey]);
  const station = STATIONS.find((item) => item.id === panel || item.id === MANIFEST.hotspots.find((item) => item.id === panel)?.room);
  const go = useCallback((index: number) => {
    const destination = STATIONS[index];
    if (destination === undefined) return;
    travel.current = { position: destination.anchor, yaw: destination.yaw, instant: true };
    setEntered(true); setPanel(null); resume();
    if (flatView) setPose({ position: destination.anchor, yaw: destination.yaw, speed: 0, hotspot: MANIFEST.hotspots.find((item) => item.room === destination.id)?.id ?? null });
  }, [flatView, resume]);

  const travelToHotspot = useCallback((id: string) => {
    const target = MANIFEST.hotspots.find((item) => item.id === id);
    if (target === undefined) return;
    const index = STATIONS.findIndex((item) => item.id === target.room);
    if (index >= 0) { go(index); return; }
    // Corridor landmarks have their own clear manifest anchor, outside the ten room shortcuts.
    const position: Vec3 = [target.position[0], 0, target.position[2]];
    const authored = raw.hotspots.find((item) => item.id === id);
    const yaw = authored === undefined ? 0 : Math.atan2(position[0] - (authored.lookAt[0] ?? 0), position[2] - (authored.lookAt[2] ?? 0));
    travel.current = { position, yaw, instant: true };
    setEntered(true); setPanel(null); resume();
    if (flatView) setPose({ position, yaw, speed: 0, hotspot: id });
  }, [go, flatView, resume]);
  const staffStation = station?.id === "lobby" ? "reception" : station?.id === "briefing" ? "briefing" : station?.id === "open_office" ? "office" : null;
  const orientationStep = checkedIn ? (briefed ? (fileReviewed ? 4 : 3) : 2) : 1;

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input,textarea,select,[role=dialog],dialog")) return;
      if (event.repeat || !entered) return;
      if (event.code === "KeyE" && flatView && !paused && panel === null && pose.hotspot !== null) setPanel(pose.hotspot);
      if (event.code === "KeyV" && !flatView) setCameraMode((mode) => nextCameraMode(mode, paused));
      if (event.code === "KeyM") setPanel((current) => current === "map" ? null : "map");
      if (event.code === "Escape") { if (panel !== null) setPanel(null); else if (paused) resume(); else setPaused(true); }
      const index = STATIONS.findIndex((item) => event.key === item.key);
      if (index >= 0 && panel === null) go(index);
    };
    window.addEventListener("keydown", listener);
    return () => { window.removeEventListener("keydown", listener); };
  }, [entered, paused, panel, go, resume, flatView, pose.hotspot]);

  return <div className={`precinct-root${largeText ? " large-text" : ""}${contrast ? " high-contrast" : ""}`}>
    <div className="precinct-stage"><RenderBoundary onUnavailable={onUnavailable} fallback={<div className="precinct-flat-view" role="img" aria-label="Original precinct lobby preview" />}><Suspense fallback={<div className="precinct-loading">Opening the precinct…</div>}><PrecinctCanvas manifest={MANIFEST} active={entered && panel === null} paused={paused} cameraMode={cameraMode} reducedMotion={reducedMotion} tier={tier} onTierChange={setTier} travel={travel} onPose={setPose} onInteract={open} onReady={onReady} /></Suspense></RenderBoundary></div>
    <div className="precinct-vignette" />
    {flatView ? <div className="precinct-render-notice" role="status">3D rendering is unavailable on this device. Use the map or number keys to visit each station.</div> : null}
    <header className="precinct-header">
      <Link className="precinct-brand" to="/" aria-label="Arena precinct home"><span className="brand-emblem"><Symbol name="compass" /></span><span>ARENA<small>INVESTIGATION TRAINING</small></span></Link>
      <div className="precinct-location"><span className="live-dot" />WASHINGTON, DC <span>/</span> {entered ? room?.name ?? "Investigation Hall" : "NORTHSTAR PRECINCT"}</div>
      <div className="precinct-header-actions"><span className="local-badge">LOCAL TRAINING</span><button className="icon-button" aria-label="Comfort and accessibility settings" onClick={() => { setPanel("settings"); }}><Symbol name="settings" /></button></div>
    </header>

    {!entered ? <section className="precinct-welcome" aria-labelledby="welcome-title"><div className="welcome-rule" /><span className="precinct-kicker">YOUR NEXT CHAPTER BEGINS WITH A QUESTION</span><h1 id="welcome-title">Start your shift.</h1><p>A place to practice listening, follow the evidence,<br />and make a finding you can support.</p><div className="welcome-actions"><button className="precinct-primary" disabled={!ready} onClick={() => { setEntered(true); travel.current = {position: [0,0,-4.2],yaw:0,instant:reducedMotion}; }}>{ready ? "Enter the precinct" : "Preparing the precinct…"}<Symbol name="arrow" /></button><button className="precinct-text-button" disabled={!ready} onClick={() => { setEntered(true); }}>Skip arrival</button></div><div className="welcome-meta"><span>01 / ORIENTATION</span><span>EXPLORE AT YOUR OWN PACE</span></div></section> : <>
      <section className="precinct-objective" aria-label="Current objective"><span className="precinct-kicker">ON YOUR SHIFT</span><h1>{!checkedIn ? "Check in at reception" : !briefed ? "Meet your training sergeant" : !fileReviewed ? "Read your case file" : "Prepare your interview"}</h1><p>{!checkedIn ? "Get your assignment. Meet your colleagues." : !briefed ? "Review the objective and evidence-first ground rule." : !fileReviewed ? "Your desk is the next stop. Follow the records." : "Your file is reviewed. Decide which neutral question to ask first."}</p><div className="shift-progress" role="progressbar" aria-label="Orientation progress" aria-valuemin={0} aria-valuemax={6} aria-valuenow={orientationStep - 1}><span style={{ width: `${String((orientationStep - 1) / 6 * 100)}%` }} /></div><small>ORIENTATION <span>{orientationStep} OF 6</span></small></section>
      <Minimap pose={pose} onMap={() => { setPanel("map"); }} />
      {hotspot !== undefined && panel === null && !paused ? <button className="precinct-interact" onClick={() => { setPanel(hotspot.id); }}><kbd>E</kbd><span>{hotspot.label}</span><Symbol name="arrow" /></button> : null}
      <div className="precinct-controls">{flatView ? <><span><kbd>1–0</kbd> Visit a station</span><span><kbd>M</kbd> Directory</span><span><kbd>E</kbd> Open station</span></> : <><span><kbd>W A S D</kbd> Walk</span><span><kbd>↔ ↕</kbd> Look</span><span>Right-click mouse look</span><span><kbd>V</kbd> {cameraMode === "first" ? "First person" : cameraMode === "third" ? "Third person" : "Free camera"}</span><span><kbd>Shift</kbd> Sprint</span></>}</div>
      <button className="precinct-pause" onClick={() => { if (paused) resume(); else setPaused(true); }}>{paused ? "Resume exploration" : "Pause"}<kbd>Esc</kbd></button>
    </>}
    {paused && panel === null ? <div className="precinct-paused"><span>EXPLORATION PAUSED</span><h2>Take your time.</h2><p>Press V to change the camera, or resume when you’re ready.</p><button className="precinct-primary" onClick={resume}>Resume<Symbol name="arrow" /></button></div> : null}
    <footer className="precinct-ground-rule">{EX4_TEXT}</footer>

    {panel === "map" ? <Modal title="Find your way." onClose={close}><p className="panel-lead">Every part of your training has a place here. Walk there, or choose a station to fast travel.</p><div className="station-directory">{STATIONS.map((item, index) => <button key={item.id} onClick={() => { go(index); }}><kbd>{item.key}</kbd><span><strong>{item.label}</strong><small>{item.description}</small></span><Symbol name="arrow" /></button>)}</div></Modal> : null}
    {panel === "settings" ? <Modal title="Make yourself comfortable." onClose={close}><p className="panel-lead">Your pace. Your point of view.</p><div className="precinct-settings"><label><span>Reduced motion<small>Steady cameras and still background gestures</small></span><input type="checkbox" checked={reducedMotion} onChange={(event) => { setReducedMotion(event.target.checked); }} /></label><label><span>Larger text<small>More readable panels and subtitles</small></span><input type="checkbox" checked={largeText} onChange={(event) => { setLargeText(event.target.checked); }} /></label><label><span>High contrast<small>Opaque, clearly separated interface surfaces</small></span><input type="checkbox" checked={contrast} onChange={(event) => { setContrast(event.target.checked); }} /></label><label><span>Rendering quality<small>Rendering can step down automatically for smoother movement</small></span><select value={tier} onChange={(event) => { const value = event.target.value; if (value === "high" || value === "medium" || value === "low") setTier(value); }}><option value="low">Low</option><option value="medium">Balanced</option><option value="high">High</option></select></label></div><p className="precinct-note">Keyboard-only: WASD moves, arrow keys look, E interacts, V changes camera, M opens the map. Number keys 1–0 fast travel. A connected controller uses the sticks to move/look and A to interact.</p></Modal> : null}
    {panel !== null && panel !== "map" && panel !== "settings" ? <Modal title={station?.label ?? MANIFEST.hotspots.find((item) => item.id === panel)?.label ?? "Precinct station"} onClose={close}>{staffStation !== null ? <ReceptionBriefingPanel key={notebookScope} station={staffStation} assignment={session.selectedCase} controller={npcController} checkedIn={checkedIn} briefed={briefed} onCheckIn={() => { setCheckedIn(true); }} onBriefed={() => { if (session.selectedCase !== null) setBriefedScope(notebookScope); }} onTravel={travelToHotspot} /> : station?.id === "dossier" ? <PrecinctDeskPanel key={notebook.key} session={session} notebook={notebook} reviewed={fileReviewed} onReviewed={() => { if (session.packetState === "ready" && session.packet !== null && !notebook.readOnly) setReviewedScope(notebook.key); }} onChooseCase={() => { setPanel("case_board"); }} onUiEvent={dossierEvent} /> : station?.id === "board_wall" ? <PrecinctCaseChoicePanel session={session} onSelect={selectCase} onDesk={() => { travelToHotspot("personal_dossier"); }} /> : <><span className="station-tag">PRECINCT ORIENTATION</span><p className="panel-lead">{station?.description ?? "Welcome to the investigation training center."}</p><p>This station is being brought into the world. The existing interview, recorded runs, and training tools remain available below.</p></>}<div className="station-actions"><Link className="precinct-primary" to="/session">Open training session<Symbol name="arrow" /></Link><Link className="precinct-secondary" to="/trust/methodology">Trust & methodology</Link></div><aside className="precinct-safety"><strong>Evidence first. Always.</strong><p>Nervousness, demeanor, accent and stress are never evidence.</p><p>{EX4_TEXT}</p></aside></Modal> : null}
  </div>;
}
