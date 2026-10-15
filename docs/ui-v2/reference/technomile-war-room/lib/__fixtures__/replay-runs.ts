/**
 * Test-only helpers for the replay suites: a small synthetic run (a two-hour wait at H1, a one-minute wait at H2)
 * and the recorded NAVSEA SSG run (eb3c3363, 1,069 events, decided) as bh-api served it: every envelope the stream
 * sent from seq 0, and its own /swarm, /snapshot and /inspect answers.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import type { RunEvent, RunEventEnvelope, WarRoomSnapshot } from "@/lib/contracts/run-events";
import { parseInspection, type Inspection } from "@/lib/live/inspect";
import type { RunDetail } from "@/lib/live/types";

import type { ReplaySource } from "../replay";

export const T = Date.parse("2026-10-05T04:00:00.000Z");
export const at = (s: number) => new Date(T + s * 1000).toISOString();

export function env(seq: number, s: number, event: RunEvent): RunEventEnvelope {
  return { seq, runId: "r1", idemKey: `k${seq}`, ts: at(s), event };
}

export const SNAP: WarRoomSnapshot = {
  runId: "r1",
  opportunity: "sam:abc",
  lanes: {
    ACME: { subject: "ACME", label: "ACME", home: false, status: "running", fetches: 0, activity: "" },
    BETA: { subject: "BETA", label: "BETA", home: false, status: "queued", fetches: 0, activity: "" },
  },
  laneOrder: ["ACME", "BETA"],
  columns: [{ key: "corporate", label: "Corporate" }],
  cells: {},
  cost: { usd: 0, capUsd: 9.87 },
  counters: { fetches: 0, rows: 0, claimsChecked: 0, supported: 0, partial: 0, unsupported: 0, withheld: 0 },
  stages: { S0: "done", S3: "done", S4: "running" },
};

/** S0 and S3, a park at H1 for two hours, S4 with one fetch, a park at H2 for a minute, then decided. */
export const SYNTH_ENVS: RunEventEnvelope[] = [
  env(1, 2, { type: "STEP_STARTED", stepName: "S0" }),
  env(2, 2.1, { type: "STATE_DELTA", delta: [{ op: "replace", path: "/stages/S0", value: "running" }] }),
  env(3, 3, { type: "STEP_FINISHED", stepName: "S0", status: "done" }),
  env(4, 3.5, { type: "STEP_STARTED", stepName: "S3" }),
  env(5, 10, { type: "STEP_FINISHED", stepName: "S3", status: "done" }),
  env(6, 10.5, { type: "RUN_FINISHED", threadId: "run:r1", runId: "r1", result: { state: "awaiting_plan_approval" } }),
  env(7, 7213, { type: "STEP_STARTED", stepName: "S4" }),
  env(8, 7213.1, { type: "STATE_DELTA", delta: [{ op: "replace", path: "/lanes/ACME/status", value: "running" }] }),
  env(9, 7213.2, { type: "STATE_SNAPSHOT", snapshot: SNAP }),
  env(10, 7214, {
    type: "ACTIVITY_SNAPSHOT",
    messageId: "f1",
    activityType: "fetch",
    content: { subject: "ACME", evidenceId: "e1", host: "api.sam.gov", sourceType: "sam.entity", tier: "other", status: "ok", column: "corporate" },
  }),
  env(11, 7214.1, { type: "STATE_DELTA", delta: [{ op: "replace", path: "/counters/fetches", value: 1 }] }),
  env(12, 7220, { type: "STEP_FINISHED", stepName: "S4", status: "done" }),
  env(13, 7221, { type: "RUN_FINISHED", threadId: "run:r1", runId: "r1", result: { state: "awaiting_decision" } }),
];

export const SYNTH: ReplaySource = {
  runId: "r1",
  run: { createdAt: at(0), terminalAt: at(7281), status: "decided", capUsd: "10.000000", opportunityRef: "sam:abc" },
  approvals: [
    { gate: "h1", createdAt: at(7210.5), subjects: ["ACME", " BETA ", "ACME"] },
    { gate: "h2", createdAt: at(7281) },
  ],
  envs: SYNTH_ENVS,
};

export function synthInspection(): Inspection {
  const call = (s: number, stage: string, usd: number) => ({
    createdAt: at(s),
    stage,
    phase: "execute",
    purpose: null,
    provider: "vertex",
    endpoint: "vertex",
    free: false,
    model: "m",
    inputTokens: 10,
    outputTokens: 5,
    usd,
    latencyMs: 100,
    status: "ok",
    errorKind: null,
    errorDetail: null,
  });
  return {
    run: { status: "decided", createdAt: at(0), endedAt: at(7281), durationMs: 7281_000, usd: 0.035, capUsd: 10, calls: 3, inputTokens: 30, outputTokens: 15 },
    stages: [
      { stage: "S0", startedAt: at(2), endedAt: at(3), durationMs: 1000, status: "done", usd: 0, calls: 0 },
      { stage: "S3", startedAt: at(3.5), endedAt: at(10), durationMs: 6500, status: "done", usd: 0.01, calls: 1 },
      { stage: "S4", startedAt: at(7213), endedAt: at(7220), durationMs: 7000, status: "done", usd: 0.025, calls: 2 },
    ],
    calls: [call(5, "S3", 0.01), call(7215, "S4", 0.02), call(7219, "S4", 0.005)],
  };
}

export function synthDetail(): RunDetail {
  return {
    run: {
      id: "r1",
      orgId: "o1",
      createdBy: "u1",
      mine: true,
      opportunityRef: "sam:abc",
      awardMode: "single_award",
      preset: "standard",
      status: "decided",
      currentPhase: "execute",
      generation: 0,
      lastEventSeq: 13,
      capUsd: "10.000000",
      h1PlanSha256: null,
      policyVersion: "p",
      createdAt: at(0),
      updatedAt: at(7281),
      terminalAt: at(7281),
      title: "A notice",
      stage: { id: "S4", state: "finished", outcome: "done" },
    },
    phases: [],
    launches: [],
    approvals: [
      { gate: "h1", approvedBy: "u1", createdAt: at(7210.5), subjects: ["ACME", "BETA"] },
      { gate: "h2", approvedBy: "u1", createdAt: at(7281), decision: "bid" },
    ],
    launcher: "local",
  };
}

export interface RecordedRun {
  runId: string;
  run: { createdAt: string; terminalAt: string | null; status: string; capUsd: string; opportunityRef: string; awardMode: string; lastEventSeq: number; title: string | null };
  approvals: { gate: string; createdAt: string; subjects?: string[]; decision?: string }[];
  envelopes: unknown[];
  swarm: { status: string; events: unknown[] };
  snapshot: { seq: number; snapshot: WarRoomSnapshot; run: { status: string }; activeStage: unknown; lastEventAt: string | null };
  inspect: unknown;
}

/** The recorded NAVSEA SSG run (fixture built from the local bh-api's answers; no user ids, emails or rationale). */
export function navsea(): { raw: RecordedRun; inspection: Inspection } {
  const raw = JSON.parse(gunzipSync(readFileSync(new URL("./run-navsea-ssg.json.gz", import.meta.url))).toString("utf8")) as RecordedRun;
  const inspection = parseInspection(raw.inspect);
  if (!inspection) throw new Error("the fixture's inspection does not parse");
  return { raw, inspection };
}
