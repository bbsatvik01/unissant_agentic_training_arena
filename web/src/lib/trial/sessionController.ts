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
 * - Lost frames: a refused frame that may carry state, or one too broken to identify, makes the controller re-read
 *   the snapshot (the absolute state), in any mode. A practice text stream is also gap-free (S5 6.1): the cursor
 *   stops at the gap-free prefix, a card above a gap waits, and a gap is covered the same way; a refused card
 *   closes its turn and counts toward the prefix.
 * - Retries: an action retried after a failure that may have been applied resends the same request and
 *   idempotency key (S5 5.2); only its own answer, or an outright refusal (4xx) while no earlier attempt may have
 *   been applied (after such an attempt, only a 422 on the same body), forgets it.
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
/** A failed snapshot re-read is retried this many times (after 1, 2 and 4 s). */
export const RESYNC_RETRIES = 3;

/**
 * `idle` before `start()`; `loading` while the snapshot is read; `connecting` until the stream opens; `live`;
 * `reconnecting` while a retry is scheduled (the room says "Reconnecting"); `hidden` after the hidden-tab close;
 * `gave_up` when the retry budget ran out (`reconnect()` starts again); `ending` once the stream is closed for good
 * while the terminal snapshot and the debrief are read over REST (with bounded retries); `end_failed` when those
 * reads kept failing (`reconnect()` reads them again, opening no stream); `finished` once both are loaded; `failed` when the snapshot could not be read; `closed` after `dispose()`.
 */
export type ConnectionState =
  | "idle"
  | "loading"
  | "connecting"
  | "live"
  | "reconnecting"
  | "hidden"
  | "gave_up"
  | "ending"
  | "end_failed"
  | "finished"
  | "failed"
  | "closed";

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
 * The server refused this attempt outright (4xx: this attempt wrote nothing). Any other failure (network, 5xx, a
 * lost or malformed answer) may have been applied: the retry must reuse the key.
 */
function refused(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}

/**
 * Whether a failed attempt ends its action's identity. A refusal ends it only when no earlier attempt under the same
 * key may have been applied; once one may have (`uncertain`), a refusal of a retry (a 403, a 429) says nothing about
 * that earlier attempt, and only a 422 (the same body is invalid, so no attempt could have been applied) ends it.
 */
function endsIdentity(error: unknown, uncertain: boolean): boolean {
  if (!refused(error)) return false;
  return !uncertain || (error instanceof ApiError && error.status === 422);
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
  /** Idempotency keys some attempt of which may have been applied (a lost answer, a 5xx, a malformed answer). */
  const uncertainKeys = new Set<string>();
  let completing: Promise<void> | null = null;
  /** The gap-free prefix a snapshot re-read was last made for. */
  let gapResynced: number | null = null;
  let resyncing = false;
  let resyncAgain = false;
  let resyncFailures = 0;
  let findingsInFlight = 0;
  let findingCommitted = false;
  let reported = 0;
  let started: Promise<void> | null = null;
  let disposed = false;
  let unsubscribeVisibility: (() => void) | null = null;

  /** Read through a function: awaits in between can dispose the controller, which a narrowed flag would hide. */
  const isDisposed = (): boolean => disposed;

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
    // Acknowledge before subscribers are told, so before any render (S6 5.6). This runs on an unchanged state too:
    // a streamed card the snapshot already showed is acknowledged when its frame arrives.
    const { trial, drops } = settleAcks(incoming);
    if (trial === state.trial && drops === 0) return;
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

  /** The stream is closed for good (S6 5.1); what remains is reading the terminal state over REST. */
  const stopForGood = () => {
    stopStream("finish");
    clearHiddenTimer();
  };

  /** The stream is closed for good: no stream is opened again (`ending`, `end_failed` or `finished`). */
  const over = (): boolean => state.connection === "ending" || state.connection === "end_failed" || state.connection === "finished";

  /** Waits of the REST retries; dispose() ends them all at once, so nothing awaiting one hangs. */
  const waits = new Set<() => void>();
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        waits.delete(done);
        resolve();
      };
      const handle = scheduler.setTimeout(() => {
        catchUpTimers.delete(handle);
        done();
      }, ms);
      catchUpTimers.add(handle);
      waits.add(done);
    });

  /** A REST read retried RESYNC_RETRIES times (1, 2, 4 s); each failure is kept as the error. */
  const readWithRetries = async <T,>(read: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        set({ error });
        if (attempt >= RESYNC_RETRIES || isDisposed()) throw error;
        await delay(CATCH_UP_MS * 2 ** attempt);
        if (isDisposed()) throw error;
      }
    }
  };

  /** A published debrief is never replaced by an older `scoring` answer. */
  const setDebrief = (debrief: DebriefRead) => {
    if (state.debrief !== null && "schema_version" in state.debrief && !("schema_version" in debrief)) return;
    set({ debrief });
  };

  const loadDebrief = async () => {
    if (isDisposed()) return;
    try {
      setDebrief(await api.readDebrief(sessionId));
    } catch (error) {
      set({ error });
    }
  };

  /** Read and fold the snapshot now (the room changed under a request); a failed read is kept as the error. */
  const reloadRoom = async () => {
    if (isDisposed()) return;
    try {
      const snapshot = await api.trialSnapshot(trialId);
      if (!disposed) dispatch({ type: "snapshot", snapshot });
    } catch (error) {
      set({ error });
    }
  };

  /** Read the debrief; a published one ends the stream (S6 5.1), a `scoring` answer keeps it open. */
  const finishIfPublished = async () => {
    await loadDebrief();
    if (state.debrief !== null && "schema_version" in state.debrief && stream !== null) await complete();
  };

  /**
   * The session is over and its stream closed for good (`debrief.ready`, a published debrief, or a ticket answered
   * 409 `stream_closed`): the terminal snapshot (the commitment hash, and in an assessment the coaching withheld
   * until now) and the debrief carry everything (S6 5.1, SG4-21).
   */
  const complete = (options: { readonly snapshotLoaded?: boolean } = {}): Promise<void> => {
    if (isDisposed()) return Promise.resolve();
    completing ??= (async () => {
      stopForGood();
      set({ connection: "ending" });
      try {
        if (options.snapshotLoaded !== true) {
          const snapshot = await readWithRetries(() => api.trialSnapshot(trialId));
          if (isDisposed()) return;
          dispatch({ type: "snapshot", snapshot });
        }
        if (state.debrief === null || !("schema_version" in state.debrief)) {
          setDebrief(await readWithRetries(() => api.readDebrief(sessionId)));
        }
        set({ connection: "finished", error: null });
      } catch {
        // Kept as `error`; `reconnect()` reads again. The stream stays closed for good.
        set({ connection: "end_failed" });
      }
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

  /** The room is following a stream (any mode): a lost frame there is covered by re-reading the snapshot. */
  const streaming = (): boolean => view() !== null && stream !== null && !over();

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
    if (isDisposed()) return;
    if (resyncing) {
      resyncAgain = true;
      return;
    }
    resyncing = true;
    void (async () => {
      let failed = false;
      try {
        const snapshot = await api.trialSnapshot(trialId);
        resyncFailures = 0;
        if (!disposed && !over()) {
          dispatch({ type: "snapshot", snapshot });
          // The trial ended: a lost debrief.ready is not in any snapshot, so ask the debrief route directly.
          if (snapshot.status !== "running") await finishIfPublished();
        }
      } catch (error) {
        failed = true;
        set({ error });
      } finally {
        resyncing = false;
      }
      if (disposed || over()) return;
      if (resyncAgain) {
        resyncAgain = false;
        resync();
      } else if (failed && resyncFailures < RESYNC_RETRIES) {
        // A failed read is retried a bounded number of times, with growing waits; a later frame may also retry.
        resyncFailures += 1;
        gapResynced = null;
        const handle = scheduler.setTimeout(() => {
          catchUpTimers.delete(handle);
          resync();
        }, CATCH_UP_MS * 2 ** (resyncFailures - 1));
        catchUpTimers.add(handle);
      } else if (failed) {
        gapResynced = null;
      } else {
        checkGap();
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
   * A frame this client refuses but can identify (this trial). In a practice text trial a card closes its turn and
   * is acknowledged invalid; no other frame depends on it, so its seq counts toward the gap-free prefix. Any other
   * frame, in any mode, may carry state the room needs (an answer, a release, the end): the snapshot is re-read to
   * cover it, and in a gap-free stream its seq stays a gap, so the cards above it wait. Nothing of it is kept.
   */
  const refuseIdentified = (frame: { readonly seq: unknown; readonly type: unknown; readonly data: unknown }) => {
    const turn = brokenCardTurn(frame);
    const v = view();
    if (turn !== null && v?.mode === "practice" && v.channel === "text") {
      streamCards.add(turn);
      droppedCards.add(turn);
      dispatch({ type: "card_refused", turn_no: turn });
      if (typeof frame.seq === "number" && Number.isSafeInteger(frame.seq)) dispatch({ type: "seq_skipped", seq: frame.seq });
      return;
    }
    if (streaming()) resync();
  };

  /** A frame dropped before validation (S6 5.2): identify it if it can be, else re-read the snapshot. */
  const onDrop = (reason: TrialDropReason, raw: unknown) => {
    set({ dropped: state.dropped + 1 });
    if (reason === "rejected") return;
    const parsed = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const scope = parsed?.["scope_id"];
    if (parsed !== null && scope === trialId) refuseIdentified({ seq: parsed["seq"], type: parsed["type"], data: parsed["data"] });
    // A frame naming another trial is that trial's, never this one's; anything else could be this trial's: re-read.
    else if (!(typeof scope === "string" && scope !== "") && streaming()) resync();
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
    if (over() || disposed) handle.close();
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
    if (isDisposed()) return;
    const handle = scheduler.setTimeout(() => {
      catchUpTimers.delete(handle);
      if (stream !== null && behind()) stream.reconnect();
    }, CATCH_UP_MS);
    catchUpTimers.add(handle);
  };

  const afterPost = (answer: PostAck) => {
    const target = answer.last_seq;
    catchUp(() => (stream?.lastSeq ?? cursor) < target);
  };

  /**
   * An action identical to one still in flight shares its request instead of sending a second one under the same
   * key: a refusal of the second could otherwise end the identity while the first may still be applied.
   */
  const inFlight = new Map<string, Promise<unknown>>();
  const once = <T,>(id: string, run: () => Promise<T>): Promise<T> => {
    const held = inFlight.get(id);
    if (held !== undefined) return held as Promise<T>;
    const started = run().finally(() => {
      if (inFlight.get(id) === started) inFlight.delete(id);
    });
    inFlight.set(id, started);
    return started;
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
    uncertainKeys.delete(key);
  };

  const requireView = () => {
    const v = view();
    if (v === null) throw new Error("the room cannot act before the snapshot is read");
    return v;
  };

  const run = async () => {
    set({ connection: "loading", error: null });
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
      // Not awaited: start() settles once the snapshot is in; the debrief read (with its retries) follows.
      void complete({ snapshotLoaded: true });
      return;
    }
    unsubscribeVisibility = visibility.subscribe(syncVisibility);
    openLive();
  };

  return {
    start() {
      // A bootstrap that failed (the snapshot could not be read) may be started again.
      if (state.connection === "failed") started = null;
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
    submitTurn(question) {
      return once(`turn:${question}`, async () => {
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
          uncertainKeys.delete(body.idem_key);
        };
        try {
          const answer = await api.submitTurn(trialId, body);
          settle();
          afterPost(answer);
        } catch (error) {
          if (endsIdentity(error, uncertainKeys.has(body.idem_key))) settle();
          else if (!refused(error)) uncertainKeys.add(body.idem_key);
          throw error;
        }
      });
    },
    requestEvidence(recordIds) {
      return once(`evidence:${JSON.stringify(recordIds)}`, async () => {
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
          if (endsIdentity(error, uncertainKeys.has(idem))) settleKey("evidence", match, idem);
          else if (!refused(error)) uncertainKeys.add(idem);
          throw error;
        }
      });
    },
    submitFinding(finding) {
      return once(`finding:${JSON.stringify(finding)}`, async () => {
        requireView();
        const match = JSON.stringify(finding);
        const idem = keyFor("finding", match);
        findingsInFlight += 1;
        dispatch({ type: "finding_submitted" });
        try {
          const answer = await api.commitFinding(trialId, { finding, idem_key: idem });
          findingsInFlight -= 1;
          findingCommitted = true;
          settleKey("finding", match, idem);
          afterPost(answer);
        } catch (error) {
          findingsInFlight -= 1;
          if (endsIdentity(error, uncertainKeys.has(idem))) settleKey("finding", match, idem);
          else if (!refused(error)) uncertainKeys.add(idem);
          // S6 4.6: a 409 (a turn is still open) reloads the room state before the investigator confirms again; the
          // draft is the caller's and stays as it is.
          if (error instanceof ApiError && error.status === 409) await reloadRoom();
          // The room leaves `finalizing` only when no submit is still in flight and none succeeded.
          if (findingsInFlight === 0 && !findingCommitted) dispatch({ type: "finding_failed" });
          throw error;
        }
      });
    },
    async requestDebrief() {
      const debrief = await api.requestDebrief(sessionId);
      setDebrief(debrief);
      await complete();
    },
    reconnect() {
      if (state.connection === "end_failed") {
        void complete();
        return;
      }
      if (stream === null || state.connection !== "gave_up") return;
      set({ connection: "connecting" });
      stream.reconnect();
    },
    dispose() {
      stopStream("close");
      clearHiddenTimer();
      for (const handle of catchUpTimers) scheduler.clearTimeout(handle);
      catchUpTimers.clear();
      for (const done of [...waits]) done();
      unsubscribeVisibility?.();
      unsubscribeVisibility = null;
      set({ connection: "closed" });
      disposed = true;
      listeners.clear();
    },
  };
}
