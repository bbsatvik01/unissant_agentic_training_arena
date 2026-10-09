/**
 * The trial event stream (S6 5.1-5.2; S5 6.3-6.4): one ticketed SSE stream per trial, built on
 * `openTicketedStream`.
 *
 * - Every attempt mints a fresh single-use ticket (`POST /api/trials/{id}/stream-tickets`, injected
 *   as `mintTicket` so that every `fetch` stays in `src/lib/api`, S6 FE-TECH-3) and opens
 *   `GET /api/trials/{id}/events?ticket=..&after=<last accepted seq>`.
 * - Reconnects follow `[250, 1000, 2000, 4000, 8000]` ms: the donor's 2 s first retry alone would
 *   break the 3 s KPI-4 budget on any reconnect (S6 5.1).
 * - Each payload is checked before the reducer sees it: at most 16 KB of UTF-8 (S6 5.2) and a
 *   trial-scope envelope for this trial. The parsed object is handed on whole, unknown keys included, so the
 *   caller's schema validation sees exactly what the server sent. A frame failing either check, or rejected by the caller's
 *   validator and reducer, is dropped and counted, never rendered (S6 5.2, FE-SSE-6).
 * - The `after=` cursor is the highest persisted `seq` the caller accepted (or, with `resumeCursor`, the end of the
 *   caller's gap-free prefix). Synthesized frames
 *   (`seq: null`: the snapshot, `subject.thinking`, `coach.working`, `trial.status`, `notice`) and
 *   replayed duplicates are handed to the caller but never move the cursor and never refill the
 *   retry budget, so a stream that only ever re-sends its snapshot still gives up (FE-SSE-1).
 */

import {
  openTicketedStream,
  type MessageVerdict,
  type TicketedStreamHandle,
  type TicketedStreamOptions,
} from "./ticketed-stream";

/** Trial-stream reconnect schedule in ms, by attempt (S6 5.1). Later attempts stay at the cap. */
export const TRIAL_STREAM_BACKOFF_MS = [250, 1000, 2000, 4000, 8000] as const;

const BACKOFF_CAP_MS = TRIAL_STREAM_BACKOFF_MS[4];

/** Largest payload the client accepts, in UTF-8 bytes (S6 5.2; TechnoMile `MAX_EVENT_BYTES`). */
export const MAX_EVENT_BYTES = 16 * 1024;

/** Backoff for reconnect attempt N (1-based): the schedule above, then its last step. */
export function trialStreamBackoff(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), TRIAL_STREAM_BACKOFF_MS.length) - 1;
  // A non-number attempt (NaN) has no step; it waits the longest.
  return TRIAL_STREAM_BACKOFF_MS[index] ?? BACKOFF_CAP_MS;
}

/** The S6 5.2 envelope on the trial scope. `data` is validated per `type` by the caller. */
export interface TrialFrame {
  readonly v: 1;
  /** The persisted row's sequence (its SSE id), or null for a synthesized frame. */
  readonly seq: number | null;
  readonly scope: "trial";
  readonly scope_id: string;
  readonly type: string;
  readonly ts: string;
  readonly transcript_version?: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Why a frame never reached the reducer, or why the reducer refused it (`rejected`). */
export type TrialDropReason = "oversize" | "malformed" | "envelope" | "rejected";

const utf8 = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Parse one SSE payload into this trial's envelope, or name the reason it is dropped. */
export function parseTrialFrame(raw: unknown, trialId: string): TrialFrame | Exclude<TrialDropReason, "rejected"> {
  if (typeof raw !== "string") return "malformed";
  if (utf8.encode(raw).byteLength > MAX_EVENT_BYTES) return "oversize";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "malformed";
  }
  if (!isRecord(value)) return "envelope";
  const { v, seq, scope, scope_id: scopeId, type, ts, transcript_version: version, data } = value;
  if (v !== 1 || scope !== "trial" || scopeId !== trialId) return "envelope";
  if (seq !== null && !isCount(seq)) return "envelope";
  if (typeof type !== "string" || type === "" || typeof ts !== "string" || !isRecord(data)) return "envelope";
  if (version !== undefined && !isCount(version)) return "envelope";
  // The checks above make `value` a trial envelope; any other key stays for the schema validator to refuse.
  return value as unknown as TrialFrame;
}

/** `GET /api/trials/{id}/events?ticket=..&after=..` (S5 5.5, 6.3). */
export function trialEventsUrl(trialId: string, ticket: string, after: string | null): string {
  const query = new URLSearchParams({ ticket });
  if (after !== null) query.set("after", after);
  return `/api/trials/${encodeURIComponent(trialId)}/events?${query.toString()}`;
}

/** Lifecycle hooks, retry budget and test seams pass straight through to `openTicketedStream`. */
type PassThroughOptions = Pick<
  TicketedStreamOptions,
  "onOpen" | "onRetry" | "onGiveUp" | "maxRetries" | "eventSourceFactory" | "scheduler"
>;

export interface TrialStreamOptions extends PassThroughOptions {
  trialId: string;
  /** Mints one single-use stream ticket for the trial (`POST /api/trials/{id}/stream-tickets`). */
  mintTicket: (trialId: string) => Promise<string>;
  /** Validate and fold one well-formed frame; return true only when it was accepted. */
  onFrame: (frame: TrialFrame) => boolean;
  /** One frame was dropped (S6 5.2: dropped and counted, never rendered). */
  onDrop?: (reason: TrialDropReason) => void;
  /** Resume point carried over from an earlier handle (the reducer already holds frames up to it). */
  initialLastSeq?: number | null;
  /**
   * Where an accepted persisted frame moves the cursor to, when that is not the frame's own seq: the caller's
   * gap-free prefix, so a resume replays a frame that is still missing below it. Defaults to the frame's seq.
   */
  resumeCursor?: (frame: TrialFrame & { readonly seq: number }) => number;
}

export interface TrialStreamHandle extends TicketedStreamHandle {
  /** The highest persisted seq accepted so far (the `after=` cursor), or null before any. */
  readonly lastSeq: number | null;
  /** Frames dropped on this handle. */
  readonly dropped: number;
}

export function openTrialStream(options: TrialStreamOptions): TrialStreamHandle {
  const { trialId, mintTicket, onFrame, onDrop, initialLastSeq = null, resumeCursor, ...passThrough } = options;
  let lastSeq = initialLastSeq;
  let dropped = 0;

  const drop = (reason: TrialDropReason): MessageVerdict => {
    dropped += 1;
    onDrop?.(reason);
    return false;
  };

  const stream = openTicketedStream({
    ...passThrough,
    backoffMs: trialStreamBackoff,
    initialLastEventId: initialLastSeq === null ? null : String(initialLastSeq),
    resolveUrl: async ({ lastEventId }) => trialEventsUrl(trialId, await mintTicket(trialId), lastEventId),
    onMessage: (event) => {
      const frame = parseTrialFrame(event.data, trialId);
      if (typeof frame === "string") return drop(frame);
      if (!onFrame(frame)) return drop("rejected");
      if (frame.seq === null) return false;
      const next = resumeCursor === undefined ? frame.seq : resumeCursor({ ...frame, seq: frame.seq });
      if (lastSeq !== null && next <= lastSeq) return false;
      lastSeq = next;
      return { cursor: String(next) };
    },
  });

  return {
    close: () => {
      stream.close();
    },
    finish: () => {
      stream.finish();
    },
    reconnect: () => {
      stream.reconnect();
    },
    get current() {
      return stream.current;
    },
    get lastEventId() {
      return stream.lastEventId;
    },
    get lastSeq() {
      return lastSeq;
    },
    get dropped() {
      return dropped;
    },
  };
}
