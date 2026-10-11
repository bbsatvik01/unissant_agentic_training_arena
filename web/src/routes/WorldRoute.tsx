/**
 * The arena's world (D-020, D-021, stage 2): the precinct hub, then the interview room of the chosen case, with the
 * 2D overlay (DESIGN.md components) floating on the 3D stage. A room runs one of two feeds into the same reducer and
 * world: a live session (`POST /api/sessions`, then the session controller's SSE stream) when the arena API answers,
 * or a recorded run (the bundled F01 recording or an exported file). Without the API the hub falls back to the
 * bundled case list and recordings only.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { ArenaView } from "../components/overlay/ArenaView";
import { Onboarding } from "../components/overlay/Onboarding";
import { CoachPanel } from "../components/overlay/CoachPanel";
import { Composer, PlaybackBar } from "../components/overlay/Controls";
import { DebriefScene } from "../components/overlay/DebriefScene";
import { EvidencePanel } from "../components/overlay/EvidencePanel";
import { FindingPanel } from "../components/overlay/FindingPanel";
import { Tabs } from "../components/overlay/Tabs";
import { Transcript } from "../components/overlay/Transcript";
import type { ScoreCard, WallDocument } from "../components/world/moments";
import { RUBRIC } from "../lib/copy/rubric";
import { createArenaApi } from "../lib/api/arena";
import { parseBoard, type Board } from "../lib/arena/leaderboard";
import { EMPTY_TOURNAMENT, foldPoll, type TournamentState } from "../lib/arena/tournament";
import { createApiClient } from "../lib/api/client";
import type { Debrief } from "../lib/contracts/generated/types";
import { isWire } from "../lib/contracts/validate";
import { EX4_TEXT } from "../lib/copy/ex4";
import { draftToFinding } from "../lib/copy/finding";
import type { RoomStatus, TrialView } from "../lib/trial/trialReducer";
import { CASES, RECORDED_CASE_ID, type CaseCard } from "../lib/world/cases";
import { allowedModes, nextStepText, stepLabel } from "../lib/study/study";
import { draftAfterSend } from "../lib/world/live";
import type { CaseDocument, Recording } from "../lib/world/recording";
import type { WorldState } from "../lib/world/worldState";
import { REFUSED_TEXT, useLiveSession } from "./world/useLiveSession";
import { useMe } from "./world/useMe";
import { useMotionPrefs } from "./world/useMotionPrefs";
import { useVoice } from "./world/useVoice";
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
const OFFLINE_REASON = "The arena server is not running; recorded runs only.";

type Load = { readonly state: "none" } | { readonly state: "loading" } | { readonly state: "ready"; readonly recording: Recording } | { readonly state: "error"; readonly message: string };
/** What the room is showing: choosing how to start, a live session, or a recorded run. */
type RoomMode = "choose" | "live" | "playback";

/** Why the composer cannot send right now, or null when it can. */
function composerReason(view: TrialView | null, mode: RoomMode, live: boolean): string | null {
  if (mode === "playback") return PLAYBACK_REASON;
  if (!live) return OFFLINE_REASON;
  if (mode === "choose" || view === null) return "Start the interview to ask a question.";
  if (view.status === "awaiting_question") return null;
  if (view.status === "cap_reached") return "This interview has reached its length limit; commit your finding.";
  if (view.status === "ended" || view.status === "finalizing") return "The interview is over.";
  return "One moment: the previous turn is still being answered.";
}

export function WorldRoute() {
  const { reducedMotion, paused, togglePaused } = useMotionPrefs();
  const api = useMemo(() => createArenaApi(createApiClient()), []);
  const [liveCases, setLiveCases] = useState<readonly CaseCard[] | null>(null);
  const [place, setPlace] = useState<"hub" | "room">("hub");
  const [active, setActive] = useState<CaseCard | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ state: "none" });
  const [mode, setMode] = useState<RoomMode>("choose");
  const [liveDocs, setLiveDocs] = useState<readonly CaseDocument[]>([]);
  const [arrived, setArrived] = useState(false);
  const [draft, setDraft] = useState("");
  const [cite, setCite] = useState<{ turn: number; quote: string; nonce: number } | null>(null);
  const [debriefClosed, setDebriefClosed] = useState(false);
  const [tab, setTab] = useState("coach");
  const [fileError, setFileError] = useState<string | null>(null);
  const [showPet, setShowPet] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [arena, setArena] = useState<{ assistant: Board | null; subject: Board | null; tournament: TournamentState; name: string; example: boolean } | null>(null);
  const [showArena, setShowArena] = useState(false);
  // The arena's data: the bundled examples until the leaderboard and tournament routes land (WP-16, WP-17).
  // The arena reads the published boards of the tournament named in the address (`?tournament=<id>`) from the
  // server; without one, or when the server has none, it shows the bundled example data, labeled as such.
  const openArena = () => {
    setShowArena(true);
    if (arena !== null) return;
    const tournamentId = new URLSearchParams(window.location.search).get("tournament");
    const published =
      live && tournamentId !== null
        ? Promise.all([api.leaderboard(tournamentId, "assistant"), api.leaderboard(tournamentId, "subject")]).then(
            ([a, s]) => ({ assistant: parseBoard(a), subject: parseBoard(s) }),
            () => null,
          )
        : Promise.resolve(null);
    void Promise.all([published, import("../fixtures/leaderboard.example.json"), import("../fixtures/tournament.example.json")]).then(([boards, lb, tour]) => {
      const poll: unknown = tour.default.poll;
      const real = boards !== null && boards.assistant !== null;
      setArena({
        name: real ? "Tournament leaderboards" : lb.default.tournament.name,
        assistant: real ? boards.assistant : parseBoard(lb.default.assistant),
        subject: real ? boards.subject : parseBoard(lb.default.subject),
        tournament: isWire("tournament-poll", poll) ? foldPoll(EMPTY_TOURNAMENT, poll) : EMPTY_TOURNAMENT,
        example: !real,
      });
    });
  };
  const [sound, setSound] = useState(() => {
    try {
      return window.localStorage.getItem("arena.sound") !== "0";
    } catch {
      return true;
    }
  });
  const toggleSound = () => {
    setSound((on) => {
      try {
        window.localStorage.setItem("arena.sound", on ? "0" : "1");
      } catch {
        // Storage unavailable: the toggle still works for this page.
      }
      return !on;
    });
  };

  // The live arena, when its server answers: the cases offered to this user.
  useEffect(() => {
    let cancelled = false;
    api.listCases().then(
      (cases) => {
        if (!cancelled) setLiveCases(cases);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  const live = liveCases !== null;
  const meCtl = useMe(api, live);
  const study = meCtl.me?.study ?? null;
  const canStartLive = live && meCtl.me !== null && meCtl.me.ex4_acknowledged !== null;
  const mustAcknowledge = live && meCtl.me !== null && meCtl.me.ex4_acknowledged === null;
  const modes = allowedModes(study);
  const refreshMe = meCtl.refresh;
  const [showOnboarding, setShowOnboarding] = useState(false);
  const cases = liveCases ?? CASES;

  const recording = load.state === "ready" ? load.recording : null;
  const subjectName = recording?.case.subject.display_name ?? active?.subject.display_name ?? "Subject";
  const playback = usePlayback(mode === "playback" ? recording : null, { subjectName, reducedMotion, paused });
  const session = useLiveSession({ api, caseId: mode === "playback" ? null : (active?.case_id ?? null), subjectName, reducedMotion, paused });
  const { play, seekTo } = playback;
  const liveFeed = mode === "live";
  const view: TrialView | null = liveFeed ? session.trial.view : mode === "playback" ? playback.trial.view : null;
  const world: WorldState | null = liveFeed ? session.world : mode === "playback" ? playback.world : null;
  const clock = liveFeed ? session.clock : playback.clock;

  useEffect(() => {
    if (load.state !== "loading") return;
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
  }, [load.state]);

  // Once the camera has landed in the room and the recording is ready, a recorded run plays (never in the precinct).
  useEffect(() => {
    if (arrived && place === "room" && mode === "playback" && recording !== null) play();
  }, [arrived, place, mode, recording, play]);

  // The live brief: the case's initial documents for the wall and the evidence list.
  useEffect(() => {
    if (!live || active === null || mode === "playback") return;
    let cancelled = false;
    api.caseBrief(active.case_id).then(
      (brief) => {
        if (!cancelled) setLiveDocs(brief.initialDocuments);
      },
      () => {
        if (!cancelled) setLiveDocs([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, live, active, mode]);

  const resetRoom = () => {
    setArrived(false);
    setDebriefClosed(false);
    setCite(null);
    setDraft("");
    setLiveDocs([]);
  };

  const openCase = useCallback(
    (caseId: string) => {
      const card = cases.find((c) => c.case_id === caseId) ?? (active?.case_id === caseId ? active : null);
      if (card === null) return;
      setActive(card);
      // With the server, the room offers a live interview (and the recorded run for F01); without it, the recorded
      // run plays straight away where there is one.
      const recorded = card.case_id === RECORDED_CASE_ID;
      setMode(live || !recorded ? "choose" : "playback");
      setLoad((l) => (l.state === "ready" && l.recording.case.case_id === card.case_id ? l : recorded ? { state: "loading" } : { state: "none" }));
      resetRoom();
      setPlace("room");
      seekTo(0);
    },
    [seekTo, active, cases, live],
  );

  // The recorded run plays once it is loaded and the camera has landed (the effect above).
  const watchRecording = () => {
    setMode("playback");
  };

  const startLive = (m: "practice" | "assessment") => {
    setMode("live");
    void session.start(m);
  };

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
        setMode("playback");
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
    session.stop();
    refreshMe();
    setPlace("hub");
    setArrived(false);
  }, [playback, session, refreshMe]);
  const onArrive = useCallback(() => {
    setArrived(true);
  }, []);
  // A citation always lands in a visible transcript: it opens the panel if the viewer had collapsed it.
  const onCite = useCallback((turn: number, quote: string) => {
    setLeftOpen(true);
    setCite((c) => ({ turn, quote, nonce: (c?.nonce ?? 0) + 1 }));
  }, []);

  const documents: readonly CaseDocument[] = useMemo(() => (mode === "playback" ? (recording?.case.initial_documents ?? []) : liveDocs), [mode, recording, liveDocs]);
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
  const focusCard = cases.find((c) => c.case_id === focused) ?? active ?? cases[0] ?? null;
  const liveDebrief = session.debrief !== null && "schema_version" in session.debrief ? session.debrief : null;
  const debrief: Debrief | null = liveFeed ? liveDebrief : (recording?.debrief ?? null);
  const debriefReady = liveFeed ? debrief !== null : world?.debriefReady === true && debrief !== null;
  const showDebrief = place === "room" && debriefReady && !debriefClosed;
  // The debrief scene's score cards on the wall: the document's total and five dimension scores, as they are.
  const scoreCards: readonly ScoreCard[] | null = useMemo(() => {
    if (!showDebrief || debrief === null || !debrief.scored || debrief.rubric.total === null) return null;
    return [
      { label: "Total", title: "Rubric total", score: `${String(debrief.rubric.total)}/100` },
      ...debrief.rubric.dimensions.map((d) => ({ label: d.dim_id, title: RUBRIC[d.dim_id].name, score: `${String(d.score)}/4` })),
    ];
  }, [showDebrief, debrief]);
  // Reduced motion or the pause control: loops stop, camera moves cut, signature moments show their end state.
  const still = reducedMotion || paused;
  const reason = composerReason(view, mode, live);
  // Voices speak only in the room, unmuted, live or during playback at normal speed.
  useVoice({
    world,
    view,
    subjectName,
    clock,
    active: sound && place === "room" && !paused && (liveFeed || (mode === "playback" && playback.playing && playback.speed === 1)),
    scope: liveFeed ? (session.session?.session_id ?? "live") : (recording?.trial_id ?? "none"),
  });
  // The study step may have moved once a session ends: read /api/me again (S6 3.2).
  const trialEnded = liveFeed && view?.status === "ended";
  useEffect(() => {
    if (trialEnded) refreshMe();
  }, [trialEnded, refreshMe]);
  const canAct = liveFeed && view !== null && (view.status === "awaiting_question" || view.status === "cap_reached");

  const caption = (() => {
    // A study participant's refused start is the study's order (S6 3.2): the server states only a code.
    if (liveFeed && session.error === REFUSED_TEXT && study !== null && session.phase === "error") return `This is not the next step of the study. ${stepLabel(study)}: ${nextStepText(study)}`;
    if (liveFeed && session.error !== null) return session.error;
    if (liveFeed && session.connectionError !== null) return session.connectionError;
    if (liveFeed && session.phase === "starting") return "Opening the interview room.";
    if (liveFeed && session.connection === "scoring") return "Scoring the session.";
    if (mode === "playback" && load.state === "loading") return "Loading the recorded run.";
    if (mode === "playback" && load.state === "error") return `The recording was refused: ${load.message}`;
    if (world !== null) return world.caption;
    if (active === null) return "";
    return `${active.subject.display_name}, ${active.subject.position}.${live ? "" : ` ${OFFLINE_REASON}`}`;
  })();

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
          {place === "room" ? (
            <button type="button" className="btn-secondary-sm" aria-pressed={!sound} onClick={toggleSound}>
              {sound ? "Mute voices" : "Unmute voices"}
            </button>
          ) : null}
          {live && meCtl.me !== null ? (
            <button type="button" className="btn-secondary-sm" aria-pressed={showOnboarding || mustAcknowledge} onClick={() => {
                setShowOnboarding((v) => !v);
              }}>
              Ground rule
            </button>
          ) : null}
          {place === "hub" ? (
            <button type="button" className="btn-secondary-sm" aria-pressed={showArena} onClick={showArena ? () => { setShowArena(false); } : openArena}>
              Arena
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
        <aside className="side left" data-open={leftOpen && !showDebrief ? "true" : "false"}>
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={leftOpen && !showDebrief}
            disabled={showDebrief}
            onClick={() => {
              setLeftOpen((v) => !v);
            }}
          >
            {leftOpen && !showDebrief ? "Hide" : place === "hub" ? "Cases" : "Transcript"}
          </button>
          {place === "hub" ? (
            <section className="panel" aria-labelledby="cases-title">
              <header className="panel-head">
                <h1 id="cases-title">Pick a case file.</h1>
              </header>
              <div className="panel-body">
                <p className="lead">
                  {live ? "Practice cases from the development split. Open one to step into its interview room." : `${OFFLINE_REASON} Open a case to watch its recorded run.`}
                </p>
                <ul className="case-list">
                  {cases.map((c) => (
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
                cases={cases}
                recordedCaseId={RECORDED_CASE_ID}
                subjectName={subjectName}
                focusedCase={focused}
                documents={wallDocs}
                clock={clock}
                still={still}
                reducedMotion={still}
                showPet={showPet}
                scoreCards={scoreCards}
                onOpenCase={openCase}
                onFocusCase={setFocused}
                onArrive={onArrive}
              />
            </Suspense>
          </div>
          {place === "room" && debriefReady && debriefClosed ? (
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
          {showDebrief && debrief !== null ? (
            <DebriefScene
              debrief={debrief}
              view={view}
              documents={documents}
              reducedMotion={still}
              onClose={() => {
                setDebriefClosed(true);
              }}
            />
          ) : null}
          {place === "room" ? (
            <div className="room-controls">
              <p className="caption" role="status">
                {caption}
              </p>
              {liveFeed && session.debriefFailed ? (
                <div className="start-row">
                  <button type="button" className="btn-secondary-sm start-alt" onClick={session.retryDebrief}>
                    Score the debrief again
                  </button>
                </div>
              ) : null}
              {liveFeed && session.failedQuestion !== null ? (
                <div className="start-row">
                  <button type="button" className="btn-secondary-sm start-alt" onClick={() => {
                      const sent = session.failedQuestion;
                      void session.retryAsk().then((ok) => {
                        if (ok && sent !== null) setDraft((current) => draftAfterSend(current, sent));
                      });
                    }}>
                    Send the question again
                  </button>
                </div>
              ) : null}
              {liveFeed && session.connectionError !== null ? (
                <div className="start-row">
                  <button type="button" className="btn-secondary-sm start-alt" onClick={session.reconnect}>
                    Reconnect
                  </button>
                </div>
              ) : null}
              {mode === "choose" ? (
                <div className="start-row" role="group" aria-label="Start">
                  {live && study !== null ? (
                    <div className="study-step">
                      <span className="eyebrow">Study</span> <strong>{stepLabel(study)}</strong>
                      <p className="fine">{nextStepText(study)}</p>
                    </div>
                  ) : null}
                  {live && !canStartLive ? <p className="fine">{meCtl.failed ? "Your profile could not be read; reload the page." : "Read the ground rule before you start."}</p> : null}
                  {live && session.resumable !== null ? (
                    <button type="button" className="btn-primary" disabled={!canStartLive} onClick={() => {
                        setMode("live");
                        void session.resume();
                      }}>
                      Return to your {session.resumable.mode === "practice" ? "practice interview" : "assessment"}
                    </button>
                  ) : null}
                  {live
                    ? modes.map((m, i) => (
                        <button
                          key={m}
                          type="button"
                          className={session.resumable === null && i === 0 ? "btn-primary" : "btn-secondary-sm start-alt"}
                          disabled={!canStartLive}
                          onClick={() => {
                            startLive(m);
                          }}
                        >
                          {m === "practice" ? "Start practice interview" : study !== null && study.next_phase !== "done" ? `Start ${stepLabel(study).toLowerCase()}` : "Assessment"}
                        </button>
                      ))
                    : null}
                  {active?.case_id === RECORDED_CASE_ID ? (
                    <button type="button" className="btn-secondary-sm start-alt" onClick={watchRecording}>
                      Watch the recorded run
                    </button>
                  ) : null}
                </div>
              ) : null}
              {mode === "playback" && recording !== null ? (
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
              ) : null}
              <Composer
                draft={draft}
                onDraft={(text) => {
                  setDraft(text);
                  session.typing();
                }}
                onSend={
                  reason === null
                    ? (text) => {
                        void session.ask(text).then((ok) => {
                          if (ok) setDraft((current) => draftAfterSend(current, text));
                        });
                      }
                    : null
                }
                reason={reason ?? ""}
              />
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
                  content:
                    view === null ? (
                      <p className="empty">{mode === "choose" ? "Start the interview; the coach reviews each answer and suggests a follow-up." : "Opening the session."}</p>
                    ) : (
                      <CoachPanel view={view} released={view.released} documents={documents} onCite={onCite} onUseQuestion={liveFeed ? setDraft : null} />
                    ),
                },
                {
                  id: "evidence",
                  label: freshId === null ? "Evidence" : "Evidence (new)",
                  content: (
                    <EvidencePanel
                      documents={documents}
                      released={view?.released ?? []}
                      requestable={view?.requestable ?? []}
                      exchangesUsed={view?.exchangesUsed ?? 0}
                      freshId={freshId}
                      onRequest={canAct ? (id) => void session.request(id) : null}
                    />
                  ),
                },
                {
                  id: "finding",
                  label: "Finding",
                  content: (
                    <FindingPanel
                      key={`${active?.case_id ?? "none"}-${mode}`}
                      committed={view?.committedFinding ?? null}
                      hash={view?.commitmentHash ?? null}
                      turns={view?.turns ?? []}
                      records={[...documents.map((d) => ({ id: d.doc_id, title: d.title })), ...(view?.released ?? []).map((r) => ({ id: r.record_id, title: r.title }))]}
                      onConfirm={
                        canAct
                          ? (d) => {
                              const finding = draftToFinding(d);
                              if (finding !== null) void session.commit(finding);
                            }
                          : null
                      }
                      disabledReason={reason ?? "Ask at least one question first."}
                    />
                  ),
                },
              ]}
            />
          )}
        </aside>
      </main>

      {mustAcknowledge || showOnboarding ? (
        <Onboarding
          acknowledged={meCtl.me?.ex4_acknowledged ?? null}
          onAcknowledge={meCtl.acknowledge}
          onClose={mustAcknowledge ? null : () => {
            setShowOnboarding(false);
          }}
        />
      ) : null}
      {place === "hub" && showArena && arena !== null ? (
        <ArenaView
          name={arena.name}
          example={arena.example}
          assistant={arena.assistant}
          subject={arena.subject}
          tournament={arena.tournament}
          motionOff={still}
          onClose={() => {
            setShowArena(false);
          }}
        />
      ) : null}
      <footer className="ex4">{EX4_TEXT}</footer>
    </div>
  );
}
