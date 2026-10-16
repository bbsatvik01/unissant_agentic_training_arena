/**
 * The arena's world (D-020, D-021, stage 2): the precinct hub, then the interview room of the chosen case, with the
 * 2D overlay (DESIGN.md components) floating on the 3D stage. A room runs one of two feeds into the same reducer and
 * world: a live session (`POST /api/sessions`, then the session controller's SSE stream) when the arena API answers,
 * or a recorded run (the bundled F01 recording or an exported file). Without the API the hub falls back to the
 * bundled case list and recordings only.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MoreMenu } from "../components/overlay/MoreMenu";
import { ArenaView } from "../components/overlay/ArenaView";
import { DemoGuide } from "../components/overlay/DemoGuide";
import { Onboarding } from "../components/overlay/Onboarding";
import { ProgressView } from "../components/overlay/ProgressView";
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
import { parseBoard, type Board, type BoardsState } from "../lib/arena/leaderboard";
import { EMPTY_TOURNAMENT, foldPoll, type TournamentState } from "../lib/arena/tournament";
import { ApiError, createApiClient } from "../lib/api/client";
import type { Debrief } from "../lib/contracts/generated/types";
import { isWire } from "../lib/contracts/validate";
import { EX4_TEXT } from "../lib/copy/ex4";
import { draftToFinding } from "../lib/copy/finding";
import { initialTrialState, trialReducer, type RoomStatus, type TrialView } from "../lib/trial/trialReducer";
import { CASES, RECORDED_CASE_ID, type CaseCard } from "../lib/world/cases";
import { followRoom, type DemoStep } from "../lib/demo/demo";
import { allowedModes, nextStepText, stepLabel } from "../lib/study/study";
import { debriefView, type EndedTrial } from "../lib/world/debrief";
import { draftAfterSend } from "../lib/world/live";
import type { RecordingResult } from "../lib/world/parseRecording";
import type { CaseDocument, Recording } from "../lib/world/recording";
import type { WorldState } from "../lib/world/worldState";
import { REFUSED_TEXT, useLiveSession } from "./world/useLiveSession";
import { useMe } from "./world/useMe";
import { useProgress } from "./world/useProgress";
import { standings } from "../lib/arena/standings";
import { useBoards } from "./world/useBoards";
import { useTournament, useTournamentList } from "./world/useTournament";
import { modeBadge } from "../lib/world/badge";
import { latestOnly } from "../lib/world/latest";
import { useMotionPrefs } from "./world/useMotionPrefs";
import { useVoice } from "./world/useVoice";
import { useVoiceSession } from "./world/useVoiceSession";
import { INVESTIGATOR, subjectPersona } from "../lib/world/cast";
import { VoiceBar } from "../components/overlay/VoiceBar";
import { liveVoiceView, voiceShownCount, withLiveVoice } from "../lib/voice/liveWorld";
import type { ExchangeEntry } from "../lib/voice/voiceMachine";
import type { VoiceExchange } from "../lib/contracts/generated/types";

type StartKind = "practice" | "assessment" | "voice";
const NO_EXCHANGES: readonly VoiceExchange[] = [];

function fromEntries(entries: readonly ExchangeEntry[]): VoiceExchange[] {
  return entries.map((e) => ({ exchange_no: e.exchangeNo, lines: [...e.lines] }));
}
import { roomEngine } from "./world/voiceEngines";
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
  const placeRef = useRef(place);
  // Every way a recording reaches the room (a file, the bundled demo run, a run from the server) takes a turn here,
  // and only the newest turn's answer is used: choosing another run, opening a case, starting a live interview,
  // going back to the precinct or leaving the arena before an answer arrives never lets that older answer replace
  // what came after it.
  const replayOrder = useRef(latestOnly());
  useEffect(() => {
    placeRef.current = place;
  });
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
  // Progressive disclosure (stage 8): the room's side panels stay out of the way until the interview has something
  // in them (its first turn) or the trainee opens one; the precinct's brief appears once a case is pointed at.
  const [panelsAsked, setPanelsAsked] = useState(false);
  // The example arena (no tournament selected): boards and matrix from the bundled fixtures.
  const [arena, setArena] = useState<{ assistant: Board | null; subject: Board | null; example: TournamentState | null; name: string; boards: BoardsState } | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [endedTrial, setEndedTrial] = useState<EndedTrial | null>(null);
  // The judge demo (`?demo` or the precinct's Guided demo button): its step and when it began.
  const [demo, setDemo] = useState<{ step: DemoStep; startedAt: number } | null>(() => (new URLSearchParams(window.location.search).has("demo") ? { step: "precinct", startedAt: Date.now() } : null));
  // An address naming a tournament (`?tournament=<id>`, as the corrected and original links do) opens the arena.
  const [showArena, setShowArena] = useState(() => new URLSearchParams(window.location.search).has("tournament"));
  // The selected tournament's matrix comes from the tournament poll (S6 4.9); without a selection, the list of
  // tournaments to choose from.
  const [tournamentId] = useState(() => new URLSearchParams(window.location.search).get("tournament"));
  // A selected tournament is followed while the arena is open or the precinct (with its standings wall) is in view.
  // Each opening of the arena reads the tournament and its boards again (a stopped poll restarts, a failed read is
  // not final).
  const [arenaRound, setArenaRound] = useState(0);
  const tournamentLoad = useTournament(api, tournamentId, showArena || place === "hub", arenaRound);
  const tournamentList = useTournamentList(api, showArena && tournamentId === null);
  // A selected tournament (`?tournament=<id>`, and `&label=original` for a corrected board's original) shows its
  // published boards: the sealed state before reveal, never numbers (FE-LB-5), read again when its poll reports the
  // reveal. Without a selection the arena shows the bundled example boards and matrix, labeled as such.
  const [boardLabel] = useState<"original" | null>(() => (new URLSearchParams(window.location.search).get("label") === "original" ? "original" : null));
  const revealed = tournamentLoad.state === "ready" && tournamentLoad.tournament.state === "revealed";
  const published = useBoards(api, tournamentId, boardLabel, showArena || place === "hub", revealed, arenaRound);
  // Stable, so the memoized precinct (whose standings wall opens the arena) does not re-render with every frame.
  const openArena = useCallback(() => {
    setArenaRound((r) => r + 1);
    setShowArena(true);
    setShowProgress(false);
  }, []);
  // The example data, read once the arena is first shown without a selected tournament.
  const exampleLoaded = arena !== null;
  useEffect(() => {
    if (!showArena || exampleLoaded || tournamentId !== null) return;
    void Promise.all([import("../fixtures/leaderboard.example.json"), import("../fixtures/tournament.example.json")]).then(([lb, tour]) => {
      const poll: unknown = tour.default.poll;
      setArena({
        name: lb.default.tournament.name,
        assistant: parseBoard(lb.default.assistant),
        subject: parseBoard(lb.default.subject),
        example: isWire("tournament-poll", poll) ? foldPoll(EMPTY_TOURNAMENT, poll) : EMPTY_TOURNAMENT,
        boards: { kind: "example" },
      });
    });
  }, [showArena, exampleLoaded, tournamentId]);
  const arenaShown = useMemo(
    () => (tournamentId === null ? arena : published === null ? null : { name: "Tournament leaderboards", assistant: published.assistant, subject: published.subject, example: null, boards: published.state }),
    [tournamentId, arena, published],
  );
  // The same board on the precinct's wall (S6 4.10), turned over when it changes (the reveal).
  const wallStandings = useMemo(() => (arenaShown === null ? null : standings(arenaShown.assistant, arenaShown.boards)), [arenaShown]);
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
  // The coach in the earpiece (practice only): on by default, the trainee's choice remembered in this browser.
  const [earpiece, setEarpiece] = useState(() => {
    try {
      return window.localStorage.getItem("arena.earpiece") !== "0";
    } catch {
      return true;
    }
  });
  const toggleEarpiece = () => {
    setEarpiece((on) => {
      try {
        window.localStorage.setItem("arena.earpiece", on ? "0" : "1");
      } catch {
        // Storage unavailable: the toggle still works for this page.
      }
      return !on;
    });
  };

  const live = liveCases !== null;
  const meCtl = useMe(api, live);
  const study = meCtl.me?.study ?? null;
  // The live arena, when its server answers: the cases offered to this user. A study participant's offer changes
  // with the step (the server lists only the next test set, S6 3.2), so the list is read again whenever the study
  // status changes; a focused card no longer offered is let go.
  const studyKey = study === null ? "" : `${study.next_phase}:${String(study.ended.pre)}:${String(study.ended.practice)}:${String(study.ended.post)}`;
  useEffect(() => {
    let cancelled = false;
    api.listCases().then(
      (cases) => {
        if (cancelled) return;
        setLiveCases(cases);
        setFocused((f) => (f !== null && cases.some((c) => c.case_id === f) ? f : null));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, studyKey]);
  const canStartLive = live && meCtl.me !== null && meCtl.me.ex4_acknowledged !== null;
  const mustAcknowledge = live && meCtl.me !== null && meCtl.me.ex4_acknowledged === null;
  const modes = allowedModes(study);
  const refreshMe = meCtl.refresh;
  const [showOnboarding, setShowOnboarding] = useState(false);
  const progress = useProgress(api, showProgress);
  const cases = liveCases ?? CASES;

  const recording = load.state === "ready" ? load.recording : null;
  const subjectName = recording?.case.subject.display_name ?? active?.subject.display_name ?? "Subject";
  const playback = usePlayback(mode === "playback" ? recording : null, { subjectName, reducedMotion, paused });
  const session = useLiveSession({ api, caseId: mode === "playback" ? null : (active?.case_id ?? null), subjectName, reducedMotion, paused });
  const { play, seekTo } = playback;
  const liveFeed = mode === "live";
  const view: TrialView | null = liveFeed ? session.trial.view : mode === "playback" ? playback.trial.view : null;
  const isVoice = liveFeed && view?.channel === "voice";
  const voice = useVoiceSession({ api, trialId: isVoice ? (session.session?.trial_id ?? null) : null, exchanges: view?.voiceExchanges ?? NO_EXCHANGES, voices: { subject: subjectPersona(subjectName).voice.gemini, investigator: INVESTIGATOR.voice.gemini } });
  const derived: WorldState | null = liveFeed ? session.world : mode === "playback" ? playback.world : null;
  // A voice session has no turns: who is talking comes from the voice session (lib/voice/liveWorld).
  const world = isVoice && derived !== null ? withLiveVoice(derived, liveVoiceView(voice.state, voice.captureAboveFloor), subjectName) : derived;
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

  // Once the camera has landed in the room and the recording is ready, a recorded run plays (never in the precinct),
  // once per recording: a later camera move never restarts it, nor undoes a seek to its debrief.
  const autoplayed = useRef<Recording | null>(null);
  useEffect(() => {
    // Leaving the room forgets it, so the next visit plays the run again.
    if (place !== "room") {
      autoplayed.current = null;
      return;
    }
    if (!arrived || mode !== "playback" || recording === null || autoplayed.current === recording) return;
    autoplayed.current = recording;
    play();
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
      // With the server, only a case it offers now can open (a study step changes the offer); offline, the case
      // of a recording already in hand can open again.
      const card = cases.find((c) => c.case_id === caseId) ?? (!live && active?.case_id === caseId ? active : null);
      if (card === null) return;
      replayOrder.current();
      setActive(card);
      // With the server, the room offers a live interview (and the recorded run for F01); without it, the recorded
      // run plays straight away where there is one.
      const recorded = card.case_id === RECORDED_CASE_ID;
      setMode(live || !recorded ? "choose" : "playback");
      setLoad((l) => (l.state === "ready" && l.recording.case.case_id === card.case_id ? l : recorded ? { state: "loading" } : { state: "none" }));
      resetRoom();
      setPanelsAsked(false);
      setPlace("room");
      seekTo(0);
    },
    [seekTo, active, cases, live],
  );

  // The recorded run plays once it is loaded and the camera has landed (the effect above).
  const watchRecording = () => {
    setMode("playback");
  };

  // A live start waits for the render in which the session hook holds this case (coming from playback, the hook's
  // case is null until the mode changes), then starts once.
  const pendingStart = useRef<StartKind | null>(null);
  const startSession = session.start;
  const liveCaseId = mode === "live" ? (active?.case_id ?? null) : null;
  const startLive = (m: StartKind) => {
    replayOrder.current();
    // Already live (a retry after a refused start): start now; otherwise once the mode has changed.
    if (liveCaseId !== null) {
      void startSession(m === "voice" ? "practice" : m, m === "voice");
      return;
    }
    pendingStart.current = m;
    setMode("live");
  };
  useEffect(() => {
    const m = pendingStart.current;
    if (m === null || liveCaseId === null) return;
    pendingStart.current = null;
    void startSession(m === "voice" ? "practice" : m, m === "voice");
  }, [liveCaseId, startSession]);

  // D-021: any exported run (`recordings/<trial>.json`) plays the same way, checked whole before it is used.
  // A checked recording plays in the room the same way whether it came from a file or the server.
  const playRecording = useCallback((raw: unknown, parse: (v: unknown) => RecordingResult) => {
    const result = parse(raw);
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
    // Already in the room (a recording replaced there), the camera has landed: keep it so the new run plays.
    setArrived((a) => (placeRef.current === "room" ? a : false));
    setDebriefClosed(false);
    setCite(null);
    setPanelsAsked(false);
    setPlace("room");
  }, []);

  const openRecordingFile = useCallback(
    (file: File) => {
      const current = replayOrder.current();
      void Promise.all([file.text(), import("../lib/world/parseRecording")]).then(
        ([text, { parseRecording }]) => {
          if (!current()) return;
          let raw: unknown;
          try {
            raw = JSON.parse(text);
          } catch {
            setFileError("That file is not JSON.");
            return;
          }
          playRecording(raw, parseRecording);
        },
        () => {
          if (current()) setFileError("The file could not be read.");
        },
      );
    },
    [playRecording],
  );

  // A run from the server (`GET /api/trials/{id}/recording`): one of the participant's own, or a tournament trial
  // chosen in the arena, replayed in the room.
  const replayTrial = useCallback(
    (trialId: string) => {
      const current = replayOrder.current();
      setShowProgress(false);
      void Promise.all([api.recording(trialId), import("../lib/world/parseRecording")]).then(
        ([raw, { parseRecording }]) => {
          if (current()) playRecording(raw, parseRecording);
        },
        (e: unknown) => {
          if (current()) setFileError(e instanceof ApiError && e.status === 404 ? "The server does not offer this run's recording." : "That run could not be loaded.");
        },
      );
      // The ended trial's snapshot carries coaching an assessment withheld, which its recording does not (FE-DEB-4).
      setEndedTrial(null);
      api.trialSnapshot(trialId).then(
        (snapshot) => {
          const ended = trialReducer(initialTrialState(), { type: "snapshot", snapshot }).view;
          if (ended !== null && current()) setEndedTrial({ trialId, view: ended });
        },
        () => undefined,
      );
    },
    [api, playRecording],
  );
  // The demo's interview: the bundled recorded run (no model call), whatever the server offers.
  const openDemoRecording = useCallback(() => {
    const current = replayOrder.current();
    void Promise.all([import("../fixtures/recordings/F01-truthful.json"), import("../lib/world/parseRecording")]).then(
      ([raw, { parseRecording }]) => {
        if (current()) playRecording(structuredClone(raw.default), parseRecording);
      },
      () => {
        if (current()) setFileError("The recorded run could not be loaded.");
      },
    );
  }, [playRecording]);
  // Leaving the arena: a replay chosen there and still loading no longer opens the room.
  const closeArena = () => {
    replayOrder.current();
    setShowArena(false);
  };
  const backToHub = useCallback(() => {
    replayOrder.current();
    playback.pause();
    session.stop();
    refreshMe();
    setPanelsAsked(false);
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
  const activeOffered = active !== null && (!live || cases.some((c) => c.case_id === active.case_id));
  const focusCard = cases.find((c) => c.case_id === focused) ?? (activeOffered ? active : null) ?? cases[0] ?? null;
  const liveDebrief = session.debrief !== null && "schema_version" in session.debrief ? session.debrief : null;
  const debrief: Debrief | null = liveFeed ? liveDebrief : (recording?.debrief ?? null);
  const debriefReady = liveFeed ? debrief !== null : world?.debriefReady === true && debrief !== null;
  const showDebrief = place === "room" && debriefReady && !debriefClosed;
  // The demo's interview step moves on to the debrief by itself once the debrief is up.
  const demoStep: DemoStep | null = demo === null ? null : followRoom(demo.step, place === "room" && debriefReady);
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
  // Voices speak only in the room, unmuted, live or during playback at normal speed: Gemini voices through the server
  // when it is there (each line cached there, so a recorded run replays for free), the browser's own otherwise.
  const engine = useMemo(() => roomEngine(live ? api : null), [live, api]);
  useEffect(() => engine.activate(), [engine]);
  const { coachSpeaking } = useVoice({
    earpiece,
    engine,
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

  const roomQuiet = place === "room" && !panelsAsked && (view?.turns.length ?? 0) === 0 && (view?.voiceExchanges.length ?? 0) === 0;
  const leftShown = leftOpen && !showDebrief && !roomQuiet;
  const rightShown = rightOpen && !roomQuiet && (place !== "hub" || panelsAsked || focused !== null);

  return (
    <div className="app" data-place={place} data-paused={paused ? "true" : "false"} data-demo={demo === null ? "false" : "true"}>
      <header className="topbar">
        <div className="brand">
          <span className="eyebrow">Training arena</span>
          <span className="crumb">{place === "hub" ? "Precinct" : (active?.title ?? "Interview room")}</span>
        </div>
        <div className="topbar-meta">
          {place === "room" && view !== null ? (
            <>
              <span className="badge">{isVoice ? "Voice practice: not scored" : modeBadge(view.mode, mode === "playback" ? (recording?.snapshot.mode ?? null) : null)}</span>
              <span className="badge mono">
                {isVoice ? voiceShownCount(voice.state, view.exchangesUsed) : view.exchangesUsed}/{view.exchangesCap} exchanges
              </span>
              {isVoice ? null : (
                <span className="badge" data-state={view.status}>
                  {subjectName}: {STATUS_WORD[view.status]}
                </span>
              )}
            </>
          ) : null}
          {place === "room" ? (
            <button type="button" className="btn-secondary-sm" aria-pressed={!sound} onClick={toggleSound}>
              {sound ? "Mute voices" : "Unmute voices"}
            </button>
          ) : null}
          {place === "room" && sound && view?.mode === "practice" ? (
            <button
              type="button"
              className="btn-secondary-sm earpiece"
              aria-pressed={earpiece}
              data-speaking={coachSpeaking ? "true" : "false"}
              title="The coach says its suggestion quietly in your earpiece after each answer"
              onClick={toggleEarpiece}
            >
              <span className="earpiece-dot" aria-hidden="true" />
              {earpiece ? "Earpiece on" : "Earpiece off"}
              {coachSpeaking ? <span className="sr-only">, the coach is speaking</span> : null}
            </button>
          ) : null}
          {place === "hub" && demo === null ? (
            <button type="button" className="btn-secondary-sm" onClick={() => {
                setDemo({ step: "precinct", startedAt: Date.now() });
                closeArena();
                setShowProgress(false);
              }}>
              Guided demo
            </button>
          ) : null}
          {place === "hub" && live && meCtl.me !== null ? (
            <button type="button" className="btn-secondary-sm" aria-pressed={showProgress} onClick={() => {
                setShowProgress((v) => !v);
                closeArena();
              }}>
              Progress
            </button>
          ) : null}
          {place === "hub" ? (
            <button type="button" className="btn-secondary-sm" aria-pressed={showArena} onClick={showArena ? closeArena : openArena}>
              Arena
            </button>
          ) : null}
          {/* Now-and-then controls behind one button, so the bar holds only what the moment needs. */}
          <MoreMenu
            items={[
              ...(live && meCtl.me !== null
                ? [{ id: "rule", label: "Ground rule", pressed: showOnboarding || mustAcknowledge, onSelect: () => { setShowOnboarding((v) => !v); } }]
                : []),
              ...(place === "hub" ? [{ id: "trust", label: "Trust center", href: "/trust/methodology" }] : []),
              ...(place === "room" ? [{ id: "pet", label: showPet ? "Hide companion" : "Show companion", pressed: !showPet, onSelect: () => { setShowPet((v) => !v); } }] : []),
              { id: "motion", label: paused ? "Resume motion" : "Pause motion", pressed: paused, onSelect: togglePaused },
            ]}
          />
          {place === "room" ? (
            <button type="button" className="btn-secondary-sm" onClick={backToHub}>
              Back to precinct
            </button>
          ) : null}
        </div>
      </header>

      <main className="stage">
        <aside className="side left" data-open={leftShown ? "true" : "false"}>
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={leftShown}
            disabled={showDebrief}
            onClick={() => {
              if (leftShown) setLeftOpen(false);
              else {
                setPanelsAsked(true);
                setLeftOpen(true);
              }
            }}
          >
            {leftShown ? "Hide" : place === "hub" ? "Cases" : "Transcript"}
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
              voiceExchanges={isVoice ? fromEntries(voice.state.transcript) : (view?.voiceExchanges ?? [])}
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
                standings={wallStandings}
                onOpenStandings={openArena}
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
              view={mode === "playback" ? debriefView(view, endedTrial, recording?.trial_id ?? null) : view}
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
                  {live && modes.includes("practice") ? (
                    <button
                      type="button"
                      className="btn-secondary-sm start-alt"
                      disabled={!canStartLive}
                      onClick={() => {
                        startLive("voice");
                      }}
                    >
                      Start voice practice
                    </button>
                  ) : null}
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
              {isVoice ? (
                <VoiceBar
                  state={voice.state}
                  captureAboveFloor={voice.captureAboveFloor}
                  subjectName={subjectName}
                  error={voice.error}
                  talk={voice.state.audible !== null && !still ? 1 : 0}
                  onOpen={voice.open}
                  onConsent={voice.consent}
                  onDecline={voice.decline}
                  onStop={voice.stop}
                  onInterrupt={voice.interrupt}
                  onReconnect={voice.reconnect}
                />
              ) : (
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
              )}
            </div>
          ) : (
            <p className="caption">Point at a file on the board, or use the list, to open a case.</p>
          )}
        </div>

        <aside className="side right" data-open={rightShown ? "true" : "false"}>
          <button
            type="button"
            className="panel-toggle"
            aria-expanded={rightShown}
            onClick={() => {
              if (rightShown) setRightOpen(false);
              else {
                setPanelsAsked(true);
                setRightOpen(true);
              }
            }}
          >
            {rightShown ? "Hide" : place === "hub" ? "Brief" : "Coach, evidence, finding"}
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
                      exchangesUsed={isVoice ? (voice.state.exchangeCount?.used ?? 0) : (view?.exchangesUsed ?? 0)}
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
      {place === "hub" && showProgress && !mustAcknowledge ? (
        <ProgressView
          load={progress.load}
          scores={progress.scores}
          study={study}
          onReplay={replayTrial}
          onClose={() => {
            setShowProgress(false);
          }}
        />
      ) : null}
      {place === "hub" && showArena && arenaShown !== null ? (
        <ArenaView
          name={arenaShown.name}
          boards={arenaShown.boards}
          assistant={arenaShown.assistant}
          subject={arenaShown.subject}
          tournament={arenaShown.example ?? (tournamentLoad.state === "ready" ? tournamentLoad.tournament : EMPTY_TOURNAMENT)}
          matrix={arenaShown.example !== null ? "example" : tournamentLoad.state === "ready" || tournamentLoad.state === "idle" ? "ready" : tournamentLoad.state}
          tournaments={tournamentList}
          notice={fileError}
          onReplay={replayTrial}
          motionOff={still}
          onClose={closeArena}
        />
      ) : null}
      {demoStep === null || demo === null || mustAcknowledge ? null : (
        <DemoGuide
          step={demoStep}
          startedAt={demo.startedAt}
          recordingLoaded={mode === "playback" && recording !== null}
          nextDisabled={demoStep === "interview" && !(mode === "playback" && recording !== null)}
          noDebrief={mode === "playback" && recording !== null && recording.debrief === null}
          canLive={canStartLive && active !== null && cases.some((c) => c.case_id === active.case_id) && (session.phase === "idle" || session.phase === "error")}
          error={fileError}
          onClose={() => {
            setDemo(null);
          }}
          onBack={demoStep === "precinct" ? null : () => {
            if (demoStep === "interview") {
              backToHub();
              setDemo({ ...demo, step: "precinct" });
            } else if (demoStep === "debrief") {
              // Watch the run again from the start: a recorded run rewinds; a finished live interview replays as its
              // own recording.
              const trialId = session.session?.trial_id ?? null;
              if (mode === "live" && trialId !== null) {
                replayTrial(trialId);
              } else {
                playback.seekTo(0);
                playback.play();
              }
            } else {
              setShowArena(false);
              openDemoRecording();
              setDemo({ ...demo, step: "interview" });
            }
          }}
          onNext={() => {
            if (demoStep === "precinct") {
              openDemoRecording();
              setDemo({ ...demo, step: "interview" });
            } else if (demoStep === "interview" && mode === "playback" && recording !== null && recording.debrief !== null) {
              // To the debrief wall: the recorded run jumps to its end, where the debrief goes up; a camera landing
              // after this must not start the run over.
              autoplayed.current = recording;
              playback.seekTo(playback.duration);
            } else if (demoStep === "debrief" || (demoStep === "interview" && mode === "playback" && recording?.debrief === null)) {
              // A recording without a published debrief goes on to the arena.
              backToHub();
              openArena();
              setDemo({ ...demo, step: "arena" });
            }
          }}
          onRecorded={openDemoRecording}
          onFile={openRecordingFile}
          onLive={() => {
            startLive("practice");
          }}
/>
      )}
      <footer className="ex4">{EX4_TEXT}</footer>
    </div>
  );
}
