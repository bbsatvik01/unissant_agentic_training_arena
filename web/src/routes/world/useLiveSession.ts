/**
 * A live session in the world (stage 2): `POST /api/sessions`, then the session controller (snapshot, ticketed SSE,
 * validation, acknowledgements) folds the stream into the trial reducer, exactly the input playback feeds. Each new
 * reducer state is turned into arrival times on the session clock (`trackArrivals`), and a requestAnimationFrame
 * loop derives the world from the view and the clock, publishing it only when it changes; the clock lives in a ref
 * for the figures' per-frame reads. Same three outputs as `usePlayback`: trial state, world, clock.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { ArenaApi, StartedSession } from "../../lib/api/arena";
import { ApiError } from "../../lib/api/client";
import type { DebriefRead, EvidenceResult, InvestigatorFinding } from "../../lib/contracts/generated/types";
import { createSessionController, type ConnectionState, type SessionController } from "../../lib/trial/sessionController";
import { initialTrialState, type TrialState } from "../../lib/trial/trialReducer";
import { EMPTY_TRACKER, trackArrivals, type ArrivalTracker } from "../../lib/world/live";
import { recallSession, rememberSession } from "../../lib/world/sessionMemory";
import { speechSync } from "../../lib/voice/speechSync";
import { deriveWorld, type WorldState } from "../../lib/world/worldState";

export type LivePhase = "idle" | "starting" | "running" | "error";

export interface LiveControls {
  readonly phase: LivePhase;
  readonly session: StartedSession | null;
  readonly connection: ConnectionState;
  readonly trial: TrialState;
  readonly world: WorldState | null;
  readonly debrief: DebriefRead | null;
  readonly clock: { current: number };
  /** The last action's error in words, or null. */
  readonly error: string | null;
  readonly start: (mode: "practice" | "assessment") => Promise<void>;
  /** The session this tab last started on the case, when there is one to go back to (S6 5.1). */
  readonly resumable: StartedSession | null;
  /** Attach to `resumable` again: its snapshot, then the stream or its published debrief. */
  readonly resume: () => Promise<void>;
  readonly ask: (question: string) => Promise<boolean>;
  readonly request: (recordId: string) => Promise<EvidenceResult | null>;
  readonly commit: (finding: InvestigatorFinding) => Promise<boolean>;
  /** Ask the referee for the debrief again after a failure. */
  readonly retryDebrief: () => void;
  /** True when the last debrief request failed. */
  readonly debriefFailed: boolean;
  /** Tell the companion the investigator is typing (S6 6.3 `listening`). */
  readonly typing: () => void;
  readonly stop: () => void;
  /** The connection's trouble in words (the snapshot could not be read, the stream gave up), or null. */
  readonly connectionError: string | null;
  /** Retry after `connectionError`, keeping the session. */
  readonly reconnect: () => void;
}

interface Options {
  readonly api: ArenaApi;
  readonly caseId: string | null;
  readonly subjectName: string;
  readonly reducedMotion: boolean;
  readonly paused: boolean;
}

/** The server's refusals in the room's words (S6 4.3, 4.4, 4.6). */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "The daily session limit has been reached.";
    if (error.status === 409) return "One moment: the previous turn is still being saved.";
    if (error.status === 404) return "This case is not available.";
    if (error.status === 422) return "The request was refused as invalid.";
    if (error.status >= 500) return "The server could not complete the request. Try again.";
  }
  return "The request could not be completed.";
}

/** The controller's unrecoverable-by-itself states in the room's words. */
export function describeConnection(connection: ConnectionState): string | null {
  if (connection === "failed") return "The interview could not be loaded.";
  if (connection === "gave_up") return "The connection to the interview was lost.";
  if (connection === "end_failed") return "The end of the interview could not be read.";
  return null;
}

const TYPING_MS = 1600;

export function useLiveSession({ api, caseId, subjectName, reducedMotion, paused }: Options): LiveControls {
  const [phase, setPhase] = useState<LivePhase>("idle");
  const [session, setSession] = useState<StartedSession | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [trial, setTrial] = useState<TrialState>(initialTrialState);
  const [world, setWorld] = useState<WorldState | null>(null);
  const [debrief, setDebrief] = useState<DebriefRead | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debriefFailed, setDebriefFailed] = useState(false);
  const [debriefAttempt, setDebriefAttempt] = useState(0);
  const controller = useRef<SessionController | null>(null);
  const tracker = useRef<ArrivalTracker>(EMPTY_TRACKER);
  const trialRef = useRef<TrialState>(initialTrialState());
  const t0 = useRef(0);
  const clock = useRef(0);
  const lastTyped = useRef(-Infinity);
  const worldKey = useRef("");
  const debriefAsked = useRef(false);
  const generation = useRef(0);
  const options = useRef({ subjectName, reducedMotion, paused });
  useEffect(() => {
    options.current = { subjectName, reducedMotion, paused };
  });

  const dropController = () => {
    controller.current?.dispose();
    controller.current = null;
  };

  const stop = useCallback(() => {
    generation.current += 1;
    controller.current?.dispose();
    controller.current = null;
    tracker.current = EMPTY_TRACKER;
    trialRef.current = initialTrialState();
    worldKey.current = "";
    debriefAsked.current = false;
    setDebriefFailed(false);
    setPhase("idle");
    setSession(null);
    setConnection("idle");
    setTrial(initialTrialState());
    setWorld(null);
    setDebrief(null);
    setError(null);
  }, []);

  // A different case ends the session in hand.
  useEffect(() => stop, [caseId, stop]);

  // Attach a controller to a started session; `run` is the start's generation, so a stop (or a new case) while
  // the POST or the snapshot is pending leaves the room as it is and the late answer is dropped.
  const attach = useCallback(
    async (started: StartedSession, run: number) => {
      const c = createSessionController({ trialId: started.trial_id, sessionId: started.session_id, api });
      controller.current = c;
      t0.current = performance.now();
      c.subscribe(() => {
        if (generation.current !== run) return;
        const s = c.getState();
        const now = performance.now() - t0.current;
        tracker.current = trackArrivals(tracker.current, s.trial, now);
        trialRef.current = s.trial;
        setTrial(s.trial);
        setConnection(s.connection);
        setDebrief(s.debrief);
      });
      setSession(started);
      setPhase("running");
      await c.start();
    },
    [api],
  );

  const start = useCallback(
    async (mode: "practice" | "assessment") => {
      if (caseId === null || controller.current !== null) return;
      const run = generation.current;
      setPhase("starting");
      setError(null);
      try {
        const started = await api.startSession({ case_id: caseId, mode, voice: false, idem_key: crypto.randomUUID() });
        if (generation.current !== run) return;
        rememberSession(started);
        await attach(started, run);
      } catch (e) {
        if (generation.current !== run) return;
        dropController();
        setError(describeError(e));
        setPhase("error");
      }
    },
    [api, attach, caseId],
  );

  const resumable = caseId === null || phase !== "idle" ? null : recallSession(caseId);
  const resume = useCallback(async () => {
    const started = caseId === null ? null : recallSession(caseId);
    if (started === null || controller.current !== null) return;
    const run = generation.current;
    setPhase("starting");
    setError(null);
    try {
      await attach(started, run);
    } catch (e) {
      if (generation.current !== run) return;
      dropController();
      setError(describeError(e));
      setPhase("error");
    }
  }, [attach, caseId]);

  // Reconnect after the stream gave up or the end could not be read (the controller's own retry), or reload the
  // session from its snapshot when the first snapshot read failed (the controller cannot recover that one).
  const reconnect = useCallback(() => {
    const c = controller.current;
    if (c === null || session === null) return;
    if (c.getState().connection !== "failed") {
      c.reconnect();
      return;
    }
    c.dispose();
    controller.current = null;
    tracker.current = EMPTY_TRACKER;
    const run = generation.current;
    attach(session, run).catch(() => {
      if (generation.current === run) setConnection("failed");
    });
  }, [attach, session]);

  // The world, derived every frame from the view and the session clock, published when it changes.
  useEffect(() => {
    if (phase !== "running") return;
    let frame = 0;
    const step = () => {
      const now = performance.now() - t0.current;
      clock.current = now;
      const o = options.current;
      const w = deriveWorld({
        view: trialRef.current.view,
        nowMs: now,
        arrivals: tracker.current.arrivals,
        subjectName: o.subjectName,
        investigatorActive: now - lastTyped.current < TYPING_MS,
        reducedMotion: o.reducedMotion,
        paused: o.paused,
        voice: speechSync.activeFor,
      });
      const key = JSON.stringify(w);
      if (key !== worldKey.current) {
        worldKey.current = key;
        setWorld(w);
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [phase]);

  // Once the trial has ended with a committed finding, ask the referee for the debrief (S6 4.7); once.
  const ended = trial.view?.status === "ended" && trial.view.commitmentHash !== null;
  useEffect(() => {
    if (!ended || debriefAsked.current || controller.current === null) return;
    debriefAsked.current = true;
    controller.current.requestDebrief().then(
      () => {
        setDebriefFailed(false);
      },
      () => {
        setDebriefFailed(true);
        setError("The debrief could not be scored: the referee did not answer. Try again in a moment.");
      },
    );
  }, [ended, debriefAttempt]);

  const retryDebrief = useCallback(() => {
    debriefAsked.current = false;
    setError(null);
    setDebriefAttempt((n) => n + 1);
  }, []);

  const ask = useCallback(async (question: string) => {
    const c = controller.current;
    if (c === null) return false;
    setError(null);
    try {
      await c.submitTurn(question);
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    }
  }, []);

  const request = useCallback(async (recordId: string) => {
    const c = controller.current;
    if (c === null) return null;
    setError(null);
    try {
      const result = await c.requestEvidence([recordId]);
      if (result.denied.includes(recordId)) setError("Not available at this point in the interview.");
      return result;
    } catch (e) {
      setError(describeError(e));
      return null;
    }
  }, []);

  const commit = useCallback(async (finding: InvestigatorFinding) => {
    const c = controller.current;
    if (c === null) return false;
    setError(null);
    try {
      await c.submitFinding(finding);
      return true;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "The interview changed; review and confirm again." : describeError(e));
      return false;
    }
  }, []);

  const typing = useCallback(() => {
    lastTyped.current = performance.now() - t0.current;
  }, []);

  useEffect(
    () => () => {
      controller.current?.dispose();
    },
    [],
  );

  const connectionError = phase === "running" ? describeConnection(connection) : null;
  return { phase, session, connection, trial, world, debrief, clock, error, start, resumable, resume, ask, request, commit, retryDebrief, debriefFailed, typing, stop, connectionError, reconnect };
}
