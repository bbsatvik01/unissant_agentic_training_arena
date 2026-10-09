import { describe, expect, it } from "vitest";

import { createArenaApi, type ArenaApi, type ContractViolationReport } from "../api/arena";
import { ApiError, ContractError, createApiClient } from "../api/client";
import type { CardAck, DebriefRead, EvidenceResult, TrialFrame, TrialSnapshot, TurnSubmit } from "../contracts/generated/types";
import type { EventSourceLike } from "../sse/ticketed-stream";
import { fixture } from "../../test/wire-fixtures";
import { COMMITMENT_HASH, LogBuilder, SESSION_ID, TRIAL_ID, cardFor, frame, snapshot, voiceSnapshot } from "../../test/trial-log";
import { CATCH_UP_MS, HIDDEN_CLOSE_MS, RESYNC_RETRIES, createSessionController, documentVisibility, type SessionControllerOptions } from "./sessionController";
import { roomStatus, type TrialView } from "./trialReducer";

class FakeES implements EventSourceLike {
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event("open"));
  }
  send(f: unknown) {
    const seq = (f as { seq?: unknown }).seq;
    this.onmessage?.({ data: JSON.stringify(f), lastEventId: typeof seq === "number" ? String(seq) : "" } as MessageEvent);
  }
  raw(data: string) {
    this.onmessage?.({ data, lastEventId: "" } as MessageEvent);
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
}

/** A manual clock: timers run when `advance` passes their due time. */
class Clock {
  now = 0;
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  readonly scheduler = {
    setTimeout: (fn: () => void, ms: number) => {
      const id = this.next++;
      this.timers.set(id, { at: this.now + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      this.timers.delete(id);
    },
  };
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
  pending(): number {
    return this.timers.size;
  }
}

/** Start, then let the first ticket mint settle and the EventSource open. */
async function begin(c: { start(): Promise<void> }): Promise<void> {
  await c.start();
  await flush();
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

class FakeVisibility {
  isHidden = false;
  private listeners = new Set<() => void>();
  hidden = () => this.isHidden;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  set(hidden: boolean) {
    this.isHidden = hidden;
    for (const fn of this.listeners) fn();
  }
  get count() {
    return this.listeners.size;
  }
}

type Answer<T> = T | Error | (() => T | Error);

function settle<T>(answer: Answer<T>): Promise<T> {
  const value = typeof answer === "function" ? (answer as () => T | Error)() : answer;
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

function harness(opts: { snapshots?: Answer<TrialSnapshot>[]; tickets?: Answer<string>[]; debrief?: Answer<DebriefRead>; hidden?: boolean } = {}) {
  const clock = new Clock();
  const visibility = new FakeVisibility();
  visibility.isHidden = opts.hidden ?? false;
  const sources: FakeES[] = [];
  const log: string[] = [];
  const acks: CardAck[] = [];
  const violations: ContractViolationReport[] = [];
  const turns: TurnSubmit[] = [];
  const snapshots = [...(opts.snapshots ?? [snapshot()])];
  const tickets = [...(opts.tickets ?? [])];
  let mints = 0;
  const api: ArenaApi = {
    trialSnapshot: (id) => {
      log.push(`snapshot ${id}`);
      const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
      return settle(next ?? new Error("no snapshot"));
    },
    mintStreamTicket: () => {
      mints += 1;
      log.push("mint");
      const next = tickets.shift();
      return settle(next ?? `tk${String(mints)}`);
    },
    readDebrief: (id) => {
      log.push(`read debrief ${id}`);
      return settle(opts.debrief ?? (fixture("debrief:scored") as DebriefRead));
    },
    requestDebrief: () => Promise.reject(new Error("set per test")),
    ackCard: (body) => {
      log.push(`ack ${String(body.turn_no)} ${String(body.client_valid)}`);
      acks.push(body);
      return Promise.resolve();
    },
    reportContractViolation: (body) => {
      log.push(`violation ${body.frame_type}`);
      violations.push(body);
      return Promise.resolve();
    },
    submitTurn: (_id, body) => {
      turns.push(body);
      return Promise.resolve({ last_seq: 0 });
    },
    requestEvidence: () => Promise.reject(new Error("set per test")),
    commitFinding: () => Promise.resolve({ last_seq: 0 }),
  };
  const options: SessionControllerOptions = {
    trialId: TRIAL_ID,
    sessionId: SESSION_ID,
    api,
    visibility,
    scheduler: clock.scheduler,
    newKey: () => "00000000-0000-4000-8000-00000000000a",
    eventSourceFactory: (url) => {
      const es = new FakeES(url);
      sources.push(es);
      log.push(`open ${url}`);
      return es;
    },
  };
  const make = (extra: Partial<SessionControllerOptions> = {}) => createSessionController({ ...options, ...extra });
  const last = () => {
    const es = sources.at(-1);
    if (es === undefined) throw new Error("no EventSource");
    return es;
  };
  return { clock, visibility, sources, log, acks, violations, turns, api, make, last };
}

function trialView(c: { getState(): { trial: { view: TrialView | null } } }): TrialView {
  const v = c.getState().trial.view;
  if (v === null) throw new Error("no view");
  return v;
}

describe("session controller: bootstrap (S6 5.1, S5 6.4)", () => {
  it("reads the snapshot, then mints a ticket and opens the stream after snapshot.last_seq", async () => {
    const h = harness({ snapshots: [snapshot({ last_seq: 7 })] });
    const c = h.make();
    expect(c.getState().connection).toBe("idle");
    await begin(c);
    expect(h.log).toEqual([`snapshot ${TRIAL_ID}`, "mint", `open /api/trials/${TRIAL_ID}/events?ticket=tk1&after=7`]);
    expect(c.getState().connection).toBe("connecting");
    h.last().open();
    expect(c.getState().connection).toBe("live");
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
  });

  it("folds the stream's frames into the reducer and moves the cursor", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask();
    for (const f of b.frames) h.last().send(f);
    expect(trialView(c).cards).toHaveLength(1);
    expect(trialView(c).lastSeq).toBe(b.seq);
    h.last().fail();
    await h.clock.advance(250);
    expect(h.last().url).toContain(`after=${String(b.seq)}`);
  });

  it("drops and counts every frame that fails the compiled validators; the cursor stays", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const [q] = new LogBuilder().ask().frames as [TrialFrame];
    h.last().send({ ...q, data: { ...q.data, role: "deceptive" } });
    h.last().send({ ...q, transcript_version: "1" });
    h.last().raw("{not json");
    expect(c.getState().dropped).toBe(3);
    expect(trialView(c).turns).toEqual([]);
    h.last().fail();
    await h.clock.advance(250);
    expect(h.last().url).toContain("after=0");
  });

  it("reports a snapshot that fails validation and opens no stream", async () => {
    const h = harness({ snapshots: [new ContractError("/api/trials/x/snapshot", "snapshot")] });
    const c = h.make();
    await begin(c);
    expect(c.getState().connection).toBe("failed");
    expect(c.getState().error).toBeInstanceOf(ContractError);
    expect(h.sources).toHaveLength(0);
  });

  it("a fresh visit to an ended session reads the snapshot and the debrief and never opens a stream (SG4-21)", async () => {
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 30 });
    const h = harness({ snapshots: [ended] });
    const c = h.make();
    await begin(c);
    expect(h.log).toEqual([`snapshot ${TRIAL_ID}`, `read debrief ${SESSION_ID}`]);
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
    expect(roomStatus(c.getState().trial)).toBe("ended");
  });

  it("an ended session whose debrief keeps failing ends in end_failed; reconnect() reads it again and finishes", async () => {
    let healthy = false;
    let reads = 0;
    const h = harness({
      snapshots: [snapshot({ status: "infra_failed" })],
      debrief: () => {
        reads += 1;
        return healthy ? (fixture("debrief:scored") as DebriefRead) : new Error("down");
      },
    });
    const c = h.make();
    await begin(c);
    expect(c.getState().connection).toBe("ending");
    await h.clock.advance(60_000);
    expect(c.getState().connection).toBe("end_failed");
    expect(c.getState().debrief).toBeNull();
    expect(c.getState().error).toBeInstanceOf(Error);
    expect(reads).toBe(1 + RESYNC_RETRIES);
    healthy = true;
    c.reconnect();
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
    expect(c.getState().error).toBeNull();
    expect(h.sources).toHaveLength(0);
  });


  it("notifies subscribers on every change and stops after unsubscribe", async () => {
    const h = harness();
    const c = h.make();
    const seen: string[] = [];
    const off = c.subscribe(() => seen.push(c.getState().connection));
    await begin(c);
    h.last().open();
    off();
    h.last().fail();
    // loading, the snapshot folded (still loading), the stream opening, open
    expect(seen).toEqual(["loading", "loading", "connecting", "live"]);
  });
});

describe("session controller: through the end of the trial (S6 5.1, FE-SSE-5)", () => {
  it("keeps the stream open after the terminal status and finishes on debrief.ready", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    h.last().open();
    const b = new LogBuilder().ask().commit();
    for (const f of b.frames) h.last().send(f);
    expect(roomStatus(c.getState().trial)).toBe("ended");
    expect(h.last().closed).toBe(false);
    expect(c.getState().connection).toBe("live");
    // a drop after the end reconnects with a catch-up ticket
    h.last().fail();
    await h.clock.advance(250);
    expect(h.sources).toHaveLength(2);
    expect(h.last().url).toContain(`after=${String(b.seq)}`);
    h.last().send(b.debriefReady().frames.at(-1));
    expect(h.last().closed).toBe(true);
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
    h.last().fail();
    await h.clock.advance(60_000);
    expect(h.sources).toHaveLength(2);
  });

  it("the completion pair resumes after a drop between its frames and shows the hash once (FE-SSE-8)", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask().commit();
    const pair = b.frames.slice(-2);
    for (const f of b.frames.slice(0, -1)) h.last().send(f);
    expect(roomStatus(c.getState().trial)).toBe("ended");
    h.last().fail();
    await h.clock.advance(250);
    // the cursor stayed below the trial_ended row, so the server replays both frames
    expect(h.last().url).toContain(`after=${String(b.seq - 1)}`);
    for (const f of pair) h.last().send(f);
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
    expect(c.getState().dropped).toBe(0);
  });

  it("publication committed and the connection dropped before debrief.ready: 409 stream_closed ends it from REST", async () => {
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 9 });
    const h = harness({
      snapshots: [snapshot(), ended],
      tickets: ["tk1", new ApiError(409, "stream_closed", "/api/trials/x/stream-tickets")],
    });
    const c = h.make();
    await begin(c);
    for (const f of new LogBuilder().ask().commit().frames) h.last().send(f);
    h.last().fail();
    await h.clock.advance(250);
    await flush();
    expect(h.sources).toHaveLength(1);
    expect(h.log.slice(-2)).toEqual([`snapshot ${TRIAL_ID}`, `read debrief ${SESSION_ID}`]);
    expect(c.getState().connection).toBe("finished");
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
    await h.clock.advance(60_000);
    expect(h.sources).toHaveLength(1);
    expect(h.clock.pending()).toBe(0);
  });

  it("a 409 whose snapshot reads keep failing ends in end_failed; reconnect() recovers with no stream and no debrief POST", async () => {
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 9 });
    const failures = Array.from({ length: 1 + RESYNC_RETRIES }, () => new TypeError("network"));
    const h = harness({ snapshots: [snapshot(), ...failures, ended], tickets: [new ApiError(409, "stream_closed", "/x")] });
    const c = h.make();
    await begin(c);
    await h.clock.advance(60_000);
    expect(c.getState().connection).toBe("end_failed");
    expect(c.getState().error).toBeInstanceOf(TypeError);
    expect(c.getState().debrief).toBeNull();
    c.reconnect();
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
    expect(h.sources).toHaveLength(0);
  });


  it("a 409 stream_closed on the very first ticket also ends from REST", async () => {
    const h = harness({
      snapshots: [snapshot(), snapshot({ status: "completed" })],
      tickets: [new ApiError(409, "stream_closed", "/x")],
    });
    const c = h.make();
    await begin(c);
    await flush();
    expect(h.sources).toHaveLength(0);
    expect(c.getState().connection).toBe("finished");
  });

  it("the publication response lost: the stream stays open, and the 409 after a drop finishes", async () => {
    const h = harness({
      snapshots: [snapshot(), snapshot({ status: "completed" })],
      tickets: ["tk1", new ApiError(409, "stream_closed", "/x")],
    });
    const c = h.make({ api: { ...h.api, requestDebrief: () => Promise.reject(new TypeError("network")) } });
    await begin(c);
    for (const f of new LogBuilder().ask().commit().frames) h.last().send(f);
    await expect(c.requestDebrief()).rejects.toBeInstanceOf(TypeError);
    expect(h.last().closed).toBe(false);
    h.last().fail();
    await h.clock.advance(250);
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
  });

  it("a published debrief from the POST finishes the stream with no reconnect", async () => {
    const debrief = fixture("debrief:unscored");
    const h = harness();
    const c = h.make({ api: { ...h.api, requestDebrief: () => Promise.resolve(debrief as never) } });
    await begin(c);
    for (const f of new LogBuilder().ask().commit().frames) h.last().send(f);
    await c.requestDebrief();
    expect(h.last().closed).toBe(true);
    expect(c.getState().debrief).toEqual(debrief);
    expect(c.getState().connection).toBe("finished");
    await h.clock.advance(60_000);
    expect(h.sources).toHaveLength(1);
  });

  it("other ticket failures keep retrying on the stream's schedule, then give up; reconnect() starts again", async () => {
    const fail = () => new ApiError(503, "paused", "/x");
    const h = harness({ tickets: ["tk1", fail(), fail(), fail(), fail(), fail()] });
    const c = h.make();
    await begin(c);
    h.last().fail();
    await h.clock.advance(250);
    expect(c.getState().connection).toBe("reconnecting");
    await h.clock.advance(20_000);
    expect(c.getState().connection).toBe("gave_up");
    c.reconnect();
    await flush();
    expect(h.sources).toHaveLength(2);
    expect(c.getState().connection).toBe("connecting");
  });
});

describe("session controller: hidden tab (S6 5.1, FE-SSE-5)", () => {
  it("closes the stream within 61 s of the tab hiding and resumes after=<lastSeq> on visible", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    h.last().open();
    const b = new LogBuilder().ask();
    for (const f of b.frames) h.last().send(f);
    h.visibility.set(true);
    await h.clock.advance(HIDDEN_CLOSE_MS - 1);
    expect(h.last().closed).toBe(false);
    await h.clock.advance(1);
    expect(HIDDEN_CLOSE_MS).toBeLessThanOrEqual(61_000);
    expect(h.last().closed).toBe(true);
    expect(c.getState().connection).toBe("hidden");
    await h.clock.advance(120_000);
    expect(h.sources).toHaveLength(1);
    h.visibility.set(false);
    await flush();
    expect(h.sources).toHaveLength(2);
    expect(h.last().url).toBe(`/api/trials/${TRIAL_ID}/events?ticket=tk2&after=${String(b.seq)}`);
  });

  it("a tab shown again before 60 s keeps the stream", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    h.visibility.set(true);
    await h.clock.advance(30_000);
    h.visibility.set(false);
    await h.clock.advance(120_000);
    expect(h.sources).toHaveLength(1);
    expect(h.last().closed).toBe(false);
    expect(c.getState().connection).toBe("connecting");
  });

  it("a page opened hidden closes after 60 s too", async () => {
    const h = harness({ hidden: true });
    const c = h.make();
    await begin(c);
    await h.clock.advance(HIDDEN_CLOSE_MS);
    expect(h.last().closed).toBe(true);
    expect(c.getState().connection).toBe("hidden");
  });

  it("visibility changes after the end change nothing", async () => {
    const h = harness({ snapshots: [snapshot({ status: "completed" })] });
    const c = h.make();
    await begin(c);
    h.visibility.set(true);
    await h.clock.advance(HIDDEN_CLOSE_MS);
    h.visibility.set(false);
    await flush();
    expect(h.sources).toHaveLength(0);
    expect(c.getState().connection).toBe("finished");
  });
});

describe("session controller: catch-up after a POST (S6 5.1)", () => {
  it("reconnects after=<lastSeq> when the stream is still behind the POST's last_seq 1 s later", async () => {
    const h = harness();
    const c = h.make({ api: { ...h.api, submitTurn: () => Promise.resolve({ last_seq: 5 }) } });
    await begin(c);
    h.last().open();
    const b = new LogBuilder().ask();
    for (const f of b.frames.slice(0, 1)) h.last().send(f);
    await c.submitTurn("Why did you enter?");
    await h.clock.advance(CATCH_UP_MS - 1);
    expect(h.sources).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.sources).toHaveLength(2);
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.last().url).toContain("after=1");
  });

  it("does nothing when the stream already reached it", async () => {
    const h = harness();
    const c = h.make({ api: { ...h.api, submitTurn: () => Promise.resolve({ last_seq: 3 }) } });
    await begin(c);
    for (const f of new LogBuilder().ask().frames) h.last().send(f);
    await c.submitTurn("Why?");
    await h.clock.advance(5_000);
    expect(h.sources).toHaveLength(1);
  });

  it("sends the turn with the current transcript version, no records, and a fresh key", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    for (const f of new LogBuilder().ask({ releaseBefore: "rec-01" }).frames) h.last().send(f);
    await c.submitTurn("Next?");
    expect(h.turns).toEqual([{ question: "Next?", release_ids: [], expected_version: 3, idem_key: "00000000-0000-4000-8000-00000000000a" }]);
    await h.clock.advance(5_000);
    expect(h.sources).toHaveLength(1);
  });

  it("an evidence request catches up when its transcript version is not on the stream 1 s later", async () => {
    const result = { released: [{ record_id: "rec-02", kind: "record", doc_kind: "alarm_log" }], already_released: [], denied: [], transcript_version: 3 } as const;
    const h = harness();
    const c = h.make({ api: { ...h.api, requestEvidence: () => Promise.resolve(result) } });
    await begin(c);
    for (const f of new LogBuilder().ask().frames) h.last().send(f);
    await expect(c.requestEvidence(["rec-02"])).resolves.toEqual(result);
    await h.clock.advance(CATCH_UP_MS);
    expect(h.sources).toHaveLength(2);
    const caughtUp = h.make({ api: { ...h.api, requestEvidence: () => Promise.resolve({ ...result, released: [], transcript_version: 2 }) } });
    await begin(caughtUp);
    for (const f of new LogBuilder().ask().frames) h.last().send(f);
    await caughtUp.requestEvidence(["rec-02"]);
    await h.clock.advance(CATCH_UP_MS);
    expect(h.sources).toHaveLength(3);
  });

  it("the finding submit shows finalizing, catches up, and recovers when the POST fails", async () => {
    let fail = true;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        commitFinding: () => (fail ? Promise.reject(new ApiError(409, "turn_in_progress", "/x")) : Promise.resolve({ last_seq: 9 })),
      },
    });
    await begin(c);
    const body = (fixture("finding-commit") as { finding: never }).finding;
    const pending = c.submitFinding(body);
    expect(roomStatus(c.getState().trial)).toBe("finalizing");
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
    fail = false;
    await c.submitFinding(body);
    expect(roomStatus(c.getState().trial)).toBe("finalizing");
    await h.clock.advance(CATCH_UP_MS);
    expect(h.sources).toHaveLength(2);
  });

  it("no catch-up once the stream is gone", async () => {
    const h = harness();
    const c = h.make({ api: { ...h.api, submitTurn: () => Promise.resolve({ last_seq: 50 }) } });
    await begin(c);
    await c.submitTurn("Why?");
    c.dispose();
    await h.clock.advance(CATCH_UP_MS);
    expect(h.sources).toHaveLength(1);
  });
});

describe("session controller: KPI-4 acknowledgement and the visibility re-check (S6 5.6, FE-KPI4-1, FE-SSE-3)", () => {
  it("acknowledges a valid card once, client_valid true, before subscribers see it", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    c.subscribe(() => {
      if (trialView(c).cards.length > 0) h.log.push("render card");
    });
    const b = new LogBuilder().ask();
    for (const f of b.frames) h.last().send(f);
    h.last().send(b.frames.at(-1));
    await flush();
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: true }]);
    expect(h.log.indexOf("ack 1 true")).toBeLessThan(h.log.indexOf("render card"));
  });

  it("acknowledges a stale card client_valid false and renders nothing", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    for (const f of new LogBuilder().ask({ coach: "stale" }).frames) h.last().send(f);
    await flush();
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
    expect(trialView(c).cards).toEqual([]);
  });

  it("acknowledges a card that fails the schema client_valid false, once, and drops it", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask({ coach: "none" });
    for (const f of b.frames) h.last().send(f);
    const card = frame("coach.card", b.seq + 1, b.version, { turn_no: 1, card: { ...cardFor(1, b.version), candidate_sha256: "a".repeat(64) } as never });
    h.last().send(card);
    h.last().send(card);
    await flush();
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
    expect(c.getState().dropped).toBe(2);
    expect(trialView(c).cards).toEqual([]);
  });

  it("a broken frame that names no turn is dropped with no acknowledgement", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    h.last().send(frame("coach.card", 3, 2, { turn_no: 0 } as never));
    h.last().send({ ...frame("coach.card", 3, 2, { turn_no: 1 } as never), scope_id: "other" });
    await flush();
    expect(h.acks).toEqual([]);
    expect(c.getState().dropped).toBe(2);
  });

  it("in assessment, a coach.card renders nothing, posts no acknowledgement and one violation report", async () => {
    const h = harness({ snapshots: [snapshot({ mode: "assessment" })] });
    const c = h.make();
    await begin(c);
    const practice = new LogBuilder("practice").ask();
    for (const f of practice.frames) h.last().send(f);
    const card = practice.frames.find((f) => f.type === "coach.card");
    h.last().send(card);
    await flush();
    expect(h.acks).toEqual([]);
    expect(trialView(c).cards).toEqual([]);
    expect(h.violations.filter((v) => v.frame_type === "coach.card")).toEqual([
      { trial_id: TRIAL_ID, frame_type: "coach.card", seq: card?.seq ?? null, reason: "assessment_coaching" },
    ]);
    expect(h.violations.map((v) => v.frame_type)).toEqual(["coach.working", "coach.card"]);
  });

  it("a voice trial's card posts nothing and is reported", async () => {
    const h = harness({ snapshots: [voiceSnapshot()] });
    const c = h.make();
    await begin(c);
    h.last().send(frame("coach.card", 4, 2, { turn_no: 1, card: cardFor(1, 2) }));
    await flush();
    expect(h.acks).toEqual([]);
    expect(h.violations).toEqual([{ trial_id: TRIAL_ID, frame_type: "coach.card", seq: 4, reason: "voice_text_frame" }]);
  });

  it("reports a running assessment snapshot that carries coaching", async () => {
    const h = harness({
      snapshots: [
        snapshot({
          mode: "assessment",
          last_seq: 3,
          exchanges_used: 1,
          turns: [
            { turn_no: 1, question: "Q?", source: "investigator", answer: "A.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 },
          ],
          cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: 3 }],
        }),
      ],
    });
    const c = h.make();
    await begin(c);
    await flush();
    expect(h.violations).toEqual([{ trial_id: TRIAL_ID, frame_type: "snapshot", seq: null, reason: "assessment_coaching" }]);
    expect(trialView(c).cards).toEqual([]);
  });

  it("a failing acknowledgement or report never breaks the room", async () => {
    const h = harness({ snapshots: [snapshot({ mode: "assessment" })] });
    const c = h.make({
      api: { ...h.api, ackCard: () => Promise.reject(new Error("x")), reportContractViolation: () => Promise.reject(new Error("y")) },
    });
    await begin(c);
    for (const f of new LogBuilder("practice").ask().frames) h.last().send(f);
    await flush();
    expect(trialView(c).turns).toHaveLength(1);
    const p = harness();
    const pc = p.make({ api: { ...p.api, ackCard: () => Promise.reject(new Error("x")) } });
    await begin(pc);
    for (const f of new LogBuilder().ask().frames) p.last().send(f);
    await flush();
    expect(trialView(pc).cards).toHaveLength(1);
  });
});

describe("session controller: lifecycle", () => {
  it("dispose closes the stream, cancels timers, unsubscribes visibility and ignores late answers", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    h.visibility.set(true);
    expect(h.visibility.count).toBe(1);
    c.dispose();
    expect(h.last().closed).toBe(true);
    expect(h.visibility.count).toBe(0);
    await h.clock.advance(HIDDEN_CLOSE_MS);
    expect(c.getState().connection).toBe("closed");

    let release: (s: TrialSnapshot) => void = () => undefined;
    const late = harness();
    const lc = late.make({ api: { ...late.api, trialSnapshot: () => new Promise((r) => (release = r)) } });
    const started = lc.start();
    lc.dispose();
    release(snapshot());
    await started;
    expect(late.sources).toHaveLength(0);
    expect(lc.getState().trial.view).toBeNull();
  });

  it("start is idempotent", async () => {
    const h = harness();
    const c = h.make();
    await Promise.all([c.start(), c.start()]);
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(1);
  });

  it("acting before the snapshot is refused", async () => {
    const h = harness();
    await expect(h.make().submitTurn("x")).rejects.toThrow(/before the snapshot/);
  });

  it("an ended trial's debrief POST stores the document and finishes", async () => {
    const debrief = fixture("debrief:scored");
    const h = harness({ snapshots: [snapshot({ status: "completed" })], debrief: { status: "scoring" } });
    const c = h.make({ api: { ...h.api, requestDebrief: () => Promise.resolve(debrief as never) } });
    await begin(c);
    expect(c.getState().debrief).toEqual({ status: "scoring" });
    await c.requestDebrief();
    expect(c.getState().debrief).toEqual(debrief);
  });

  it("uses the default stream opener and idempotency keys when none are injected", async () => {
    const h = harness();
    const c = createSessionController({
      trialId: TRIAL_ID,
      sessionId: SESSION_ID,
      api: h.api,
      visibility: h.visibility,
      scheduler: h.clock.scheduler,
      eventSourceFactory: (url) => {
        const es = new FakeES(url);
        h.sources.push(es);
        return es;
      },
    });
    await begin(c);
    await c.submitTurn("Why?");
    expect(h.turns[0]?.idem_key).toMatch(/^[0-9a-f-]{36}$/);
    c.dispose();
  });

  it("falls back to the global timers and an always-visible page when none are injected", async () => {
    const h = harness();
    const c = createSessionController({
      trialId: TRIAL_ID,
      sessionId: SESSION_ID,
      api: h.api,
      eventSourceFactory: (url) => {
        const es = new FakeES(url);
        h.sources.push(es);
        return es;
      },
    });
    await begin(c);
    expect(h.sources).toHaveLength(1);
    c.dispose();
  });
});

describe("documentVisibility", () => {
  it("reads visibilityState and forwards visibilitychange", () => {
    const target = new EventTarget() as EventTarget & { visibilityState: string };
    target.visibilityState = "visible";
    const v = documentVisibility(target as unknown as Document);
    let calls = 0;
    const off = v.subscribe(() => (calls += 1));
    expect(v.hidden()).toBe(false);
    target.visibilityState = "hidden";
    target.dispatchEvent(new Event("visibilitychange"));
    expect(v.hidden()).toBe(true);
    off();
    target.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toBe(1);
  });

  it("is always visible without a document", () => {
    const v = documentVisibility(null);
    expect(v.hidden()).toBe(false);
    v.subscribe(() => undefined)();
  });
});

describe("session controller: Codex round 1 regressions", () => {
  function keys() {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
  }

  it("a turn retried after a lost answer resends the same request, key and version; a refused one does not", async () => {
    const sent: TurnSubmit[] = [];
    const answers: (Error | { last_seq: number })[] = [new TypeError("network"), { last_seq: 0 }, new ApiError(409, "turn_in_progress", "/x"), { last_seq: 0 }];
    const h = harness();
    const c = h.make({
      newKey: keys(),
      api: {
        ...h.api,
        submitTurn: (_id, body) => {
          sent.push(body);
          const a = answers.shift();
          return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? { last_seq: 0 });
        },
      },
    });
    await begin(c);
    await expect(c.submitTurn("Why?")).rejects.toBeInstanceOf(TypeError);
    // the question was committed before the answer was lost: the stream moves the version meanwhile
    for (const f of new LogBuilder().ask().frames.slice(0, 1)) h.last().send(f);
    await c.submitTurn("Why?");
    expect(sent[1]).toEqual(sent[0]);
    await expect(c.submitTurn("Then?")).rejects.toBeInstanceOf(ApiError);
    await c.submitTurn("Then?");
    expect(sent[3]?.idem_key).not.toBe(sent[2]?.idem_key);
    expect(sent[2]?.idem_key).not.toBe(sent[0]?.idem_key);
  });

  it("evidence requests and findings reuse their key on a retry of the same action only", async () => {
    const evidenceKeys: string[] = [];
    const findingKeys: string[] = [];
    let failEvidence = 2;
    let failFinding = 1;
    const result = { released: [], already_released: [], denied: [], transcript_version: 0 };
    const h = harness();
    const c = h.make({
      newKey: keys(),
      api: {
        ...h.api,
        requestEvidence: (_id, body) => {
          evidenceKeys.push(body.idem_key);
          failEvidence -= 1;
          if (failEvidence === 1) return Promise.reject(new TypeError("lost"));
          if (failEvidence === 0) return Promise.reject(new ApiError(422, "unknown_record", "/x"));
          return Promise.resolve(result);
        },
        commitFinding: (_id, body) => {
          findingKeys.push(body.idem_key);
          failFinding -= 1;
          return failFinding === 0 ? Promise.reject(new ApiError(503, "paused", "/x")) : Promise.resolve({ last_seq: 0 });
        },
      },
    });
    await begin(c);
    await expect(c.requestEvidence(["rec-02"])).rejects.toBeInstanceOf(TypeError);
    await expect(c.requestEvidence(["rec-02"])).rejects.toBeInstanceOf(ApiError);
    await c.requestEvidence(["rec-02"]);
    expect(evidenceKeys[1]).toBe(evidenceKeys[0]);
    expect(evidenceKeys[2]).not.toBe(evidenceKeys[1]);
    await c.requestEvidence(["rec-03"]);
    expect(evidenceKeys[3]).not.toBe(evidenceKeys[2]);
    const body = (fixture("finding-commit") as { finding: never }).finding;
    await expect(c.submitFinding(body)).rejects.toBeInstanceOf(ApiError);
    await c.submitFinding(body);
    expect(findingKeys[1]).toBe(findingKeys[0]);
  });

  it("a debrief published between trial.status and trial.finalized still shows the hash, from the terminal snapshot", async () => {
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 9 });
    const debrief = fixture("debrief:scored");
    const h = harness({ snapshots: [snapshot(), ended] });
    const c = h.make({ api: { ...h.api, requestDebrief: () => Promise.resolve(debrief as never) } });
    await begin(c);
    for (const f of new LogBuilder().ask().commit().frames.slice(0, -1)) h.last().send(f);
    expect(trialView(c).commitmentHash).toBeNull();
    await c.requestDebrief();
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
    expect(c.getState().debrief).toEqual(debrief);
    expect(h.log.filter((l) => l.startsWith("read debrief"))).toEqual([]);
  });

  it("a live assessment that ends shows the coaching withheld until then, from the terminal snapshot", async () => {
    const turn = { turn_no: 1, question: "Q?", source: "investigator", answer: "A.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 } as const;
    const ended = snapshot({ mode: "assessment", status: "completed", last_seq: 9, exchanges_used: 1, turns: [turn], cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: 3 }] });
    const h = harness({ snapshots: [snapshot({ mode: "assessment" }), ended] });
    const c = h.make();
    await begin(c);
    const b = new LogBuilder("assessment").ask().commit().debriefReady();
    for (const f of b.frames) h.last().send(f);
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([1]);
    expect(h.violations).toEqual([]);
  });

  it("a card that fails the schema closes its turn, so the composer is not stuck", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask({ coach: "none" });
    for (const f of b.frames) h.last().send(f);
    expect(roomStatus(c.getState().trial)).toBe("coach_working");
    h.last().send(frame("coach.card", b.seq + 1, b.version, { turn_no: 1, card: { ...cardFor(1, b.version), candidate_id: "x" } as never }));
    await flush();
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
  });

  it("a card ahead of its answer waits, then is acknowledged valid and shown once the answer arrives", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const frames = new LogBuilder().ask().frames;
    const card = frames.at(-1);
    h.last().send(frames[0]);
    h.last().send(card);
    await flush();
    expect(h.acks).toEqual([]);
    expect(trialView(c).cards).toEqual([]);
    for (const f of frames.slice(1, -1)) h.last().send(f);
    await flush();
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: true }]);
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([1]);
  });

  it("a stale card is dropped and counted, and does not move the cursor", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask({ coach: "stale" });
    for (const f of b.frames) h.last().send(f);
    expect(c.getState().dropped).toBe(1);
    h.last().fail();
    await h.clock.advance(250);
    expect(h.last().url).toContain(`after=${String(b.seq - 1)}`);
  });

  it("a frame with a key outside the envelope schema is dropped", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const [q] = new LogBuilder().ask().frames as [TrialFrame];
    h.last().send({ ...q, role: "deceptive" });
    expect(c.getState().dropped).toBe(1);
    expect(trialView(c).turns).toEqual([]);
  });

  it("a scoring answer that settles after the published debrief never replaces it", async () => {
    const debrief = fixture("debrief:scored");
    let answer: (d: DebriefRead) => void = () => undefined;
    const h = harness({ snapshots: [snapshot({ status: "completed" })] });
    const c = h.make({
      api: {
        ...h.api,
        readDebrief: () => new Promise<DebriefRead>((r) => (answer = r)),
        requestDebrief: () => Promise.resolve(debrief as never),
      },
    });
    const started = c.start();
    await flush();
    // the published document arrives first; the older GET (still in flight) settles after it
    const requested = c.requestDebrief();
    await flush();
    answer({ status: "scoring" });
    await requested;
    await started;
    await flush();
    expect(c.getState().debrief).toEqual(debrief);
  });

  it("with the real API wrappers, the acknowledgement leaves before subscribers hear of the card", async () => {
    const order: string[] = [];
    const h = harness();
    const fetchLike = (url: string, init: RequestInit): Promise<Response> => {
      order.push(`${init.method ?? "GET"} ${url}`);
      const body = url === "/api/me" ? { user_id: "u", display_name: "D", roles: [], ex4_acknowledged: null, csrf_token: "t" } : url.endsWith("/stream-tickets") ? { ticket: "tk" } : url.endsWith("/snapshot") ? snapshot() : null;
      return Promise.resolve(new Response(body === null ? null : JSON.stringify(body), { status: body === null ? 204 : 200 }));
    };
    const api = createArenaApi(createApiClient({ fetch: fetchLike }));
    const c = createSessionController({
      trialId: TRIAL_ID,
      sessionId: SESSION_ID,
      api,
      visibility: h.visibility,
      scheduler: h.clock.scheduler,
      eventSourceFactory: (url) => {
        const es = new FakeES(url);
        h.sources.push(es);
        return es;
      },
    });
    await c.start();
    for (let i = 0; i < 20 && h.sources.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    c.subscribe(() => {
      if (trialView(c).cards.length > 0 && !order.includes("render")) order.push("render");
    });
    for (const f of new LogBuilder().ask().frames) h.last().send(f);
    expect(order.slice(-2)).toEqual(["POST /api/telemetry/kpi4", "render"]);
  });
});

describe("session controller: Codex round 2 regressions", () => {
  function deferred<T>() {
    let resolve: (v: T) => void = () => undefined;
    let reject: (e: Error) => void = () => undefined;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("an older turn settling never clears a newer turn's retry identity", async () => {
    let n = 0;
    const sent: TurnSubmit[] = [];
    const answers = [deferred<{ last_seq: number }>(), deferred<{ last_seq: number }>(), deferred<{ last_seq: number }>()];
    const h = harness();
    const c = h.make({
      newKey: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`,
      api: {
        ...h.api,
        submitTurn: (_id, body) => {
          sent.push(body);
          return (answers[sent.length - 1] as (typeof answers)[number]).promise;
        },
      },
    });
    await begin(c);
    const first = c.submitTurn("One?");
    const second = c.submitTurn("Two?");
    answers[0]?.resolve({ last_seq: 0 });
    await first;
    answers[1]?.reject(new TypeError("lost"));
    await expect(second).rejects.toBeInstanceOf(TypeError);
    const retry = c.submitTurn("Two?");
    answers[2]?.resolve({ last_seq: 0 });
    await retry;
    expect(sent[2]).toEqual(sent[1]);
  });

  it("an older evidence request settling never clears a newer one's key", async () => {
    const keysSent: string[] = [];
    let n = 0;
    const gates = [deferred<EvidenceResult>(), deferred<EvidenceResult>(), deferred<EvidenceResult>()];
    const result: EvidenceResult = { released: [], already_released: [], denied: [], transcript_version: 0 };
    const h = harness();
    const c = h.make({
      newKey: () => `k${String((n += 1))}`,
      api: {
        ...h.api,
        requestEvidence: (_id, body) => {
          keysSent.push(body.idem_key);
          return (gates[keysSent.length - 1] as (typeof gates)[number]).promise;
        },
      },
    });
    await begin(c);
    const a = c.requestEvidence(["rec-01"]);
    const b = c.requestEvidence(["rec-02"]);
    gates[0]?.resolve(result);
    await a;
    gates[1]?.reject(new TypeError("lost"));
    await expect(b).rejects.toBeInstanceOf(TypeError);
    const retry = c.requestEvidence(["rec-02"]);
    gates[2]?.resolve(result);
    await retry;
    expect(keysSent).toEqual(["k1", "k2", "k2"]);
  });

  it("a terminal snapshot read that fails once is retried and covers the end", async () => {
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 9 });
    const h = harness({ snapshots: [snapshot(), new TypeError("network"), ended], tickets: [new ApiError(409, "stream_closed", "/x")] });
    const c = h.make();
    await begin(c);
    await flush();
    expect(c.getState().connection).toBe("ending");
    expect(trialView(c).commitmentHash).toBeNull();
    await h.clock.advance(CATCH_UP_MS);
    expect(c.getState().connection).toBe("finished");
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
    expect(roomStatus(c.getState().trial)).toBe("ended");
  });


  it("a card above a missing frame neither shows nor is acknowledged until the snapshot re-read covers the gap", async () => {
    const b = new LogBuilder().ask({ releaseAfter: "rec-02" });
    const [q, , answer, release, , card] = b.frames;
    expect(release?.type).toBe("evidence.released");
    const covered = snapshot({
      last_seq: release?.seq ?? 0,
      exchanges_used: 1,
      turns: [{ turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 }],
      released: [{ ...(release?.data as never as object), transcript_version: 3, event_seq: release?.seq ?? 0 } as never],
    });
    let answerSnapshot: (s: TrialSnapshot) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve(snapshot()) : new Promise<TrialSnapshot>((r) => (answerSnapshot = r));
        },
      },
    });
    await begin(c);
    h.last().send(q);
    h.last().send(answer);
    h.last().send(card);
    await flush();
    expect(trialView(c).cards).toEqual([]);
    expect(trialView(c).pendingCards).toEqual([1]);
    expect(h.acks).toEqual([]);
    expect(reads).toBe(2);
    answerSnapshot(covered);
    await flush();
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([1]);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: true }]);
  });

  it("a card judged before an earlier release arrives is never shown or acknowledged valid", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const shown: number[] = [];
    c.subscribe(() => shown.push(trialView(c).cards.length));
    // answer at v2 (seq 2), release at v3 (seq 3), card read at v2 (seq 4): stale once seq 3 is known
    const b = new LogBuilder().ask({ coach: "none" });
    b.release("rec-02");
    const card = frame("coach.card", b.seq + 1, 2, { turn_no: 1, card: cardFor(1, 2) });
    const [q, , answer, release] = b.frames;
    for (const f of [q, answer, card]) h.last().send(f);
    expect(h.acks).toEqual([]);
    h.last().send(release);
    await flush();
    expect(shown.every((count) => count === 0)).toBe(true);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
    expect(trialView(c).rejectedCards).toEqual([1]);
  });

  it("an assessment stream's legitimate gaps (withheld coaching rows) move the cursor and trigger no resume", async () => {
    const h = harness({ snapshots: [snapshot({ mode: "assessment" })] });
    const c = h.make();
    await begin(c);
    const b = new LogBuilder("assessment").ask();
    h.last().send(b.frames[0]);
    h.last().send({ ...b.frames[2], seq: 5 });
    await h.clock.advance(5_000);
    expect(h.sources).toHaveLength(1);
    h.last().fail();
    await h.clock.advance(250);
    expect(h.last().url).toContain("after=5");
    expect(trialView(c).turns.map((t) => t.answer)).toEqual(["Answer 1."]);
  });
});

describe("session controller: Codex round 3 regressions", () => {
  it("a card that fails the schema does not hold later coaching behind a gap", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask().ask();
    const frames = b.frames.map((f) => (f.type === "coach.card" && f.data.turn_no === 1 ? { ...f, data: { ...f.data, card: { ...f.data.card, candidate_id: "x" } } } : f));
    for (const f of frames) h.last().send(f);
    await flush();
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([2]);
    expect(trialView(c).pendingCards).toEqual([]);
    expect(h.acks).toEqual([
      { trial_id: TRIAL_ID, turn_no: 1, client_valid: false },
      { trial_id: TRIAL_ID, turn_no: 2, client_valid: true },
    ]);
    await h.clock.advance(5_000);
    expect(h.sources).toHaveLength(1);
  });

  it("an unparseable frame makes the room re-read the snapshot, which closes the turn it carried", async () => {
    const b = new LogBuilder().ask();
    const card = b.frames.at(-1);
    const after = snapshot({
      last_seq: card?.seq ?? 0,
      exchanges_used: 1,
      turns: [{ turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 }],
      cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: card?.seq ?? 0 }],
    });
    const h = harness({ snapshots: [snapshot(), after] });
    const c = h.make();
    await begin(c);
    for (const f of b.frames.slice(0, -1)) h.last().send(f);
    expect(roomStatus(c.getState().trial)).toBe("coach_working");
    h.last().raw("{broken");
    await flush();
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(2);
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([1]);
    // shown from the snapshot, never acknowledged: only streamed cards are
    expect(h.acks).toEqual([]);
  });

  it("an identifiable frame that fails parsing (a card with a bad envelope field) closes its turn and is acknowledged invalid", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask().ask();
    const firstCard = b.frames.find((f) => f.type === "coach.card" && f.data.turn_no === 1);
    for (const f of b.frames) h.last().send(f === firstCard ? { ...f, ts: 42 } : f);
    await flush();
    expect(h.acks).toEqual([
      { trial_id: TRIAL_ID, turn_no: 1, client_valid: false },
      { trial_id: TRIAL_ID, turn_no: 2, client_valid: true },
    ]);
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([2]);
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(1);
  });

  it("a dropped frame of another trial is never taken for this one's", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask({ coach: "none" });
    for (const f of b.frames) h.last().send(f);
    h.last().send({ ...frame("coach.card", b.seq + 1, b.version, { turn_no: 1, card: cardFor(1, b.version) }), scope_id: "00000000-0000-4000-8000-000000000000" });
    await flush();
    expect(h.acks).toEqual([]);
    expect(roomStatus(c.getState().trial)).toBe("coach_working");
  });

  it("an evidence request whose records share one version waits for every record", async () => {
    const result: EvidenceResult = {
      released: [
        { record_id: "rec-02", kind: "record", doc_kind: "alarm_log" },
        { record_id: "rec-03", kind: "record", doc_kind: "alarm_log" },
      ],
      already_released: [],
      denied: [],
      transcript_version: 3,
    };
    const h = harness();
    const c = h.make({ api: { ...h.api, requestEvidence: () => Promise.resolve(result) } });
    await begin(c);
    const b = new LogBuilder().ask();
    const first = b.release("rec-02", "requested");
    for (const f of b.frames) h.last().send(f);
    expect(first.transcript_version).toBe(3);
    await c.requestEvidence(["rec-02", "rec-03"]);
    await h.clock.advance(CATCH_UP_MS);
    expect(h.sources).toHaveLength(2);
  });

  it("a card refused after it was pending is counted as dropped once", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask({ coach: "none" });
    b.release("rec-02");
    const card = frame("coach.card", b.seq + 1, 2, { turn_no: 1, card: cardFor(1, 2) });
    const [q, , answer, release] = b.frames;
    for (const f of [q, answer, card]) h.last().send(f);
    expect(c.getState().dropped).toBe(0);
    h.last().send(release);
    h.last().send(card);
    await flush();
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
    // once when it was refused, once more for the replayed copy the stream itself drops
    expect(c.getState().dropped).toBe(2);
  });
});

describe("session controller: Codex round 4 regressions", () => {
  it("a different question in between does not lose an unresolved turn's identity", async () => {
    let n = 0;
    const sent: TurnSubmit[] = [];
    const answers: (Error | { last_seq: number })[] = [new TypeError("lost"), new ApiError(409, "turn_in_progress", "/x"), { last_seq: 0 }];
    const h = harness();
    const c = h.make({
      newKey: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`,
      api: {
        ...h.api,
        submitTurn: (_id, body) => {
          sent.push(body);
          const a = answers.shift();
          return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? { last_seq: 0 });
        },
      },
    });
    await begin(c);
    await expect(c.submitTurn("A?")).rejects.toBeInstanceOf(TypeError);
    await expect(c.submitTurn("B?")).rejects.toBeInstanceOf(ApiError);
    await c.submitTurn("A?");
    expect(sent[2]).toEqual(sent[0]);
  });

  it("snapshot re-reads run one at a time, and a request during one runs once more after it", async () => {
    const gates: ((s: TrialSnapshot) => void)[] = [];
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve(snapshot()) : new Promise<TrialSnapshot>((r) => gates.push(r));
        },
      },
    });
    await begin(c);
    h.last().raw("{a");
    h.last().raw("{b");
    h.last().raw("{c");
    await flush();
    expect(reads).toBe(2);
    gates.shift()?.(snapshot());
    await flush();
    expect(reads).toBe(3);
    gates.shift()?.(snapshot());
    await flush();
    expect(reads).toBe(3);
    expect(c.getState().dropped).toBe(3);
  });

  it("a failed snapshot re-read keeps the room and records the error", async () => {
    const h = harness({ snapshots: [snapshot(), new TypeError("network"), snapshot()] });
    const c = h.make();
    await begin(c);
    h.last().raw("{broken");
    await flush();
    expect(c.getState().error).toBeInstanceOf(TypeError);
    expect(c.getState().connection).toBe("connecting");
  });
});

describe("session controller: gap cursor and pinned refusals", () => {
  it("while a gap is open, a dropped connection resumes from the gap-free prefix", async () => {
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve(snapshot()) : new Promise<TrialSnapshot>(() => undefined);
        },
      },
    });
    await begin(c);
    const b = new LogBuilder().ask({ releaseAfter: "rec-02" });
    const [q, , answer, , , card] = b.frames;
    for (const f of [q, answer, card]) h.last().send(f);
    h.last().fail();
    await h.clock.advance(250);
    expect(h.last().url).toContain(`after=${String(answer?.seq ?? -1)}`);
  });

  it("a card acknowledged invalid never shows, even when a later snapshot carries it", async () => {
    const b = new LogBuilder().ask({ releaseAfter: "rec-02", coach: "none" });
    const stale = frame("coach.card", b.seq + 1, 2, { turn_no: 1, card: cardFor(1, 2) });
    const resynced = snapshot({
      last_seq: b.seq + 1,
      exchanges_used: 1,
      turns: [{ turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 }],
      cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: b.seq + 1 }],
    });
    const h = harness({ snapshots: [snapshot(), resynced] });
    const c = h.make();
    await begin(c);
    for (const f of [...b.frames, stale]) h.last().send(f);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
    h.last().raw("{broken");
    await flush();
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(2);
    expect(trialView(c).cards).toEqual([]);
    expect(trialView(c).rejectedCards).toEqual([1]);
  });
});

describe("session controller: Codex round 5 regressions", () => {
  const turn1 = { turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 } as const;

  function releaseSession() {
    // question v1 (seq 1), answer v2 (seq 2), scheduled release v3 (seq 3)
    const b = new LogBuilder().ask({ releaseAfter: "rec-02", coach: "none" });
    const release = b.frames.find((f) => f.type === "evidence.released") as TrialFrame;
    const covered = snapshot({
      last_seq: release.seq ?? 0,
      exchanges_used: 1,
      turns: [turn1],
      released: [{ ...(release.data as never as object), transcript_version: 3, event_seq: release.seq ?? 0 } as never],
    });
    return { b, release, covered };
  }

  it.each([
    [3, true],
    [2, false],
  ] as const)("a release that fails validation holds a card read at %i until the snapshot covers it (shown: %s)", async (version, shown) => {
    const { b, release, covered } = releaseSession();
    const h = harness({ snapshots: [snapshot(), covered] });
    const c = h.make();
    await begin(c);
    const card = frame("coach.card", b.seq + 1, version, { turn_no: 1, card: cardFor(1, version) });
    for (const f of b.frames) h.last().send(f === release ? { ...f, data: { ...f.data, title: 7 } } : f);
    h.last().send(card);
    expect(trialView(c).cards).toEqual([]);
    await flush();
    expect(trialView(c).cards.length).toBe(shown ? 1 : 0);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: shown }]);
  });

  it("a streamed card the snapshot already showed is acknowledged when its frame arrives", async () => {
    const b = new LogBuilder().ask();
    const card = b.frames.at(-1) as TrialFrame;
    const covered = snapshot({ last_seq: card.seq ?? 0, exchanges_used: 1, turns: [turn1], cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: card.seq ?? 0 }] });
    const h = harness({ snapshots: [snapshot(), covered] });
    const c = h.make();
    await begin(c);
    for (const f of b.frames.slice(0, -1)) h.last().send(f);
    h.last().raw("{broken");
    await flush();
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([1]);
    expect(h.acks).toEqual([]);
    h.last().send(card);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: true }]);
  });

  it("a failed snapshot re-read is retried, and the retry covers the gap", async () => {
    const { b, release, covered } = releaseSession();
    const h = harness({ snapshots: [snapshot(), new TypeError("network"), covered] });
    const c = h.make();
    await begin(c);
    const card = frame("coach.card", b.seq + 1, 3, { turn_no: 1, card: cardFor(1, 3) });
    for (const f of b.frames) if (f !== release) h.last().send(f);
    h.last().send(card);
    await flush();
    expect(trialView(c).pendingCards).toEqual([1]);
    expect(c.getState().error).toBeInstanceOf(TypeError);
    await h.clock.advance(CATCH_UP_MS);
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([1]);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: true }]);
  });

  it("snapshot re-reads that keep failing stop after the bounded retries", async () => {
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve(snapshot()) : Promise.reject(new TypeError("down"));
        },
      },
    });
    await begin(c);
    h.last().raw("{broken");
    await flush();
    await h.clock.advance(60_000);
    expect(reads).toBe(1 + 1 + RESYNC_RETRIES);
    expect(c.getState().connection).toBe("connecting");
  });
});

describe("session controller: a second gap behind the first", () => {
  it("re-checks for a remaining gap after a snapshot re-read covered the first", async () => {
    const b = new LogBuilder().ask().ask();
    // turn 1: q1 a2 c3; turn 2: q4 a5 c6. Missing: 3 (card 1) and 5 (answer 2).
    const byseq = new Map(b.frames.filter((f) => f.seq !== null).map((f) => [f.seq, f] as const));
    const s3 = snapshot({ last_seq: 3, exchanges_used: 1, turns: [turn(1)], cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: 3 }] });
    const s5 = snapshot({ last_seq: 5, exchanges_used: 2, turns: [turn(1), { ...turn(2), answer_version: 4 }], cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: 3 }] });
    const h = harness({ snapshots: [snapshot(), s3, s5] });
    const c = h.make();
    await begin(c);
    for (const seq of [1, 2, 4, 6]) h.last().send(byseq.get(seq));
    await flush();
    await flush();
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(3);
    expect(trialView(c).contiguousSeq).toBe(6);
    expect(trialView(c).cards.map((x) => x.turn_no)).toEqual([1, 2]);
  });

  function turn(n: number) {
    return { turn_no: n, question: `Question ${String(n)}?`, source: "investigator", answer: `Answer ${String(n)}.`, partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 3 * n - 2 } as const;
  }
});

describe("session controller: lost frames outside practice text", () => {
  it("an assessment answer that fails validation is recovered from the snapshot", async () => {
    const b = new LogBuilder("assessment").ask();
    const answer = b.frames.find((f) => f.type === "subject.answer") as TrialFrame;
    const covered = snapshot({
      mode: "assessment",
      last_seq: answer.seq ?? 0,
      exchanges_used: 1,
      turns: [{ turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 }],
    });
    const h = harness({ snapshots: [snapshot({ mode: "assessment" }), covered] });
    const c = h.make();
    await begin(c);
    for (const f of b.frames) h.last().send(f === answer ? { ...f, data: { ...f.data, partial: "no" } } : f);
    expect(roomStatus(c.getState().trial)).toBe("subject_answering");
    await flush();
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
  });

  it("an assessment answer too broken to parse is recovered from the snapshot", async () => {
    const b = new LogBuilder("assessment").ask();
    const covered = snapshot({
      mode: "assessment",
      last_seq: 2,
      exchanges_used: 1,
      turns: [{ turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 }],
    });
    const h = harness({ snapshots: [snapshot({ mode: "assessment" }), covered] });
    const c = h.make();
    await begin(c);
    h.last().send(b.frames[0]);
    h.last().raw("{not json");
    await flush();
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
  });

  it("a voice trial's release that fails validation is recovered from the snapshot", async () => {
    const voice = voiceSnapshot();
    const release = new LogBuilder("practice", { seq: voice.last_seq }).release("rec-02");
    const covered = { ...voice, last_seq: release.seq ?? 0, released: [{ ...(release.data as never as object), transcript_version: release.transcript_version, event_seq: release.seq ?? 0 } as never] } as TrialSnapshot;
    const h = harness({ snapshots: [voice, covered] });
    const c = h.make();
    await begin(c);
    h.last().send({ ...release, data: { ...release.data, trigger: "later" } });
    await flush();
    expect(trialView(c).released.map((r) => r.record_id)).toEqual(["rec-02"]);
  });
});

describe("session controller: Codex round 7 regressions", () => {
  const turn1 = { turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 } as const;

  it.each([
    [2, false],
    [3, true],
  ] as const)("a snapshot covering a held card at %i keeps the release-before-card order the stream showed (shown: %s)", async (version, shown) => {
    const b = new LogBuilder().ask({ coach: "none" });
    b.release("rec-02");
    const [q, , answer, release] = b.frames;
    const card = frame("coach.card", b.seq + 1, version, { turn_no: 1, card: cardFor(1, version) });
    const covered = snapshot({
      last_seq: card.seq ?? 0,
      exchanges_used: 1,
      turns: [turn1],
      released: [{ ...((release as TrialFrame).data as never as object), transcript_version: 3, event_seq: (release as TrialFrame).seq ?? 0 } as never],
      cards: [{ turn_no: 1, card: cardFor(1, version), event_seq: card.seq ?? 0 }],
    });
    const h = harness({ snapshots: [snapshot(), covered] });
    const c = h.make();
    await begin(c);
    expect(q?.seq).toBe(1);
    for (const f of [answer, release, card]) h.last().send(f);
    await flush();
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(2);
    expect(trialView(c).cards.length).toBe(shown ? 1 : 0);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: shown }]);
  });

  it.each([
    ["no scope", (f: TrialFrame) => ({ ...f, scope_id: undefined, data: { ...f.data, partial: "x" } })],
    ["a numeric scope", (f: TrialFrame) => ({ ...f, scope_id: 5 })],
    ["an array", () => [1, 2]],
  ])("an assessment frame with %s is not taken as another trial's: the snapshot is re-read", async (_why, broken) => {
    const b = new LogBuilder("assessment").ask();
    const answer = b.frames.find((f) => f.type === "subject.answer") as TrialFrame;
    const covered = snapshot({ mode: "assessment", last_seq: answer.seq ?? 0, exchanges_used: 1, turns: [turn1] });
    const h = harness({ snapshots: [snapshot({ mode: "assessment" }), covered] });
    const c = h.make();
    await begin(c);
    h.last().send(b.frames[0]);
    h.last().send(broken(answer));
    await flush();
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
  });

  it.each([
    ["fails validation", (f: TrialFrame) => h0(f)],
    ["cannot be parsed", () => "{broken"],
  ])("a debrief.ready that %s is recovered through the snapshot and the debrief route", async (_why, broken) => {
    const b = new LogBuilder().ask().commit().debriefReady();
    const ready = b.frames.at(-1) as TrialFrame;
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: (ready.seq ?? 1) - 1 });
    const h = harness({ snapshots: [snapshot(), ended] });
    const c = h.make();
    await begin(c);
    for (const f of b.frames.slice(0, -1)) h.last().send(f);
    const payload = broken(ready);
    if (typeof payload === "string") h.last().raw(payload);
    else h.last().send(payload);
    await flush();
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
    expect(h.sources[0]?.closed).toBe(true);
  });

  it("a terminal re-read whose debrief is still scoring keeps the stream", async () => {
    const b = new LogBuilder().ask().commit();
    const h = harness({ snapshots: [snapshot(), snapshot({ status: "completed" })], debrief: { status: "scoring" } });
    const c = h.make();
    await begin(c);
    for (const f of b.frames) h.last().send(f);
    h.last().raw("{broken");
    await flush();
    await flush();
    expect(c.getState().debrief).toEqual({ status: "scoring" });
    expect(c.getState().connection).not.toBe("finished");
    expect(h.last().closed).toBe(false);
  });
});

function h0(f: TrialFrame): unknown {
  return { ...f, data: { session_id: 7 } };
}

describe("session controller: Codex round 8 regression", () => {
  const turn1 = { turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 } as const;

  it.each([
    [2, false],
    [3, true],
  ] as const)("a snapshot ending at a held card places its unseen release before the card (card at %i shown: %s)", async (version, shown) => {
    const b = new LogBuilder().ask({ coach: "none" });
    b.release("rec-02");
    const [q, , answer, release] = b.frames;
    const card = frame("coach.card", b.seq + 1, version, { turn_no: 1, card: cardFor(1, version) });
    const covered = snapshot({
      last_seq: card.seq ?? 0,
      exchanges_used: 1,
      turns: [turn1],
      released: [{ ...((release as TrialFrame).data as never as object), transcript_version: 3, event_seq: (release as TrialFrame).seq ?? 0 } as never],
      cards: [{ turn_no: 1, card: cardFor(1, version), event_seq: card.seq ?? 0 }],
    });
    const h = harness({ snapshots: [snapshot(), covered] });
    const c = h.make();
    await begin(c);
    for (const f of [q, answer]) h.last().send(f);
    h.last().send({ ...(release as TrialFrame), data: { ...(release as TrialFrame).data, title: 9 } });
    h.last().send(card);
    await flush();
    expect(trialView(c).cards.length).toBe(shown ? 1 : 0);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: shown }]);
  });

  it("a snapshot ending at a held card places an unseen later question before it: the card is stale", async () => {
    const b = new LogBuilder().ask({ coach: "none" });
    const [q, , answer] = b.frames;
    const card = frame("coach.card", 4, 2, { turn_no: 1, card: cardFor(1, 2) });
    const covered = snapshot({
      last_seq: 4,
      exchanges_used: 1,
      turns: [turn1, { turn_no: 2, question: "Two?", source: "investigator", answer: null, partial: false, committed_at: null, answer_version: null, question_seq: 3 }],
      cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: 4 }],
    });
    const h = harness({ snapshots: [snapshot(), covered] });
    const c = h.make();
    await begin(c);
    for (const f of [q, answer]) h.last().send(f);
    h.last().raw("{lost question 2");
    h.last().send(card);
    await flush();
    expect(trialView(c).cards).toEqual([]);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
  });
});

describe("session controller: Codex round 9 regressions", () => {
  const t = (n: number, v: number, q: number) =>
    ({ turn_no: n, question: `Question ${String(n)}?`, source: "investigator", answer: `Answer ${String(n)}.`, partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: v, question_seq: q }) as const;

  it("a refused card's skip marker survives the recovery snapshot and keeps proving an earlier card stale", async () => {
    const b = new LogBuilder().ask({ releaseAfter: "rec-02", coach: "none" });
    const release = b.frames.find((f) => f.type === "evidence.released") as TrialFrame;
    const stale = frame("coach.card", 4, 2, { turn_no: 1, card: cardFor(1, 2) });
    const turn2 = new LogBuilder("practice", { seq: 4, version: 3, turn: 1 }).ask();
    const [q5, , a6, , card7] = turn2.frames;
    const covered = snapshot({
      last_seq: 7,
      exchanges_used: 2,
      turns: [t(1, 2, 1), t(2, 5, 5)],
      released: [{ ...(release.data as never as object), transcript_version: 3, event_seq: release.seq ?? 0 } as never],
      cards: [
        { turn_no: 1, card: cardFor(1, 2), event_seq: 4 },
        { turn_no: 2, card: cardFor(2, 5), event_seq: 7 },
      ],
    });
    const h = harness({ snapshots: [snapshot(), covered] });
    const c = h.make();
    await begin(c);
    const [q1, , a2] = b.frames;
    for (const f of [q1, a2]) h.last().send(f);
    h.last().raw("{lost release");
    h.last().send(stale);
    for (const f of [q5, a6]) h.last().send(f);
    h.last().send({ ...(card7 as TrialFrame), data: { turn_no: 2, card: { ...cardFor(2, 5), candidate_id: "x" } } });
    await flush();
    expect(trialView(c).cards).toEqual([]);
    expect(h.acks).toEqual([
      { trial_id: TRIAL_ID, turn_no: 2, client_valid: false },
      { trial_id: TRIAL_ID, turn_no: 1, client_valid: false },
    ]);
  });

  it("a card frame that arrives after the recovery snapshot already covered it is re-judged by its seq", async () => {
    const b = new LogBuilder().ask({ releaseAfter: "rec-02", coach: "none" });
    const release = b.frames.find((f) => f.type === "evidence.released") as TrialFrame;
    const stale = frame("coach.card", 4, 2, { turn_no: 1, card: cardFor(1, 2) });
    const covered = snapshot({
      last_seq: 4,
      exchanges_used: 1,
      turns: [t(1, 2, 1)],
      released: [{ ...(release.data as never as object), transcript_version: 3, event_seq: release.seq ?? 0 } as never],
      cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: 4 }],
    });
    const h = harness({ snapshots: [snapshot(), covered] });
    const c = h.make();
    await begin(c);
    const [q1, , a2] = b.frames;
    for (const f of [q1, a2]) h.last().send(f);
    h.last().raw("{lost release");
    await flush();
    h.last().send(stale);
    await flush();
    expect(trialView(c).cards).toEqual([]);
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
  });
});

describe("session controller: overlapping finding submits", () => {
  it.each([
    ["the failure first", [1, 0] as const],
    ["the success first", [0, 1] as const],
  ])("a failed submit never takes the room out of finalizing while another is pending or succeeded (%s)", async (_why, order) => {
    const gates: { resolve: (v: { last_seq: number }) => void; reject: (e: Error) => void }[] = [];
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        commitFinding: () =>
          new Promise((resolve, reject) => {
            gates.push({ resolve, reject });
          }),
      },
    });
    await begin(c);
    const body = (fixture("finding-commit") as { finding: never }).finding;
    const ok = c.submitFinding(body);
    const bad = c.submitFinding({ ...(body as object), rationale: "Another." } as never);
    for (const i of order) {
      if (i === 0) gates[0]?.resolve({ last_seq: 0 });
      else gates[1]?.reject(new ApiError(409, "turn_in_progress", "/x"));
      await flush();
    }
    await ok;
    await expect(bad).rejects.toBeInstanceOf(ApiError);
    expect(roomStatus(c.getState().trial)).toBe("finalizing");
  });

  it("the last of several failed submits takes the room back out of finalizing", async () => {
    const h = harness();
    const c = h.make({ api: { ...h.api, commitFinding: () => Promise.reject(new ApiError(409, "turn_in_progress", "/x")) } });
    await begin(c);
    const body = (fixture("finding-commit") as { finding: never }).finding;
    const a = c.submitFinding(body);
    const b = c.submitFinding({ ...(body as object), rationale: "Another." } as never);
    expect(roomStatus(c.getState().trial)).toBe("finalizing");
    await expect(a).rejects.toBeInstanceOf(ApiError);
    await expect(b).rejects.toBeInstanceOf(ApiError);
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
  });
});

describe("session controller: a malformed POST answer", () => {
  it("keeps the turn's request and key, so the retry resumes it", async () => {
    const sent: TurnSubmit[] = [];
    let first = true;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        submitTurn: (_id, body) => {
          sent.push(body);
          if (first) {
            first = false;
            return Promise.reject(new ContractError("/api/trials/x/turns", "a POST answer with last_seq"));
          }
          return Promise.resolve({ last_seq: 0 });
        },
      },
    });
    await begin(c);
    await expect(c.submitTurn("Why?")).rejects.toBeInstanceOf(ContractError);
    for (const f of new LogBuilder().ask().frames.slice(0, 1)) h.last().send(f);
    await c.submitTurn("Why?");
    expect(sent[1]).toEqual(sent[0]);
  });
});

describe("session controller: cold gate regressions", () => {
  it("a finding refused with 409 reloads and folds the room state before the caller confirms again (S6 4.6)", async () => {
    const reopened = snapshot({
      last_seq: 1,
      turns: [{ turn_no: 1, question: "Q?", source: "investigator", answer: null, partial: false, committed_at: null, answer_version: null, question_seq: 1 }],
    });
    const h = harness({ snapshots: [snapshot(), reopened] });
    const c = h.make({ api: { ...h.api, commitFinding: () => Promise.reject(new ApiError(409, "turn_in_progress", "/x")) } });
    await begin(c);
    const body = (fixture("finding-commit") as { finding: never }).finding;
    const error = await c.submitFinding(body).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(2);
    // the reload is folded before the caller hears of the refusal: the open turn shows
    expect(roomStatus(c.getState().trial)).toBe("subject_answering");
  });

  it("a finding refused otherwise does not reload", async () => {
    const h = harness();
    const c = h.make({ api: { ...h.api, commitFinding: () => Promise.reject(new ApiError(422, "bad_citation", "/x")) } });
    await begin(c);
    await expect(c.submitFinding((fixture("finding-commit") as { finding: never }).finding)).rejects.toBeInstanceOf(ApiError);
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(1);
  });

  it("a 409 reload that fails keeps the error and still rethrows the refusal", async () => {
    const h = harness({ snapshots: [snapshot(), new TypeError("down"), snapshot()] });
    const c = h.make({ api: { ...h.api, commitFinding: () => Promise.reject(new ApiError(409, "turn_in_progress", "/x")) } });
    await begin(c);
    await expect(c.submitFinding((fixture("finding-commit") as { finding: never }).finding)).rejects.toBeInstanceOf(ApiError);
    expect(c.getState().error).toBeInstanceOf(TypeError);
  });

  it("a bootstrap that failed can be started again, and the error clears", async () => {
    const h = harness({ snapshots: [new TypeError("offline"), snapshot()] });
    const c = h.make();
    await begin(c);
    expect(c.getState().connection).toBe("failed");
    await begin(c);
    expect(c.getState().connection).toBe("connecting");
    expect(c.getState().error).toBeNull();
    expect(h.sources).toHaveLength(1);
    await begin(c);
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(2);
  });
});

describe("session controller: overlapping snapshot reads", () => {
  it("a 409 reload that settles after the terminal recovery does not undo it", async () => {
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 6 });
    let late: (s: TrialSnapshot) => void = () => undefined;
    let reads = 0;
    const h = harness({ tickets: ["tk1", new ApiError(409, "stream_closed", "/x")] });
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return new Promise<TrialSnapshot>((r) => (late = r));
          return Promise.resolve(ended);
        },
        commitFinding: () => Promise.reject(new ApiError(409, "turn_in_progress", "/x")),
      },
    });
    await begin(c);
    const refused = c.submitFinding((fixture("finding-commit") as { finding: never }).finding).catch((e: unknown) => e);
    await flush();
    h.last().fail();
    await h.clock.advance(250);
    await flush();
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
    late(snapshot({ last_seq: 3 }));
    expect(await refused).toBeInstanceOf(ApiError);
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
    expect(roomStatus(c.getState().trial)).toBe("ended");
  });
});

describe("session controller: a card claiming a future version", () => {
  it("is refused and acknowledged invalid once everything below it arrived, and the next question keeps the real version", async () => {
    const h = harness();
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask({ coach: "none" });
    for (const f of b.frames) h.last().send(f);
    h.last().send(frame("coach.card", b.seq + 1, b.version + 1, { turn_no: 1, card: cardFor(1, b.version + 1) }));
    expect(h.acks).toEqual([{ trial_id: TRIAL_ID, turn_no: 1, client_valid: false }]);
    expect(trialView(c).cards).toEqual([]);
    await c.submitTurn("Next?");
    expect(h.turns[0]?.expected_version).toBe(b.version);
  });
});

describe("session controller: nothing new after dispose", () => {
  it("a turn or a debrief answered after dispose schedules no timer and sends no request", async () => {
    let turn: (v: { last_seq: number }) => void = () => undefined;
    let debrief: (v: never) => void = () => undefined;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        submitTurn: () => new Promise((r) => (turn = r)),
        requestDebrief: () => new Promise((r) => (debrief = r)),
      },
    });
    await begin(c);
    const t = c.submitTurn("Why?");
    const d = c.requestDebrief();
    c.dispose();
    const before = h.log.length;
    turn({ last_seq: 50 });
    debrief(fixture("debrief:scored") as never);
    await t;
    await d;
    await flush();
    expect(h.clock.pending()).toBe(0);
    expect(h.log.length).toBe(before);
    expect(c.getState().connection).toBe("closed");
  });
});

describe("session controller: an uncertain request stays uncertain", () => {
  it("lost answer, then a 403 on the retry, then a retry: the same request and key every time", async () => {
    const sent: TurnSubmit[] = [];
    const answers: (Error | { last_seq: number })[] = [new TypeError("lost"), new ApiError(403, "csrf", "/x"), { last_seq: 0 }];
    let n = 0;
    const h = harness();
    const c = h.make({
      newKey: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`,
      api: {
        ...h.api,
        submitTurn: (_id, body) => {
          sent.push(body);
          const a = answers.shift();
          return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? { last_seq: 0 });
        },
      },
    });
    await begin(c);
    await expect(c.submitTurn("Why?")).rejects.toBeInstanceOf(TypeError);
    for (const f of new LogBuilder().ask().frames) h.last().send(f);
    await expect(c.submitTurn("Why?")).rejects.toBeInstanceOf(ApiError);
    await c.submitTurn("Why?");
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[2]).toEqual(sent[0]);
  });

  it("an uncertain finding keeps its key through a 403, and a 422 on the same body ends it", async () => {
    const keys: string[] = [];
    const answers: (Error | { last_seq: number })[] = [new TypeError("lost"), new ApiError(403, "csrf", "/x"), new ApiError(422, "bad", "/x"), { last_seq: 0 }];
    let n = 0;
    const h = harness();
    const c = h.make({
      newKey: () => `k${String((n += 1))}`,
      api: {
        ...h.api,
        commitFinding: (_id, body) => {
          keys.push(body.idem_key);
          const a = answers.shift();
          return a instanceof Error ? Promise.reject(a) : Promise.resolve(a ?? { last_seq: 0 });
        },
      },
    });
    await begin(c);
    const body = (fixture("finding-commit") as { finding: never }).finding;
    for (let i = 0; i < 3; i += 1) await c.submitFinding(body).catch(() => undefined);
    await c.submitFinding(body);
    expect(keys).toEqual(["k1", "k1", "k1", "k2"]);
  });
});

describe("session controller: identical actions in flight share one request", () => {
  it("a second identical turn, evidence request or finding while the first is in flight sends nothing new", async () => {
    let calls = 0;
    const gates: (() => void)[] = [];
    const wait = <T,>(v: T) =>
      new Promise<T>((r) => {
        calls += 1;
        gates.push(() => {
          r(v);
        });
      });
    const result: EvidenceResult = { released: [], already_released: [], denied: [], transcript_version: 0 };
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        submitTurn: () => wait({ last_seq: 0 }),
        requestEvidence: () => wait(result),
        commitFinding: () => wait({ last_seq: 0 }),
      },
    });
    await begin(c);
    const body = (fixture("finding-commit") as { finding: never }).finding;
    const all = [c.submitTurn("Why?"), c.submitTurn("Why?"), c.requestEvidence(["rec-02"]), c.requestEvidence(["rec-02"]), c.submitFinding(body), c.submitFinding(body)];
    expect(calls).toBe(3);
    for (const g of gates) g();
    await Promise.all(all);
    // settled: the next identical action is a new request
    void c.submitTurn("Why?");
    expect(calls).toBe(4);
  });
});

describe("session controller: dispose during terminal recovery", () => {
  it("during a retry wait: the waiting debrief request settles and nothing more is read", async () => {
    const h = harness({ snapshots: [snapshot(), new TypeError("down")] });
    const c = h.make({ api: { ...h.api, requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never) } });
    await begin(c);
    const requested = c.requestDebrief();
    await flush();
    const reads = h.log.filter((l) => l.startsWith("snapshot")).length;
    c.dispose();
    await requested;
    await h.clock.advance(60_000);
    expect(h.log.filter((l) => l.startsWith("snapshot")).length).toBe(reads);
  });

  it("during the terminal snapshot read: no debrief read starts after it settles", async () => {
    let answer: (s: TrialSnapshot) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve(snapshot()) : new Promise<TrialSnapshot>((r) => (answer = r));
        },
        // an answer that is not the published document, so the end still needs the debrief read
        requestDebrief: () => Promise.resolve({ status: "scoring" } as never),
      },
    });
    await begin(c);
    const requested = c.requestDebrief();
    await flush();
    c.dispose();
    answer(snapshot({ status: "completed" }));
    await requested;
    await flush();
    expect(h.log.filter((l) => l.startsWith("read debrief"))).toEqual([]);
  });
});

describe("session controller: a publication supersedes an older debrief read", () => {
  it.each([
    ["fails for good", "reject"],
    ["never settles", "hang"],
  ] as const)("an ended visit whose GET %s still finishes once the debrief POST returns the document", async (_why, mode) => {
    const debrief = fixture("debrief:scored");
    const h = harness({ snapshots: [snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH })] });
    const c = h.make({
      api: {
        ...h.api,
        readDebrief: () => (mode === "reject" ? Promise.reject(new TypeError("down")) : new Promise<DebriefRead>(() => undefined)),
        requestDebrief: () => Promise.resolve(debrief as never),
      },
    });
    await begin(c);
    await c.requestDebrief();
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(debrief);
    await h.clock.advance(60_000);
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(debrief);
    expect(c.getState().error).toBeNull();
  });
});

describe("session controller: recovery reads never undo a loaded end state", () => {
  it("after end_failed, reconnect() reads only what is missing, and a later failure cannot undo the publication", async () => {
    let debriefReads = 0;
    let snapshotReads = 0;
    const h = harness({ snapshots: [snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH })] });
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          snapshotReads += 1;
          return snapshotReads === 1 ? Promise.resolve(snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH })) : Promise.reject(new TypeError("down"));
        },
        readDebrief: () => {
          debriefReads += 1;
          return Promise.reject(new TypeError("down"));
        },
        requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never),
      },
    });
    await begin(c);
    await h.clock.advance(60_000);
    expect(c.getState().connection).toBe("end_failed");
    c.reconnect();
    await flush();
    await c.requestDebrief();
    expect(c.getState().connection).toBe("finished");
    await h.clock.advance(60_000);
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
    expect(snapshotReads).toBe(1);
    expect(debriefReads).toBeLessThanOrEqual(2 + RESYNC_RETRIES);
  });
});

describe("session controller: the debrief must be published to finish", () => {
  it("an ended visit whose debrief is still scoring waits in `scoring`; reconnect() reads it again and finishes", async () => {
    let ready = false;
    const h = harness({
      snapshots: [snapshot({ status: "completed" })],
      debrief: () => (ready ? (fixture("debrief:scored") as DebriefRead) : { status: "scoring" }),
    });
    const c = h.make();
    await begin(c);
    expect(c.getState().connection).toBe("scoring");
    expect(c.getState().debrief).toEqual({ status: "scoring" });
    ready = true;
    c.reconnect();
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
    expect(h.sources).toHaveLength(0);
  });

  it("a terminal snapshot installed by another read while this one fails: the debrief is still read", async () => {
    let fail: (e: Error) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return new Promise<TrialSnapshot>((_r, j) => (fail = j));
          return Promise.resolve(snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 5 }));
        },
        commitFinding: () => Promise.reject(new ApiError(409, "turn_in_progress", "/x")),
      },
    });
    await begin(c);
    h.last().send(frame("debrief.ready", 1, 0, { session_id: SESSION_ID }));
    await flush();
    expect(c.getState().connection).toBe("ending");
    await c.submitFinding((fixture("finding-commit") as { finding: never }).finding).catch(() => undefined);
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
    fail(new TypeError("down"));
    await flush();
    expect(h.log.filter((l) => l.startsWith("read debrief"))).toHaveLength(1);
    expect(c.getState().connection).toBe("finished");
  });
});

describe("session controller: dispose between a superseded snapshot read and the debrief", () => {
  it("starts no debrief read after dispose", async () => {
    let fail: (e: Error) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return new Promise<TrialSnapshot>((_r, j) => (fail = j));
          return Promise.resolve(snapshot({ status: "completed", last_seq: 5 }));
        },
        commitFinding: () => Promise.reject(new ApiError(409, "turn_in_progress", "/x")),
      },
    });
    await begin(c);
    h.last().send(frame("debrief.ready", 1, 0, { session_id: SESSION_ID }));
    await flush();
    await c.submitFinding((fixture("finding-commit") as { finding: never }).finding).catch(() => undefined);
    c.dispose();
    fail(new TypeError("down"));
    await flush();
    expect(h.log.filter((l) => l.startsWith("read debrief"))).toEqual([]);
  });
});

describe("session controller: Codex round 24 regressions", () => {
  it("a gap whose only frame above it was refused still makes the room re-read the snapshot", async () => {
    const covered = snapshot({
      last_seq: 3,
      exchanges_used: 1,
      turns: [{ turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 }],
    });
    const h = harness({ snapshots: [snapshot(), covered] });
    const c = h.make();
    await begin(c);
    const b = new LogBuilder().ask();
    const [q, , , , card] = b.frames;
    h.last().send(q);
    h.last().send({ ...(card as TrialFrame), data: { turn_no: 1, card: { ...cardFor(1, 2), candidate_id: "x" } } });
    await flush();
    expect(h.log.filter((l) => l.startsWith("snapshot"))).toHaveLength(2);
    expect(roomStatus(c.getState().trial)).toBe("awaiting_question");
  });

  it("a lost debrief.ready: the debrief read after the terminal re-read is retried, and finishes once published", async () => {
    let debriefReads = 0;
    const b = new LogBuilder().ask().commit();
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: b.seq + 1 });
    const h = harness({
      snapshots: [snapshot(), ended],
      debrief: () => {
        debriefReads += 1;
        return debriefReads === 1 ? new TypeError("blip") : (fixture("debrief:scored") as DebriefRead);
      },
    });
    const c = h.make();
    await begin(c);
    for (const f of b.frames) h.last().send(f);
    h.last().raw("{lost debrief.ready");
    await flush();
    await h.clock.advance(CATCH_UP_MS);
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
  });

  it("when those debrief reads keep failing, the stream stays and reconnect() reads the debrief again", async () => {
    let healthy = false;
    const b = new LogBuilder().ask().commit();
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: b.seq + 1 });
    const h = harness({
      snapshots: [snapshot(), ended],
      debrief: () => (healthy ? (fixture("debrief:scored") as DebriefRead) : new TypeError("down")),
    });
    const c = h.make();
    await begin(c);
    for (const f of b.frames) h.last().send(f);
    h.last().raw("{lost debrief.ready");
    await flush();
    await h.clock.advance(60_000);
    expect(c.getState().debrief).toBeNull();
    expect(h.last().closed).toBe(false);
    healthy = true;
    c.reconnect();
    await flush();
    expect(c.getState().connection).toBe("finished");
  });
});

describe("session controller: the end state finishes whoever loads it", () => {
  it("a published GET started by a re-read finishes the room while a later GET still hangs", async () => {
    const gets: ((d: DebriefRead) => void)[] = [];
    const b = new LogBuilder().ask().commit();
    const ended = snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: b.seq });
    const h = harness({ snapshots: [snapshot(), ended] });
    const c = h.make({ api: { ...h.api, readDebrief: () => new Promise<DebriefRead>((r) => gets.push(r)) } });
    await begin(c);
    for (const f of b.frames) h.last().send(f);
    h.last().raw("{lost frame");
    await flush();
    expect(gets).toHaveLength(1);
    h.last().send(frame("debrief.ready", b.seq + 1, b.version, { session_id: SESSION_ID }));
    await flush();
    expect(gets).toHaveLength(2);
    gets[0]?.(fixture("debrief:scored") as DebriefRead);
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
  });
});

describe("session controller: a terminal snapshot from any read completes a published session", () => {
  it("the finding-409 reload installing the terminal snapshot finishes it while the completion read still hangs", async () => {
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return new Promise<TrialSnapshot>(() => undefined);
          return Promise.resolve(snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 5 }));
        },
        requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never),
        commitFinding: () => Promise.reject(new ApiError(409, "turn_in_progress", "/x")),
      },
    });
    await begin(c);
    void c.requestDebrief();
    await flush();
    expect(c.getState().connection).toBe("ending");
    await c.submitFinding((fixture("finding-commit") as { finding: never }).finding).catch(() => undefined);
    expect(c.getState().connection).toBe("finished");
    expect(trialView(c).commitmentHash).toBe(COMMITMENT_HASH);
  });
});

describe("session controller: no side effect after dispose", () => {
  it("a ticket answered 409 after dispose starts no recovery read", async () => {
    let answer: (e: Error) => void = () => undefined;
    const h = harness();
    const c = h.make({ api: { ...h.api, mintStreamTicket: () => new Promise<string>((_r, j) => (answer = j)) } });
    await c.start();
    c.dispose();
    const before = h.log.length;
    answer(new ApiError(409, "stream_closed", "/x"));
    await flush();
    await h.clock.advance(60_000);
    expect(h.log.length).toBe(before);
  });

  it("a completion snapshot that settles after dispose posts no acknowledgement and no report", async () => {
    let answer: (s: TrialSnapshot) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve(snapshot()) : new Promise<TrialSnapshot>((r) => (answer = r));
        },
      },
    });
    await begin(c);
    const b = new LogBuilder().ask();
    const [q, , , , card] = b.frames;
    // the answer (seq 2) is missing: the card (seq 3) waits above the gap; debrief.ready (seq 4) starts the completion
    h.last().send(q);
    h.last().send(card);
    h.last().send(frame("debrief.ready", 4, b.version, { session_id: SESSION_ID }));
    await flush();
    expect(h.acks).toEqual([]);
    c.dispose();
    answer(
      snapshot({
        status: "completed",
        last_seq: 4,
        exchanges_used: 1,
        turns: [{ turn_no: 1, question: "Question 1?", source: "investigator", answer: "Answer 1.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2, question_seq: 1 }],
        cards: [{ turn_no: 1, card: cardFor(1, 2), event_seq: 3 }],
      }),
    );
    await flush();
    expect(h.acks).toEqual([]);
    expect(h.log.filter((l) => l.startsWith("read debrief"))).toEqual([]);
  });

});

describe("session controller: re-reads and the end", () => {
  it("a re-read started before the end still installs its terminal snapshot, so the published debrief finishes the room", async () => {
    let first: (s: TrialSnapshot) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return new Promise<TrialSnapshot>((r) => (first = r));
          return new Promise<TrialSnapshot>(() => undefined);
        },
        requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never),
      },
    });
    await begin(c);
    h.last().raw("{lost frame");
    await flush();
    void c.requestDebrief();
    await flush();
    expect(c.getState().connection).toBe("ending");
    first(snapshot({ status: "completed", commitment_hash: COMMITMENT_HASH, last_seq: 4 }));
    await flush();
    expect(c.getState().connection).toBe("finished");
  });

  it("no re-read starts after the room finished, and an old failure does not come back as the error", async () => {
    let reads = 0;
    let fail: (e: Error) => void = () => undefined;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return new Promise<TrialSnapshot>((_r, j) => (fail = j));
          return Promise.resolve(snapshot({ status: "completed", last_seq: 4 }));
        },
        requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never),
      },
    });
    await begin(c);
    h.last().raw("{lost frame");
    await flush();
    await c.requestDebrief();
    expect(c.getState().connection).toBe("finished");
    fail(new TypeError("obsolete"));
    await flush();
    expect(c.getState().error).toBeNull();
    const readsAtEnd = reads;
    await h.clock.advance(60_000);
    expect(reads).toBe(readsAtEnd);
    h.last().raw("{another lost frame");
    expect(reads).toBe(readsAtEnd);
  });

});

describe("session controller: a re-read retry due after the end", () => {
  it("does not read again", async () => {
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return Promise.reject(new TypeError("blip"));
          return Promise.resolve(snapshot({ status: "completed", last_seq: 4 }));
        },
        requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never),
      },
    });
    await begin(c);
    h.last().raw("{lost frame");
    await flush();
    await c.requestDebrief();
    expect(c.getState().connection).toBe("finished");
    const readsAtEnd = reads;
    await h.clock.advance(60_000);
    expect(reads).toBe(readsAtEnd);
  });
});

describe("session controller: Codex round 28 regressions", () => {
  it("a re-read settling with a terminal snapshot after dispose starts no debrief read", async () => {
    let answer: (s: TrialSnapshot) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve(snapshot()) : new Promise<TrialSnapshot>((r) => (answer = r));
        },
      },
    });
    await begin(c);
    h.last().raw("{lost frame");
    await flush();
    c.dispose();
    answer(snapshot({ status: "completed", last_seq: 4 }));
    await flush();
    expect(h.log.filter((l) => l.startsWith("read debrief"))).toEqual([]);
  });

  it("a finding-409 reload failing after the room finished leaves no obsolete error", async () => {
    let fail: (e: Error) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return new Promise<TrialSnapshot>((_r, j) => (fail = j));
          return Promise.resolve(snapshot({ status: "completed", last_seq: 4 }));
        },
        commitFinding: () => Promise.reject(new ApiError(409, "turn_in_progress", "/x")),
        requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never),
      },
    });
    await begin(c);
    const refused = c.submitFinding((fixture("finding-commit") as { finding: never }).finding).catch(() => undefined);
    await flush();
    await c.requestDebrief();
    expect(c.getState().connection).toBe("finished");
    fail(new TypeError("obsolete"));
    await refused;
    expect(c.getState().error).toBeNull();
  });
});

describe("session controller: a debrief request settles when the end state is loaded", () => {
  it("even while an obsolete completion read never settles", async () => {
    let resyncAnswer: (s: TrialSnapshot) => void = () => undefined;
    let reads = 0;
    const h = harness();
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(snapshot());
          if (reads === 2) return new Promise<TrialSnapshot>((r) => (resyncAnswer = r));
          return new Promise<TrialSnapshot>(() => undefined);
        },
        requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never),
      },
    });
    await begin(c);
    h.last().raw("{lost frame");
    await flush();
    let settled = false;
    const requested = c.requestDebrief().then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    resyncAnswer(snapshot({ status: "completed", last_seq: 4 }));
    await requested;
    expect(settled).toBe(true);
    expect(c.getState().connection).toBe("finished");
  });

  it("and on dispose", async () => {
    const h = harness();
    let reads = 0;
    const c = h.make({
      api: {
        ...h.api,
        trialSnapshot: () => {
          reads += 1;
          return reads === 1 ? Promise.resolve(snapshot()) : new Promise<TrialSnapshot>(() => undefined);
        },
        requestDebrief: () => Promise.resolve(fixture("debrief:scored") as never),
      },
    });
    await begin(c);
    const requested = c.requestDebrief();
    await flush();
    c.dispose();
    await requested;
  });
});
