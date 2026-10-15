/**
 * One session in one precinct. The existing live/SSE and v1 playback hooks own all reducer folding,
 * arrival times, validation and motion; this hook only composes their lifecycles and public views.
 * Merely mounting, choosing a case, or walking into a room never starts a backend or audio request.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPrecinctLocalConnection } from "../../lib/api/precinctLocalApi";
import type { Me } from "../../lib/api/client";
import type { InvestigatorFinding, VoiceExchange } from "../../lib/contracts/generated/types";
import { allowedModes } from "../../lib/study/study";
import { createLocalReadAloud, LOCAL_VOICE_UNAVAILABLE } from "../../lib/precinct/localReadAloud";
import { canSubmitSessionAction, isLoopbackOrigin, publicPacket, questionDisabledReason, recordingCaseCard, visibleRecordedDebrief, type LocalBackendState, type PrecinctSessionSource } from "../../lib/precinct/session";
import { CASES, RECORDED_CASE_ID, type CaseCard } from "../../lib/world/cases";
import { INVESTIGATOR, subjectPersona } from "../../lib/world/cast";
import { latestOnly } from "../../lib/world/latest";
import { draftAfterSend } from "../../lib/world/live";
import { parseRecording } from "../../lib/world/parseRecording";
import type { Recording, RecordingCase } from "../../lib/world/recording";
import { liveVoiceView, withLiveVoice } from "../../lib/voice/liveWorld";
import { useLiveSession } from "../world/useLiveSession";
import { usePlayback } from "../world/usePlayback";
import { useVoice } from "../world/useVoice";
import { useVoiceSession } from "../world/useVoiceSession";
import { roomEngine } from "../world/voiceEngines";

const NO_EXCHANGES: readonly VoiceExchange[] = [];
const NO_ARRIVALS: ReadonlyMap<string, number> = new Map();
const EMPTY_CLOCK = { current: 0 };

export interface PrecinctSessionOptions {
  readonly reducedMotion: boolean;
  readonly paused: boolean;
  /** Parent says whether subject audio belongs in the current room. Does not grant microphone consent. */
  readonly audioInRoom: boolean;
}

type PendingStart = { readonly caseId: string; readonly kind: "practice" | "assessment" | "voice" | "resume" };

export function usePrecinctSession({ reducedMotion, paused, audioInRoom }: PrecinctSessionOptions) {
  const connection = useMemo(() => createPrecinctLocalConnection({ origin: () => window.location }), []);
  const api = connection.api;
  const [backend, setBackend] = useState<LocalBackendState>("offline");
  const [backendError, setBackendError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [cases, setCases] = useState<readonly CaseCard[]>(CASES);
  const [selectedCase, setSelectedCase] = useState<CaseCard | null>(null);
  const [packet, setPacket] = useState<RecordingCase | null>(null);
  const [packetState, setPacketState] = useState<"empty" | "loading" | "ready" | "unavailable">("empty");
  const [source, setSource] = useState<PrecinctSessionSource>("idle");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recordingState, setRecordingState] = useState<"empty" | "loading" | "ready" | "error">("empty");
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sound, setSoundState] = useState(false);
  const [readAloudError, setReadAloudError] = useState<string | null>(null);
  const [earpiece, setEarpiece] = useState(false);
  const readAloudUnavailable = useCallback(() => { setSoundState(false); setEarpiece(false); setReadAloudError(LOCAL_VOICE_UNAVAILABLE); }, []);
  const localReadAloud = useMemo(() => createLocalReadAloud(readAloudUnavailable), [readAloudUnavailable]);
  const setSound = useCallback((enabled: boolean) => {
    if (enabled && backend !== "connected" && !localReadAloud.available()) { readAloudUnavailable(); return; }
    setReadAloudError(null); setSoundState(enabled);
  }, [backend, localReadAloud, readAloudUnavailable]);
  const [pending, setPending] = useState<PendingStart | null>(null);
  const selectionOrder = useRef(latestOnly());
  const backendOrder = useRef(latestOnly());
  const recordingOrder = useRef(latestOnly());
  const actionOrder = useRef(latestOnly());
  const subjectName = selectedCase?.subject.display_name ?? "Subject";
  const localCase = backend === "connected" && source !== "recording" ? selectedCase?.case_id ?? null : null;
  const live = useLiveSession({ api, caseId: localCase, subjectName, reducedMotion, paused });
  const playback = usePlayback(source === "recording" ? recording : null, { subjectName, reducedMotion, paused });
  const trial = source === "live" ? live.trial : source === "recording" ? playback.trial : null;
  const view = trial?.view ?? null;
  const isVoice = source === "live" && view?.channel === "voice";
  const voice = useVoiceSession({ api, trialId: isVoice && backend === "connected" ? live.session?.trial_id ?? null : null,
    exchanges: view?.voiceExchanges ?? NO_EXCHANGES,
    voices: { subject: subjectPersona(subjectName).voice.gemini, investigator: INVESTIGATOR.voice.gemini } });
  const derived = source === "live" ? live.world : source === "recording" ? playback.world : null;
  const world = isVoice && derived !== null ? withLiveVoice(derived, liveVoiceView(voice.state, voice.captureAboveFloor), subjectName) : derived;
  const clock = source === "live" ? live.clock : source === "recording" ? playback.clock : EMPTY_CLOCK;
  const arrivals = source === "live" ? live.arrivals : source === "recording" ? playback.arrivals : NO_ARRIVALS;
  const documents = packet?.initial_documents ?? [];
  const released = view?.released ?? [];
  const liveDebrief = source === "live" && live.debrief !== null && "schema_version" in live.debrief ? live.debrief : null;
  const debrief = source === "live" ? liveDebrief : source === "recording" ? visibleRecordedDebrief(recording, view, world) : null;
  const sessionKey = source === "live" ? live.session?.session_id ?? `starting:${selectedCase?.case_id ?? "none"}` : source === "recording" ? recording?.trial_id ?? "none" : `case:${selectedCase?.case_id ?? "none"}`;
  // Do not even construct the Web Audio engine until audio was explicitly enabled for this local connection.
  // Offline speech requires an installed localService voice; the browser's unspecified default is never used.
  const engine = useMemo(() => sound && backend === "connected" ? roomEngine(api) : localReadAloud, [sound, backend, api, localReadAloud]);
  const { coachSpeaking } = useVoice({ engine, world, view, subjectName, clock, scope: sessionKey, earpiece,
    active: sound && audioInRoom && !paused && !isVoice && (source === "live" || (source === "recording" && playback.playing && playback.speed === 1)) });

  const stopLive = live.stop;
  const stopVoice = voice.stop;
  const pauseReplay = playback.pause;
  const resetActive = useCallback(() => {
    recordingOrder.current();
    selectionOrder.current();
    actionOrder.current();
    stopVoice(); stopLive(); pauseReplay();
    setPending(null); setSource("idle"); setRecording(null); setRecordingState("empty"); setRecordingError(null);
    setSound(false); setEarpiece(false); setDraft("");
  }, [stopLive, stopVoice, pauseReplay, setSound]);

  const selectCase = useCallback((caseId: string) => {
    const card = cases.find((candidate) => candidate.case_id === caseId);
    if (card === undefined) return;
    resetActive();
    const current = selectionOrder.current();
    setSelectedCase(card); setPacket(null); setPacketState("loading");
    if (backend === "connected") {
      api.caseBrief(caseId).then((brief) => {
        if (!current()) return;
        setSelectedCase(brief.case); setPacket(publicPacket(brief.case, brief.initialDocuments)); setPacketState("ready");
      }, () => { if (current()) setPacketState("unavailable"); });
      return;
    }
    if (caseId !== RECORDED_CASE_ID) { setPacketState("unavailable"); return; }
    // Read only public metadata and initial documents. No events, score, outcome, or finding is installed.
    void import("../../fixtures/recordings/F01-truthful.json").then((raw) => {
      if (!current()) return;
      setPacket(publicPacket(card, raw.default.case.initial_documents)); setPacketState("ready");
    }, () => { if (current()) setPacketState("unavailable"); });
  }, [api, backend, cases, resetActive]);

  const connectLocalBackend = useCallback(async () => {
    if (!isLoopbackOrigin(window.location)) {
      setBackendError("A local backend can only be selected from a loopback address. No connection was attempted.");
      return;
    }
    if (connection.isEnabled() || backend === "connecting" || backend === "connected") return;
    const current = backendOrder.current();
    connection.enable(); setSound(false); setEarpiece(false); setBackend("connecting"); setBackendError(null);
    try {
      const [profile, offered] = await Promise.all([api.me(), api.listCases()]);
      if (!current()) return;
      setMe(profile); setCases(offered); setBackend("connected");
    } catch {
      if (!current()) return;
      connection.disable(); setMe(null); setBackend("error");
      setBackendError("The explicitly selected local backend did not answer. Recordings still work offline.");
    }
  }, [api, backend, connection, setSound]);

  const disconnectLocalBackend = useCallback(() => {
    backendOrder.current(); connection.disable(); resetActive();
    setBackend("offline"); setBackendError(null); setMe(null); setCases(CASES);
    setSelectedCase(null); setPacket(null); setPacketState("empty");
  }, [resetActive, connection]);

  const acknowledgeGroundRule = useCallback(async () => {
    if (backend !== "connected") return false;
    const current = backendOrder.current();
    try { const at = await api.ackEx4(); if (!current()) return false; setMe((profile) => profile === null ? null : { ...profile, ex4_acknowledged: at }); return true; }
    catch { if (current()) setBackendError("The ground-rule acknowledgement could not be saved. Try again."); return false; }
  }, [api, backend]);

  const start = live.start;
  const resume = live.resume;
  const canStart = backend === "connected" && me !== null && me.ex4_acknowledged !== null && selectedCase !== null && cases.some((card) => card.case_id === selectedCase.case_id);
  const modes = allowedModes(me?.study ?? null);
  const startInterview = useCallback((kind: PendingStart["kind"]) => {
    if (!canStart || !modes.includes(kind === "voice" ? "practice" : kind === "resume" ? live.resumable?.mode ?? "practice" : kind)) return;
    if (source === "live" && (live.phase === "starting" || live.phase === "running")) return;
    recordingOrder.current(); actionOrder.current(); pauseReplay(); setSound(false); setEarpiece(false); setDraft("");
    setRecording(null); setRecordingState("empty"); setRecordingError(null);
    setSource("live"); setPending({ caseId: selectedCase.case_id, kind });
    const current = selectionOrder.current();
    setPacket(null); setPacketState("loading");
    void api.caseBrief(selectedCase.case_id).then((brief) => {
      if (!current()) return;
      setSelectedCase(brief.case); setPacket(publicPacket(brief.case, brief.initialDocuments)); setPacketState("ready");
    }, () => { if (current()) setPacketState("unavailable"); });
  }, [api, canStart, selectedCase, modes, live.resumable, live.phase, source, pauseReplay, setSound]);
  useEffect(() => {
    if (pending === null || source !== "live" || localCase !== pending.caseId) return;
    // A microtask lets React's existing case-change cleanup finish before starting that case's controller.
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setPending(null);
      if (pending.kind === "resume") await resume();
      else await start(pending.kind === "voice" ? "practice" : pending.kind, pending.kind === "voice");
    });
    return () => { cancelled = true; };
  }, [pending, source, localCase, resume, start]);

  const installRecording = useCallback((raw: unknown) => {
    const checked = parseRecording(raw);
    if (!checked.ok) { setRecordingState("error"); setRecordingError(`Recording refused: ${checked.errors.slice(0, 3).join("; ")}`); return; }
    selectionOrder.current(); actionOrder.current(); stopVoice(); stopLive(); pauseReplay();
    const card = recordingCaseCard(checked.recording);
    setSelectedCase(card); setPacket(publicPacket(card, checked.recording.case.initial_documents)); setPacketState("ready");
    setPending(null); setDraft(""); setSound(false); setEarpiece(false);
    setRecording(checked.recording); setRecordingState("ready"); setRecordingError(null); setSource("recording");
  }, [pauseReplay, stopLive, stopVoice, setSound]);

  const loadBundledRecording = useCallback(async () => {
    const current = recordingOrder.current(); setRecordingState("loading"); setRecordingError(null);
    try { const raw = await import("../../fixtures/recordings/F01-truthful.json"); if (current()) installRecording(structuredClone(raw.default)); }
    catch { if (current()) { setRecordingState("error"); setRecordingError("The bundled recording could not be loaded."); } }
  }, [installRecording]);
  const loadCoachedRecording = useCallback(async () => {
    const current = recordingOrder.current(); setRecordingState("loading"); setRecordingError(null);
    try { const raw = await import("../../fixtures/recordings/F01-coached.json"); if (current()) installRecording(structuredClone(raw.default)); }
    catch { if (current()) { setRecordingState("error"); setRecordingError("The recorded coached interview could not be loaded."); } }
  }, [installRecording]);
  const importRecording = useCallback(async (file: File) => {
    const current = recordingOrder.current(); setRecordingState("loading"); setRecordingError(null);
    try {
      const text = await file.text(); if (!current()) return;
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { setRecordingState("error"); setRecordingError("That file is not JSON."); return; }
      installRecording(raw);
    } catch { if (current()) { setRecordingState("error"); setRecordingError("The recording file could not be read."); } }
  }, [installRecording]);
  const loadLocalRecording = useCallback(async (trialId: string) => {
    if (backend !== "connected" || trialId.trim() === "") return;
    const current = recordingOrder.current(); setRecordingState("loading"); setRecordingError(null);
    try { const raw = await api.recording(trialId.trim()); if (current()) installRecording(raw); }
    catch { if (current()) { setRecordingState("error"); setRecordingError("The local backend does not offer that recorded run."); } }
  }, [api, backend, installRecording]);

  const trialEnded = source === "live" && view?.status === "ended";
  useEffect(() => {
    if (!trialEnded || backend !== "connected") return;
    const current = backendOrder.current();
    void Promise.all([api.me(), api.listCases()]).then(([profile, offered]) => {
      if (!current()) return;
      setMe(profile); setCases(offered);
    }, () => { if (current()) setBackendError("The interview ended, but your updated local study status could not be read."); });
  }, [trialEnded, backend, api]);

  const seekTo = playback.seekTo;
  useEffect(() => { if (recording !== null && source === "recording") seekTo(0); }, [recording, source, seekTo]);
  useEffect(() => { if (paused) pauseReplay(); }, [paused, pauseReplay]);
  // Leaving the room after microphone consent hangs up; walking back never reopens it automatically.
  useEffect(() => { if (isVoice && (!audioInRoom || paused)) stopVoice(); }, [isVoice, audioInRoom, paused, stopVoice]);
  useEffect(() => () => { connection.disable(); selectionOrder.current(); recordingOrder.current(); backendOrder.current(); actionOrder.current(); }, [connection]);

  const play = useCallback(() => { if (!paused) playback.play(); }, [paused, playback]);
  const voiceOpen = useCallback(() => { if (isVoice && audioInRoom && !paused && backend === "connected") voice.open(); }, [isVoice, audioInRoom, paused, backend, voice]);
  const voiceConsent = useCallback(() => { if (isVoice && audioInRoom && !paused && backend === "connected") voice.consent(); }, [isVoice, audioInRoom, paused, backend, voice]);
  const voiceReconnect = useCallback(() => { if (isVoice && audioInRoom && !paused && backend === "connected") voice.reconnect(); }, [isVoice, audioInRoom, paused, backend, voice]);
  const questionReason = questionDisabledReason(source, view, backend);
  const canAct = canSubmitSessionAction(source, view, backend);
  const ask = useCallback(async (text: string) => {
    if (questionReason !== null || text.trim() === "") return false;
    const current = actionOrder.current();
    const ok = await live.ask(text); if (ok && current()) setDraft((value) => draftAfterSend(value, text)); return ok;
  }, [questionReason, live]);
  const retryQuestion = useCallback(async () => {
    if (source !== "live" || backend !== "connected") return;
    const current = actionOrder.current();
    const sent = live.failedQuestion; const ok = await live.retryAsk();
    if (ok && current() && sent !== null) setDraft((value) => draftAfterSend(value, sent));
  }, [source, backend, live]);
  const requestEvidence = useCallback(async (id: string) => canAct ? live.request(id) : null, [canAct, live]);
  const commitFinding = useCallback(async (finding: InvestigatorFinding) => canAct ? live.commit(finding) : false, [canAct, live]);
  const updateDraft = useCallback((text: string) => { setDraft(text); if (source === "live") live.typing(); }, [source, live]);

  return {
    backend, backendError, me, cases, selectedCase, packet, packetState, documents, released,
    source, sessionKey, recordingState, recordingError, recordingTrialId: source === "recording" ? recording?.trial_id ?? null : null,
    view, world, clock, arrivals, subjectName, debrief, debriefReady: debrief !== null,
    /** Narrow referee state: no score, outcome, secret role, or evaluator fields. */
    referee: source === "live" && live.debrief !== null ? ("status" in live.debrief ? live.debrief : { session_id: live.debrief.session_id, scored: live.debrief.scored }) : debrief === null ? null : { session_id: debrief.session_id, scored: debrief.scored },
    live: { phase: live.phase, error: source === "live" ? live.error : null, connectionError: source === "live" ? live.connectionError : null,
      failedQuestion: source === "live" ? live.failedQuestion : null, debriefFailed: source === "live" && live.debriefFailed,
      resumable: live.resumable, reconnect: live.reconnect, retryDebrief: live.retryDebrief },
    playback: { ...playback, play }, isVoice, voice: { ...voice, open: voiceOpen, consent: voiceConsent, reconnect: voiceReconnect }, transcriptExchanges: isVoice ? voice.state.transcript.map((entry) => ({ exchange_no: entry.exchangeNo, lines: [...entry.lines] })) : view?.voiceExchanges ?? NO_EXCHANGES,
    draft, updateDraft, ask, retryQuestion, requestEvidence, commitFinding, canAct, questionReason, canStart, modes,
    sound, setSound, readAloudError, earpiece, setEarpiece, coachSpeaking,
    selectCase, startInterview, connectLocalBackend, disconnectLocalBackend, acknowledgeGroundRule,
    loadBundledRecording, loadCoachedRecording, importRecording, loadLocalRecording, stopSession: resetActive,
  };
}

export type PrecinctSession = ReturnType<typeof usePrecinctSession>;
