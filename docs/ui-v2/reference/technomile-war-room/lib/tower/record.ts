/**
 * The Bid Tower's own read of the run's events, beside the office's (`foldOffice`): the facts the tower draws that
 * the office record does not keep. Every field is a recorded event; nothing is inferred:
 *
 * - when each research lane was first named (its floor stops reading "Vacant"),
 * - each lane's activity lines and status changes (`STATE_DELTA` `/lanes/<subject>/activity|status`): the rival's
 *   researcher works in the archive while its lane runs, and the floor's ticker shows the lane's own lines, so the
 *   quiet minute of S6 dossier drafting is narrated by what the run recorded,
 * - every S7 verdict with its `sourceUnreachable` flag and the rival it belongs to: the verdict's own paired cell
 *   delta (idem key `<verdict key>:delta`, `/cells/<subject>:<column>`) names the rival; without one the verdict stays
 *   unattributed,
 * - the run's first recorded event (the lobby lights) and any `RUN_STARTED` phase starts.
 */
import type { LaneStatus, RunEventEnvelope } from "@/lib/contracts/run-events";

import { podKey, VERDICT, type Verdict } from "../office";

export interface LaneLine {
  seq: number;
  ts: number;
  text: string;
}

export interface LaneMark {
  seq: number;
  ts: number;
  status: LaneStatus;
}

export interface TowerVerdict {
  seq: number;
  ts: number;
  verdict: Verdict;
  unreachable: boolean;
  /** The rival's pod key, from the verdict's paired cell delta; null when no delta names one. */
  lane: string | null;
}

export interface Recorded {
  seq: number;
  ts: number;
}

export interface TowerRecord {
  /** When each lane (by pod key) was first named: by the run's snapshot or a fetch. */
  laneSeen: Record<string, Recorded>;
  /** Each lane's activity lines in ledger order. */
  lines: Record<string, LaneLine[]>;
  /** Each lane's status changes in ledger order. */
  marks: Record<string, LaneMark[]>;
  verdicts: TowerVerdict[];
  /** The run's first recorded event of any kind. */
  first: Recorded | null;
  /** The run's last recorded event of any kind. */
  last: Recorded | null;
  /** `RUN_STARTED` frames (a phase began). */
  starts: (Recorded & { phase: string })[];
}

export const EMPTY_TOWER: TowerRecord = { laneSeen: {}, lines: {}, marks: {}, verdicts: [], first: null, last: null, starts: [] };

const LANE_PATH = /^\/lanes\/(.+)\/(activity|status)$/;
const CELL_PATH = /^\/cells\/(.+)$/;
const STATUSES: ReadonlySet<string> = new Set(["queued", "running", "done", "degraded", "ended"]);

/** One JSON-pointer token, unescaped (`~1` is "/", `~0` is "~"). */
export function unpoint(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** The rival a cell path names (`/cells/<subject>:<column>`), as a pod key; null for any other path. */
export function cellLane(path: string): string | null {
  const m = CELL_PATH.exec(path);
  if (!m) return null;
  const key = unpoint(m[1] ?? "");
  const cut = key.lastIndexOf(":");
  return cut > 0 ? podKey(key.slice(0, cut)) : null;
}

/** The events the tower keeps from the run's stream beyond the office's own: lane and cell deltas, phase starts. */
export function isTowerEvent(env: RunEventEnvelope): boolean {
  const ev = env.event;
  if (ev.type === "RUN_STARTED") return true;
  if (ev.type !== "STATE_DELTA") return false;
  return ev.delta.some((op) => LANE_PATH.test(op.path) || CELL_PATH.test(op.path));
}

/** Fold envelopes (any order, duplicates allowed; frames without a readable time skipped) into the tower record. */
export function foldTower(envs: readonly RunEventEnvelope[]): TowerRecord {
  const out: TowerRecord = { laneSeen: {}, lines: {}, marks: {}, verdicts: [], first: null, last: null, starts: [] };
  const seen = new Set<number>();
  const sorted = [...envs].sort((a, b) => a.seq - b.seq);
  // each verdict's own cell delta (idem key `<verdict key>:delta`, recorded with it) names the verdict's rival
  const laneOfDelta = new Map<string, string>();
  for (const env of sorted) {
    if (env.event.type !== "STATE_DELTA" || !env.idemKey.endsWith(":delta")) continue;
    for (const op of env.event.delta) {
      const lane = cellLane(op.path);
      if (lane) {
        laneOfDelta.set(env.idemKey.slice(0, -":delta".length), lane);
        break;
      }
    }
  }
  const see = (key: string, at: Recorded) => {
    if (!out.laneSeen[key]) out.laneSeen[key] = at;
  };
  for (const env of sorted) {
    if (seen.has(env.seq)) continue;
    seen.add(env.seq);
    const ts = Date.parse(env.ts);
    if (!Number.isFinite(ts)) continue;
    const at = { seq: env.seq, ts };
    out.first ??= at;
    out.last = at;
    const ev = env.event;
    if (ev.type === "RUN_STARTED") {
      out.starts.push({ ...at, phase: ev.phase });
    } else if (ev.type === "STATE_SNAPSHOT") {
      for (const subject of ev.snapshot.laneOrder) {
        const lane = ev.snapshot.lanes[subject];
        if (lane) see(podKey(lane.subject), at);
      }
    } else if (ev.type === "ACTIVITY_SNAPSHOT" && ev.activityType === "fetch") {
      see(podKey(ev.content.subject), at);
    } else if (ev.type === "ACTIVITY_SNAPSHOT" && ev.activityType === "verify") {
      out.verdicts.push({ ...at, verdict: VERDICT[ev.content.verdict], unreachable: ev.content.sourceUnreachable, lane: laneOfDelta.get(env.idemKey) ?? null });
    } else if (ev.type === "STATE_DELTA") {
      for (const op of ev.delta) {
        const m = LANE_PATH.exec(op.path);
        if (!m) continue;
        const key = podKey(unpoint(m[1] ?? ""));
        if (m[2] === "activity" && typeof op.value === "string" && op.value.trim() !== "") {
          (out.lines[key] ??= []).push({ ...at, text: op.value.trim() });
        } else if (m[2] === "status" && typeof op.value === "string" && STATUSES.has(op.value)) {
          (out.marks[key] ??= []).push({ ...at, status: op.value as LaneStatus });
        }
      }
    }
  }
  return out;
}

/** The latest of a list (ordered by seq) recorded at or before display time `t`, given each item's display time. */
export function latestAt<T>(items: readonly T[] | undefined, at: (item: T) => number, t: number): T | null {
  if (!items) return null;
  let found: T | null = null;
  for (const it of items) {
    if (at(it) > t) break;
    found = it;
  }
  return found;
}
