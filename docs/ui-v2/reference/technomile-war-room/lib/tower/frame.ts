/**
 * The Bid Tower at one display time. `buildModel` turns the recorded run into the tower's plan once per change of
 * data (the lift's rides, each rider's legs, the model calls, the gates, the stamp beats, the log); `towerFrame`
 * reads that plan and the office's own frame (`frameAt`, the shared event-to-activity mapping) at time `t`.
 *
 * The office frame says who is typing, sending and receiving and which messages are in flight; the tower adds where
 * people are in the building (a researcher in the archive while its lane runs, an evaluator riding up to the
 * penthouse), what the rooms show (CRTs, the notary's stamp and trays, the racks, the riser, the gates) and the
 * factual popups. Nothing here invents an event: every change keys on a recorded one.
 */
import type { AgentCard, AgentMessageKind, FetchActivity } from "@/lib/contracts/run-events";
import type { PhaseId, StepId } from "@/lib/pipeline/steps";

import { FLIGHT_MS, STAMP_MS, type Activity, type BeatClock, type OfficeFrame, type OfficePlan, type Pt, type Schedule, type Verdict } from "../office";
import { interviewOf, type SwarmView } from "../swarm";

import { X, type RoomId, type Row, type TowerLayout } from "./layout";
import { sceneAt, seatKnown, type Scene } from "../scene";
import { cabinAt, cutPath, nearestFloor, planLift, tubePath, walkMs, type LiftPlan, type LiftRide, type RideRequest } from "./route";
import {
  buildLog,
  callsAt,
  callSpans,
  beatAt,
  finalBack,
  gateAt,
  gateSpans,
  laneLineAt,
  laneTrips,
  phaseAt,
  rackSlots,
  riserRows,
  runningStep,
  stampBeats,
  stepStripAt,
  tallyAt,
  timedVerdicts,
  type CallSpan,
  type CallsNow,
  type GateNow,
  type GateSpan,
  type LaneTrip,
  type LogRow,
  type RackPlan,
  type StampBeat,
  type StripCell,
  type TimedVerdict,
  type TowerInputs,
} from "./world";

/* ------------------------------------------------------------------------------------------------ riders */

export type LegKind = "walk" | "wait" | "cabin" | "stay";

export interface Leg {
  kind: LegKind;
  start: number;
  end: number;
  /** Walk: from and to; wait and stay: where (from = to). Feet positions. */
  from: Pt;
  to: Pt;
  /** The ride a cabin leg is part of. */
  ride: string | null;
  carrying: boolean;
  /** A stay at an archive carrel (the researcher reads at the CRT, back to the viewer). */
  carrel: boolean;
}

export interface RiderPlan {
  seat: string;
  legs: Leg[];
  /** Evaluators: when they come in at the street doors (before that they are not in the building). */
  appear: number | null;
  /** Evaluators: when they sit down at the penthouse table. */
  seated: number | null;
}

/** The waiting spot beside a landing door. */
export const WAIT_DX = 10;

export function legAt(plan: RiderPlan, t: number): Leg | null {
  for (const leg of plan.legs) if (t >= leg.start && t < leg.end) return leg;
  return null;
}

/**
 * Every rider's legs and the lift's rides: researchers go down to their carrel when their lane starts and come back
 * when it ends; evaluators come in at the street doors when their cards are recorded and ride up to the penthouse.
 */
export function planRiders(layout: TowerLayout, plan: OfficePlan, sched: Schedule, trips: readonly LaneTrip[]): { lift: LiftPlan; riders: Record<string, RiderPlan> } {
  const rows = layout.rows;
  const floorOf = (row: number) => (rows[row] as Row).floor;
  const door = (row: number): Pt => ({ x: X.door + WAIT_DX, y: floorOf(row) });
  const carrelPt = (trip: LaneTrip): Pt => ({ x: layout.carrels[trip.slot]?.x ?? X.in0 + 40, y: floorOf(layout.basement) });
  type Meta = { seat: string; trip: LaneTrip | null; leg: "down" | "up" | "board" };

  const make = (arrivals: ReadonlyMap<string, number>) => {
    const requests: RideRequest[] = [];
    const meta = new Map<string, Meta>();
    trips.forEach((trip, k) => {
      const spot = layout.seats[trip.seat];
      if (!spot) return;
      if (Number.isFinite(trip.down)) {
        const id = `${trip.seat}#${k}#down`;
        meta.set(id, { seat: trip.seat, trip, leg: "down" });
        requests.push({ rider: id, from: spot.row, to: layout.basement, event: trip.down, ready: trip.down + walkMs(spot.x - X.door) });
      }
      if (Number.isFinite(trip.up)) {
        const id = `${trip.seat}#${k}#up`;
        meta.set(id, { seat: trip.seat, trip, leg: "up" });
        // a lane that ends before its researcher reaches the carrel: the researcher turns round on arrival
        const event = Math.max(trip.up, arrivals.get(`${trip.seat}#${k}`) ?? -Infinity);
        requests.push({ rider: id, from: layout.basement, to: spot.row, event, ready: event + walkMs(carrelPt(trip).x - X.door) });
      }
    });
    for (const id of plan.order) {
      const seat = plan.seats[id];
      const spot = layout.seats[id];
      const at = sched.presentFrom[id];
      if (!seat || !spot || seat.zone !== "board" || at === undefined || !Number.isFinite(at)) continue;
      const rid = `${id}#board`;
      meta.set(rid, { seat: id, trip: null, leg: "board" });
      requests.push({ rider: rid, from: layout.ground, to: layout.roof, event: at, ready: at + walkMs(layout.doors.x - X.door) });
    }
    return { requests, meta, lift: planLift(requests, rows, layout.ground) };
  };

  // plan once, then make sure no researcher is asked up before reaching its carrel
  let made = make(new Map());
  for (let pass = 0; pass < 2; pass++) {
    const arrivals = new Map<string, number>();
    let late = false;
    trips.forEach((trip, k) => {
      const rid = `${trip.seat}#${k}#down`;
      const alight = made.lift.rides.find((r) => r.riders.includes(rid))?.alight[rid];
      if (alight === undefined) return;
      const arrive = alight + walkMs(carrelPt(trip).x - X.door);
      arrivals.set(`${trip.seat}#${k}`, arrive);
      if (Number.isFinite(trip.up) && trip.up < arrive) late = true;
    });
    if (!late) break;
    made = make(arrivals);
  }
  const { requests, meta, lift } = made;

  const riders: Record<string, RiderPlan> = {};
  const get = (seat: string) => (riders[seat] ??= { seat, legs: [], appear: null, seated: null });
  const leg = (kind: LegKind, start: number, end: number, from: Pt, to: Pt, carrying: boolean, extra: Partial<Leg> = {}): Leg => ({ kind, start, end, from, to, ride: null, carrying, carrel: false, ...extra });
  // history: a researcher already in the archive when the office opened stays there until its lane ends
  trips.forEach((trip) => {
    if (!Number.isFinite(trip.down) && Number.isFinite(trip.up)) get(trip.seat).legs.push(leg("stay", -Infinity, trip.up, carrelPt(trip), carrelPt(trip), false, { carrel: true }));
  });
  for (const req of requests) {
    const m = meta.get(req.rider);
    const ride = lift.rides.find((r) => r.riders.includes(req.rider));
    const spot = m ? layout.seats[m.seat] : undefined;
    if (!m || !ride || !spot) continue;
    const board = ride.board[req.rider] ?? req.ready;
    const alight = ride.alight[req.rider] ?? board;
    const legs = get(m.seat).legs;
    const seatPt: Pt = { x: spot.x, y: floorOf(spot.row) };
    const cabin = (carrying: boolean) => leg("cabin", board, alight, door(req.from), door(req.to), carrying, { ride: ride.id });
    if (m.trip && m.leg === "down") {
      const c = carrelPt(m.trip);
      const arrive = alight + walkMs(c.x - X.door);
      const stayEnd = Number.isFinite(m.trip.up) ? Math.max(arrive, m.trip.up) : Infinity;
      legs.push(
        leg("walk", req.event, req.ready, seatPt, door(req.from), false),
        leg("wait", req.ready, board, door(req.from), door(req.from), false),
        cabin(false),
        leg("walk", alight, arrive, door(req.to), c, false),
        leg("stay", arrive, stayEnd, c, c, false, { carrel: true }),
      );
    } else if (m.trip && m.leg === "up") {
      const c = carrelPt(m.trip);
      const carrying = m.trip.carries;
      legs.push(
        leg("walk", req.event, req.ready, c, door(req.from), carrying),
        leg("wait", req.ready, board, door(req.from), door(req.from), carrying),
        cabin(carrying),
        leg("walk", alight, alight + walkMs(spot.x - X.door), door(req.to), seatPt, carrying),
      );
    } else {
      const street: Pt = { x: layout.doors.x, y: floorOf(layout.ground) };
      const seated = alight + walkMs(spot.x - X.door);
      const r = get(m.seat);
      r.appear = req.event;
      r.seated = seated;
      legs.push(
        leg("walk", req.event, req.ready, street, door(req.from), false),
        leg("wait", req.ready, board, door(req.from), door(req.from), false),
        cabin(false),
        leg("walk", alight, seated, door(req.to), seatPt, false),
      );
    }
  }
  for (const r of Object.values(riders)) r.legs = r.legs.filter((l) => l.end > l.start).sort((a, b) => a.start - b.start);
  return { lift, riders };
}

/* ------------------------------------------------------------------------------------------------ the model */

export interface Pin {
  id: string;
  at: number;
  pod: string | null;
  text: string;
}

export interface MessageFacts {
  kind: AgentMessageKind;
  state: string;
  cites: number;
  dropped: number;
  /** A rating: how many offerors it rated. */
  rated: number;
  round: number;
}

export interface TowerModel {
  layout: TowerLayout;
  plan: OfficePlan;
  sched: Schedule;
  view: SwarmView;
  inputs: TowerInputs;
  settledSeq: number;
  /** Recorded time to display time (the exact or the live clock the model was built with). */
  clockAt: (ts: number) => number;
  /** Display time of the run's first recorded moment (the clock and the log count from it). */
  origin: number;
  /** Display time to the recorded time it shows (durations, waits and clocks read in recorded time). */
  back: (display: number) => number;
  /** Display time by which everything recorded has happened. */
  end: number;
  trips: LaneTrip[];
  lift: LiftPlan;
  riders: Record<string, RiderPlan>;
  spans: CallSpan[];
  racks: RackPlan;
  gates: { h1: GateSpan; h2: GateSpan };
  verdicts: TimedVerdict[];
  beats: StampBeat[];
  log: LogRow[];
  /** Display time each rival floor's lane (or, failing that, its first card) was recorded; "Vacant" before. */
  floorFrom: Record<string, number>;
  /** Fetches on the display clock, per lane, in time order. */
  fetches: Record<string, { at: number; host: string; status: FetchActivity["status"] }[]>;
  /** Interview cards pinned on the home office board. */
  pins: Pin[];
  messages: Record<string, MessageFacts>;
}

export interface ModelArgs {
  inputs: TowerInputs;
  layout: TowerLayout;
  plan: OfficePlan;
  sched: Schedule;
  clock: BeatClock;
  settledSeq: number;
  origin: number;
  end: number;
  back: (display: number) => number;
}

export function buildModel(args: ModelArgs): TowerModel {
  const { inputs, layout, plan, sched, clock, settledSeq, origin, end, back } = args;
  const { view, record, tower, history, approvals, calls } = inputs;
  const fresh = (seq: number) => seq > settledSeq;
  const trips = laneTrips(plan, record, tower, approvals, clock, settledSeq, layout.carrels.length);
  const { lift, riders } = planRiders(layout, plan, sched, trips);
  const spans = callSpans(calls, clock);
  const gates = gateSpans(history, approvals, clock);
  const verdicts = timedVerdicts(tower, clock, settledSeq);
  const beats = stampBeats(verdicts);

  const floorFrom: Record<string, number> = {};
  for (const pod of plan.pods) {
    const seen = tower.laneSeen[pod.key];
    const cards = Object.values(view.cards)
      .filter((c) => pod.groupId !== null && c.group === pod.groupId)
      .map((c) => view.cardSeen[c.agentId])
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .sort((a, b) => a.seq - b.seq);
    const first = seen ?? (cards[0] ? { seq: cards[0].seq, ts: Date.parse(cards[0].ts) } : null);
    floorFrom[pod.key] = first && fresh(first.seq) ? clock.at(first.ts) : -Infinity;
  }

  const fetches: TowerModel["fetches"] = {};
  for (const f of record.fetches) (fetches[f.lane] ??= []).push({ at: fresh(f.seq) ? clock.at(f.ts) : -Infinity, host: f.host, status: f.status });
  for (const list of Object.values(fetches)) list.sort((a, b) => a.at - b.at);

  const messages: Record<string, MessageFacts> = {};
  const pins: Pin[] = [];
  for (const m of view.messages) {
    const ratings = m.data.ratings;
    messages[m.messageId] = {
      kind: m.kind,
      state: m.state,
      cites: m.citations.length,
      dropped: m.dropped,
      rated: ratings !== null && typeof ratings === "object" ? Object.keys(ratings).length : 0,
      round: m.round,
    };
    if (m.kind !== "interview" || m.state !== "completed") continue;
    const qa = interviewOf(m);
    const answers = qa.reduce((n, q) => n + q.statements.length, 0);
    const withheld = qa.reduce((n, q) => n + q.withheld, 0);
    const card = view.cards[m.from];
    const ts = Date.parse(m.ts);
    pins.push({
      id: m.messageId,
      at: fresh(m.seq) && Number.isFinite(ts) ? clock.at(ts) : -Infinity,
      pod: card ? (plan.pods.find((p) => p.groupId === card.group)?.key ?? null) : null,
      text: `${answers} ${answers === 1 ? "answer" : "answers"}, ${withheld} withheld`,
    });
  }
  pins.sort((a, b) => a.at - b.at);

  return {
    layout,
    plan,
    sched,
    view,
    inputs,
    settledSeq,
    clockAt: clock.at,
    origin,
    back,
    end,
    trips,
    lift,
    riders,
    spans,
    racks: rackSlots(spans),
    gates,
    verdicts,
    beats,
    log: buildLog(inputs, plan, clock, settledSeq, spans, beats, gates, verdicts),
    floorFrom,
    fetches,
    pins,
    messages,
  };
}

/* ------------------------------------------------------------------------------------------------ the frame */

export type Placement = "seat" | "move" | "absent";

export interface AgentNow {
  seat: string;
  placement: Placement;
  activity: Activity;
  facing: "front" | "back";
  carrying: boolean;
  /** The leg under way while away from the desk (walks are interpolated every animation frame; cabin legs follow
   *  the cabin; a stay is still). */
  leg: Leg | null;
  /** The agent's card is recorded (an empty desk shows a dim nameplate before). */
  present: boolean;
  /** When the agent clocked in (the door puff and the "joined" popup), null for history or no card. */
  joinedAt: number | null;
}

export interface CapsuleNow {
  id: string;
  msgId: string;
  /** The tube path (a failed message's stops halfway). */
  path: Pt[];
  start: number;
  /** When it reaches the end of its path. */
  end: number;
  kind: AgentMessageKind;
  failed: boolean;
}

export interface CarrelNow {
  slot: number;
  lane: string | null;
  /** The latest fetch at this carrel by `t`. */
  last: { at: number; host: string; status: FetchActivity["status"] } | null;
  /** Pages printed (sources that answered) so far. */
  printed: number;
}

export type PopupTone = "plain" | "signal" | "danger" | "mono";

export interface Popup {
  id: string;
  text: string;
  x: number;
  y: number;
  start: number;
  tone: PopupTone;
}

export interface Bubble {
  seat: string;
  msgId: string;
  text: string;
  start: number;
  failed: boolean;
  rejected: boolean;
  cites: number;
  dropped: number;
  rated: number;
}

export type Lamp = 0 | 1 | 2;

export interface TowerFrame {
  t: number;
  agents: Record<string, AgentNow>;
  cabin: { ride: LiftRide | null; y: number; doorsOpen: boolean; riders: { seat: string; carrying: boolean }[] };
  capsules: CapsuleNow[];
  /** Capsules in flight past the cap (drawn as one "+n" capsule on the trunk). */
  moreCapsules: number;
  /** Reduced motion: tube paths carrying a message now (a still highlight instead of a capsule). */
  tubes: Pt[][];
  carrels: CarrelNow[];
  /** Per pod: sources fetched by `t` and how many answered (the in-tray and the floor label). */
  sources: Record<string, { fetched: number; ok: number }>;
  tally: Record<Verdict, number> & { unreachable: number };
  laneTally: Record<string, Record<Verdict, number> & { unreachable: number }>;
  /** The stamp beat on show (its stamp drop and popup). */
  beat: StampBeat | null;
  stamping: boolean;
  calls: CallsNow;
  riser: number[];
  lamps: Partial<Record<RoomId, Lamp>>;
  gates: { h1: GateNow; h2: GateNow };
  phase: PhaseId;
  strip: StripCell[];
  step: StepId | null;
  popups: Popup[];
  bubbles: Bubble[];
  pins: Pin[];
  scores: boolean;
  sent: number;
  /** Rival floors (by pod key) whose lane is not recorded yet. */
  vacant: string[];
  lines: Record<string, string | null>;
  running: string[];
  /** Finished stages and when (display) they finished. */
  finished: Record<string, number>;
  /** Stages with a model call in flight. */
  calling: string[];
  /** A run error being flashed: the room of the step running when it was recorded. */
  alarm: { at: number; room: RoomId } | null;
  /** What is known at `t` (rivals named, agents carded, endpoints called): names and counts read from this. */
  scene: Scene;
}

export const MAX_CAPSULES = 16;
/** A failed message's capsule stays jammed this long after it would have landed. */
export const JAM_MS = 1200;
export const POPUP_MS = 900;
export const JOIN_MS = 1200;
export const ALARM_MS = 1500;

/** The room a stage works in (its lamps, a run error's alarm). */
export function stageRoom(stage: string): RoomId {
  const k = Number(/^S(\d{1,2})$/.exec(stage)?.[1] ?? "-1");
  if (k === 4 || k === 5) return "archive";
  if (k === 6) return "dossier";
  if (k === 7) return "notary";
  if (k === 8) return "ledger";
  if (k === 9) return "red";
  if (k === 10) return "penthouse";
  if (k >= 11) return "deck";
  return "lobby";
}

/** The tower at display time `t`. `reduced`: nobody walks or rides; people are where the current phase puts them. */
/** `wallNow`: the wall clock for the final frame of a run still parked at a gate (its wait keeps counting), else null. */
export function towerFrame(model: TowerModel, frame: OfficeFrame, t: number, reduced: boolean, wallNow: number | null = null): TowerFrame {
  const back = finalBack(model.back, wallNow);
  const { layout, plan, sched } = model;
  const floorOf = (row: number) => (layout.rows[row] as Row).floor;

  // what is known at the frame: nothing on a rival's floor shows before the rival is named
  const scene = sceneAt({ record: model.inputs.record, view: model.view, calls: model.spans, clockAt: model.clockAt, settledSeq: model.settledSeq }, t);

  // where every agent is
  const agents: Record<string, AgentNow> = {};
  const inCabin: { seat: string; carrying: boolean }[] = [];
  for (const id of plan.order) {
    const seat = plan.seats[id];
    const sf = frame.seats[id];
    if (!seat || !sf || !layout.seats[id]) continue;
    if (!seatKnown(seat, scene)) {
      agents[id] = { seat: id, placement: "absent", activity: "idle", facing: "front", carrying: false, leg: null, present: false, joinedAt: null };
      continue;
    }
    const rider = model.riders[id];
    const joined = sched.presentFrom[id];
    const researcher = seat.role === "researcher";
    let placement: Placement = sf.present ? "seat" : "absent";
    // researchers and the verifier act through the tower's own rooms (the archive, the stamp)
    let activity: Activity = researcher || seat.role === "verifier" ? "idle" : sf.activity;
    let leg: Leg | null = null;
    if (reduced && researcher) {
      const trip = model.trips.find((tr) => tr.seat === id && t >= tr.down && t < tr.up);
      const c = trip ? layout.carrels[trip.slot] : undefined;
      if (trip && c) {
        const at = { x: c.x, y: floorOf(layout.basement) };
        leg = { kind: "stay", start: trip.down, end: trip.up, from: at, to: at, ride: null, carrying: false, carrel: true };
      }
    } else if (reduced && rider?.appear !== null && rider !== undefined) {
      placement = t >= (rider.appear ?? Infinity) ? "seat" : "absent";
    } else if (rider) {
      leg = legAt(rider, t);
      if (!leg && rider.appear !== null) placement = rider.seated !== null && t >= rider.seated ? "seat" : "absent";
    }
    let facing: "front" | "back" = "front";
    if (leg) {
      placement = "move";
      if (leg.kind === "walk") activity = "walking";
      else if (leg.kind === "stay") {
        activity = "browsing";
        facing = "back";
      } else activity = "idle";
      if (leg.kind === "cabin") inCabin.push({ seat: id, carrying: leg.carrying });
    }
    // a model call shows at the desk only: an evaluator still on the way is not yet typing
    if (placement !== "seat" && (activity === "typing" || activity === "sending" || activity === "receiving")) activity = "idle";
    agents[id] = { seat: id, placement, activity, facing, carrying: leg?.carrying ?? false, leg, present: sf.present, joinedAt: joined !== undefined && Number.isFinite(joined) ? joined : null };
  }
  // the verifier stamps on each beat
  let beat: StampBeat | null = null;
  for (const b of model.beats) {
    if (b.start > t) break;
    beat = b;
  }
  // the beat on show counts only the verdicts recorded by now
  if (beat) beat = beatAt(beat, model.verdicts, t);
  const stamping = beat !== null && t - beat.start < STAMP_MS;
  const verifier = agents.verifier;
  if (verifier && stamping) verifier.activity = "stamping";

  // capsules: one per recipient of each message in flight; ratings stay in the penthouse, rejected calls never ran
  const capsules: CapsuleNow[] = [];
  const tubes: Pt[][] = [];
  for (const b of sched.beats) {
    if (b.kind !== "send" || t < b.start) continue;
    const msg = model.messages[b.msgId];
    if (!msg || msg.kind === "rating" || msg.state === "rejected") continue;
    if (t >= b.start + FLIGHT_MS + (b.failed ? JAM_MS : 0)) continue;
    for (const r of b.to) {
      const path = tubePath(layout, b.seat, r);
      if (!path) continue;
      if (reduced) {
        if (t < b.start + FLIGHT_MS) tubes.push(path);
        continue;
      }
      const half = b.failed ? cutPath(path, 0.5) : path;
      capsules.push({ id: `${b.id}>${r}`, msgId: b.msgId, path: half, start: b.start, end: b.start + (b.failed ? FLIGHT_MS / 2 : FLIGHT_MS), kind: msg.kind, failed: b.failed });
    }
  }
  capsules.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));

  // the archive: each lane's carrel and its CRT; each floor's in-tray
  const podIndex = new Map(plan.pods.map((p, i) => [p.key, i]));
  const carrels: CarrelNow[] = layout.carrels.map((c) => ({ slot: c.slot, lane: null, last: null, printed: 0 }));
  const sources: TowerFrame["sources"] = {};
  for (const [lane, list] of Object.entries(model.fetches)) {
    let fetched = 0;
    let ok = 0;
    let last: CarrelNow["last"] = null;
    for (const f of list) {
      if (f.at > t) break;
      fetched += 1;
      if (f.status === "ok") ok += 1;
      last = f;
    }
    sources[lane] = { fetched, ok };
    const carrel = carrels[(podIndex.get(lane) ?? plan.pods.length) % carrels.length];
    if (carrel && carrel.lane === null) Object.assign(carrel, { lane, last, printed: ok });
  }

  // stages at t
  const running = new Set<string>();
  const finished: Record<string, number> = {};
  for (const s of sched.stages) {
    if (s.at > t) break;
    if (s.edge === "started") {
      running.add(s.stage);
      delete finished[s.stage];
    } else {
      running.delete(s.stage);
      finished[s.stage] = s.at;
    }
  }
  const calls = callsAt(model.spans, t);
  const strip = stepStripAt(sched.stages, model.inputs.history, model.gates, t, back);

  // lamps: 2 lit, 1 dim, 0 dark
  const has = (stages: readonly string[]) => stages.some((s) => running.has(s));
  const seated = (pred: (a: AgentNow) => boolean) => Object.values(agents).some((a) => a.placement === "seat" && a.present && a.joinedAt !== null && pred(a));
  const begun = sched.stages.some((s) => s.at <= t) || t >= model.origin;
  const lamps: TowerFrame["lamps"] = {
    lobby: has(["S0", "S1", "S2", "S3"]) ? 2 : begun ? 1 : 0,
    archive: has(["S4", "S5"]) || Object.values(agents).some((a) => a.leg?.carrel) ? 2 : finished.S4 !== undefined ? 1 : 0,
    machine: calls.inFlight.length > 0 ? 2 : calls.started > 0 ? 1 : 0,
    dossier: has(["S6"]) ? 2 : finished.S6 !== undefined ? 1 : 0,
    notary: has(["S7"]) ? 2 : finished.S7 !== undefined ? 1 : 0,
    ledger: has(["S8"]) ? 2 : finished.S8 !== undefined ? 1 : 0,
    red: has(["S9"]) ? 2 : seated((a) => a.seat.startsWith("red_team")) || finished.S9 !== undefined ? 1 : 0,
    home: has(["S9"]) ? 2 : seated((a) => plan.seats[a.seat]?.zone === "analyst") || finished.S9 !== undefined ? 1 : 0,
    penthouse: has(["S10"]) || frame.scores ? 2 : Object.values(agents).some((a) => a.seat.startsWith("board:") && a.placement === "seat") ? 1 : 0,
    deck: has(["S11", "S12", "S13", "S14", "S15"]) ? 2 : finished.S13 !== undefined ? 1 : 0,
  };
  const vacant: string[] = [];
  const sceneRivals = new Set(scene.rivals);
  for (const pod of plan.pods) {
    const room: RoomId = `floor:${pod.key}`;
    if (t < (model.floorFrom[pod.key] ?? -Infinity) || !sceneRivals.has(pod.key)) {
      vacant.push(pod.key);
      lamps[room] = 0;
    } else lamps[room] = has(["S9"]) || (has(["S4"]) && sources[pod.key] !== undefined) ? 2 : 1;
  }

  // popups: factual floating words (a host read, a verdict, a joined agent, a failed message)
  const popups: Popup[] = [];
  const archiveFloor = floorOf(layout.basement);
  for (const c of carrels) {
    if (!c.last || !Number.isFinite(c.last.at) || t - c.last.at >= POPUP_MS) continue;
    const x = layout.carrels[c.slot]?.x ?? 0;
    popups.push({ id: `fetch:${c.slot}:${c.last.at}`, text: c.last.status === "ok" ? c.last.host : c.last.status, x, y: archiveFloor - 50, start: c.last.at, tone: c.last.status === "ok" ? "mono" : "danger" });
  }
  if (beat && t - beat.start < POPUP_MS) {
    const one = beat.total === 1;
    const word = !one ? `${beat.total} checked` : beat.counts.withheld ? "Withheld" : beat.counts.partly ? "Partly" : "Supported";
    popups.push({ id: `verdict:${beat.id}`, text: word, x: 752, y: floorOf(layout.ground) - 58, start: beat.start, tone: one && beat.counts.withheld ? "danger" : "plain" });
  }
  for (const a of Object.values(agents)) {
    if (a.joinedAt === null || t < a.joinedAt || t - a.joinedAt >= JOIN_MS) continue;
    const spot = layout.seats[a.seat];
    if (!spot) continue;
    const walksIn = model.riders[a.seat]?.appear != null;
    popups.push({ id: `joined:${a.seat}`, text: "joined", x: walksIn ? layout.doors.x : spot.x, y: walksIn ? floorOf(layout.ground) - 50 : floorOf(spot.row) - 46, start: a.joinedAt, tone: "signal" });
  }
  for (const c of capsules) {
    if (!c.failed || t < c.end) continue;
    const at = c.path.at(-1);
    if (at) popups.push({ id: `failed:${c.id}`, text: "failed", x: at.x, y: at.y - 8, start: c.end, tone: "danger" });
  }

  // speech bubbles: the latest three messages being sent
  const bubbles: Bubble[] = Object.entries(frame.seats)
    .flatMap(([seat, sf]): Bubble[] => {
      if (!sf.bubble) return [];
      const msg = model.messages[sf.bubble.msgId];
      return [{ seat, msgId: sf.bubble.msgId, text: sf.bubble.text, start: sf.bubble.start, failed: sf.bubble.failed, rejected: msg?.state === "rejected", cites: msg?.cites ?? 0, dropped: msg?.dropped ?? 0, rated: msg?.rated ?? 0 }];
    })
    .sort((a, b) => a.start - b.start)
    .slice(-3);

  const lines: Record<string, string | null> = {};
  const laneTally: TowerFrame["laneTally"] = {};
  for (const pod of plan.pods) {
    lines[pod.key] = laneLineAt(model.inputs.tower, pod.key, model.clockAt, model.settledSeq, t);
    laneTally[pod.key] = tallyAt(model.verdicts, t, pod.key);
  }

  // a run error flashes the room of the step running when it was recorded
  let alarm: TowerFrame["alarm"] = null;
  for (const e of model.inputs.history?.errors ?? []) {
    const at = e.seq > model.settledSeq ? model.clockAt(e.ts) : -Infinity;
    if (t < at || t - at >= ALARM_MS) continue;
    const stage = [...sched.stages].reverse().find((s) => s.at <= at && s.edge === "started")?.stage ?? "S0";
    alarm = { at, room: stageRoom(stage) };
  }

  const cabin = cabinAt(model.lift, layout.rows, t);
  // reduced motion: the cabin stands at the landing nearest it (a jump between floors, never a glide)
  const landing = nearestFloor(layout.rows, cabin.y);
  return {
    t,
    agents,
    cabin: { ride: reduced ? null : cabin.ride, y: reduced ? landing : cabin.y, doorsOpen: cabin.doorsOpen && !reduced, riders: reduced ? [] : inCabin },
    capsules: capsules.slice(-MAX_CAPSULES),
    moreCapsules: Math.max(0, capsules.length - MAX_CAPSULES),
    tubes,
    carrels,
    sources,
    tally: tallyAt(model.verdicts, t),
    laneTally,
    beat: beat && t - beat.start < POPUP_MS ? beat : null,
    stamping,
    calls,
    riser: riserRows(layout, calls.inFlight),
    lamps,
    gates: { h1: gateAt(model.gates.h1, t, back), h2: gateAt(model.gates.h2, t, back) },
    phase: phaseAt(sched.stages, t),
    strip,
    step: runningStep(strip),
    popups,
    bubbles,
    pins: model.pins.filter((p) => p.at <= t),
    scores: frame.scores,
    sent: frame.sent,
    vacant,
    lines,
    running: [...running],
    finished,
    calling: [...new Set(calls.inFlight.map((c) => c.stage))],
    alarm,
    scene,
  };
}

/** The card the hover or focus card shows for a seat: its agent's, only while the agent is present at the frame. */
export function agentCardAt(frame: Pick<TowerFrame, "agents">, plan: Pick<OfficePlan, "seats">, view: Pick<SwarmView, "cards">, seatId: string | null): { card: AgentCard; rival: boolean } | null {
  if (!seatId) return null;
  const seat = plan.seats[seatId];
  const card = seat?.agentId ? view.cards[seat.agentId] : undefined;
  if (!seat || !card || frame.agents[seatId]?.present !== true) return null;
  return { card, rival: seat.zone === "pod" };
}
