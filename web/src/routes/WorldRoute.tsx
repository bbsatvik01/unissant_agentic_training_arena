/**
 * The arena's world (D-020): the precinct hub, then the interview room of the chosen case, with the 2D overlay
 * (DESIGN.md components) around the 3D view. Opening the recorded case (F01) loads its recording and plays it
 * through the same reducer the live room will use (D-021); the other cases open their room and brief and wait for
 * live sessions (stage 2, after WP-13).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { CoachPanel } from "../components/overlay/CoachPanel";
import { Composer, PlaybackBar } from "../components/overlay/Controls";
import { DebriefScore } from "../components/overlay/DebriefScore";
import { EvidencePanel } from "../components/overlay/EvidencePanel";
import { FindingPanel } from "../components/overlay/FindingPanel";
import { Tabs } from "../components/overlay/Tabs";
import { Transcript } from "../components/overlay/Transcript";
import type { WallDocument } from "../components/world/moments";
import { EX4_TEXT } from "../lib/copy/ex4";
import type { RoomStatus } from "../lib/trial/trialReducer";
import { CASES, RECORDED_CASE_ID, type CaseCard } from "../lib/world/cases";
import type { CaseDocument, Recording } from "../lib/world/recording";
import { useMotionPrefs } from "./world/useMotionPrefs";
import { usePlayback } from "./world/usePlayback";

const WorldCanvas = lazy(() => import("../components/world/WorldCanvas"));

const STATUS_WORD: Readonly<Record<RoomStatus, string>> = {
  connecting: "Opening",
  awaiting_question: "Listening",
  subject_answering: "Answering",
  coach_working: "Listening",
  cap_reached: "Listening",
  finalizing: "Saving",
  ended: "Session ended",
};

const PLAYBACK_REASON = "Playback: the questions come from the recording.";
const LIVE_REASON = "Live sessions connect when the session API lands. Case F01 has a recorded run.";

type Load = { readonly state: "none" } | { readonly state: "loading" } | { readonly state: "ready"; readonly recording: Recording } | { readonly state: "error"; readonly message: string };

export function WorldRoute() {
  const { reducedMotion, paused, togglePaused } = useMotionPrefs();
  const [place, setPlace] = useState<"hub" | "room">("hub");
  const [active, setActive] = useState<CaseCard | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: "none" });
  const [arrived, setArrived] = useState(false);
  const [draft, setDraft] = useState("");
  const [cite, setCite] = useState<{ turn: number; quote: string; nonce: number } | null>(null);
  const [debriefClosed, setDebriefClosed] = useState(false);
  const [tab, setTab] = useState("coach");
  const [fileError, setFileError] = useState<string | null>(null);
  const [showPet, setShowPet] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  const recording = load.state === "ready" ? load.recording : null;
  const subjectName = recording?.case.subject.display_name ?? active?.subject.display_name ?? "Subject";
  const playback = usePlayback(recording, { subjectName, reducedMotion, paused });
  const { play, seekTo } = playback;
  const view = playback.trial.view;
  const world = playback.world;

  useEffect(() => {
    if (active?.case_id !== RECORDED_CASE_ID || load.state !== "loading") return;
    let cancelled = false;
    void Promise.all([import("../fixtures/recordings/F01-truthful.json"), import("../lib/world/parseRecording")]).then(
      ([mod, { parseRecording }]) => {
        if (cancelled) return;
        const result = parseRecording(mod.default);
        setLoad(result.ok ? { state: "ready", recording: result.recording } : { state: "error", message: result.errors.join("; ") });
      },
      () => {
        if (!cancelled) setLoad({ state: "error", message: "The recording could not be loaded." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, load.state]);

  // Once the camera has landed in the room and the recording is ready, the run plays (never in the precinct).
  useEffect(() => {
    if (arrived && place === "room" && recording !== null) play();
  }, [arrived, place, recording, play]);

  const openCase = useCallback(
    (caseId: string) => {
      // A case from the board, or the case of a recording file opened earlier (kept with its recording).
      const card = CASES.find((c) => c.case_id === caseId) ?? (active?.case_id === caseId ? active : null);
      if (card === null) return;
      setActive(card);
      // A recording already loaded for this case is kept (reopening replays it from the start).
      setLoad((l) =>
        l.state === "ready" && l.recording.case.case_id === card.case_id ? l : card.case_id === RECORDED_CASE_ID ? { state: "loading" } : { state: "none" },
      );
      setArrived(false);
      setDebriefClosed(false);
      setCite(null);
      setDraft("");
      setPlace("room");
      seekTo(0);
    },
    [seekTo, active],
  );
  // D-021: any exported run (`recordings/<trial>.json`) plays the same way, checked whole before it is used.
  const openRecordingFile = useCallback((file: File) => {
    void Promise.all([file.text(), import("../lib/world/parseRecording")]).then(
      ([text, { parseRecording }]) => {
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          setFileError("That file is not JSON.");
          return;
        }
        const result = parseRecording(raw);
        if (!result.ok) {
          setFileError(`The recording was refused: ${result.errors.slice(0, 3).join("; ")}`);
          return;
        }
        const c = result.recording.case;
        setFileError(null);
        setActive({
          case_id: c.case_id,
          title: c.title,
          objective: c.objective,
          domain: c.domain,
          difficulty_level: c.difficulty_level,
          subject: c.subject,
          facility: c.setting,
          initial_documents: c.initial_documents.length,
          requestable_records: result.recording.snapshot.requestable.length,
        });
        setLoad({ state: "ready", recording: result.recording });
        setArrived(false);
        setDebriefClosed(false);
        setCite(null);
        setPlace("room");
      },
      () => {
        setFileError("The file could not be read.");
      },
    );
  }, []);
  const backToHub = useCallback(() => {
    playback.pause();
    setPlace("hub");
    setArrived(false);
  }, [playback]);
  const onArrive = useCallback(() => {
    setArrived(true);
  }, []);
  const onCite = useCallback((turn: number, quote: string) => {
    setCite((c) => ({ turn, quote, nonce: (c?.nonce ?? 0) + 1 }));
  }, []);

  const documents: readonly CaseDocument[] = useMemo(() => recording?.case.initial_documents ?? [], [recording]);
  const wallDocs: readonly WallDocument[] = useMemo(() => {
    const initial = documents.map((d) => ({ id: d.doc_id, title: d.title, note: "Initial document", releasedAt: null }));
    const released = (world?.wall ?? []).map((p) => ({ id: p.record_id, title: p.title, note: `Released at T${String(p.releasedAtTurn)}`, releasedAt: p.releasedAt }));
    return [...initial, ...released];
  }, [documents, world?.wall]);

  const flag = world?.flag ?? null;
  const highlighted = useMemo(() => {
    const set = new Set<number>();
    if (flag !== null) {
      set.add(flag.turn);
      if (flag.conflictTurn !== null) set.add(flag.conflictTurn);
    }
    if (cite !== null) set.add(cite.turn);
    return set;
  }, [flag, cite]);

  const freshId = world?.wall.find((p) => p.fresh)?.record_id ?? null;
  const focusCard = CASES.find((c) => c.case_id === focused) ?? active ?? CASES[0] ?? null;
  const debrief = recording?.debrief ?? null;
  const showDebrief = place === "room" && world?.debriefReady === true && debrief !== null && !debriefClosed;
  // Reduced motion or the pause control: loops stop, camera moves cut, signature moments show their end state.
  const still = reducedMotion || paused;

  return (
    <div className="app" data-place={place} data-paused={paused ? "true" : "false"}>
      <header className="topbar">
        <div className="brand">
          <span className="eyebrow">Training arena</span>
          <span className="crumb">{place === "hub" ? "Precinct" : (active?.title ?? "Interview room")}</span>
        </div>
        <div className="topbar-meta">
          {place === "room" && view !== null ? (
            <>
              <span className="badge">{view.mode === "practice" ? "Practice" : "Assessment"}</span>
              <span className="badge mono">
                {view.exchangesUsed}/{view.exchangesCap} exchanges
              </span>
              <span className="badge" data-state={view.status}>
                {subjectName}: {STATUS_WORD[view.status]}
              </span>
            </>
          ) : null}
          {place === "room" ? (
            <button
              type="button"
              className="btn-secondary-sm"
              aria-pressed={!showPet}
              onClick={() => {
                setShowPet((v) => !v);
              }}
            >
              {showPet ? "Hide companion" : "Show companion"}
            </button>
          ) : null}
          <button type="button" className="btn-secondary-sm" aria-pressed={paused} onClick={togglePaused}>
            {paused ? "Resume motion" : "Pause motion"}
          </button>
          {place === "room" ? (
            <button type="button" className="btn-secondary-sm" onClick={backToHub}>
              Back to precinct
            </button>
          ) : null}
        </div>
      </header>

      <main className="stage">
        <aside className="side left" data-open={leftOpen ? "true" : "false"}>
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={leftOpen}
            onClick={() => {
              setLeftOpen((v) => !v);
            }}
          >
            {leftOpen ? "Hide" : place === "hub" ? "Cases" : "Transcript"}
          </button>
          {place === "hub" ? (
            <section className="panel" aria-labelledby="cases-title">
              <header className="panel-head">
                <h1 id="cases-title">Pick a case file.</h1>
              </header>
              <div className="panel-body">
                <p className="lead">Five practice cases from the development split. Open one to step into its interview room.</p>
                <ul className="case-list">
                  {CASES.map((c) => (
                    <li key={c.case_id}>
                      <button
                        type="button"
                        className="case-item"
                        data-active={focused === c.case_id ? "true" : "false"}
                        onMouseEnter={() => {
                          setFocused(c.case_id);
                        }}
                        onFocus={() => {
                          setFocused(c.case_id);
                        }}
                        onClick={() => {
                          openCase(c.case_id);
                        }}
                      >
                        <span className="mono">{c.case_id}</span>
                        <span className="case-title">{c.title}</span>
                        <span className="fine">
                          {c.subject.display_name}, level {c.difficulty_level}
                          {c.case_id === RECORDED_CASE_ID ? " · recorded run" : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <label className="btn-secondary-sm file-pick">
                  Play a recording file
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file !== undefined) openRecordingFile(file);
                      e.target.value = "";
                    }}
                  />
                </label>
                {fileError === null ? null : (
                  <p className="fine" role="alert">
                    {fileError}
                  </p>
                )}
              </div>
            </section>
          ) : (
            <Transcript
              turns={view?.turns ?? []}
              voiceExchanges={view?.voiceExchanges ?? []}
              released={view?.released ?? []}
              subjectName={subjectName}
              highlighted={highlighted}
              motionOff={still}
              quote={cite === null ? null : { turn: cite.turn, text: cite.quote }}
              focusTurn={cite === null ? null : { turn: cite.turn, nonce: cite.nonce }}
            />
          )}
        </aside>

        <div className="center">
          <div className="viewport">
            <Suspense fallback={<p className="loading viewport-loading">Loading the precinct</p>}>
              <WorldCanvas
                place={place}
                world={world}
                cases={CASES}
                recordedCaseId={RECORDED_CASE_ID}
                subjectName={subjectName}
                focusedCase={focused}
                documents={wallDocs}
                clock={playback.clock}
                still={still}
                reducedMotion={still}
                showPet={showPet}
                onOpenCase={openCase}
                onFocusCase={setFocused}
                onArrive={onArrive}
              />
            </Suspense>
            {place === "room" && world?.debriefReady === true && debrief !== null && debriefClosed ? (
              <button
                type="button"
                className="btn-secondary-sm debrief-open"
                onClick={() => {
                  setDebriefClosed(false);
                }}
              >
                Open debrief
              </button>
            ) : null}
            {showDebrief ? (
              <DebriefScore
                debrief={debrief}
                reducedMotion={still}
                onClose={() => {
                  setDebriefClosed(true);
                }}
              />
            ) : null}
          </div>
          {place === "room" ? (
            <div className="room-controls">
              <p className="caption" role="status">
                {load.state === "loading"
                  ? "Loading the recorded run."
                  : load.state === "error"
                    ? `The recording was refused: ${load.message}`
                    : (world?.caption ?? (active === null ? "" : `${active.subject.display_name}, ${active.subject.position}. ${LIVE_REASON}`))}
              </p>
              {recording === null ? null : (
                <PlaybackBar
                  playing={playback.playing}
                  speed={playback.speed}
                  clock={playback.clock}
                  duration={playback.duration}
                  onPlay={playback.play}
                  onPause={playback.pause}
                  onSpeed={playback.setSpeed}
                  onSeek={playback.seekTo}
                />
              )}
              <Composer draft={draft} onDraft={setDraft} onSend={null} reason={recording === null ? LIVE_REASON : PLAYBACK_REASON} />
            </div>
          ) : (
            <p className="caption">Point at a file on the board, or use the list, to open a case.</p>
          )}
        </div>

        <aside className="side right" data-open={rightOpen ? "true" : "false"}>
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={rightOpen}
            onClick={() => {
              setRightOpen((v) => !v);
            }}
          >
            {rightOpen ? "Hide" : place === "hub" ? "Brief" : "Coach, evidence, finding"}
          </button>
          {place === "hub" ? (
            focusCard === null ? null : (
              <section className="panel" aria-labelledby="brief-title">
                <header className="panel-head">
                  <span className="eyebrow mono">{focusCard.case_id}</span>
                </header>
                <div className="panel-body">
                  <h2 id="brief-title" className="brief-title">
                    {focusCard.title}
                  </h2>
                  <p>{focusCard.objective}</p>
                  <dl className="facts">
                    <div>
                      <dt>Subject</dt>
                      <dd>
                        {focusCard.subject.display_name}, {focusCard.subject.position}
                      </dd>
                    </div>
                    <div>
                      <dt>Facility</dt>
                      <dd>{focusCard.facility}</dd>
                    </div>
                    <div>
                      <dt>On file</dt>
                      <dd>
                        {focusCard.initial_documents} documents, {focusCard.requestable_records} requestable records
                      </dd>
                    </div>
                  </dl>
                  <p className="fine">{EX4_TEXT}</p>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => {
                      openCase(focusCard.case_id);
                    }}
                  >
                    Open case
                  </button>
                </div>
              </section>
            )
          ) : (
            <Tabs
              label="Room panels"
              value={tab}
              onChange={setTab}
              tabs={[
                {
                  id: "coach",
                  label: "Coach",
                  content: (<>
                {view === null ? (
                  <p className="empty">{recording === null && load.state !== "loading" ? LIVE_REASON : "Opening the session."}</p>
                ) : (
                  <CoachPanel view={view} released={view.released} documents={documents} onCite={onCite} onUseQuestion={null} />
                )}
              </>),
                },
                {
                  id: "evidence",
                  label: freshId === null ? "Evidence" : "Evidence (new)",
                  content: (<>
                <EvidencePanel
                  documents={documents}
                  released={view?.released ?? []}
                  requestable={view?.requestable ?? []}
                  exchangesUsed={view?.exchangesUsed ?? 0}
                  freshId={freshId}
                  onRequest={null}
                />
              </>),
                },
                {
                  id: "finding",
                  label: "Finding",
                  content: (<>
                <FindingPanel
                  key={active?.case_id ?? "none"}
                  committed={view?.committedFinding ?? null}
                  hash={view?.commitmentHash ?? null}
                  turns={view?.turns ?? []}
                  records={[...documents.map((d) => ({ id: d.doc_id, title: d.title })), ...(view?.released ?? []).map((r) => ({ id: r.record_id, title: r.title }))]}
                  onConfirm={null}
                  disabledReason={recording === null ? LIVE_REASON : PLAYBACK_REASON}
                />
              </>),
                },
              ]}
            />
          )}
        </aside>
      </main>

      <footer className="ex4">{EX4_TEXT}</footer>
    </div>
  );
}
