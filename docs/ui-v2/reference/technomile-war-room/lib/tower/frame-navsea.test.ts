/**
 * The Bid Tower over the recorded NAVSEA SSG run (eb3c3363): the tower model and its frame at the moments the run
 * went through (before it began, parked at H1, the lift taking the researchers down, the archive at work, the
 * notary's stamps, the role-play's capsules, the board walking in, the decision), on the exact and the replay clock.
 */
import { describe, expect, it } from "vitest";

import { FLIGHT_MS, STAMP_MS, type Beat } from "../office";
import { navseaTower } from "../__fixtures__/tower-runs";

import { ALARM_MS, JAM_MS, JOIN_MS, legAt, MAX_CAPSULES, planRiders, POPUP_MS, stageRoom, towerFrame, WAIT_DX, type RiderPlan } from "./frame";
import { X } from "./layout";
import { cutPath, tubePath, walkMs } from "./route";
import { APPROVED_SIGN_MS, laneTrips, type LaneTrip } from "./world";

function must<T>(v: T | null | undefined, what = "value"): T {
  if (v === null || v === undefined) throw new Error(`missing ${what}`);
  return v;
}

const run = navseaTower();
const { model, plan, layout, sched, raw, inputs } = run;
const LANES = ["LEIDOS, INC.", "MANTECH ADVANCED SYSTEMS INTERNATIONAL, INC.", "AMERICAN SYSTEMS CORPORATION", "DYNAMIC ANIMATION SYSTEMS, INC.", "NORTHROP GRUMMAN SYSTEMS CORPORATION"];
const stageAt = (stage: string, edge: "started" | "finished") => must(sched.stages.find((s) => s.stage === stage && s.edge === edge), `${stage} ${edge}`).at;
const sends = sched.beats.filter((b): b is Extract<Beat, { kind: "send" }> => b.kind === "send");

function legsInOrder(r: RiderPlan): boolean {
  return r.legs.every((l, i) => l.end > l.start && (i === 0 || l.start >= (r.legs[i - 1]?.start ?? -Infinity)));
}

describe("the NAVSEA tower model", () => {
  it("draws the five rivals on their own floors in lane order, with one vacant floor in a six-floor building", () => {
    expect(plan.pods.map((p) => p.key)).toEqual(LANES);
    expect(layout.rivalRows.map((r) => layout.rows[r]?.pod ?? null)).toEqual([...LANES, null]);
    expect(layout.overflow).toEqual([]);
    expect(model.origin).toBe(run.clock.at(run.bounds.start));
  });

  it("sends every researcher down when the plan is approved and brings each back up when its own lane ends", () => {
    expect(model.trips.map((t) => t.lane).sort()).toEqual([...LANES].sort());
    for (const trip of model.trips) {
      expect(trip.down).toBe(model.gates.h1.approved);
      expect(trip.up).toBeGreaterThan(trip.down);
      expect(trip.carries).toBe(true);
      expect(trip.slot).toBe(LANES.indexOf(trip.lane));
    }
    // the lane with the last fetch is the last back upstairs, and none returns before its last fetch
    for (const [lane, list] of Object.entries(model.fetches)) {
      const trip = must(model.trips.find((t) => t.lane === lane));
      expect(trip.up).toBeGreaterThanOrEqual(must(list.at(-1)).at);
    }
  });

  it("gathers the five researchers into one ride down, floor by floor, then returns each alone", () => {
    const [down, ...rest] = model.lift.rides;
    const first = must(down);
    expect(first.riders).toHaveLength(5);
    expect(first.start).toBe(model.gates.h1.approved);
    // set off from the ground floor, collect top to bottom, drop at B1
    expect(first.stops.map((s) => s.row)).toEqual([layout.ground, ...layout.rivalRows.slice(0, 5), layout.basement]);
    for (const r of first.riders) expect(first.alight[r]).toBeGreaterThan(must(first.board[r]));
    // one ride back up per lane, in the order the lanes ended, then the board's evaluators up to the roof
    const ups = rest.slice(0, 5);
    expect(ups.every((r) => r.riders.length === 1 && r.stops.at(-1)?.row !== layout.basement)).toBe(true);
    const board = must(rest.at(-1));
    expect(board.riders.map((r) => r.split("#")[0])).toEqual(["board:0", "board:1", "board:2"]);
    expect(board.stops.at(-1)?.row).toBe(layout.roof);
    // rides never overlap: the cabin is one cabin
    model.lift.rides.forEach((r, i) => i === 0 || expect(r.start).toBeGreaterThanOrEqual(must(model.lift.rides[i - 1]).end));
  });

  it("gives each researcher a walk, a wait, the cabin, a walk and a stay at its carrel, then the way back with printouts", () => {
    for (const lane of LANES) {
      const r = must(model.riders[`${lane}:lane`]);
      expect(legsInOrder(r)).toBe(true);
      expect(r.appear).toBeNull();
      const kinds = r.legs.map((l) => l.kind);
      expect(kinds.slice(0, 5)).toEqual(["walk", "wait", "cabin", "walk", "stay"]);
      expect(kinds.at(-1)).toBe("walk");
      const stay = must(r.legs.find((l) => l.kind === "stay"));
      expect(stay.carrel).toBe(true);
      expect(stay.from).toEqual({ x: must(layout.carrels[LANES.indexOf(lane)]).x, y: must(layout.rows[layout.basement]).floor });
      // down empty-handed, back with the pages
      expect(r.legs.slice(0, 5).every((l) => !l.carrying)).toBe(true);
      expect(must(r.legs.at(-1)).carrying).toBe(true);
      // the waiting spot is beside the landing door
      expect(must(r.legs.find((l) => l.kind === "wait")).from.x).toBe(X.door + WAIT_DX);
    }
  });

  it("walks the board's evaluators in at the street doors when their cards are recorded and seats them at the table", () => {
    for (const id of ["board:0", "board:1", "board:2"]) {
      const r = must(model.riders[id]);
      expect(r.appear).toBe(sched.presentFrom[id]);
      expect(must(r.legs[0]).from.x).toBe(layout.doors.x);
      expect(r.seated).toBe(must(r.legs.at(-1)).end);
      expect(must(r.legs.at(-1)).to.y).toBe(must(layout.rows[layout.roof]).floor);
    }
  });

  it("reads the two gates and the decision from the recorded parks and approvals", () => {
    const h1 = raw.approvals.find((a) => a.gate === "h1");
    const h2 = raw.approvals.find((a) => a.gate === "h2");
    expect(model.gates.h1.approvedTs).toBe(Date.parse(must(h1).createdAt));
    expect(model.gates.h2.approvedTs).toBe(Date.parse(must(h2).createdAt));
    // H1 is the first park at the plan review; H2 the last park at the decision
    expect(model.gates.h1.parkTs).toBe(must(inputs.history?.parks[0]).ts);
    expect(model.gates.h2.parkTs).toBe(must(inputs.history?.parks.at(-1)).ts);
    expect(model.gates.h2.approved).toBe(model.end);
  });

  it("stamps all 278 recorded verdicts in beats, and pins the five capture-lead interviews to their rivals", () => {
    expect(model.verdicts).toHaveLength(inputs.tower.verdicts.length);
    expect(model.verdicts).toHaveLength(278);
    expect(model.beats.reduce((n, b) => n + b.total, 0)).toBe(278);
    expect(model.pins.map((p) => p.pod).sort()).toEqual([...LANES].sort());
    expect(model.pins.every((p) => /^\d+ answers?, \d+ withheld$/.test(p.text))).toBe(true);
    expect(model.pins.map((p) => p.at)).toEqual([...model.pins.map((p) => p.at)].sort((a, b) => a - b));
    const ratings = Object.values(model.messages).filter((m) => m.kind === "rating");
    expect(ratings).toHaveLength(3);
    expect(ratings.every((m) => m.rated === LANES.length)).toBe(true);
  });

  it("opens every rival floor at the first lane activity, and lists each lane's fetches in time order", () => {
    for (const lane of LANES) {
      expect(model.floorFrom[lane]).toBe(run.clock.at(must(inputs.tower.laneSeen[lane]).ts));
      const list = must(model.fetches[lane]);
      expect(list.map((f) => f.at)).toEqual([...list.map((f) => f.at)].sort((a, b) => a - b));
    }
    expect(Object.values(model.fetches).reduce((n, l) => n + l.length, 0)).toBe(inputs.record.fetches.length);
  });
});

describe("the NAVSEA tower at a frame", () => {
  it("is dark and empty before the run's first recorded moment", () => {
    const f = run.frame(0);
    expect(f.lamps.lobby).toBe(0);
    expect(f.lamps.archive).toBe(0);
    expect(f.vacant).toEqual(LANES);
    // only the notary's verifier, a desk with no card, is in from the start; no agent has clocked in
    expect(Object.values(f.agents).filter((a) => a.present).map((a) => a.seat)).toEqual(["verifier"]);
    expect(Object.values(f.agents).every((a) => a.joinedAt === null || a.joinedAt > 0)).toBe(true);
    expect([f.gates.h1.state, f.gates.h2.state]).toEqual(["closed", "closed"]);
    expect(f.phase).toBe("intake");
    expect(f.step).toBeNull();
    expect(f.cabin).toMatchObject({ ride: null, doorsOpen: false, y: must(layout.rows[layout.ground]).floor });
  });

  it("parks at H1 with the wait counting in recorded time and a skip to the recorded approval", () => {
    const t = must(model.gates.h1.park) + 2000;
    const f = run.frame(t);
    expect(f.gates.h1).toEqual({ state: "waiting", waitedMs: 2000 + must(model.gates.h1.park) + run.bounds.start - 600 - must(model.gates.h1.parkTs), skipTo: model.gates.h1.approved });
    expect(f.step).toBe("H1");
    expect(f.strip.find((c) => c.id === "H1")?.status).toBe("waiting");
    expect(f.strip.find((c) => c.id === "S3")?.status).toBe("done");
    // intake is over, the lobby keeps a dim light; nothing below ground yet
    expect(f.lamps.lobby).toBe(1);
    expect(f.lamps.archive).toBe(0);
    expect(f.phase).toBe("intake");
  });

  it("shows the plan approved, then the researchers riding the lift down together", () => {
    const approved = must(model.gates.h1.approved);
    expect(run.frame(approved + APPROVED_SIGN_MS - 1).gates.h1.state).toBe("approved");
    expect(run.frame(approved + APPROVED_SIGN_MS).gates.h1.state).toBe("open");
    const ride = must(model.lift.rides[0]);
    const lastBoard = Math.max(...Object.values(ride.board));
    const t = lastBoard + 1;
    const f = run.frame(t);
    expect(f.cabin.ride?.id).toBe("ride:0");
    expect(f.cabin.riders.map((r) => r.seat).sort()).toEqual(LANES.map((l) => `${l}:lane`).sort());
    for (const lane of LANES) expect(f.agents[`${lane}:lane`]).toMatchObject({ placement: "move", activity: "idle", carrying: false });
    // reduced motion: nobody rides; the cabin stands at a landing and each researcher is already at its carrel
    const still = run.frame(t, true);
    expect(still.cabin).toEqual({ ride: null, y: still.cabin.y, doorsOpen: false, riders: [] });
    expect(layout.rows.map((r) => r.floor)).toContain(still.cabin.y);
    for (const lane of LANES) expect(still.agents[`${lane}:lane`]?.leg).toMatchObject({ kind: "stay", carrel: true });
  });

  it("puts each researcher at its carrel during S4, reading with its back to the viewer, the archive and the floors lit", () => {
    const t = 60_000;
    const f = run.frame(t);
    expect(f.running).toContain("S4");
    expect(f.lamps.archive).toBe(2);
    expect(f.phase).toBe("research");
    for (const lane of LANES) {
      expect(f.agents[`${lane}:lane`]).toMatchObject({ placement: "move", activity: "browsing", facing: "back" });
      expect(f.lamps[`floor:${lane}`]).toBe(2);
      const list = must(model.fetches[lane]).filter((x) => x.at <= t);
      expect(f.sources[lane]).toEqual({ fetched: list.length, ok: list.filter((x) => x.status === "ok").length });
      const carrel = must(f.carrels[LANES.indexOf(lane)]);
      expect(carrel.lane).toBe(lane);
      expect(carrel.printed).toBe(must(f.sources[lane]).ok);
      expect(carrel.last).toEqual(list.at(-1) ?? null);
    }
    expect(f.vacant).toEqual([]);
    // the sixth carrel has no lane
    expect(f.carrels[5]).toEqual({ slot: 5, lane: null, last: null, printed: 0 });
  });

  it("floats the host a carrel read, or the failure, for a moment after each fetch", () => {
    for (const lane of LANES) {
      const list = must(model.fetches[lane]);
      // an answered read that no other fetch of the lane shares its instant with
      const ok = must(list.find((x) => x.status === "ok" && list.filter((y) => y.at === x.at).length === 1));
      const okFrame = run.frame(ok.at);
      const slot = LANES.indexOf(lane);
      const popup = okFrame.popups.find((p) => p.id.startsWith(`fetch:${slot}:`));
      expect(must(okFrame.carrels[slot]).last).toEqual(ok);
      expect(popup).toMatchObject({ text: ok.host, tone: "mono", start: ok.at });
      expect(run.frame(ok.at + POPUP_MS).popups.some((p) => p.id === `fetch:${slot}:${ok.at}`)).toBe(false);
    }
    const failed = Object.values(model.fetches)
      .flat()
      .find((x) => x.status !== "ok");
    const bad = must(failed);
    const f = run.frame(bad.at);
    expect(f.popups.some((p) => p.text === bad.status && p.tone === "danger")).toBe(true);
  });

  it("strikes the notary's stamp on each beat and counts only the verdicts recorded by the frame", () => {
    const beat = must(model.beats[0]);
    const f = run.frame(beat.start);
    expect(f.stamping).toBe(true);
    expect(f.agents.verifier?.activity).toBe("stamping");
    expect(f.beat?.id).toBe(beat.id);
    expect(f.beat?.total).toBe(model.verdicts.filter((v) => v.at === beat.start).length);
    expect(f.popups.find((p) => p.id === `verdict:${beat.id}`)?.start).toBe(beat.start);
    expect(f.lamps.notary).toBe(2);
    const later = run.frame(beat.start + STAMP_MS);
    expect(later.stamping).toBe(false);
    // the whole S7 tally once every verdict is in
    const done = run.frame(stageAt("S7", "finished"));
    expect(done.tally.supported + done.tally.partly + done.tally.withheld).toBe(278);
    expect(Object.values(done.laneTally).reduce((n, t) => n + t.supported + t.partly + t.withheld, 0)).toBe(model.verdicts.filter((v) => v.lane !== null && LANES.includes(v.lane)).length);
    expect(done.lamps.notary).toBe(1);
    expect(done.finished.S7).toBe(stageAt("S7", "finished"));
  });

  it("sends each role-play message as a capsule along the tubes, or a still lit tube under reduced motion", () => {
    const send = must(sends[0]);
    const t = send.start + FLIGHT_MS / 2;
    const f = run.frame(t);
    const caps = f.capsules.filter((c) => c.msgId === send.msgId);
    expect(caps).toHaveLength(send.to.length);
    for (const c of caps) {
      expect(c).toMatchObject({ start: send.start, end: send.start + FLIGHT_MS, failed: false, kind: model.messages[send.msgId]?.kind });
      expect(c.path).toEqual(tubePath(layout, send.seat, must(c.id.split(">")[1])));
    }
    expect(f.tubes).toEqual([]);
    const still = run.frame(t, true);
    expect(still.capsules).toEqual([]);
    expect(still.tubes.length).toBeGreaterThanOrEqual(send.to.length);
    // landed: gone
    expect(run.frame(send.start + FLIGHT_MS).capsules.some((c) => c.msgId === send.msgId)).toBe(false);
    // the speech bubble names the message's facts
    const bubble = f.bubbles.find((b) => b.msgId === send.msgId);
    expect(bubble).toMatchObject({ seat: send.seat, rejected: false, cites: model.messages[send.msgId]?.cites });
    expect(f.bubbles.length).toBeLessThanOrEqual(3);
  });

  it("shows only the latest three speech bubbles, oldest first", () => {
    // the busiest moment of the role-play: the send with the most other sends still speaking
    const busy = sends.map((s) => ({ s, f: run.frame(s.start) })).sort((a, b) => b.f.bubbles.length - a.f.bubbles.length)[0];
    const f = must(busy).f;
    expect(f.bubbles.length).toBeGreaterThan(1);
    expect(f.bubbles.length).toBeLessThanOrEqual(3);
    expect(f.bubbles.map((b) => b.start)).toEqual([...f.bubbles.map((b) => b.start)].sort((a, b) => a - b));
    expect(f.bubbles.at(-1)?.start).toBe(must(busy).s.start);
  });

  it("keeps the board's ratings in the penthouse: a rating never flies a capsule", () => {
    const rating = must(sends.find((s) => model.messages[s.msgId]?.kind === "rating"));
    expect(run.frame(rating.start + 10).capsules.some((c) => c.msgId === rating.msgId)).toBe(false);
  });

  it("walks each evaluator in from the street with a joined popup at the doors, and seats them for the board", () => {
    const r = must(model.riders["board:0"]);
    const appear = must(r.appear);
    expect(run.frame(appear - 1).agents["board:0"]?.placement).not.toBe("seat");
    const f = run.frame(appear + 1);
    expect(f.agents["board:0"]).toMatchObject({ placement: "move", activity: "walking", joinedAt: appear });
    expect(f.popups.find((p) => p.id === "joined:board:0")).toMatchObject({ text: "joined", x: layout.doors.x, tone: "signal" });
    expect(run.frame(appear + JOIN_MS).popups.some((p) => p.id === "joined:board:0")).toBe(false);
    const seated = run.frame(must(r.seated));
    expect(seated.agents["board:0"]?.placement).toBe("seat");
    expect(seated.lamps.penthouse).toBeGreaterThanOrEqual(1);
    // reduced motion: an evaluator is simply in its chair from the moment it comes in
    expect(run.frame(appear + 1, true).agents["board:0"]?.placement).toBe("seat");
    expect(run.frame(appear - 1, true).agents["board:0"]?.placement).toBe("absent");
  });

  it("pins each interview card on the home board as it is recorded", () => {
    const pin = must(model.pins[0]);
    expect(run.frame(pin.at - 1).pins).toEqual([]);
    expect(run.frame(pin.at).pins).toEqual([pin]);
  });

  it("ends decided: every step done, both gates open, every verdict tallied and every pin up", () => {
    const f = run.frame(Infinity);
    expect(f.gates.h1.state).toBe("open");
    expect(f.gates.h2.state).toBe("open");
    expect(f.step).toBeNull();
    // S14 (the brief check) finished degraded in this run; the strip says so
    expect(f.strip.filter((c) => c.status !== "done" && c.status !== "approved").map((c) => [c.id, c.status])).toEqual([["S14", "degraded"]]);
    expect(f.strip.find((c) => c.id === "H1")?.ms).toBe(4434);
    expect(f.strip.find((c) => c.id === "H2")?.ms).toBe(must(model.gates.h2.approvedTs) - must(model.gates.h2.parkTs));
    expect(f.pins).toEqual(model.pins);
    expect(f.lamps.deck).toBe(1);
    expect(f.running).toEqual([]);
    expect(f.calls.inFlight).toEqual([]);
    expect(f.calls.started).toBe(model.spans.length);
    expect(f.phase).toBe("decide");
  });

  it("lights the machine room and the riser while model calls are in flight", () => {
    const span = must(model.spans.find((s) => s.end - s.start > 100 && s.stage === "S9"));
    const f = run.frame(span.start + 1);
    expect(f.calls.inFlight).toContain(span);
    expect(f.lamps.machine).toBe(2);
    expect(f.calling).toContain("S9");
    expect(f.riser).toEqual(expect.arrayContaining([layout.upper, ...layout.rivalRows]));
    expect(run.frame(Infinity).lamps.machine).toBe(1);
  });
});

describe("a run still parked at its decision", () => {
  const parked = navseaTower({ parkedAtH2: true });

  it("waits at H2 in its final frame by the wall clock since the recorded park, and says nothing without one", () => {
    const parkTs = must(parked.model.gates.h2.parkTs);
    const f = parked.frame(Infinity, false, parkTs + 25 * 60_000);
    expect(f.gates.h2).toEqual({ state: "waiting", waitedMs: 25 * 60_000, skipTo: null });
    expect(f.step).toBe("H2");
    expect(parked.frame(Infinity).gates.h2.waitedMs).toBeNull();
    expect(parked.model.log.some((r) => r.id === "H2:approved")).toBe(false);
    expect(parked.model.log.some((r) => r.id === "H2:park")).toBe(true);
  });
});

describe("a live view opened mid-run", () => {
  // settled history: everything up to the first envelope after S4 started is already in place
  const s4seq = must(run.inputs.record.stages.find((s) => s.stage === "S4" && s.edge === "started")).seq;
  const firstFetch = must(run.inputs.record.fetches.filter((x) => x.seq > s4seq).sort((a, b) => a.seq - b.seq)[0]).seq;
  const live = navseaTower({ settledSeq: firstFetch + 40 });

  it("leaves a researcher already reading in the archive from the start until its lane ends", () => {
    const stays = Object.values(live.model.riders).filter((r) => r.legs[0]?.kind === "stay" && r.legs[0].start === -Infinity);
    expect(stays.length).toBeGreaterThan(0);
    for (const r of stays) {
      const stay = must(r.legs[0]);
      expect(stay.carrel).toBe(true);
      expect(Number.isFinite(stay.end)).toBe(true);
      expect(legAt(r, -1e12)).toBe(stay);
      expect(legAt(r, stay.end)).not.toBe(stay);
    }
    // the settled fetches are history: already on the carrel's count, never popped up
    const anyLane = must(Object.values(live.model.fetches)[0]);
    expect(anyLane[0]?.at).toBe(-Infinity);
  });

  it("shows history at once: the H1 approval and the settled stage edges carry no display time", () => {
    expect(live.model.log.filter((r) => r.at === -Infinity).length).toBeGreaterThan(0);
    expect(live.model.floorFrom[LANES[0] as string]).toBe(-Infinity);
  });
});

describe("the replay clock", () => {
  const replay = navseaTower({ clock: "replay" });

  it("plays the run faster than recorded but keeps every stage edge in order", () => {
    expect(replay.model.end).toBeLessThan(model.end);
    const order = (s: typeof sched) => s.stages.map((x) => `${x.stage}:${x.edge}`);
    expect(order(replay.sched)).toEqual(order(sched));
    expect(replay.model.trips.map((t) => t.lane).sort()).toEqual(model.trips.map((t) => t.lane).sort());
  });

  it("measures the H1 wait in recorded time, not in the warped display time", () => {
    const park = must(replay.model.gates.h1.park);
    const approved = must(replay.model.gates.h1.approved);
    const mid = (park + approved) / 2;
    const f = replay.frame(mid);
    expect(f.gates.h1.state).toBe("waiting");
    expect(f.gates.h1.waitedMs).toBeCloseTo(replay.back(mid) - must(replay.model.gates.h1.parkTs), 6);
    // the recorded wait is longer than the warped one on screen
    expect(must(f.gates.h1.waitedMs)).toBeGreaterThan(mid - park);
  });
});

describe("events the NAVSEA run did not have", () => {
  it("flashes the room of the step running when a run error was recorded, for ALARM_MS", () => {
    const s6 = stageAt("S6", "started");
    const ts = run.back(s6 + 1000);
    const history = { ...must(inputs.history), errors: [{ seq: 99_999, ts, message: "the dossier press jammed", code: "boom" }] };
    const m = { ...model, inputs: { ...inputs, history } };
    const at = model.clockAt(ts);
    const frame = (t: number) => towerFrame(m, { seats: {}, scores: false, sent: 0 } as never, t, false);
    expect(frame(at).alarm).toEqual({ at, room: "dossier" });
    expect(frame(at + ALARM_MS - 1).alarm?.room).toBe("dossier");
    expect(frame(at + ALARM_MS).alarm).toBeNull();
    expect(frame(at - 1).alarm).toBeNull();
  });

  it("jams a failed message's capsule halfway, then pops a failed word where it stopped", () => {
    const send = must(sends.find((s) => s.to.length > 0 && model.messages[s.msgId]?.kind !== "rating"));
    const failedBeat = { ...send, failed: true };
    const m = { ...model, sched: { ...sched, beats: [failedBeat] } };
    const office = { seats: {}, scores: false, sent: 0 } as never;
    const mid = towerFrame(m, office, send.start + 10, false);
    const cap = must(mid.capsules[0]);
    const full = must(tubePath(layout, send.seat, must(send.to[0])));
    expect(cap.path).toEqual(cutPath(full, 0.5));
    expect(cap.end).toBe(send.start + FLIGHT_MS / 2);
    expect(cap.failed).toBe(true);
    const jammed = towerFrame(m, office, send.start + FLIGHT_MS, false);
    expect(jammed.capsules).toHaveLength(send.to.length);
    const stop = must(cap.path.at(-1));
    expect(jammed.popups.find((p) => p.id === `failed:${cap.id}`)).toMatchObject({ text: "failed", x: stop.x, y: stop.y - 8, tone: "danger" });
    expect(towerFrame(m, office, send.start + FLIGHT_MS + JAM_MS, false).capsules).toEqual([]);
  });

  it("never flies a message that was rejected for budget", () => {
    const send = must(sends[0]);
    const msg = must(model.messages[send.msgId]);
    const m = { ...model, messages: { ...model.messages, [send.msgId]: { ...msg, state: "rejected" } } };
    expect(towerFrame(m, { seats: {}, scores: false, sent: 0 } as never, send.start + 10, false).capsules).toEqual([]);
  });

  it("draws at most MAX_CAPSULES capsules and counts the rest on the trunk", () => {
    const send = must(sends[0]);
    const many = Array.from({ length: MAX_CAPSULES + 4 }, (_, i) => ({ ...send, id: `${send.id}#${i}`, start: send.start + i }));
    const m = { ...model, sched: { ...sched, beats: many } };
    const f = towerFrame(m, { seats: {}, scores: false, sent: 0 } as never, send.start + 30, false);
    expect(f.capsules).toHaveLength(MAX_CAPSULES);
    expect(f.moreCapsules).toBe(4 * send.to.length + (send.to.length - 1) * MAX_CAPSULES);
  });
});

describe("the riders' plan", () => {
  it("turns a researcher round on arrival when its lane ends before it reaches the carrel", () => {
    const seat = `${LANES[0]}:lane`;
    const trip: LaneTrip = { lane: must(LANES[0]), seat, slot: 0, down: 10_000, up: 10_500, carries: false };
    const { riders, lift } = planRiders(layout, plan, { ...sched, presentFrom: {} }, [trip]);
    const r = must(riders[seat]);
    const stay = r.legs.find((l) => l.kind === "stay");
    const arrive = must(r.legs.find((l) => l.kind === "walk" && l.to.y === must(layout.rows[layout.basement]).floor)).end;
    // the stay is empty (it ends as it starts) and filtered out; the way back sets off on arrival, not at the lane's end
    expect(stay).toBeUndefined();
    const backWalk = must(r.legs.find((l) => l.kind === "walk" && l.start >= arrive));
    expect(backWalk.start).toBe(arrive);
    expect(lift.rides).toHaveLength(2);
    expect(legsInOrder(r)).toBe(true);
  });

  it("skips a trip whose researcher has no desk in the building", () => {
    const trip: LaneTrip = { lane: "NOBODY", seat: "NOBODY:lane", slot: 0, down: 1000, up: 5000, carries: true };
    expect(planRiders(layout, plan, { ...sched, presentFrom: {} }, [trip])).toEqual({ lift: { rides: [], rest: layout.ground }, riders: {} });
  });

  it("walks the researcher from its desk to the door in walkMs of the distance", () => {
    const seat = `${LANES[1]}:lane`;
    const spot = must(layout.seats[seat]);
    const trip: LaneTrip = { lane: must(LANES[1]), seat, slot: 1, down: 0, up: 60_000, carries: true };
    const r = must(planRiders(layout, plan, { ...sched, presentFrom: {} }, [trip]).riders[seat]);
    const first = must(r.legs[0]);
    expect(first).toMatchObject({ kind: "walk", start: 0, end: walkMs(spot.x - X.door) });
  });
});

describe("lane trips over the recorded run", () => {
  it("makes every trip history when the tower opens after the run", () => {
    const trips = laneTrips(plan, inputs.record, inputs.tower, inputs.approvals, run.clock, Number.MAX_SAFE_INTEGER, layout.carrels.length);
    expect(trips).toHaveLength(5);
    expect(trips.every((t) => t.down === -Infinity && t.up === -Infinity)).toBe(true);
  });

  it("sets researchers off at S4's own start when the approval came too long before it", () => {
    const early = { h1: { at: new Date(run.bounds.start - 3_600_000).toISOString() }, h2: null };
    const trips = laneTrips(plan, inputs.record, inputs.tower, early, run.clock, 0);
    const s4 = must(inputs.record.stages.find((s) => s.stage === "S4" && s.edge === "started")).ts;
    expect(trips.every((t) => t.down === run.clock.at(s4))).toBe(true);
  });
});

describe("the room a stage works in", () => {
  it("maps each stage to its room, and anything else to the lobby", () => {
    expect(["S0", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S15", "H1", "x"].map(stageRoom)).toEqual([
      "lobby",
      "lobby",
      "archive",
      "archive",
      "dossier",
      "notary",
      "ledger",
      "red",
      "penthouse",
      "deck",
      "deck",
      "lobby",
      "lobby",
    ]);
  });
});
