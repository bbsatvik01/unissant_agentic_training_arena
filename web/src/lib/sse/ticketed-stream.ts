/**
 * Reconnecting EventSource for SSE endpoints authorised by a SINGLE-USE ticket in the query
 * string (S5 6.3: single-use hashed tickets, 60 s).
 *
 * Lifted from TechnoMile `web/src/lib/sse/ticketed-stream.ts` (last changed in commit 183deb0; itself
 * lifted from gokbase `src/lib/sse/ticketed-stream.ts` with the resume fix); see web/ATTRIBUTIONS.md. The
 * browser's native reconnect would replay the spent ticket and die silently, so every attempt
 * closes the old EventSource and opens a NEW one with a fresh ticket. A new EventSource does not
 * carry the `Last-Event-ID` header, so every attempt is handed the resume cursor and the URL says
 * `?after=<cursor>`; the server replays `seq > after` (no gap, no duplicate work for the reducer).
 *
 * Arena change (S6 FE-SSE-1): the caller may name the cursor an accepted message advances to
 * (`{ cursor }`). Browsers keep `MessageEvent.lastEventId` from the last `id:` line they saw, so a
 * frame sent without an id (a synthesized frame) arrives carrying the id of the frame before it,
 * even when the caller rejected that frame; a cursor read from the event would then skip it. The
 * donor's `true` verdict (cursor from `lastEventId`) is kept for streams whose every frame has an id.
 *
 * Retry-budget invariant (kept from the donor): only a message the CALLER accepts as forward
 * progress refills the budget. A bare open, a heartbeat or a malformed frame never does, so a
 * stream that opens and idles, or emits junk, still reaches give-up.
 *
 * Attempt invariant (arena fix): only the newest connection attempt may take effect. Every attempt
 * starts a new generation; an attempt whose ticket mint settles after a newer attempt started, or
 * after `close()` or `finish()`, opens nothing and schedules nothing, so a `reconnect()` while a
 * mint is pending can never leave a second, orphaned EventSource behind.
 */

/** The slice of `EventSource` this helper needs. */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface ResolveContext {
  /** The resume cursor: the last accepted message's cursor on any earlier connection, or null. */
  lastEventId: string | null;
  /** 0 for the first connection, then 1, 2, ... for reconnects. */
  attempt: number;
}

/**
 * What the caller made of one message. `false`: no forward progress (rejected, a heartbeat, or a
 * frame that changes nothing); the cursor stays. `true`: progress, and the cursor advances to the
 * event's `lastEventId` when it has one. `{ cursor }`: progress, and the cursor advances to `cursor`.
 */
export type MessageVerdict = boolean | { readonly cursor: string };

export interface TicketedStreamOptions {
  /** Mints a fresh ticket and returns the stream URL. Called once per attempt, never reused. */
  resolveUrl: (ctx: ResolveContext) => Promise<string>;
  onOpen?: () => void;
  /** Only a progress verdict refills the retry budget and moves the cursor. */
  onMessage: (event: MessageEvent) => MessageVerdict;
  onRetry?: (info: { attempt: number; delayMs: number }) => void;
  onGiveUp?: (info: { attempt: number; error: unknown }) => void;
  maxRetries?: number;
  /**
   * Resume point carried over from an earlier handle (the view already holds events up to it).
   * Without it a new handle would replay from the start while the view ignores the duplicates.
   */
  initialLastEventId?: string | null;
  /** Backoff for attempt N (1-based). Defaults to 2 s x N, capped at 15 s. */
  backoffMs?: (attempt: number) => number;
  eventSourceFactory?: (url: string) => EventSourceLike;
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => number;
    clearTimeout: (handle: number) => void;
  };
}

export interface TicketedStreamHandle {
  /** Stop reconnecting and close the current connection. */
  close(): void;
  /** A terminal event arrived: the server closing next is expected and must not reconnect. */
  finish(): void;
  /** Manual retry after give-up (the "Reconnect" button); resets the budget. */
  reconnect(): void;
  readonly current: EventSourceLike | null;
  readonly lastEventId: string | null;
}

export const DEFAULT_MAX_RETRIES = 5;

export const defaultBackoff = (attempt: number) => Math.min(2_000 * attempt, 15_000);

function defaultFactory(url: string): EventSourceLike {
  if (typeof EventSource === "undefined") throw new Error("EventSource is not available in this environment");
  return new EventSource(url);
}

export function openTicketedStream(options: TicketedStreamOptions): TicketedStreamHandle {
  const {
    resolveUrl,
    onOpen,
    onMessage,
    onRetry,
    onGiveUp,
    maxRetries = DEFAULT_MAX_RETRIES,
    backoffMs = defaultBackoff,
    eventSourceFactory = defaultFactory,
    scheduler,
    initialLastEventId = null,
  } = options;

  const setTimeoutFn = scheduler?.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn =
    scheduler?.clearTimeout ??
    ((handle: number) => {
      clearTimeout(handle);
    });

  let source: EventSourceLike | null = null;
  let attempt = 0;
  let connections = 0;
  let stopped = false;
  let finished = false;
  let retryHandle: number | null = null;
  let lastEventId: string | null = initialLastEventId;
  let generation = 0;

  const halted = (): boolean => stopped || finished;

  const closeSource = () => {
    if (!source) return;
    const current = source;
    source = null;
    // Detach first: some implementations fire onerror synchronously from close().
    current.onopen = null;
    current.onmessage = null;
    current.onerror = null;
    try {
      current.close();
    } catch {
      // Already closed; nothing to release.
    }
  };

  const cancelRetry = () => {
    if (retryHandle !== null) {
      clearTimeoutFn(retryHandle);
      retryHandle = null;
    }
  };

  // Callers have already checked that this attempt is current and the stream is not halted.
  const scheduleRetry = (error: unknown) => {
    attempt += 1;
    if (attempt > maxRetries) {
      stopped = true;
      onGiveUp?.({ attempt, error });
      return;
    }
    const delayMs = backoffMs(attempt);
    // The timer belongs to this attempt's generation: a reconnect() since (including one made from
    // the onRetry callback below) supersedes it even if the scheduler fails to cancel it. It is
    // registered before the callback runs, so a reentrant reconnect() finds and cancels it.
    const mine = generation;
    retryHandle = setTimeoutFn(() => {
      if (mine !== generation) return;
      retryHandle = null;
      void connect();
    }, delayMs);
    onRetry?.({ attempt, delayMs });
  };

  const connect = async (): Promise<void> => {
    if (halted()) return;
    // A new attempt ends the previous one's generation: its pending mint is abandoned.
    generation += 1;
    const mine = generation;
    // Read through a function: close(), finish() and reconnect() can run while the mint is
    // awaited, and a plain re-check after the await would read as already narrowed.
    const current = (): boolean => mine === generation && !halted();
    closeSource();
    let url: string;
    try {
      url = await resolveUrl({ lastEventId, attempt: connections });
    } catch (error) {
      if (current()) scheduleRetry(error);
      return;
    }
    if (!current()) return;
    connections += 1;
    let es: EventSourceLike;
    try {
      es = eventSourceFactory(url);
    } catch (error) {
      scheduleRetry(error);
      return;
    }
    source = es;
    es.onopen = () => onOpen?.();
    es.onmessage = (event: MessageEvent) => {
      // The resume cursor advances only past frames the caller accepted: a rejected frame is
      // re-requested on the next connection instead of being skipped for good.
      const verdict = onMessage(event);
      if (verdict === false) return;
      attempt = 0;
      if (verdict === true) {
        if (event.lastEventId) lastEventId = event.lastEventId;
      } else {
        lastEventId = verdict.cursor;
      }
    };
    es.onerror = (event: Event) => {
      if (stopped) return;
      if (finished) {
        closeSource();
        return;
      }
      closeSource();
      scheduleRetry(event);
    };
  };

  void connect();

  return {
    close() {
      stopped = true;
      cancelRetry();
      closeSource();
    },
    finish() {
      finished = true;
      cancelRetry();
      closeSource();
    },
    reconnect() {
      if (finished) return;
      cancelRetry();
      stopped = false;
      attempt = 0;
      void connect();
    },
    get current() {
      return source;
    },
    get lastEventId() {
      return lastEventId;
    },
  };
}
