/**
 * The room's session controller (S6 5.1, 5.6; S5 6.3-6.4): the imperative shell around the pure
 * `trialReducer`. Framework-free; a React hook can read it through `subscribe` and `getState`.
 *
 * - Bootstrap: `GET /api/trials/{id}/snapshot` (validated), folded into the reducer; a running trial then
 *   opens the ticketed stream with `after=<snapshot.last_seq>`, each attempt minting a fresh ticket.
 * - Every frame passes the compiled wire validators (`isWire("events")`, schema and invariants) before the
 *   reducer sees it; a failing frame is dropped and counted, never rendered (S6 5.2, FE-SSE-6). A frame the
 *   visibility re-check refuses is dropped too and reported once to `POST /api/telemetry/contract-violation`.
 * - KPI-4 (S6 5.6): on a `coach.card` frame in a practice text trial the controller posts one acknowledgement
 *   per turn, `client_valid` from the schema and the complete-card rule, before subscribers are told (before
 *   any render); a duplicate posts nothing new.
 * - Catch-up: after a POST that produces events, if the stream has not reached its `last_seq` (or, for an
 *   evidence request, which answers no `last_seq`, its `transcript_version`) 1 s later, the stream reconnects
 *   with `after=<lastSeq>`.
 * - Hidden tab: the stream closes after 60 s hidden and resumes with `after=<lastSeq>` when visible.
 * - The end: after a terminal status the stream stays open (catch-up tickets) until `debrief.ready` or a
 *   published debrief from `POST /api/sessions/{id}/debrief`; then `finish()`. A ticket answered 409
 *   `stream_closed`, and any visit to an ended trial, read the snapshot and `GET /api/sessions/{id}/debrief`
 *   and open no stream (SG4-21).
 */

import type { ArenaApi, PostAck } from "../api/arena";
import { ApiError } from "../api/client";
import type { DebriefRead, EvidenceResult, InvestigatorFinding, TrialFrame as WireFrame } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { openTrialStream, type TrialFrame, type TrialStreamHandle, type TrialStreamOptions } from "../sse/trial-stream";
import type { EventSourceLike } from "../sse/ticketed-stream";
import { applyFrame, initialTrialState, trialReducer, type TrialAction, type TrialState } from "./trialReducer";

/** The stream closes after the tab has been hidden this long (S6 5.1; FE-SSE-5 allows 61 s). */
export const HIDDEN_CLOSE_MS = 60_000;
/** The catch-up check runs this long after a POST answered (S6 5.1). */
export const CATCH_UP_MS = 1_000;

/**
 * `idle` before `start()`; `loading` while the snapshot is read; `connecting` until the stream opens; `live`;
 * `reconnecting` while a retry is scheduled (the room says "Reconnecting"); `hidden` after the hidden-tab close;
 * `gave_up` when the retry budget ran out (`reconnect()` starts again); `finished` once the debrief is the
 * source of truth; `failed` when the snapshot could not be read; `closed` after `dispose()`.
 */
export type ConnectionState = "idle" | "loading" | "connecting" | "live" | "reconnecting" | "hidden" | "gave_up" | "finished" | "failed" | "closed";

export interface SessionState {
  readonly trial: TrialState;
  readonly connection: ConnectionState;
  /** The debrief as last read or published; null until then. */
  readonly debrief: DebriefRead | null;
  /** Frames dropped (malformed, oversize, foreign, failing validation or the visibility re-check). */
  readonly dropped: number;
  /** The last error the controller kept (snapshot or debrief read). */
  readonly error: unknown;
}

export interface VisibilitySource {
  hidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export type SessionApi = Pick<
  ArenaApi,
  | "trialSnapshot"
  | "mintStreamTicket"
  | "readDebrief"
  | "requestDebrief"
  | "ackCard"
  | "reportContractViolation"
  | "submitTurn"
  | "requestEvidence"
  | "commitFinding"
>;

export interface SessionControllerOptions {
  readonly trialId: string;
  readonly sessionId: string;
  readonly api: SessionApi;
  /** Defaults to the page's `document`. */
  readonly visibility?: VisibilitySource;
  /** Timers for the controller and the stream's retries. Defaults to the global timers. */
  readonly scheduler?: Scheduler;
  /** Test seam: the stream opener. Defaults to `openTrialStream`. */
  readonly openStream?: (options: TrialStreamOptions) => TrialStreamHandle;
  /** Test seam passed to the stream. */
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
  /** A fresh idempotency key per action (S6 5.5). Defaults to `crypto.randomUUID`. */
  readonly newKey?: () => string;
}

export interface SessionController {
  start(): Promise<void>;
  getState(): SessionState;
  subscribe(listener: () => void): () => void;
  submitTurn(question: string): Promise<void>;
  requestEvidence(recordIds: readonly string[]): Promise<EvidenceResult>;
  submitFinding(finding: InvestigatorFinding): Promise<void>;
  /** `POST /api/sessions/{id}/debrief`; a published document finishes the stream. */
  requestDebrief(): Promise<void>;
  /** Manual retry after `gave_up`. */
  reconnect(): void;
  dispose(): void;
}

/** The page's visibility; always visible where there is no document. */
export function documentVisibility(doc: Document | null = (globalThis as { document?: Document }).document ?? null): VisibilitySource {
  if (doc === null) return { hidden: () => false, subscribe: () => () => undefined };
  return {
    hidden: () => doc.visibilityState === "hidden",
    subscribe: (listener) => {
      doc.addEventListener("visibilitychange", listener);
      return () => {
        doc.removeEventListener("visibilitychange", listener);
      };
    },
  };
}

const globalScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
};

/** The turn a broken `coach.card` frame names, when it names one (1..12), for its `client_invalid` acknowledgement. */
function brokenCardTurn(frame: TrialFrame): number | null {
  if (frame.type !== "coach.card") return null;
  const turn = frame.data["turn_no"];
  return typeof turn === "number" && Number.isInteger(turn) && turn >= 1 && turn <= 12 ? turn : null;
}

export function createSessionController(options: SessionControllerOptions): SessionController {
  const { trialId, sessionId, api } = options;
  const scheduler = options.scheduler ?? globalScheduler;
  const visibility = options.visibility ?? documentVisibility();
  const openStream = options.openStream ?? openTrialStream;
  const newKey = options.newKey ?? (() => crypto.randomUUID());

  let state: SessionState = { trial: initialTrialState(), connection: "idle", debrief: null, dropped: 0, error: null };
  const listeners = new Set<() => void>();
  let stream: TrialStreamHandle | null = null;
  /** The resume cursor kept across a hidden-tab close. */
  let cursor = 0;
  let hiddenTimer: number | null = null;
  const catchUpTimers = new Set<number>();
  const acked = new Set<number>();
  let reported = 0;
  let started: Promise<void> | null = null;
  let disposed = false;
  let unsubscribeVisibility: (() => void) | null = null;

  const set = (patch: Partial<SessionState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const setTrial = (trial: TrialState) => {
    if (trial === state.trial) return;
    // Report each new violation once (S6 5.4); a report that fails is not retried and never breaks the room.
    for (const v of trial.violations.slice(reported)) {
      api.reportContractViolation({ trial_id: trialId, frame_type: v.frame_type, seq: v.seq, reason: v.reason }).catch(() => undefined);
    }
    reported = trial.violations.length;
    set({ trial });
  };

  const dispatch = (action: TrialAction) => {
    setTrial(trialReducer(state.trial, action));
  };

  const view = () => state.trial.view;

  const ack = (turn: number, valid: boolean) => {
    if (acked.has(turn)) return;
    acked.add(turn);
    api.ackCard({ trial_id: trialId, turn_no: turn, client_valid: valid }).catch(() => undefined);
  };

  const clearHiddenTimer = () => {
    if (hiddenTimer !== null) scheduler.clearTimeout(hiddenTimer);
    hiddenTimer = null;
  };

  const stopStream = (how: "close" | "finish") => {
    if (stream === null) return;
    cursor = stream.lastSeq ?? cursor;
    if (how === "close") stream.close();
    else stream.finish();
    stream = null;
  };

  const finish = () => {
    stopStream("finish");
    clearHiddenTimer();
    set({ connection: "finished" });
  };

  const loadDebrief = async () => {
    try {
      const debrief = await api.readDebrief(sessionId);
      set({ debrief });
    } catch (error) {
      set({ error });
    }
  };

  /** The trial is over and its stream closed for good: the snapshot and the debrief carry everything (SG4-21). */
  const endFromRest = async () => {
    finish();
    try {
      const snapshot = await api.trialSnapshot(trialId);
      if (!disposed) dispatch({ type: "snapshot", snapshot });
    } catch (error) {
      set({ error });
    }
    await loadDebrief();
  };

  const onFrame = (frame: TrialFrame): boolean => {
    const trialView = view();
    if (!isWire("events", frame)) {
      const turn = brokenCardTurn(frame);
      if (turn !== null && trialView?.mode === "practice" && trialView.channel === "text") ack(turn, false);
      return false;
    }
    const wire: WireFrame = frame;
    const result = applyFrame(state.trial, wire);
    if (result.outcome === "applied" && wire.type === "coach.card") {
      // Acknowledge before subscribers are told, so before any render (S6 5.6).
      ack(wire.data.turn_no, result.state.view?.cards.some((c) => c.turn_no === wire.data.turn_no) ?? false);
    }
    setTrial(result.state);
    if (result.state.view?.debriefReady != null && stream !== null) {
      finish();
      void loadDebrief();
    }
    return result.outcome === "applied" || result.outcome === "duplicate";
  };

  const mintTicket = async (id: string): Promise<string> => {
    try {
      return await api.mintStreamTicket(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "stream_closed") void endFromRest();
      throw error;
    }
  };

  const openLive = () => {
    set({ connection: "connecting" });
    const handle = openStream({
      trialId,
      mintTicket,
      initialLastSeq: cursor,
      onFrame,
      onDrop: () => {
        set({ dropped: state.dropped + 1 });
      },
      onOpen: () => {
        if (stream === handle) set({ connection: "live" });
      },
      onRetry: () => {
        if (stream === handle) set({ connection: "reconnecting" });
      },
      onGiveUp: () => {
        if (stream === handle) set({ connection: "gave_up" });
      },
      scheduler,
      ...(options.eventSourceFactory === undefined ? {} : { eventSourceFactory: options.eventSourceFactory }),
    });
    // The first ticket mint can settle before this assignment only as a 409 handled by endFromRest, which
    // finished the session; never keep a handle after that.
    if (state.connection === "finished" || disposed) handle.close();
    else stream = handle;
    syncVisibility();
  };

  const syncVisibility = () => {
    if (visibility.hidden()) {
      if (stream !== null && hiddenTimer === null) {
        hiddenTimer = scheduler.setTimeout(() => {
          hiddenTimer = null;
          stopStream("close");
          set({ connection: "hidden" });
        }, HIDDEN_CLOSE_MS);
      }
      return;
    }
    clearHiddenTimer();
    if (state.connection === "hidden" && !disposed) openLive();
  };

  /** S6 5.1: if the stream has not delivered what a POST produced 1 s later, resume from the cursor. */
  const catchUp = (behind: () => boolean) => {
    const handle = scheduler.setTimeout(() => {
      catchUpTimers.delete(handle);
      if (stream !== null && behind()) stream.reconnect();
    }, CATCH_UP_MS);
    catchUpTimers.add(handle);
  };

  const afterPost = (answer: PostAck) => {
    const target = answer.last_seq;
    if (target !== null) catchUp(() => (stream?.lastSeq ?? cursor) < target);
  };

  const requireView = () => {
    const v = view();
    if (v === null) throw new Error("the room cannot act before the snapshot is read");
    return v;
  };

  const run = async () => {
    set({ connection: "loading" });
    let snapshot;
    try {
      snapshot = await api.trialSnapshot(trialId);
    } catch (error) {
      set({ connection: "failed", error });
      return;
    }
    if (disposed) return;
    dispatch({ type: "snapshot", snapshot });
    cursor = snapshot.last_seq;
    if (snapshot.status !== "running") {
      finish();
      await loadDebrief();
      return;
    }
    unsubscribeVisibility = visibility.subscribe(syncVisibility);
    openLive();
  };

  return {
    start() {
      started ??= run();
      return started;
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async submitTurn(question) {
      const v = requireView();
      afterPost(
        await api.submitTurn(trialId, { question, release_ids: [], expected_version: v.transcriptVersion, idem_key: newKey() }),
      );
    },
    async requestEvidence(recordIds) {
      requireView();
      const result = await api.requestEvidence(trialId, { record_ids: [...recordIds], idem_key: newKey() });
      catchUp(() => (view()?.transcriptVersion ?? 0) < result.transcript_version);
      return result;
    },
    async submitFinding(finding) {
      requireView();
      dispatch({ type: "finding_submitted" });
      try {
        afterPost(await api.commitFinding(trialId, { finding, idem_key: newKey() }));
      } catch (error) {
        dispatch({ type: "finding_failed" });
        throw error;
      }
    },
    async requestDebrief() {
      const debrief = await api.requestDebrief(sessionId);
      set({ debrief });
      if (state.connection !== "finished") finish();
    },
    reconnect() {
      if (stream === null || state.connection !== "gave_up") return;
      set({ connection: "connecting" });
      stream.reconnect();
    },
    dispose() {
      stopStream("close");
      clearHiddenTimer();
      for (const handle of catchUpTimers) scheduler.clearTimeout(handle);
      catchUpTimers.clear();
      unsubscribeVisibility?.();
      unsubscribeVisibility = null;
      set({ connection: "closed" });
      disposed = true;
      listeners.clear();
    },
  };
}
