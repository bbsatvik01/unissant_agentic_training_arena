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
 * - A practice text stream is gap-free (S5 6.1): the cursor stops at the gap-free prefix, a card above a gap waits,
 *   and a gap, or a frame too broken to identify, makes the controller re-read the snapshot (the absolute state).
 *   A refused frame it can identify (this trial, a seq) counts toward the prefix; a refused card closes its turn.
 * - Retries: an action retried after a failure that may have been applied resends the same request and
 *   idempotency key (S5 5.2); only its own answer or an outright refusal (4xx) forgets it.
 * - The end: after a terminal status the stream stays open (catch-up tickets) until `debrief.ready` or a
 *   published debrief from `POST /api/sessions/{id}/debrief`; then `finish()`. A ticket answered 409
 *   `stream_closed`, and any visit to an ended trial, read the snapshot and `GET /api/sessions/{id}/debrief`
 *   and open no stream (SG4-21).
 */

import type { ArenaApi, PostAck } from "../api/arena";
import { ApiError } from "../api/client";
import type { DebriefRead, EvidenceResult, InvestigatorFinding, TrialFrame as WireFrame, TurnSubmit } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { openTrialStream, type TrialDropReason, type TrialFrame, type TrialStreamHandle, type TrialStreamOptions } from "../sse/trial-stream";
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

/**
 * The server refused the request outright (4xx: nothing was written), so a later attempt is a new action. Any
 * other failure (network, 5xx, a lost answer) may have been applied: the retry must reuse the key.
 */
function refused(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/** The turn a broken `coach.card` frame names, when it names one (1..12), for its `client_invalid` acknowledgement. */
function brokenCardTurn(frame: { readonly type: unknown; readonly data: unknown }): number | null {
  if (frame.type !== "coach.card" || typeof frame.data !== "object" || frame.data === null) return null;
  const turn = (frame.data as Record<string, unknown>)["turn_no"];
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
  /** Turns whose `coach.card` arrived on the stream: only these are acknowledged (S6 5.6). */
  const streamCards = new Set<number>();
  /** Streamed card turns already counted as dropped. */
  const droppedCards = new Set<number>();
  /**
   * Unsettled requests by action and content, so a retry of the same action resends the same request with the same
   * idempotency key (S5 5.2) even after other actions ran in between. Each is forgotten only when its own request
   * settles: answered, or refused outright (4xx).
   */
  const pendingTurns = new Map<string, TurnSubmit>();
  const pendingKeys = new Map<string, string>();
  let completing: Promise<void> | null = null;
  /** The gap-free prefix a snapshot re-read was last made for. */
  let gapResynced: number | null = null;
  let resyncing = false;
  let resyncAgain = false;
  let reported = 0;
  let started: Promise<void> | null = null;
  let disposed = false;
  let unsubscribeVisibility: (() => void) | null = null;

  const set = (patch: Partial<SessionState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const ack = (turn: number, valid: boolean) => {
    acked.add(turn);
    api.ackCard({ trial_id: trialId, turn_no: turn, client_valid: valid }).catch(() => undefined);
  };

  /**
   * One acknowledgement per streamed card, once its verdict is known: shown, or refused (stale or failing the
   * schema). A pending card (reading a frame not folded yet) waits; a later frame shows or refuses it. A refused
   * card is pinned refused (`card_refused`), so nothing later, a snapshot included, shows what was acknowledged
   * invalid. Practice text trials only: no other population receives live cards (S6 5.6).
   */
  const settleAcks = (incoming: TrialState): { trial: TrialState; drops: number } => {
    let trial = incoming;
    let drops = 0;
    const v = incoming.view;
    if (v === null || v.mode !== "practice" || v.channel !== "text") return { trial, drops };
    for (const turn of streamCards) {
      if (acked.has(turn)) continue;
      if (v.cards.some((c) => c.turn_no === turn)) ack(turn, true);
      else if (v.rejectedCards.includes(turn)) {
        ack(turn, false);
        trial = trialReducer(trial, { type: "card_refused", turn_no: turn });
        // Refused after it was taken as pending: dropped and counted now, once (S6 4.5).
        if (!droppedCards.has(turn)) {
          droppedCards.add(turn);
          drops += 1;
        }
      }
    }
    return { trial, drops };
  };

  const setTrial = (incoming: TrialState) => {
    if (incoming === state.trial) return;
    // Acknowledge before subscribers are told, so before any render (S6 5.6).
    const { trial, drops } = settleAcks(incoming);
    // Report each new violation once (S6 5.4); a report that fails is not retried and never breaks the room.
    for (const v of trial.violations.slice(reported)) {
      api.reportContractViolation({ trial_id: trialId, frame_type: v.frame_type, seq: v.seq, reason: v.reason }).catch(() => undefined);
    }
    reported = trial.violations.length;
    set({ trial, dropped: state.dropped + drops });
  };

  const dispatch = (action: TrialAction) => {
    setTrial(trialReducer(state.trial, action));
  };

  const view = () => state.trial.view;

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

  /** A published debrief is never replaced by an older `scoring` answer. */
  const setDebrief = (debrief: DebriefRead) => {
    if (state.debrief !== null && "schema_version" in state.debrief && !("schema_version" in debrief)) return;
    set({ debrief });
  };

  const loadDebrief = async () => {
    try {
      setDebrief(await api.readDebrief(sessionId));
    } catch (error) {
      set({ error });
    }
  };

  /**
   * The session is over and its stream closed for good (`debrief.ready`, a published debrief, or a ticket answered
   * 409 `stream_closed`): the terminal snapshot (the commitment hash, and in an assessment the coaching withheld
   * until now) and the debrief carry everything (S6 5.1, SG4-21).
   */
  const complete = (): Promise<void> => {
    completing ??= (async () => {
      finish();
      try {
        const snapshot = await api.trialSnapshot(trialId);
        if (!disposed) dispatch({ type: "snapshot", snapshot });
      } catch (error) {
        set({ error });
      }
      if (state.debrief === null || !("schema_version" in state.debrief)) await loadDebrief();
    })().finally(() => {
      // Only the run in flight is shared: a later call (another debrief request) reads the REST state again.
      completing = null;
    });
    return completing;
  };

  /** Practice text streams are gap-free (S5 6.1): there the cursor stops at the gap-free prefix. */
  const resumePoint = (): number => {
    const v = view();
    if (v === null) return cursor;
    return v.mode === "practice" && v.channel === "text" ? v.contiguousSeq : v.lastSeq;
  };

  const gapFreeRunning = (): boolean => {
    const v = view();
    return v !== null && v.mode === "practice" && v.channel === "text" && v.status !== "ended";
  };

  /**
   * Re-read the snapshot, the trial's absolute state, to cover frames this client could not use: a gap in a
   * gap-free stream, or a frame it could not even parse. One read at a time; a request during a read runs once
   * more after it, so a frame committed after the first read began is covered too.
   */
  const resync = () => {
    if (resyncing) {
      resyncAgain = true;
      return;
    }
    resyncing = true;
    void (async () => {
      try {
        const snapshot = await api.trialSnapshot(trialId);
        if (!disposed && state.connection !== "finished") dispatch({ type: "snapshot", snapshot });
      } catch (error) {
        set({ error });
      } finally {
        resyncing = false;
        if (resyncAgain) {
          resyncAgain = false;
          resync();
        }
      }
    })();
  };

  /** A missing frame below a held one in a gap-free stream: re-read the snapshot, once per gap. */
  const checkGap = () => {
    const v = view();
    if (v === null || !gapFreeRunning() || v.lastSeq <= v.contiguousSeq || gapResynced === v.contiguousSeq) return;
    gapResynced = v.contiguousSeq;
    resync();
  };

  /**
   * A frame this client refuses but can identify (this trial, a persisted seq): its seq will never fold, so it
   * counts toward the gap-free prefix; a card closes its turn and is acknowledged invalid. Nothing of it is kept.
   */
  const refuseIdentified = (frame: { readonly seq: unknown; readonly type: unknown; readonly data: unknown }) => {
    const turn = brokenCardTurn(frame);
    const v = view();
    if (turn !== null && v?.mode === "practice" && v.channel === "text") {
      streamCards.add(turn);
      droppedCards.add(turn);
      dispatch({ type: "card_refused", turn_no: turn });
    }
    if (typeof frame.seq === "number" && Number.isSafeInteger(frame.seq)) dispatch({ type: "seq_skipped", seq: frame.seq });
  };

  /** A frame dropped before validation (S6 5.2): identify it if it can be, else re-read the snapshot. */
  const onDrop = (reason: TrialDropReason, raw: unknown) => {
    set({ dropped: state.dropped + 1 });
    if (reason === "rejected") return;
    const parsed = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
    if (parsed !== null && parsed["scope_id"] === trialId) refuseIdentified({ seq: parsed["seq"], type: parsed["type"], data: parsed["data"] });
    else if (gapFreeRunning()) resync();
    checkGap();
  };

  const onFrame = (frame: TrialFrame): boolean => {
    if (!isWire("events", frame)) {
      // The server closed the turn on a card like this: close it here too, keeping nothing of it.
      refuseIdentified(frame);
      checkGap();
      return false;
    }
    const wire: WireFrame = frame;
    const result = applyFrame(state.trial, wire);
    const counted = result.outcome === "applied" || result.outcome === "duplicate";
    // A card refused on arrival is dropped and counted by the stream (S6 4.5); one refused later by settleAcks.
    const refusedNow = counted && wire.type === "coach.card" && (result.state.view?.rejectedCards.includes(wire.data.turn_no) ?? false);
    if (counted && wire.type === "coach.card") {
      streamCards.add(wire.data.turn_no);
      if (refusedNow) droppedCards.add(wire.data.turn_no);
    }
    setTrial(result.state);
    checkGap();
    if (result.state.view?.debriefReady != null && stream !== null) void complete();
    return counted && !refusedNow;
  };

  const mintTicket = async (id: string): Promise<string> => {
    try {
      return await api.mintStreamTicket(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === "stream_closed") void complete();
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
      resumeCursor: () => resumePoint(),
      onDrop,
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
    // The first ticket mint can settle before this assignment only as a 409 handled by complete(), which
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

  /** The same action retried reuses its key; a different one gets a fresh key. */
  const keyFor = (kind: "evidence" | "finding", match: string): string => {
    const id = `${kind}:${match}`;
    const held = pendingKeys.get(id);
    if (held !== undefined) return held;
    const key = newKey();
    pendingKeys.set(id, key);
    return key;
  };

  /** Forget a key once its own request settled; a newer request's key stays. */
  const settleKey = (kind: "evidence" | "finding", match: string, key: string) => {
    const id = `${kind}:${match}`;
    if (pendingKeys.get(id) === key) pendingKeys.delete(id);
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
      // A retry of the same question resends the same request, key and version included, so the server resumes it.
      const body: TurnSubmit = pendingTurns.get(question) ?? {
        question,
        release_ids: [],
        expected_version: v.transcriptVersion,
        idem_key: newKey(),
      };
      pendingTurns.set(question, body);
      const settle = () => {
        if (pendingTurns.get(question) === body) pendingTurns.delete(question);
      };
      try {
        const answer = await api.submitTurn(trialId, body);
        settle();
        afterPost(answer);
      } catch (error) {
        if (refused(error)) settle();
        throw error;
      }
    },
    async requestEvidence(recordIds) {
      requireView();
      const ids = [...recordIds];
      const match = JSON.stringify(ids);
      const idem = keyFor("evidence", match);
      try {
        const result = await api.requestEvidence(trialId, { record_ids: ids, idem_key: idem });
        settleKey("evidence", match, idem);
        // Records released in one call share one transcript version: wait for each record, not only the version.
        const expected = [...result.released.map((r) => r.record_id), ...result.already_released];
        catchUp(() => {
          const v = view();
          if (v === null) return false;
          return v.transcriptVersion < result.transcript_version || expected.some((id) => !v.released.some((r) => r.record_id === id));
        });
        return result;
      } catch (error) {
        if (refused(error)) settleKey("evidence", match, idem);
        throw error;
      }
    },
    async submitFinding(finding) {
      requireView();
      const match = JSON.stringify(finding);
      const idem = keyFor("finding", match);
      dispatch({ type: "finding_submitted" });
      try {
        const answer = await api.commitFinding(trialId, { finding, idem_key: idem });
        settleKey("finding", match, idem);
        afterPost(answer);
      } catch (error) {
        if (refused(error)) settleKey("finding", match, idem);
        dispatch({ type: "finding_failed" });
        throw error;
      }
    },
    async requestDebrief() {
      const debrief = await api.requestDebrief(sessionId);
      setDebrief(debrief);
      await complete();
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
