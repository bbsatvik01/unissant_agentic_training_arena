import { describe, expect, it } from "vitest";

import type { ArenaApi, ContractViolationReport } from "../api/arena";
import { ApiError, ContractError } from "../api/client";
import type { CardAck, DebriefRead, TrialFrame, TrialSnapshot, TurnSubmit } from "../contracts/generated/types";
import type { EventSourceLike } from "../sse/ticketed-stream";
import { fixture } from "../../test/wire-fixtures";
import { COMMITMENT_HASH, LogBuilder, SESSION_ID, TRIAL_ID, cardFor, frame, snapshot, voiceSnapshot } from "../../test/trial-log";
import { CATCH_UP_MS, HIDDEN_CLOSE_MS, createSessionController, documentVisibility, type SessionControllerOptions } from "./sessionController";
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
      return Promise.resolve({ last_seq: null });
    },
    requestEvidence: () => Promise.reject(new Error("set per test")),
    commitFinding: () => Promise.resolve({ last_seq: null }),
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

  it("an ended session whose debrief cannot be read still finishes, with the error kept", async () => {
    const h = harness({ snapshots: [snapshot({ status: "infra_failed" })], debrief: new Error("down") });
    const c = h.make();
    await begin(c);
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().debrief).toBeNull();
    expect(c.getState().error).toBeInstanceOf(Error);
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

  it("a 409 whose snapshot reload fails still finishes, reads the debrief and keeps the error", async () => {
    const h = harness({
      snapshots: [snapshot(), new TypeError("network")],
      tickets: [new ApiError(409, "stream_closed", "/x")],
    });
    const c = h.make();
    await begin(c);
    await flush();
    expect(c.getState().connection).toBe("finished");
    expect(c.getState().error).toBeInstanceOf(TypeError);
    expect(c.getState().debrief).toEqual(fixture("debrief:scored"));
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
    const caughtUp = h.make({ api: { ...h.api, requestEvidence: () => Promise.resolve({ ...result, transcript_version: 2 }) } });
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
            { turn_no: 1, question: "Q?", source: "investigator", answer: "A.", partial: false, committed_at: "2026-10-20T15:04:05.123Z", answer_version: 2 },
          ],
          cards: [{ turn_no: 1, card: cardFor(1, 2) }],
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
