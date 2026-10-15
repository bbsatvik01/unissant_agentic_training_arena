/**
 * Test-only: the recorded NAVSEA SSG run (eb3c3363) laid out as the Bid Tower draws it, the way the Bid Tower office
 * style wires it (fold the envelopes, plan the office, build the building, the schedule and the tower model), on the
 * exact clock (one recorded second is one displayed second) or on the office replay clock (quiet stretches cut).
 */
import { parseEnvelope, type RunEventEnvelope } from "@/lib/contracts/run-events";
import { foldHistory, type Approvals } from "@/lib/pipeline/rail";

import { buildSchedule, foldOffice, frameAt, planOffice, replayClock, warpKeys } from "../office";
import { mergeEnvelopes } from "../replay";
import { foldSwarm, parseSwarmBody } from "../swarm";
import { buildModel, towerFrame, type TowerFrame } from "../tower/frame";
import { buildTower } from "../tower/layout";
import { foldTower } from "../tower/record";
import { exactClock, LEAD_MS, runBounds, towerWarpKeys, type TowerInputs } from "../tower/world";

import { navsea } from "./replay-runs";

export type ClockKind = "exact" | "replay";

export function navseaEnvelopes(): RunEventEnvelope[] {
  const { raw } = navsea();
  const envs = raw.envelopes.map((e) => parseEnvelope(JSON.stringify(e))).filter((e): e is RunEventEnvelope => e !== null);
  return mergeEnvelopes(envs, parseSwarmBody(raw.swarm).envelopes);
}

export interface TowerRunOptions {
  clock?: ClockKind;
  /** History up to this sequence number is already in place when the tower opens (a live view opened mid-run). */
  settledSeq?: number;
  /** Leave the H2 decision unrecorded: the run is still parked at its last gate. */
  parkedAtH2?: boolean;
}

export function navseaTower({ clock: kind = "exact", settledSeq = 0, parkedAtH2 = false }: TowerRunOptions = {}) {
  const { raw, inspection } = navsea();
  const envs = navseaEnvelopes();
  const view = foldSwarm(envs);
  const record = foldOffice(envs);
  const history = foldHistory(envs);
  const tower = foldTower(envs);
  const gate = (id: string) => raw.approvals.find((a) => a.gate === id);
  const approvals: Approvals = { h1: { at: gate("h1")?.createdAt ?? null }, h2: parkedAtH2 ? null : { at: gate("h2")?.createdAt ?? null } };
  const inputs: TowerInputs = { view, record, tower, history, approvals, calls: inspection.calls };
  const plan = planOffice(view, record);
  const layout = buildTower(plan);
  const bounds = runBounds(inputs);
  if (!bounds) throw new Error("the fixture has no recorded moments");
  const timeline = replayClock([...warpKeys(view, record), ...towerWarpKeys(tower, inspection.calls, history, approvals)]);
  const exact = exactClock(bounds.start);
  const clock = kind === "exact" ? exact : timeline;
  const back = kind === "exact" ? (d: number) => d + bounds.start - LEAD_MS : timeline.recordedAt;
  const sched = buildSchedule(plan, view, record, clock, settledSeq);
  const model = buildModel({ inputs, layout, plan, sched, clock, settledSeq, origin: clock.at(bounds.start), end: Math.max(sched.end, clock.at(bounds.end)), back });
  const frame = (t: number, reduced = false, wallNow: number | null = null): TowerFrame => towerFrame(model, frameAt(plan, sched, t), t, reduced, wallNow);
  return { raw, inspection, envs, inputs, plan, layout, bounds, clock, back, sched, model, frame };
}
