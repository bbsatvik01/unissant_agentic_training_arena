import { describe, expect, it, vi } from "vitest";

import { defaultBackoff, openTicketedStream, type EventSourceLike, type MessageVerdict, type ResolveContext } from "./ticketed-stream";
import {
  MAX_EVENT_BYTES,
  openTrialStream,
  TRIAL_STREAM_BACKOFF_MS,
  trialEventsUrl,
  trialStreamBackoff,
  type TrialDropReason,
  type TrialFrame,
} from "./trial-stream";

class FakeES implements EventSourceLike {
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event("open"));
  }
  msg(data: string, id = "") {
    this.onmessage?.({ data, lastEventId: id } as MessageEvent);
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
}

function harness(opts: { maxRetries?: number; resolveFails?: number; factoryThrows?: boolean; accept?: (d: string) => boolean; initial?: string } = {}) {
  const sources: FakeES[] = [];
  const contexts: ResolveContext[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const retries: { attempt: number; delayMs: number }[] = [];
  const giveUps: number[] = [];
  const opened: number[] = [];
  let resolveFails = opts.resolveFails ?? 0;
  const handle = openTicketedStream({
    resolveUrl: (ctx) => {
      contexts.push(ctx);
      if (resolveFails > 0) {
        resolveFails -= 1;
        return Promise.reject(new Error("mint failed"));
      }
      return Promise.resolve(`/stream?ticket=t${String(contexts.length)}${ctx.lastEventId ? `&after=${ctx.lastEventId}` : ""}`);
    },
    onOpen: () => opened.push(sources.length),
    onMessage: (e) => (opts.accept ? opts.accept(String(e.data)) : String(e.data) !== "ping"),
    onRetry: (r) => retries.push(r),
    onGiveUp: (g) => giveUps.push(g.attempt),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.initial !== undefined ? { initialLastEventId: opts.initial } : {}),
    eventSourceFactory: (url) => {
      if (opts.factoryThrows) throw new Error("no EventSource");
      const es = new FakeES(url);
      sources.push(es);
      return es;
    },
    scheduler: {
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: (h) => {
        const t = timers[h - 1];
        if (t) t.fn = () => undefined;
      },
    },
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const runTimers = async () => {
    const due = timers.splice(0);
    for (const t of due) t.fn();
    await flush();
  };
  return { handle, sources, contexts, timers, retries, giveUps, opened, flush, runTimers };
}

describe("openTicketedStream", () => {
  it("mints a fresh ticket per attempt and resumes after the last received id", async () => {
    const h = harness();
    await h.flush();
    expect(h.sources[0]?.url).toBe("/stream?ticket=t1");
    h.sources[0]?.open();
    h.sources[0]?.msg("{}", "41");
    h.sources[0]?.msg("{}", "42");
    h.sources[0]?.fail();
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.retries).toEqual([{ attempt: 1, delayMs: 2000 }]);
    await h.runTimers();
    expect(h.contexts[1]).toEqual({ lastEventId: "42", attempt: 1 });
    expect(h.sources[1]?.url).toBe("/stream?ticket=t2&after=42");
    expect(h.handle.lastEventId).toBe("42");
    expect(h.opened).toEqual([1]);
  });

  it("resumes a new handle from the carried-over resume point on its very first connection", async () => {
    const h = harness({ initial: "500" });
    await h.flush();
    expect(h.contexts[0]).toEqual({ lastEventId: "500", attempt: 0 });
    expect(h.sources[0]?.url).toBe("/stream?ticket=t1&after=500");
    h.sources[0]?.msg("{}", "501");
    expect(h.handle.lastEventId).toBe("501");
  });

  it("refills the budget only on accepted progress, never on open or heartbeats", async () => {
    const h = harness({ maxRetries: 2 });
    await h.flush();
    h.sources[0]?.open();
    h.sources[0]?.msg("ping");
    h.sources[0]?.fail();
    await h.runTimers();
    h.sources[1]?.open();
    h.sources[1]?.msg("ping");
    h.sources[1]?.fail();
    await h.runTimers();
    h.sources[2]?.fail();
    expect(h.giveUps).toEqual([3]);
    expect(h.retries.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("never advances the resume cursor past a frame the caller rejected", async () => {
    const h = harness({ accept: (d) => d === "{}" });
    await h.flush();
    h.sources[0]?.msg("{}", "1");
    h.sources[0]?.msg("bad", "2");
    h.sources[0]?.msg("ping", "3");
    expect(h.handle.lastEventId).toBe("1");
    h.sources[0]?.fail();
    await h.runTimers();
    expect(h.sources[1]?.url).toBe("/stream?ticket=t2&after=1");
  });

  it("resets the attempt counter after a real event", async () => {
    const h = harness({ maxRetries: 1 });
    await h.flush();
    h.sources[0]?.fail();
    await h.runTimers();
    h.sources[1]?.msg("{\"seq\":1}", "1");
    h.sources[1]?.fail();
    expect(h.giveUps).toEqual([]);
    expect(h.retries.map((r) => r.attempt)).toEqual([1, 1]);
  });

  it("retries when minting fails and gives up when the factory keeps throwing", async () => {
    const minted = harness({ resolveFails: 1 });
    await minted.flush();
    expect(minted.retries).toHaveLength(1);
    await minted.runTimers();
    expect(minted.sources).toHaveLength(1);

    const broken = harness({ factoryThrows: true, maxRetries: 1 });
    await broken.flush();
    await broken.runTimers();
    expect(broken.giveUps).toEqual([2]);
  });

  it("does not reconnect after finish, and ignores errors after close", async () => {
    const h = harness();
    await h.flush();
    const first = h.sources[0];
    h.handle.finish();
    first?.fail();
    expect(h.retries).toEqual([]);
    expect(h.handle.current).toBeNull();
    h.handle.reconnect();
    await h.flush();
    expect(h.sources).toHaveLength(1);

    const c = harness();
    await c.flush();
    const es = c.sources[0];
    const onerror = es?.onerror;
    c.handle.close();
    onerror?.call(es, new Event("error"));
    expect(c.retries).toEqual([]);
  });

  it("closes a stream the server ends after a terminal event without retrying", async () => {
    const h = harness();
    await h.flush();
    const es = h.sources[0];
    const onerror = es?.onerror;
    h.handle.finish();
    onerror?.call(es, new Event("error"));
    expect(h.retries).toEqual([]);
  });

  it("lets the user reconnect after give-up with a fresh budget", async () => {
    const h = harness({ maxRetries: 0 });
    await h.flush();
    h.sources[0]?.fail();
    expect(h.giveUps).toEqual([1]);
    h.handle.reconnect();
    await h.flush();
    expect(h.sources).toHaveLength(2);
    expect(h.handle.current).toBe(h.sources[1]);
  });

  it("stops a pending connect when closed while minting", async () => {
    const h = harness();
    h.handle.close();
    await h.flush();
    expect(h.sources).toHaveLength(0);
  });

  it("survives a close() that throws", async () => {
    const h = harness();
    await h.flush();
    const es = h.sources[0];
    if (es) es.close = () => {
      throw new Error("already closed");
    };
    expect(() => {
      h.handle.close();
    }).not.toThrow();
  });

  it("caps the default backoff at 15 s", () => {
    expect(defaultBackoff(1)).toBe(2000);
    expect(defaultBackoff(20)).toBe(15000);
  });

  it("fails clearly where EventSource does not exist and uses global timers by default", async () => {
    vi.useFakeTimers();
    const giveUp = vi.fn();
    const handle = openTicketedStream({ resolveUrl: () => Promise.resolve("/x"), onMessage: () => true, onGiveUp: giveUp, maxRetries: 0 });
    await vi.runAllTimersAsync();
    expect(giveUp).toHaveBeenCalledOnce();
    handle.close();
    vi.useRealTimers();
  });
});

// -------------------------------------------------------------------------------------------------
// FE-SSE-1 additions (S6 5.1, 5.2, 5.4; S5 6.3-6.4). Browsers keep `MessageEvent.lastEventId` from
// the last `id:` line they saw, so a frame sent without an id (a synthesized frame) arrives carrying
// the previous frame's id. The fakes below reproduce that by passing the sticky id explicitly.
// -------------------------------------------------------------------------------------------------

function fakeEnv() {
  const sources: FakeES[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const factory = (url: string): FakeES => {
    const es = new FakeES(url);
    sources.push(es);
    return es;
  };
  const scheduler = {
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: (h: number) => {
      const t = timers[h - 1];
      if (t) t.fn = () => undefined;
    },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const runTimers = async () => {
    const due = timers.splice(0);
    for (const t of due) t.fn();
    await flush();
  };
  return { sources, timers, factory, scheduler, flush, runTimers };
}

describe("openTicketedStream: explicit cursor verdicts", () => {
  it("moves the cursor to the cursor the caller names and refills the budget, ignoring the sticky id", async () => {
    const env = fakeEnv();
    const retries: number[] = [];
    const giveUps: number[] = [];
    const verdicts: MessageVerdict[] = [{ cursor: "9" }, false];
    const handle = openTicketedStream({
      resolveUrl: (ctx) => Promise.resolve(`/s?after=${ctx.lastEventId ?? "none"}`),
      onMessage: () => verdicts.shift() ?? false,
      onRetry: (r) => retries.push(r.attempt),
      onGiveUp: (g) => giveUps.push(g.attempt),
      maxRetries: 1,
      eventSourceFactory: env.factory,
      scheduler: env.scheduler,
    });
    await env.flush();
    env.sources[0]?.fail();
    await env.runTimers();
    // Accepted with an explicit cursor while the event itself carries a stale sticky id.
    env.sources[1]?.msg("{}", "3");
    expect(handle.lastEventId).toBe("9");
    // A rejected frame carrying a newer sticky id moves nothing.
    env.sources[1]?.msg("{}", "12");
    expect(handle.lastEventId).toBe("9");
    env.sources[1]?.fail();
    await env.runTimers();
    expect(env.sources[2]?.url).toBe("/s?after=9");
    expect(retries).toEqual([1, 1]);
    expect(giveUps).toEqual([]);
  });
});

const TRIAL = "trl_1";

function frame(seq: number | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    seq,
    scope: "trial",
    scope_id: TRIAL,
    type: seq === null ? "subject.thinking" : "question.accepted",
    ts: "2026-10-20T15:04:05.123Z",
    data: {},
    ...extra,
  });
}

function trialHarness(opts: { accept?: (f: TrialFrame) => boolean; initialLastSeq?: number; maxRetries?: number } = {}) {
  const env = fakeEnv();
  const minted: string[] = [];
  const applied: TrialFrame[] = [];
  const drops: TrialDropReason[] = [];
  const retries: { attempt: number; delayMs: number }[] = [];
  const giveUps: number[] = [];
  const handle = openTrialStream({
    trialId: TRIAL,
    mintTicket: (trialId) => {
      minted.push(trialId);
      return Promise.resolve(`tk${String(minted.length)}`);
    },
    onFrame: (f) => {
      if (opts.accept && !opts.accept(f)) return false;
      applied.push(f);
      return true;
    },
    onDrop: (reason) => drops.push(reason),
    onRetry: (r) => retries.push(r),
    onGiveUp: (g) => giveUps.push(g.attempt),
    eventSourceFactory: env.factory,
    scheduler: env.scheduler,
    ...(opts.initialLastSeq !== undefined ? { initialLastSeq: opts.initialLastSeq } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  });
  return { ...env, handle, minted, applied, drops, retries, giveUps };
}

describe("FE-SSE-1: trial stream backoff", () => {
  it("is [250, 1000, 2000, 4000, 8000] ms, capped at the last step", () => {
    expect(TRIAL_STREAM_BACKOFF_MS).toEqual([250, 1000, 2000, 4000, 8000]);
    expect([1, 2, 3, 4, 5, 6, 40].map(trialStreamBackoff)).toEqual([250, 1000, 2000, 4000, 8000, 8000, 8000]);
    // Out-of-range input: below 1 takes the first step; NaN has no step and waits the longest.
    expect([0, -3, Number.NaN].map(trialStreamBackoff)).toEqual([250, 250, 8000]);
  });

  it("schedules the first retry at 250 ms, then walks the schedule until the budget runs out", async () => {
    const h = trialHarness();
    await h.flush();
    for (let i = 0; i < 5; i += 1) {
      h.sources[i]?.fail();
      await h.runTimers();
    }
    expect(h.retries).toEqual([
      { attempt: 1, delayMs: 250 },
      { attempt: 2, delayMs: 1000 },
      { attempt: 3, delayMs: 2000 },
      { attempt: 4, delayMs: 4000 },
      { attempt: 5, delayMs: 8000 },
    ]);
    h.sources[5]?.fail();
    expect(h.giveUps).toEqual([6]);
  });

  it("hands the scheduler the 250 ms delay itself, not only the retry notice", async () => {
    const h = trialHarness();
    await h.flush();
    h.sources[0]?.fail();
    expect(h.timers.map((t) => t.ms)).toEqual([250]);
  });
});

describe("FE-SSE-1: trial stream cursor", () => {
  it("builds the S5 events URL with a fresh ticket per attempt and after=<last accepted seq>", async () => {
    const h = trialHarness();
    await h.flush();
    expect(h.sources[0]?.url).toBe("/api/trials/trl_1/events?ticket=tk1");
    h.sources[0]?.msg(frame(null, { type: "snapshot" }), "");
    h.sources[0]?.msg(frame(4), "4");
    h.sources[0]?.msg(frame(5), "5");
    h.sources[0]?.fail();
    await h.runTimers();
    expect(h.sources[1]?.url).toBe("/api/trials/trl_1/events?ticket=tk2&after=5");
    expect(h.minted).toEqual([TRIAL, TRIAL]);
    expect(h.handle.lastSeq).toBe(5);
    expect(h.handle.lastEventId).toBe("5");
  });

  it("never moves the cursor past a rejected frame, even when a later synthesized frame carries its sticky id", async () => {
    const h = trialHarness({ accept: (f) => f.seq !== 4 });
    await h.flush();
    h.sources[0]?.msg(frame(3), "3");
    h.sources[0]?.msg(frame(4), "4");
    // Sent without an id: the browser reports the id of the rejected frame before it.
    h.sources[0]?.msg(frame(null), "4");
    expect(h.applied.map((f) => f.seq)).toEqual([3, null]);
    expect(h.handle.lastSeq).toBe(3);
    expect(h.drops).toEqual(["rejected"]);
    h.sources[0]?.fail();
    await h.runTimers();
    expect(h.sources[1]?.url).toBe("/api/trials/trl_1/events?ticket=tk2&after=3");
  });

  it("does not count a synthesized frame as progress, so a stream that only re-sends its snapshot gives up", async () => {
    const h = trialHarness({ maxRetries: 1 });
    await h.flush();
    h.sources[0]?.open();
    h.sources[0]?.msg(frame(null, { type: "snapshot" }), "");
    h.sources[0]?.fail();
    await h.runTimers();
    h.sources[1]?.open();
    h.sources[1]?.msg(frame(null, { type: "snapshot" }), "");
    h.sources[1]?.fail();
    expect(h.giveUps).toEqual([2]);
    expect(h.applied).toHaveLength(2);
    expect(h.handle.lastSeq).toBeNull();
  });

  it("refills the budget on an accepted persisted frame", async () => {
    const h = trialHarness({ maxRetries: 1 });
    await h.flush();
    h.sources[0]?.fail();
    await h.runTimers();
    h.sources[1]?.msg(frame(1), "1");
    h.sources[1]?.fail();
    expect(h.giveUps).toEqual([]);
    expect(h.retries.map((r) => r.attempt)).toEqual([1, 1]);
  });

  it("keeps the cursor monotonic when a replay overlaps, while still handing the duplicate to the reducer", async () => {
    const h = trialHarness();
    await h.flush();
    h.sources[0]?.msg(frame(5), "5");
    h.sources[0]?.msg(frame(6), "6");
    h.sources[0]?.msg(frame(4), "4");
    expect(h.applied.map((f) => f.seq)).toEqual([5, 6, 4]);
    expect(h.handle.lastSeq).toBe(6);
    h.sources[0]?.fail();
    await h.runTimers();
    expect(h.sources[1]?.url).toBe("/api/trials/trl_1/events?ticket=tk2&after=6");
  });

  it("starts a new handle from a carried-over seq and ignores older replays", async () => {
    const h = trialHarness({ initialLastSeq: 41 });
    await h.flush();
    expect(h.handle.lastSeq).toBe(41);
    expect(h.sources[0]?.url).toBe("/api/trials/trl_1/events?ticket=tk1&after=41");
    h.sources[0]?.msg(frame(40), "40");
    expect(h.handle.lastSeq).toBe(41);
    h.sources[0]?.msg(frame(42), "42");
    expect(h.handle.lastSeq).toBe(42);
  });

  it("encodes the trial id and the ticket", () => {
    expect(trialEventsUrl("trl/../x", "a+b&c=d", null)).toBe("/api/trials/trl%2F..%2Fx/events?ticket=a%2Bb%26c%3Dd");
    expect(trialEventsUrl("trl_1", "t", "7")).toBe("/api/trials/trl_1/events?ticket=t&after=7");
  });
});

describe("FE-SSE-1 and FE-SSE-6: frames dropped before the reducer", () => {
  it("drops and counts malformed, foreign and ill-typed envelopes without moving the cursor", async () => {
    const h = trialHarness();
    await h.flush();
    h.sources[0]?.msg(frame(2), "2");
    const bad: [string, TrialDropReason][] = [
      ["{not json", "malformed"],
      ["[]", "envelope"],
      ["null", "envelope"],
      [frame(9, { v: 2 }), "envelope"],
      [frame(9, { scope: "tournament" }), "envelope"],
      [frame(9, { scope_id: "trl_2" }), "envelope"],
      [frame(9, { seq: -1 }), "envelope"],
      [frame(9, { seq: 1.5 }), "envelope"],
      [frame(9, { seq: "9" }), "envelope"],
      [frame(9, { type: "" }), "envelope"],
      [frame(9, { type: 7 }), "envelope"],
      [frame(9, { ts: 5 }), "envelope"],
      [frame(9, { data: null }), "envelope"],
      [frame(9, { data: [] }), "envelope"],
      [frame(9, { transcript_version: "7" }), "envelope"],
    ];
    for (const [data] of bad) h.sources[0]?.msg(data, "9");
    expect(h.drops).toEqual(bad.map(([, reason]) => reason));
    expect(h.handle.dropped).toBe(bad.length);
    expect(h.applied.map((f) => f.seq)).toEqual([2]);
    expect(h.handle.lastSeq).toBe(2);
  });

  it("accepts an optional integer transcript_version and a seq of 0", async () => {
    const h = trialHarness();
    await h.flush();
    h.sources[0]?.msg(frame(0, { transcript_version: 7 }), "0");
    expect(h.applied).toHaveLength(1);
    expect(h.handle.lastSeq).toBe(0);
  });

  it("drops a frame over 16 KB of UTF-8 and keeps one of exactly 16 KB", async () => {
    const h = trialHarness();
    await h.flush();
    const sized = (bytes: number): string => {
      const base = frame(1, { data: { pad: "" } });
      const pad = bytes - new TextEncoder().encode(base).byteLength;
      return frame(1, { data: { pad: "x".repeat(pad) } });
    };
    const exact = sized(MAX_EVENT_BYTES);
    expect(new TextEncoder().encode(exact).byteLength).toBe(16 * 1024);
    h.sources[0]?.msg(sized(MAX_EVENT_BYTES + 1), "1");
    expect(h.drops).toEqual(["oversize"]);
    h.sources[0]?.msg(exact, "1");
    expect(h.applied).toHaveLength(1);
    // Two-byte characters: fewer than 16 K code units, more than 16 KB on the wire.
    h.sources[0]?.msg(frame(2, { data: { pad: "é".repeat(9000) } }), "2");
    expect(h.drops).toEqual(["oversize", "oversize"]);
    expect(h.handle.lastSeq).toBe(1);
  });

  it("drops a non-string payload", async () => {
    const h = trialHarness();
    await h.flush();
    h.sources[0]?.onmessage?.({ data: 42, lastEventId: "1" } as MessageEvent);
    expect(h.drops).toEqual(["malformed"]);
  });
});

describe("openTicketedStream: shutdown and defaults", () => {
  it("cancels a pending retry on close(), so no reconnect follows", async () => {
    const env = fakeEnv();
    const handle = openTicketedStream({
      resolveUrl: () => Promise.resolve("/s"),
      onMessage: () => true,
      eventSourceFactory: env.factory,
      scheduler: env.scheduler,
    });
    await env.flush();
    env.sources[0]?.fail();
    expect(env.timers).toHaveLength(1);
    handle.close();
    await env.runTimers();
    expect(env.sources).toHaveLength(1);
  });

  it("does not reconnect when a retry timer fires after close() anyway", async () => {
    const env = fakeEnv();
    const handle = openTicketedStream({
      resolveUrl: () => Promise.resolve("/s"),
      onMessage: () => true,
      eventSourceFactory: env.factory,
      // A scheduler that cannot cancel: the timer still fires.
      scheduler: { setTimeout: env.scheduler.setTimeout, clearTimeout: () => undefined },
    });
    await env.flush();
    env.sources[0]?.fail();
    handle.close();
    await env.runTimers();
    expect(env.sources).toHaveLength(1);
  });

  it("schedules nothing when the ticket mint fails after close()", async () => {
    const env = fakeEnv();
    const retries: number[] = [];
    let rejectMint: (reason: Error) => void = () => undefined;
    const handle = openTicketedStream({
      resolveUrl: () =>
        new Promise<string>((_resolve, reject) => {
          rejectMint = reject;
        }),
      onMessage: () => true,
      onRetry: (r) => retries.push(r.attempt),
      eventSourceFactory: env.factory,
      scheduler: env.scheduler,
    });
    handle.close();
    rejectMint(new Error("mint failed"));
    await env.flush();
    expect(retries).toEqual([]);
    expect(env.timers).toEqual([]);
  });

  it("keeps the cursor when an accepted message carries no id", async () => {
    const env = fakeEnv();
    const handle = openTicketedStream({
      resolveUrl: () => Promise.resolve("/s"),
      onMessage: () => true,
      initialLastEventId: "7",
      eventSourceFactory: env.factory,
      scheduler: env.scheduler,
    });
    await env.flush();
    env.sources[0]?.msg("{}", "");
    expect(handle.lastEventId).toBe("7");
  });

  it("uses the global timers by default: a pending retry is cancelled with them", async () => {
    vi.useFakeTimers();
    try {
      const made: FakeES[] = [];
      const handle = openTicketedStream({
        resolveUrl: () => Promise.resolve("/s"),
        onMessage: () => true,
        eventSourceFactory: (url) => {
          const es = new FakeES(url);
          made.push(es);
          return es;
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      made[0]?.fail();
      expect(vi.getTimerCount()).toBe(1);
      handle.close();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(made).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a real EventSource with the resolved URL when no factory is given", async () => {
    const opened: string[] = [];
    vi.stubGlobal(
      "EventSource",
      class extends FakeES {
        constructor(url: string) {
          super(url);
          opened.push(url);
        }
      },
    );
    try {
      const handle = openTicketedStream({ resolveUrl: () => Promise.resolve("/api/x?ticket=t"), onMessage: () => true });
      await new Promise((r) => setTimeout(r, 0));
      expect(opened).toEqual(["/api/x?ticket=t"]);
      expect(handle.current).toBeInstanceOf(FakeES);
      handle.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("openTrialStream: the handle", () => {
  it("exposes the live source and the cursor, and close() stops everything", async () => {
    const h = trialHarness();
    await h.flush();
    expect(h.handle.current).toBe(h.sources[0]);
    h.sources[0]?.msg(frame(3), "3");
    expect(h.handle.lastEventId).toBe("3");
    h.sources[0]?.fail();
    h.handle.close();
    expect(h.handle.current).toBeNull();
    await h.runTimers();
    expect(h.sources).toHaveLength(1);
  });

  it("finish() on a terminal status closes without reconnecting, and reconnect() cannot reopen it", async () => {
    const h = trialHarness();
    await h.flush();
    const es = h.sources[0];
    const onerror = es?.onerror;
    h.handle.finish();
    onerror?.call(es, new Event("error"));
    h.handle.reconnect();
    await h.flush();
    expect(h.retries).toEqual([]);
    expect(h.sources).toHaveLength(1);
  });

  it("reconnect() after give-up resumes with a fresh ticket from the last accepted seq", async () => {
    const h = trialHarness({ maxRetries: 0 });
    await h.flush();
    h.sources[0]?.msg(frame(8), "8");
    h.sources[0]?.fail();
    expect(h.giveUps).toEqual([1]);
    h.handle.reconnect();
    await h.flush();
    expect(h.sources[1]?.url).toBe("/api/trials/trl_1/events?ticket=tk2&after=8");
  });
});

describe("openTicketedStream: only the newest attempt takes effect", () => {
  /** A stream whose ticket mints settle only when the test says so. */
  function deferredMints() {
    const env = fakeEnv();
    const mints: { resolve: (url: string) => void; reject: (error: Error) => void }[] = [];
    const retries: number[] = [];
    const handle = openTicketedStream({
      resolveUrl: () =>
        new Promise<string>((resolve, reject) => {
          mints.push({ resolve, reject });
        }),
      onMessage: (e) => ({ cursor: String(e.data) }),
      onRetry: (r) => retries.push(r.attempt),
      eventSourceFactory: env.factory,
      scheduler: env.scheduler,
    });
    return { ...env, handle, mints, retries };
  }

  it.each([
    ["the superseded mint settles first", [0, 1]],
    ["the superseded mint settles last", [1, 0]],
  ] as const)("reconnect() during a pending mint opens one connection: %s", async (_label, order) => {
    const h = deferredMints();
    h.handle.reconnect();
    expect(h.mints).toHaveLength(2);
    for (const i of order) {
      h.mints[i]?.resolve(`/s?mint=${String(i + 1)}`);
      await h.flush();
    }
    expect(h.sources.map((s) => s.url)).toEqual(["/s?mint=2"]);
    expect(h.handle.current).toBe(h.sources[0]);
    h.handle.close();
    expect(h.sources.every((s) => s.closed)).toBe(true);
  });

  it("opens nothing for a mint that settles after close() and a later reconnect()", async () => {
    const h = deferredMints();
    h.handle.close();
    h.handle.reconnect();
    h.mints[0]?.resolve("/s?mint=1");
    await h.flush();
    expect(h.sources).toEqual([]);
    h.mints[1]?.resolve("/s?mint=2");
    await h.flush();
    expect(h.sources.map((s) => s.url)).toEqual(["/s?mint=2"]);
  });

  it("schedules no retry for a superseded mint that fails", async () => {
    const h = deferredMints();
    h.handle.reconnect();
    h.mints[0]?.reject(new Error("mint 1 failed"));
    await h.flush();
    expect(h.retries).toEqual([]);
    expect(h.timers).toEqual([]);
    h.mints[1]?.reject(new Error("mint 2 failed"));
    await h.flush();
    expect(h.retries).toEqual([1]);
  });

  it("keeps a connection that onRetry opened by calling reconnect(): the retry it announced is cancelled", async () => {
    // Codex round 6: the callback ran before the retry timer existed, so the timer closed the
    // healthy connection reconnect() had just opened and minted another ticket.
    const env = fakeEnv();
    let mints = 0;
    let reconnectFromCallback = true;
    const handle: { reconnect(): void } = openTicketedStream({
      resolveUrl: () => {
        mints += 1;
        return Promise.resolve(`/s?mint=${String(mints)}`);
      },
      onMessage: () => true,
      onRetry: () => {
        if (!reconnectFromCallback) return;
        reconnectFromCallback = false;
        handle.reconnect();
      },
      eventSourceFactory: env.factory,
      scheduler: env.scheduler,
    });
    await env.flush();
    env.sources[0]?.fail();
    await env.flush();
    await env.runTimers();
    expect(env.sources.map((s) => s.url)).toEqual(["/s?mint=1", "/s?mint=2"]);
    expect(env.sources[1]?.closed).toBe(false);
    expect(mints).toBe(2);
  });

  it("ignores a retry timer from a superseded attempt even when the scheduler cannot cancel it", async () => {
    const env = fakeEnv();
    const timers: (() => void)[] = [];
    let mints = 0;
    const handle = openTicketedStream({
      resolveUrl: () => {
        mints += 1;
        return Promise.resolve(`/s?mint=${String(mints)}`);
      },
      onMessage: () => true,
      eventSourceFactory: env.factory,
      scheduler: { setTimeout: (fn) => timers.push(fn), clearTimeout: () => undefined },
    });
    await env.flush();
    env.sources[0]?.fail();
    handle.reconnect();
    await env.flush();
    for (const fire of timers.splice(0)) fire();
    await env.flush();
    expect(env.sources.map((s) => s.url)).toEqual(["/s?mint=1", "/s?mint=2"]);
    expect(env.sources[1]?.closed).toBe(false);
    expect(handle.current).toBe(env.sources[1]);
  });

  it("never lets a superseded connection move the cursor", async () => {
    const h = deferredMints();
    h.mints[0]?.resolve("/s?mint=1");
    await h.flush();
    const first = h.sources[0];
    h.handle.reconnect();
    // The first connection's handlers are detached the moment it is superseded.
    expect(first?.closed).toBe(true);
    expect(first?.onmessage).toBeNull();
    h.mints[1]?.resolve("/s?mint=2");
    await h.flush();
    h.sources[1]?.msg("5", "5");
    expect(h.handle.lastEventId).toBe("5");
  });
});
