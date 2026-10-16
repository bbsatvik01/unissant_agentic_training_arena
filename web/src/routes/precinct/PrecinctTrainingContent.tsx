/** Content only, inside the route's one native dialog. Connected reads live in short-lived keyed children. */
import { useState } from "react";
import { clearRecognitionRead, useRecognitionReadBridge, type RecognitionSink } from "./useRecognitionReadBridge";
import { Link } from "react-router";
import { ArchivePanel, CaseBoardPanel, SkillProgressPanel, TrainingGroundRule } from "../../components/precinct/TrainingStations";
import { TrophyWallPanel } from "../../components/precinct/TrophyWallPanel";
import { CoachLabPanel, InstructorPanel } from "../../components/precinct/LabStations";
import { DailyDrillPanel } from "../../components/precinct/DailyDrillPanel";
import type { PrecinctStationReads } from "../../lib/api/precinctStationReads";
import type { BoardsState } from "../../lib/arena/leaderboard";
import { sessionEnded } from "../../lib/progress/progress";
import { BUNDLED_STATION_TAPES, canReplayOwnSession, ownArchiveTapes, ownSkillSession, stationCaseEntries, TRAINING_STATION_TITLES, type BundledStationTape, type TrainingStationId } from "../../lib/precinct/stationSources";
import type { LocalBackendState } from "../../lib/precinct/session";
import type { SkillId } from "../../lib/precinct/trainingStations";
import type { CaseCard } from "../../lib/world/cases";
import { useBoards } from "../world/useBoards";
import { useProgress } from "../world/useProgress";
import { useTournament, useTournamentList } from "../world/useTournament";
import type { PrecinctStations } from "./usePrecinctStations";
import "../../styles/precinct-station-integration.css";

/** Deliberately omits debrief/recording/finding/private packet data; history comes only from /api/progress. */
export interface TrainingStationSession {
  readonly backend: LocalBackendState;
  readonly me: { readonly user_id: string } | null;
  readonly stationReads: PrecinctStationReads | null;
  readonly cases: readonly CaseCard[];
  readonly selectedCase: CaseCard | null;
}
export type StationReplayRequest = { readonly kind: "bundled"; readonly tape: BundledStationTape["id"] } | { readonly kind: "local"; readonly trialId: string };

function StationNavigation({ active, onNavigate }: { readonly active: TrainingStationId; readonly onNavigate: (kind: TrainingStationId) => void }) {
  const destinations: readonly TrainingStationId[] = ["archive", "skills", "drill", "trophies", "coach_lab", "instructor", "methodology"];
  return <nav className="training-station-navigation" aria-label="Training resources">{destinations.map((kind) => <button type="button" key={kind} aria-current={kind === active ? "page" : undefined} onClick={() => { onNavigate(kind); }}>{TRAINING_STATION_TITLES[kind]}</button>)}</nav>;
}

function BundledTapes({ onReplay }: { readonly onReplay: (request: StationReplayRequest) => void }) {
  return <section className="training-station bundled-tape-shelf" aria-label="Bundled demonstration tapes"><h3>Bundled demonstration tapes</h3>
    <p className="training-meta">These recordings are supplied with the app. They are not your sessions and never count toward your progress. Dates are not supplied in these files. Loading starts paused, with sound off.</p>
    {BUNDLED_STATION_TAPES.map((tape) => <article key={tape.id} className="archive-tape"><span className="tape-spools" aria-hidden="true">◉ ━ ◉</span><div><span className="training-mono">BUNDLED DEMONSTRATION · {tape.caseId}</span><h4>{tape.label}</h4><p>{tape.caseTitle} · {tape.mode} · {tape.channel}</p><button type="button" className="training-button" onClick={() => { onReplay({ kind: "bundled", tape: tape.id }); }}>Load {tape.label}</button></div></article>)}
  </section>;
}

function OwnHistory({ api, kind, selectedPrimer, onOpenPrimer, onReplay }: {
  readonly api: PrecinctStationReads;
  readonly kind: "archive" | "skills";
  readonly selectedPrimer: SkillId;
  readonly onOpenPrimer: (id: SkillId) => void;
  readonly onReplay: (request: StationReplayRequest) => void;
}) {
  const { load, scores } = useProgress(api, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const progress = load.state === "ready" ? load.progress : null;
  const selected = progress === null ? null : ownSkillSession(progress, selectedId);
  const status = load.state === "loading" ? "Reading your local session history…" : load.state === "missing" ? "The local backend does not offer session history yet." : load.state === "error" ? "Your local session history could not be read. Reopen this station to try again." : progress?.sessions.length === 0 ? "You have no local sessions yet." : null;
  return <>
    {status === null ? null : <p className="training-notice" role="status">{status}</p>}
    {kind === "archive" ? <ArchivePanel key={selectedPrimer} selectedPrimer={selectedPrimer} tapes={progress === null ? [] : ownArchiveTapes(progress)} onReplay={(trialId) => { if (progress !== null && canReplayOwnSession(progress, trialId)) onReplay({ kind: "local", trialId }); }} /> : <>
      {progress === null || !progress.sessions.some(sessionEnded) ? null : <label className="training-session-select">Published feedback from your session<select value={selected?.session_id ?? ""} onChange={(event) => { setSelectedId(event.target.value); }}>{progress.sessions.filter(sessionEnded).map((session) => <option key={session.session_id} value={session.session_id}>{session.case_title ?? "Training session"} · {session.mode} · {session.session_id}</option>)}</select></label>}
      <SkillProgressPanel score={selected === null ? undefined : scores[selected.session_id]} sourceLabel={selected === null ? "No completed session with published feedback has been selected from your local history." : `Your local session ${selected.session_id}. Values appear only when its own debrief is published.`} kpi1={progress?.kpi1 ?? null} onOpenPrimer={onOpenPrimer} />
    </>}
  </>;
}

function ConnectedTrophyWall({ api, motionOff, recognition }: { readonly api: PrecinctStationReads; readonly motionOff: boolean; readonly recognition?: RecognitionSink }) {
  const list = useTournamentList(api, true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [label, setLabel] = useState<"original" | null>(null);
  const selected = list.state === "ready" ? list.list.find((entry) => entry.id === selectedId) ?? null : null;
  const tournament = useTournament(api, selected?.id ?? null, selected !== null);
  const revealed = tournament.state === "ready" && tournament.tournament.state === "revealed";
  const boards = useBoards(api, selected?.id ?? null, label, selected !== null, revealed);
  // Both contracts must permit display. An accidental published body must not override a sealed ledger.
  const boardState: BoardsState | null = tournament.state === "error" ? { kind: "error" } : tournament.state === "missing" ? { kind: "missing" } : tournament.state !== "ready" || boards === null ? null : boards.state.kind === "published" && !revealed ? { kind: "sealed" } : boards.state;
  useRecognitionReadBridge(recognition, {
    tournamentId: selected?.id ?? null, label,
    ledger: tournament.state === "error" ? "error" : tournament.state === "missing" ? "missing" : tournament.state !== "ready" ? "pending" : revealed ? "revealed" : "sealed",
    state: boardState, assistant: boardState?.kind === "published" ? boards?.assistant ?? null : null,
  });
  return <>
    {list.state === "loading" ? <p role="status">Reading the local tournament list…</p> : list.state === "missing" ? <p role="status">The local backend does not offer tournaments yet.</p> : list.state === "error" ? <p role="status">The local tournament list could not be read. Reopen the trophy wall to try again.</p> : null}
    {list.state === "ready" ? <label className="training-session-select">Published tournament<select value={selected?.id ?? ""} onChange={(event) => { clearRecognitionRead(recognition, event.target.value || null, null); setSelectedId(event.target.value || null); setLabel(null); }}><option value="">Choose a tournament</option>{list.list.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.status}</option>)}</select></label> : null}
    {selected === null ? <div className="training-station"><p className="training-meta">Choose a supplied tournament to read its publication status. No example scores or ranks stand in for missing results.</p><TrainingGroundRule /></div> : <>
      <label className="training-session-select">Board publication<select value={label ?? "current"} onChange={(event) => { clearRecognitionRead(recognition, selected.id, event.target.value === "original" ? "original" : null); setLabel(event.target.value === "original" ? "original" : null); }}><option value="current">Current publication</option><option value="original">Original publication</option></select></label>
      {boardState === null ? <div className="training-station"><p role="status">Reading the tournament’s publication status…</p><TrainingGroundRule /></div> : <TrophyWallPanel state={boardState} assistant={boardState.kind === "published" ? boards?.assistant ?? null : null} subject={boardState.kind === "published" ? boards?.subject ?? null : null} motionOff={motionOff} />}
    </>}
  </>;
}

export function PrecinctTrainingContent({ kind, session, stations, assessmentActive, motionOff, onSelectCase, onNavigate, onReplay, onDesk, recognition }: {
  readonly kind: TrainingStationId;
  readonly recognition?: RecognitionSink;
  readonly session: TrainingStationSession;
  readonly stations: PrecinctStations;
  readonly assessmentActive: boolean;
  readonly motionOff: boolean;
  readonly onSelectCase: (caseId: string) => void;
  readonly onNavigate: (kind: TrainingStationId) => void;
  readonly onReplay: (request: StationReplayRequest) => void;
  readonly onDesk: () => void;
}) {
  const connected = session.backend === "connected" && session.me !== null && session.stationReads !== null;
  const entries = stationCaseEntries(session.cases, connected);
  const openPrimer = (id: SkillId) => { if (!assessmentActive) { stations.choosePrimer(id); onNavigate("archive"); } };
  // Do not mount read hooks or local instructor/playbook controls while assessment guidance is withheld.
  if (assessmentActive && kind !== "cases" && kind !== "methodology") return <div className="training-station"><p className="training-notice" role="status">Training resources and prior-session feedback are unavailable during an assessment. They return after the published debrief.</p><TrainingGroundRule /></div>;
  return <>
    {kind === "cases" ? <><CaseBoardPanel entries={entries} selectedCaseId={session.selectedCase?.case_id ?? null} assessmentActive={assessmentActive} onSelect={(id) => { if (!assessmentActive && entries.some((entry) => entry.card.case_id === id && entry.availability.kind === "available")) onSelectCase(id); }} />{session.selectedCase === null ? null : <button type="button" className="training-button" onClick={onDesk}>Go to your desk</button>}</> : null}
    {kind === "trophies" ? connected ? <ConnectedTrophyWall key={JSON.stringify([session.me.user_id, recognition?.scope])} api={session.stationReads} motionOff={motionOff} {...(recognition === undefined ? {} : { recognition })} /> : <div className="training-station"><p className="training-notice">No local tournament source is connected. Connect explicitly in the interview controls to read real publication status.</p><TrainingGroundRule /></div> : null}
    {kind === "archive" || kind === "skills" ? <>
      {connected ? <OwnHistory key={`${session.me.user_id}:${kind}`} api={session.stationReads} kind={kind} selectedPrimer={stations.selectedPrimer} onOpenPrimer={openPrimer} onReplay={onReplay} /> : kind === "archive" ? <><p className="training-notice">Your session history is offline. The technique primers and supplied demonstration tapes are available locally.</p><ArchivePanel key={stations.selectedPrimer} selectedPrimer={stations.selectedPrimer} tapes={[]} onReplay={() => undefined} /></> : <SkillProgressPanel score={undefined} sourceLabel="No participant history is connected. Bundled and imported recordings never count as your progress." onOpenPrimer={openPrimer} />}
      {kind === "archive" ? <BundledTapes onReplay={onReplay} /> : null}
    </> : null}
    {kind === "coach_lab" ? <CoachLabPanel source={stations.coachLab} onShowLocalDemo={stations.showCoachDemo} /> : null}
    {kind === "instructor" ? <InstructorPanel demoEnabled={stations.instructorDemo} cases={session.cases} assignments={stations.assignments} annotations={stations.annotations} onEnableDemo={stations.enableInstructorDemo} onAssignmentDraft={(draft) => { if (session.cases.some((card) => card.case_id === draft.caseId)) stations.addAssignment(draft); }} onAnnotationDraft={stations.addAnnotation} /> : null}
    {kind === "drill" ? session.selectedCase === null ? <div className="training-station"><p className="training-notice">Choose a public case before beginning the local writing warm-up.</p><button type="button" className="training-button" onClick={() => { onNavigate("cases"); }}>Visit the case board</button><TrainingGroundRule /></div> : <DailyDrillPanel caseCard={session.selectedCase} state={stations.drill} nowMs={stations.nowMs} onAction={stations.drillAction} /> : null}
    {kind === "methodology" ? <div className="training-station"><span className="station-tag">RECORDS & METHODOLOGY</span><h3>Know what the measures mean.</h3><p>Review the published methodology, safeguards, and limits of this synthetic training system.</p><Link className="training-button" to="/trust/methodology">Read trust & methodology</Link><TrainingGroundRule /></div> : null}
    <StationNavigation active={kind} onNavigate={onNavigate} />
  </>;
}
