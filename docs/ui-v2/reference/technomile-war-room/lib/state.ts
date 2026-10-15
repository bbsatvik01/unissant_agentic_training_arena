/**
 * War Room store: folds `run_events` envelopes into view state. Pure; the React layer batches
 * envelopes (~10 Hz) and calls `reduceAll` once per frame.
 *
 * Ordering rules:
 * - an envelope whose seq is at or below the last applied seq is a replay and is ignored;
 * - a jump in seq is recorded as a gap and the store asks for a snapshot (`needsResync`); the
 *   event is still applied because deltas carry absolute values (see the contract);
 * - a STATE_SNAPSHOT replaces the view and clears `needsResync`.
 */
import {
  isValidPatch,
  type FetchActivity,
  type JsonPatchOp,
  type RunEventEnvelope,
  type StepStatus,
  type VerifyActivity,
  type WarRoomSnapshot,
} from "@/lib/contracts/run-events";
import { STAGES, type StageId } from "@/lib/stages";

const STAGE_IDS: ReadonlySet<string> = new Set(STAGES.map((s) => s.id));

/** How many ticker items the store keeps (newest first); the ticker scrolls through all of them. */
export const ACTIVITY_LIMIT = 300;

export type StreamStatus = "idle" | "running" | "finished" | "error";

export interface FeedItem {
  seq: number;
  ts: string;
  kind: "fetch" | "verify" | "stage" | "phase" | "event";
  fetch?: FetchActivity;
  verify?: VerifyActivity;
  stage?: { id: StageId; edge: "started" | "finished"; status?: StepStatus };
  /** A phase edge: started (prepare / execute), finished at a gate (the run state it parks in), or failed. */
  phase?: { edge: "started"; name: "prepare" | "execute" } | { edge: "finished"; state: string } | { edge: "failed"; code: string };
  /** A recorded event with no detailed view yet (CUSTOM): shown by its type and stage, never by its content. */
  event?: { name: string; stage?: StageId; oversize?: boolean };
}

/** The stage working now, as the run recorded it (from a stage start, or from bh-api's snapshot). */
export interface ActiveStage {
  stage: StageId;
  startedAt: string | null;
}

export interface WarRoomStore {
  lastSeq: number;
  status: StreamStatus;
  view: WarRoomSnapshot | null;
  feed: FeedItem[];
  currentStage: StageId | null;
  /** When the current stage started (the recorded time of its STEP_STARTED), when known. */
  stageStartedTs: string | null;
  gaps: { after: number; got: number }[];
  needsResync: boolean;
  startedTs: string | null;
  lastTs: string | null;
  finalState: string | null;
  error: string | null;
  rejectedPatches: number;
  /** Times the view was repaired from a server snapshot. */
  resyncs: number;
  /** Recorded events with no display contract yet (CUSTOM frames): counted, never rendered as content. */
  unrendered: number;
  /** Replay generation: a restart starts a new epoch, and answers for an old epoch are ignored. */
  epoch: number;
  /** The seq a snapshot was requested at, while that request is in flight. */
  pendingResync: number | null;
  /** Consecutive failed snapshot requests (drives the retry backoff). */
  resyncFailures: number;
}

export function emptyStore(): WarRoomStore {
  return {
    lastSeq: 0,
    status: "idle",
    view: null,
    feed: [],
    currentStage: null,
    stageStartedTs: null,
    gaps: [],
    needsResync: false,
    startedTs: null,
    lastTs: null,
    finalState: null,
    error: null,
    rejectedPatches: 0,
    resyncs: 0,
    unrendered: 0,
    epoch: 0,
    pendingResync: null,
    resyncFailures: 0,
  };
}

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function decodePointer(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const parts = path
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  return parts.some((p) => p === "" || UNSAFE_KEYS.has(p)) ? null : parts;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply `replace`/`add` ops immutably. Only object members are addressable, every parent must
 * already exist and `replace` needs an existing member; a failing op leaves the input untouched
 * and is reported, never thrown, so one bad frame cannot take the view down.
 */
export function applyPatch<T>(doc: T, ops: readonly JsonPatchOp[]): { doc: T; rejected: number } {
  let current: unknown = doc;
  let rejected = 0;
  for (const op of ops) {
    const parts = decodePointer(op.path);
    const next = parts ? setIn(current, parts, op.value, op.op) : undefined;
    if (next === undefined) rejected += 1;
    else current = next;
  }
  return { doc: current as T, rejected };
}

function setIn(node: unknown, parts: string[], value: unknown, op: JsonPatchOp["op"]): unknown {
  if (!isPlainObject(node)) return undefined;
  const [head, ...rest] = parts;
  if (head === undefined) return undefined;
  if (rest.length === 0) {
    if (op === "replace" && !Object.hasOwn(node, head)) return undefined;
    return { ...node, [head]: value };
  }
  if (!Object.hasOwn(node, head)) return undefined;
  const child = setIn(node[head], rest, value, op);
  return child === undefined ? undefined : { ...node, [head]: child };
}

function pushFeed(feed: FeedItem[], item: FeedItem): FeedItem[] {
  const next = [item, ...feed];
  return next.length > ACTIVITY_LIMIT ? next.slice(0, ACTIVITY_LIMIT) : next;
}

export function reduce(store: WarRoomStore, env: RunEventEnvelope): WarRoomStore {
  if (env.seq <= store.lastSeq) return store;
  const gapped = env.seq > store.lastSeq + 1;
  let next: WarRoomStore = {
    ...store,
    lastSeq: env.seq,
    lastTs: env.ts,
    gaps: gapped ? [...store.gaps, { after: store.lastSeq, got: env.seq }] : store.gaps,
    needsResync: store.needsResync || gapped,
  };
  const ev = env.event;
  switch (ev.type) {
    case "RUN_STARTED":
      next = {
        ...next,
        status: "running",
        startedTs: next.startedTs ?? env.ts,
        error: null,
        feed: pushFeed(next.feed, { seq: env.seq, ts: env.ts, kind: "phase", phase: { edge: "started", name: ev.phase } }),
      };
      break;
    case "RUN_FINISHED":
      next = {
        ...next,
        status: "finished",
        finalState: ev.result.state,
        currentStage: null,
        stageStartedTs: null,
        feed: pushFeed(next.feed, { seq: env.seq, ts: env.ts, kind: "phase", phase: { edge: "finished", state: ev.result.state } }),
      };
      break;
    case "RUN_ERROR":
      next = {
        ...next,
        status: "error",
        error: ev.message,
        feed: pushFeed(next.feed, { seq: env.seq, ts: env.ts, kind: "phase", phase: { edge: "failed", code: ev.code ?? "unrecorded" } }),
      };
      break;
    case "STEP_STARTED":
    case "STEP_FINISHED": {
      const edge = ev.type === "STEP_STARTED" ? "started" : "finished";
      // a finished stage keeps its recorded status: a stub stays not_built, never "done"
      const ended = ev.type === "STEP_FINISHED" ? (ev.status ?? "done") : "running";
      const stages = next.view ? { ...next.view.stages, [ev.stepName]: ended } : null;
      const current = edge === "started" ? ev.stepName : next.currentStage === ev.stepName ? null : next.currentStage;
      next = {
        ...next,
        currentStage: current,
        stageStartedTs: edge === "started" ? env.ts : current === null ? null : next.stageStartedTs,
        view: next.view && stages ? { ...next.view, stages } : next.view,
        feed: pushFeed(next.feed, {
          seq: env.seq,
          ts: env.ts,
          kind: "stage",
          stage: ev.type === "STEP_FINISHED" && ev.status ? { id: ev.stepName, edge, status: ev.status } : { id: ev.stepName, edge },
        }),
      };
      break;
    }
    case "STATE_SNAPSHOT":
      next = { ...next, view: ev.snapshot, needsResync: false };
      break;
    case "STATE_DELTA": {
      if (!next.view) {
        next = { ...next, needsResync: true, rejectedPatches: next.rejectedPatches + ev.delta.length };
        break;
      }
      // Only contract paths with correctly typed values reach the view (see isValidPatch).
      const valid = ev.delta.filter(isValidPatch);
      const { doc, rejected } = applyPatch(next.view, valid);
      const dropped = rejected + (ev.delta.length - valid.length);
      // A dropped patch means the view no longer matches the run: ask for a snapshot.
      next = { ...next, view: doc, rejectedPatches: next.rejectedPatches + dropped, needsResync: next.needsResync || dropped > 0 };
      break;
    }
    case "CUSTOM": {
      const event: NonNullable<FeedItem["event"]> = { name: ev.name };
      if (ev.value.stage) event.stage = ev.value.stage;
      if (ev.value.oversize) event.oversize = true;
      next = { ...next, unrendered: next.unrendered + 1, feed: pushFeed(next.feed, { seq: env.seq, ts: env.ts, kind: "event", event }) };
      break;
    }
    case "ACTIVITY_SNAPSHOT":
      // the swarm's agent activities render in the Agent swarm panel (lib/war-room/swarm.ts), not the ticker
      if (ev.activityType === "fetch") next = { ...next, feed: pushFeed(next.feed, { seq: env.seq, ts: env.ts, kind: "fetch", fetch: ev.content }) };
      else if (ev.activityType === "verify") next = { ...next, feed: pushFeed(next.feed, { seq: env.seq, ts: env.ts, kind: "verify", verify: ev.content }) };
      break;
  }
  return next;
}

export function reduceAll(store: WarRoomStore, envs: readonly RunEventEnvelope[]): WarRoomStore {
  let s = store;
  for (const env of envs) s = reduce(s, env);
  return s;
}

/*
 * Snapshot recovery is a small state machine kept in the store, so the React layer only reacts:
 *   needsResync && pendingResync === null  -> requestResync (the hook fetches ?at=lastSeq)
 *   answer for this epoch at/after lastSeq -> applyResync installs it, clears needsResync
 *   answer older than lastSeq              -> stale: pending cleared, needsResync kept, so the
 *                                             hook asks again at the new cursor
 *   answer for an older epoch              -> ignored (a restart happened meanwhile)
 *   fetch failed                           -> failResync: pending cleared, failures counted
 */
export function requestResync(store: WarRoomStore, epoch: number, at: number): WarRoomStore {
  if (epoch !== store.epoch || !store.needsResync || store.pendingResync !== null) return store;
  return { ...store, pendingResync: at };
}

export function applyResync(store: WarRoomStore, epoch: number, seq: number, snapshot: WarRoomSnapshot): WarRoomStore {
  if (epoch !== store.epoch) return store;
  if (seq < store.lastSeq) return { ...store, pendingResync: null };
  return { ...store, view: snapshot, lastSeq: seq, needsResync: false, pendingResync: null, resyncFailures: 0, resyncs: store.resyncs + 1 };
}

export function failResync(store: WarRoomStore, epoch: number): WarRoomStore {
  if (epoch !== store.epoch) return store;
  return { ...store, pendingResync: null, resyncFailures: store.resyncFailures + 1 };
}

/** Run states in which a live run still produces events (bh-api routes.ACTIVE). */
export const ACTIVE_RUN_STATES: ReadonlySet<string> = new Set(["queued", "starting", "running", "recomputing", "degraded"]);

/**
 * A live run's first view: bh-api's snapshot of its durable state at `seq`, with the run's own status. A run that
 * is parked at a gate or has ended starts as such (its closing event is behind the snapshot), so the view never
 * waits on a stream with nothing left to send.
 */
export function seedFromSnapshot(
  store: WarRoomStore,
  seq: number,
  snapshot: WarRoomSnapshot,
  runStatus: string,
  active?: ActiveStage | null,
  lastEventAt?: string | null,
): WarRoomStore {
  const seeded: WarRoomStore = {
    ...store,
    view: snapshot,
    lastSeq: Math.max(seq, store.lastSeq),
    needsResync: false,
    pendingResync: null,
    ...withActive(active, runStatus),
    lastTs: latest(store.lastTs, lastEventAt),
  };
  if (ACTIVE_RUN_STATES.has(runStatus)) return { ...seeded, status: "running" };
  if (runStatus === "failed") return { ...seeded, status: "error", error: "the run failed", finalState: runStatus };
  return { ...seeded, status: "finished", finalState: runStatus };
}

/**
 * Any later read of a live run's durable state (after a phase's closing event, on a gap, when the stream ends
 * without one): the view moves forward only, and the run's own status always replaces what the stream implied,
 * so a run re-activated in another tab streams on, and a cancelled or reclaimed run stops being watched.
 */
export function applyLiveSnapshot(
  store: WarRoomStore,
  epoch: number,
  seq: number,
  snapshot: WarRoomSnapshot,
  runStatus: string,
  active?: ActiveStage | null,
  lastEventAt?: string | null,
): WarRoomStore {
  if (epoch !== store.epoch) return store;
  // an answer older than what the view already holds says nothing about now: neither view nor status moves
  if (seq < store.lastSeq) return { ...store, pendingResync: null };
  const base: WarRoomStore = {
    ...store,
    view: snapshot,
    lastSeq: seq,
    needsResync: false,
    pendingResync: null,
    resyncFailures: 0,
    resyncs: store.resyncs + 1,
    ...withActive(active, runStatus),
    lastTs: latest(store.lastTs, lastEventAt),
  };
  if (ACTIVE_RUN_STATES.has(runStatus)) return { ...base, status: "running", finalState: null, error: null };
  if (runStatus === "failed") return { ...base, status: "error", error: "the run failed", finalState: runStatus };
  return { ...base, status: "finished", finalState: runStatus };
}

/**
 * The stage working now from a snapshot answer: `undefined` = the answer did not say (keep what the stream
 * holds); `null` = nothing is working; a stage only counts while the run itself is active.
 */
function withActive(active: ActiveStage | null | undefined, runStatus: string): Partial<WarRoomStore> {
  if (active === undefined) return {};
  if (active === null || !ACTIVE_RUN_STATES.has(runStatus)) return { currentStage: null, stageStartedTs: null };
  return { currentStage: active.stage, stageStartedTs: active.startedAt };
}

/** The later of two recorded times (a snapshot's last event never moves the view's clock backwards). */
function latest(current: string | null, candidate: string | null | undefined): string | null {
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return current;
  return current && Date.parse(current) >= Date.parse(candidate) ? current : candidate;
}

/** bh-api's `activeStage` field, checked; `undefined` when the answer has none. */
export function parseActiveStage(v: unknown): ActiveStage | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.stage !== "string" || !STAGE_IDS.has(r.stage)) return null;
  const startedAt = typeof r.startedAt === "string" && Number.isFinite(Date.parse(r.startedAt)) ? r.startedAt : null;
  return { stage: r.stage as StageId, startedAt };
}

/**
 * What a live snapshot answer may do to the transport (the hook acts on it; the store change is
 * `applyLiveSnapshot`): `ignore` an answer for an earlier epoch (a restart happened); `release` an older answer
 * than the view holds (a pending gap repair asks again after a backoff; nothing else moves); otherwise `stream`
 * (the run is active: keep or reopen the stream from the answer's seq) or `stop` (parked or ended: close it, no
 * reconnects).
 */
export function liveAnswer(epoch: number, currentEpoch: number, seq: number, currentSeq: number, runStatus: string): "ignore" | "release" | "stream" | "stop" {
  if (epoch !== currentEpoch) return "ignore";
  if (seq < currentSeq) return "release";
  return ACTIVE_RUN_STATES.has(runStatus) ? "stream" : "stop";
}

/** Restart: a fresh store in a new epoch. */
export function nextEpoch(store: WarRoomStore): WarRoomStore {
  return { ...emptyStore(), epoch: store.epoch + 1 };
}

export const RESYNC_BACKOFF_MS = (failures: number) => (failures === 0 ? 0 : Math.min(1_000 * 2 ** (failures - 1), 15_000));

/** Server side: the view a client should hold after applying every event up to `seq`. */
export function snapshotAt(events: readonly RunEventEnvelope[], seq: number): { seq: number; snapshot: WarRoomSnapshot } | null {
  const upTo = events.filter((e) => e.seq <= seq);
  const last = upTo[upTo.length - 1];
  const view = reduceAll(emptyStore(), upTo).view;
  return last && view ? { seq: last.seq, snapshot: view } : null;
}
