import { describe, expect, it } from "vitest";

import { parseEnvelope, type RunEventEnvelope } from "@/lib/contracts/run-events";
import { foldHistory } from "@/lib/pipeline/rail";

import { at, env, navsea, SNAP, SYNTH, SYNTH_ENVS, synthDetail, synthInspection, T } from "./__fixtures__/replay-runs";
import { foldOffice } from "./office";
import {
  activity,
  advance,
  baseView,
  buildTimeline,
  cursorAt,
  detailAt,
  inspectAt,
  jumpFrom,
  jumpMarks,
  mergeEnvelopes,
  phaseSpans,
  playbackMap,
  replayStart,
  segmentAt,
  spendAt,
  spendIndex,
  stageEdgeAt,
  statusAt,
  trackSegments,
  withApprovedLanes,
  withRunStatus,
  withSpend,
  type Timeline,
} from "./replay";
import { emptyStore, seedFromSnapshot } from "./state";
import { foldSwarm, parseSwarmBody } from "./swarm";

const s = (sec: number) => T + sec * 1000;

function synth(): Timeline {
  const tl = buildTimeline(SYNTH);
  if (!tl) throw new Error("no timeline");
  return tl;
}

describe("buildTimeline", () => {
  it("lays the record on the run's own clock: stages, gates and the status at each moment", () => {
    const tl = synth();
    expect(tl.t0).toBe(T);
    expect(tl.end).toBe(s(7281));
    expect(tl.envs.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(tl.times[0]).toBe(s(2));
    expect(tl.stages.map((x) => [x.id, (x.start - T) / 1000, x.end === null ? null : (x.end.at - T) / 1000, x.end?.status])).toEqual([
      ["S0", 2, 3, "done"],
      ["S3", 3.5, 10, "done"],
      ["S4", 7213, 7220, "done"],
    ]);
    expect(tl.gates).toEqual([
      { id: "H1", state: "awaiting_plan_approval", parkAt: s(10.5), actedAt: s(7210.5), recordedActedAt: s(7210.5), waitMs: 7_200_000 },
      { id: "H2", state: "awaiting_decision", parkAt: s(7221), actedAt: s(7281), recordedActedAt: s(7281), waitMs: 60_000 },
    ]);
    expect(tl.h1).toEqual({ at: s(7210.5), subjects: ["ACME", "BETA"] });
    expect(tl.capUsd).toBe(10);
    expect(tl.marks.map((m) => [(m.at - T) / 1000, m.status])).toEqual([
      [0, "starting"],
      [2, "running"],
      [10.5, "awaiting_plan_approval"],
      [7210.5, "starting"],
      [7213, "running"],
      [7221, "awaiting_decision"],
      [7281, "decided"],
    ]);
    expect(statusAt(tl, s(1))).toBe("starting");
    expect(statusAt(tl, s(5))).toBe("running");
    expect(statusAt(tl, s(3600))).toBe("awaiting_plan_approval");
    expect(statusAt(tl, s(7212))).toBe("starting");
    expect(statusAt(tl, s(7250))).toBe("awaiting_decision");
    expect(statusAt(tl, s(9999))).toBe("decided");
  });

  it("shows the run's real status from the end of the record on", () => {
    const tl = buildTimeline({ ...SYNTH, run: { ...SYNTH.run, status: "interrupted", terminalAt: null }, approvals: SYNTH.approvals.slice(0, 1) });
    expect(tl?.end).toBe(s(7221));
    expect(tl?.gates.at(-1)).toEqual({ id: "H2", state: "awaiting_decision", parkAt: s(7221), actedAt: null, recordedActedAt: null, waitMs: 0 });
    expect(tl && statusAt(tl, s(7220))).toBe("running");
    expect(tl && statusAt(tl, s(7221))).toBe("interrupted");
  });

  it("starts at the first event without a creation time, fills unreadable times and keeps one envelope per seq", () => {
    const envs = [env(2, 5, { type: "STEP_STARTED", stepName: "S1" }), { ...env(1, 4, { type: "STEP_STARTED", stepName: "S0" }), ts: "not a time" }, env(2, 6, { type: "STEP_FINISHED", stepName: "S1" })];
    const tl = buildTimeline({ runId: "x", run: { createdAt: null, terminalAt: null, status: "failed", capUsd: "n/a", opportunityRef: "o" }, approvals: [], envs });
    expect(tl?.t0).toBe(s(6));
    expect(tl?.times).toEqual([s(6), s(6)]);
    expect(tl?.envs.map((e) => e.seq)).toEqual([1, 2]);
    expect(tl?.capUsd).toBe(0);
    expect(tl?.gates).toEqual([]);
    expect(tl?.h1).toBeNull();
    expect(buildTimeline({ runId: "x", run: { createdAt: null, terminalAt: null, status: "failed", capUsd: 0, opportunityRef: "o" }, approvals: [], envs: [] })).toBeNull();
  });

  it("marks a failed phase, a restart after it, and a park whose approval is missing", () => {
    const envs = [
      env(1, 1, { type: "STEP_STARTED", stepName: "S0" }),
      env(2, 2, { type: "RUN_ERROR", message: "phase failed (x)", code: "x" }),
      env(3, 3, { type: "STATE_DELTA", delta: [{ op: "replace", path: "/cost/usd", value: 0 }] }),
      env(4, 4, { type: "STEP_STARTED", stepName: "S0" }),
      env(5, 5, { type: "RUN_FINISHED", threadId: "t", runId: "x", result: { state: "awaiting_plan_approval" } }),
      env(6, 6, { type: "RUN_FINISHED", threadId: "t", runId: "x", result: { state: "awaiting_plan_approval" } }),
      env(7, 7, { type: "RUN_FINISHED", threadId: "t", runId: "x", result: { state: "cancelled" } }),
      env(8, 9, { type: "STEP_STARTED", stepName: "S4" }),
    ];
    const tl = buildTimeline({ runId: "x", run: { createdAt: at(0), terminalAt: null, status: "running", capUsd: 4, opportunityRef: "o" }, approvals: [], envs });
    expect(tl?.marks.map((m) => [(m.at - T) / 1000, m.status])).toEqual([
      [0, "starting"],
      [1, "running"],
      [2, "failed"],
      [4, "running"],
      [5, "awaiting_plan_approval"],
      [9, "running"],
    ]);
    // both attempts of S0 stay on the record: the failed one and the restart
    expect(tl?.stages.filter((x) => x.id === "S0").map((x) => x.start)).toEqual([s(1), s(4)]);
    // without an approval, the gate's park is its last closing event and the wait runs to the end of the record
    expect(tl?.gates).toEqual([{ id: "H1", state: "awaiting_plan_approval", parkAt: s(6), actedAt: null, recordedActedAt: null, waitMs: 3000 }]);
  });

  it("keeps each attempt of a retried stage on the track and in the run row as of its time", () => {
    const envs = [
      env(1, 1, { type: "STEP_STARTED", stepName: "S0" }),
      env(2, 2, { type: "RUN_ERROR", message: "failed", code: "x" }),
      env(3, 3, { type: "STEP_STARTED", stepName: "S0" }),
      env(4, 4, { type: "STEP_FINISHED", stepName: "S0", status: "done" }),
    ];
    const tl = buildTimeline({ ...SYNTH, envs });
    if (!tl) throw new Error("no timeline");
    expect(tl.stages.map((x) => [x.id, (x.start - T) / 1000, x.end ? (x.end.at - T) / 1000 : null])).toEqual([
      ["S0", 1, null],
      ["S0", 3, 4],
    ]);
    expect(stageEdgeAt(tl, s(1.5))).toEqual({ id: "S0", state: "running" });
    expect(trackSegments(tl).filter((x) => x.id === "S0").map((x) => (x.r0 - T) / 1000)).toEqual([1, 3]);
    expect(jumpMarks(tl)).toContain(s(1));
  });

  it("keeps a stage's recorded time when the record steps back, delivering the event after the one before it", () => {
    const envs = [env(1, 2, { type: "STEP_STARTED", stepName: "S0" }), env(2, 1.9, { type: "STEP_STARTED", stepName: "S1" })];
    const tl = buildTimeline({ ...SYNTH, envs });
    expect(tl?.times[1]).toBe(s(2));
    expect(tl?.envs[1]?.ts).toBe(at(1.9));
    expect(tl?.stages.find((x) => x.id === "S1")?.start).toBe(s(1.9));
  });

  it("takes an approval recorded before its park as acted at the park", () => {
    const tl = buildTimeline({ ...SYNTH, approvals: [{ gate: "h1", createdAt: at(1) }] });
    // the replay applies it at the park, while the approval's own recorded time is kept for display
    expect(tl?.gates[0]).toMatchObject({ parkAt: s(10.5), actedAt: s(10.5), recordedActedAt: s(1), waitMs: 0 });
  });
});

describe("mergeEnvelopes and cursorAt", () => {
  it("keeps one envelope per seq, the preferred read winning", () => {
    const a = env(1, 1, { type: "CUSTOM", name: "ACTIVITY_SNAPSHOT", value: { oversize: true } });
    const b = env(1, 1, { type: "STEP_STARTED", stepName: "S9" });
    expect(mergeEnvelopes([env(2, 2, { type: "STEP_STARTED", stepName: "S1" }), a], [b])).toEqual([b, env(2, 2, { type: "STEP_STARTED", stepName: "S1" })]);
  });

  it("counts the envelopes recorded by a time", () => {
    const tl = synth();
    expect(cursorAt(tl, s(0))).toBe(0);
    expect(cursorAt(tl, s(2))).toBe(1);
    expect(cursorAt(tl, s(3600))).toBe(6);
    expect(cursorAt(tl, s(99_999))).toBe(13);
  });
});

describe("playbackMap", () => {
  it("plays machine time as recorded and a long gate wait in three seconds, never moving a recorded time", () => {
    const tl = synth();
    const map = playbackMap(tl, { includeWaits: false });
    // 10.5 s before H1, 3 s for the two-hour wait, 10.5 s of research, 3 s for the one-minute H2 wait
    expect(map.duration).toBe(27_000);
    expect(map.collapsed.map((g) => g.id)).toEqual(["H1", "H2"]);
    expect(map.toPlay(s(10.5))).toBe(10_500);
    expect(map.toPlay(s(7210.5))).toBe(13_500);
    expect(map.toPlay(s(7213))).toBe(16_000);
    expect(map.toRecorded(12_000)).toBe(s(3610.5));
    expect(map.toRecorded(13_500)).toBe(s(7210.5));
    expect(map.toPlay(s(-5))).toBe(0);
    expect(map.toRecorded(99_999)).toBe(s(7281));
    for (const r of tl.times) expect(map.toRecorded(map.toPlay(r))).toBeCloseTo(r, 3);
  });

  it("plays every wait in full when waits are included, and never stretches a short one", () => {
    const tl = synth();
    expect(playbackMap(tl, { includeWaits: true }).duration).toBe(7_281_000);
    const map = playbackMap(tl, { includeWaits: false, gateMs: 90_000 });
    expect(map.collapsed.map((g) => g.id)).toEqual(["H1"]);
    expect(map.duration).toBe(10_500 + 90_000 + 70_500);
  });

  it("collapses a wait the run never left (cancelled while parked) to the end of the record", () => {
    const tl = buildTimeline({ ...SYNTH, approvals: [{ gate: "h1", createdAt: at(7210.5), subjects: ["ACME", 7] }], run: { ...SYNTH.run, status: "cancelled", terminalAt: at(9000) } });
    if (!tl) throw new Error("no timeline");
    expect(tl.h1?.subjects).toEqual(["ACME"]);
    expect(tl.gates.at(-1)).toMatchObject({ id: "H2", actedAt: null, waitMs: 1779_000 });
    const map = playbackMap(tl, { includeWaits: false });
    expect(map.knots.at(-1)).toEqual({ r: s(9000), p: 27_000 });
    expect(map.toRecorded(27_000)).toBe(s(9000));
    expect(statusAt(tl, s(8000))).toBe("awaiting_decision");
    expect(statusAt(tl, s(9000))).toBe("cancelled");
  });

  it("collapses a gate parked at the very start without a zero-length span", () => {
    const envs = [env(1, 0, { type: "RUN_FINISHED", threadId: "t", runId: "x", result: { state: "awaiting_plan_approval" } }), env(2, 100, { type: "STEP_STARTED", stepName: "S4" })];
    const tl = buildTimeline({ runId: "x", run: { createdAt: at(0), terminalAt: null, status: "interrupted", capUsd: 1, opportunityRef: "o" }, approvals: [{ gate: "h1", createdAt: at(90) }], envs });
    if (!tl) throw new Error("no timeline");
    const map = playbackMap(tl, { includeWaits: false });
    expect(map.knots).toEqual([
      { r: T, p: 0 },
      { r: s(90), p: 3000 },
      { r: s(100), p: 13_000 },
    ]);
    expect(map.toRecorded(1500)).toBe(s(45));
  });

  it("maps a zero-length record to the start", () => {
    const tl = buildTimeline({ runId: "x", run: { createdAt: at(1), terminalAt: null, status: "failed", capUsd: 1, opportunityRef: "o" }, approvals: [], envs: [] });
    if (!tl) throw new Error("no timeline");
    const map = playbackMap(tl, { includeWaits: false });
    expect(map.duration).toBe(0);
    expect(map.toRecorded(50)).toBe(s(1));
    expect(map.toPlay(s(1))).toBe(0);
  });
});

describe("the store as of a cursor", () => {
  it("starts from bh-api's base view and adds the approved lanes at H1's recorded time", () => {
    const tl = synth();
    const start = replayStart(tl);
    expect(start.store.view).toEqual(baseView(tl));
    const before = advance(start, tl, 6, s(3600));
    expect(before.store.view?.laneOrder).toEqual([]);
    expect(before.store.view?.stages).toEqual({ S0: "done", S3: "done" });
    expect(before.lanes).toBe(false);
    // the approval with no event after it yet: the lanes are there, queued
    const approved = advance(before, tl, 6, s(7211));
    expect(approved.store.view?.laneOrder).toEqual(["ACME", "BETA"]);
    expect(approved.store.view?.lanes.BETA?.status).toBe("queued");
    // the lane delta recorded after the approval applies to those lanes (no repair needed)
    const s4 = advance(start, tl, 8, s(7213.1));
    expect(s4.store.view?.lanes.ACME?.status).toBe("running");
    expect(s4.store.rejectedPatches).toBe(0);
    const all = advance(start, tl, 13, tl.end);
    expect(all.store.view?.counters.fetches).toBe(1);
    expect(all.store.view?.laneOrder).toEqual(SNAP.laneOrder);
    expect(all.k).toBe(13);
    // a cursor never moves back
    expect(advance(all, tl, 3, tl.end)).toEqual({ ...all });
  });

  it("folds to the same store whether played in batches or rebuilt by a seek (seek correctness)", () => {
    const tl = synth();
    for (let k = 0; k <= tl.envs.length; k += 1) {
      const r = k === 0 ? tl.t0 : (tl.times[k - 1] ?? tl.t0);
      let cur = replayStart(tl);
      for (let i = 1; i <= k; i += 1) cur = advance(cur, tl, i, i === k ? r : (tl.times[i - 1] ?? tl.t0));
      expect(cur).toEqual(advance(replayStart(tl), tl, k, r));
    }
  });

  it("gives the views the run's status and the calls' spend at the cursor", () => {
    const store = { ...emptyStore(), view: SNAP, currentStage: "S4" as const };
    expect(withRunStatus(store, "running")).toMatchObject({ status: "running", finalState: null, currentStage: "S4" });
    const running = withRunStatus(store, "starting");
    expect(withRunStatus(running, "running")).toBe(running);
    expect(withRunStatus(store, "awaiting_decision")).toMatchObject({ status: "finished", finalState: "awaiting_decision", currentStage: null });
    expect(withRunStatus({ ...store, error: "boom" }, "failed")).toMatchObject({ status: "error", error: "boom", finalState: "failed" });
    expect(withRunStatus(store, "failed").error).toBe("the run failed");
    expect(withSpend(store, 0.5, 10).view?.cost).toEqual({ usd: 0.5, capUsd: 10 });
    expect(withSpend(emptyStore(), 1, 1)).toEqual(emptyStore());
    expect(withApprovedLanes(store, ["X"])).toBe(store);
    expect(withApprovedLanes(emptyStore(), ["X"])).toEqual(emptyStore());
  });
});

describe("spend, the run row and the inspector as of a time", () => {
  it("counts each call's cost from its receipt's recorded time", () => {
    const i = synthInspection();
    const idx = spendIndex([...i.calls, { createdAt: null, usd: 9 }, { createdAt: at(7300), usd: Number.NaN }]);
    expect(spendAt(idx, s(4))).toBe(0);
    expect(spendAt(idx, s(5))).toBe(0.01);
    expect(spendAt(idx, s(7216))).toBe(0.03);
    expect(spendAt(idx, s(9999))).toBe(0.035);
  });

  it("holds back what the run had not recorded yet: approvals, title, status, last seq, stage", () => {
    const tl = synth();
    const d = synthDetail();
    const early = detailAt(d, tl, 2, s(2.5));
    expect(early.run).toMatchObject({ status: "running", lastEventSeq: 2, title: null, terminalAt: null, stage: { id: "S0", state: "running" }, updatedAt: at(2.1) });
    expect(early.approvals).toEqual([]);
    const waiting = detailAt(d, tl, 6, s(3600));
    expect(waiting.run).toMatchObject({ status: "awaiting_plan_approval", title: "A notice", stage: { id: "S3", state: "finished", outcome: "done" } });
    expect(detailAt(d, tl, 13, s(7250)).approvals.map((a) => a.gate)).toEqual(["h1"]);
    expect(detailAt(d, tl, 0, s(0)).run.updatedAt).toBe(at(0));
    expect(detailAt(d, tl, 13, tl.end)).toBe(d);
    expect(stageEdgeAt(tl, s(1))).toBeNull();
    const untitled = { ...d.run };
    delete untitled.title;
    expect(detailAt({ ...d, run: untitled }, tl, 6, s(3600)).run.title).toBeNull();
    expect(detailAt({ ...d, approvals: [{ gate: "h1", approvedBy: "u1", createdAt: null }] }, tl, 13, s(7250)).approvals).toEqual([]);
  });

  it("rebuilds the inspector's totals and each stage's time and spend so far", () => {
    const tl = synth();
    const full = synthInspection();
    const mid = inspectAt(full, tl, s(7216));
    expect(mid.run).toMatchObject({ status: "running", usd: 0.03, calls: 2, inputTokens: 20, outputTokens: 10, durationMs: 7_216_000, endedAt: null });
    expect(mid.stages.map((x) => [x.stage, x.status, x.durationMs, x.usd, x.calls])).toEqual([
      ["S0", "done", 1000, 0, 0],
      ["S3", "done", 6500, 0.01, 1],
      ["S4", "running", 3000, 0.02, 1],
    ]);
    const parked = inspectAt(full, tl, s(3600));
    expect(parked.stages.map((x) => x.stage)).toEqual(["S0", "S3"]);
    expect(inspectAt({ ...full, stages: [...full.stages, { stage: "S9", startedAt: null, endedAt: null, durationMs: null, status: "x", usd: 0, calls: 0 }] }, tl, s(7216)).stages).toHaveLength(3);
    // a call billed to a stage the record never started still counts for that stage
    const orphan = { ...full, calls: [...full.calls, { ...full.calls[0], createdAt: at(6), stage: "S2", usd: 0.004 } as (typeof full.calls)[number]], stages: [...full.stages, { stage: "S2", startedAt: null, endedAt: null, durationMs: null, status: "x", usd: 0.004, calls: 1 }] };
    expect(inspectAt(orphan, tl, s(7)).stages.find((x) => x.stage === "S2")).toMatchObject({ startedAt: null, durationMs: null, status: "running", usd: 0.004, calls: 1 });
    const stopped = buildTimeline({ ...SYNTH, run: { ...SYNTH.run, status: "interrupted", terminalAt: null }, envs: SYNTH_ENVS.slice(0, 11), approvals: SYNTH.approvals.slice(0, 1) });
    if (!stopped) throw new Error("no timeline");
    expect(inspectAt(full, stopped, s(7214)).stages.at(-1)?.status).toBe("running");
    expect(inspectAt(full, tl, tl.end)).toBe(full);
  });
});

describe("activity along the track", () => {
  it("counts the envelopes in each stretch of playback time", () => {
    const tl = synth();
    const map = playbackMap(tl, { includeWaits: false });
    const b = activity(tl, map, 27);
    expect(b).toHaveLength(27);
    expect(b.reduce((x, y) => x + y, 0)).toBe(13);
    // 2 s and 2.1 s fall in the third second; S4's start, delta and snapshot in the 17th (after the collapsed H1
    // wait); the H2 park in the 25th; nothing during the collapsed H2 wait at the end
    expect(b[2]).toBe(2);
    expect(b[16]).toBe(3);
    expect(b[24]).toBe(1);
    expect(b[26]).toBe(0);
    expect(activity(tl, { ...map, duration: 0 }, 0)).toEqual([0]);
  });
});

describe("navigation and the track", () => {
  it("jumps between stage starts, gates and the ends", () => {
    const tl = synth();
    expect(jumpMarks(tl).map((m) => (m - T) / 1000)).toEqual([0, 2, 3.5, 10.5, 7210.5, 7213, 7221, 7281]);
    expect(jumpFrom(tl, s(2.5), 1)).toBe(s(3.5));
    expect(jumpFrom(tl, s(3.5), 1)).toBe(s(10.5));
    expect(jumpFrom(tl, s(7281), 1)).toBe(s(7281));
    // just past a mark, back goes to the one before it
    expect(jumpFrom(tl, s(4), -1)).toBe(s(2));
    expect(jumpFrom(tl, s(6), -1)).toBe(s(3.5));
    expect(jumpFrom(tl, s(1), -1)).toBe(T);
  });

  it("draws one segment per stage that ran and per gate wait, grouped into phases", () => {
    const tl = synth();
    const seg = trackSegments(tl);
    expect(seg.map((x) => [x.kind, x.id, x.phase, (x.r0 - T) / 1000, (x.r1 - T) / 1000, x.status])).toEqual([
      ["stage", "S0", "intake", 2, 3, "done"],
      ["stage", "S3", "intake", 3.5, 10, "done"],
      ["gate", "H1", "intake", 10.5, 7210.5, "approved"],
      ["stage", "S4", "research", 7213, 7220, "done"],
      ["gate", "H2", "decide", 7221, 7281, "approved"],
    ]);
    expect(phaseSpans(seg).map((p) => [p.label, (p.r0 - T) / 1000, (p.r1 - T) / 1000])).toEqual([
      ["Intake", 2, 7210.5],
      ["Research", 7213, 7220],
      ["Decide", 7221, 7281],
    ]);
    expect(segmentAt(seg, s(3600))?.id).toBe("H1");
    expect(segmentAt(seg, s(7212))).toBeNull();
    const open = buildTimeline({ ...SYNTH, envs: SYNTH_ENVS.slice(0, 8), approvals: [], run: { ...SYNTH.run, terminalAt: null, status: "interrupted" } });
    if (!open) throw new Error("no timeline");
    expect(trackSegments(open).map((x) => [x.id, (x.r1 - T) / 1000, x.status])).toEqual([
      ["S0", 3, "done"],
      ["S3", 10, "done"],
      ["H1", 7213.1, "waiting"],
      ["S4", 7213.1, null],
    ]);
  });
});

describe("the recorded NAVSEA SSG run (eb3c3363)", () => {
  const { raw, inspection } = navsea();
  const envs = raw.envelopes.map((e) => parseEnvelope(JSON.stringify(e))).filter((e): e is RunEventEnvelope => e !== null);
  const swarm = parseSwarmBody(raw.swarm).envelopes;
  const tl = buildTimeline({ runId: raw.runId, run: raw.run, approvals: raw.approvals, envs: mergeEnvelopes(envs, swarm) });
  if (!tl) throw new Error("no timeline");

  it("reads every envelope and lays the run on its clock", () => {
    expect(envs).toHaveLength(raw.envelopes.length);
    expect(tl.envs).toHaveLength(1069);
    expect(tl.times.every((t, i) => i === 0 || t >= (tl.times[i - 1] ?? 0))).toBe(true);
    // created 04:42:31.649, decided at H2 04:49:40.112: the inspector's own duration
    expect(tl.end - tl.t0).toBe(inspection.run.durationMs);
    expect(tl.stages.map((x) => x.id)).toEqual(["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15"]);
    expect(tl.gates.map((g) => [g.id, g.waitMs])).toEqual([
      ["H1", 4122],
      ["H2", 17892],
    ]);
  });

  it("ends equal to the run's real final state: the snapshot, the swarm, the inspector and the run's status", () => {
    const end = advance(replayStart(tl), tl, tl.envs.length, tl.end);
    const spend = spendAt(spendIndex(inspection.calls), tl.end);
    const store = withRunStatus(withSpend(end.store, spend, tl.capUsd), statusAt(tl, tl.end));
    expect(store.view).toEqual(raw.snapshot.snapshot);
    expect(spend).toBe(raw.snapshot.snapshot.cost.usd);
    // the same status and closing state the live view takes from the snapshot answer
    const live = seedFromSnapshot(emptyStore(), raw.snapshot.seq, raw.snapshot.snapshot, raw.snapshot.run.status);
    expect([store.status, store.finalState, store.currentStage]).toEqual([live.status, live.finalState, live.currentStage]);
    expect(statusAt(tl, tl.end)).toBe(raw.run.status);
    expect(foldSwarm(tl.envs)).toEqual(foldSwarm(swarm));
    expect(inspectAt(inspection, tl, tl.end)).toBe(inspection);
    expect(end.store.rejectedPatches).toBe(0);
    // the office and the Pipeline read the same frames: their folds at the end are the live folds
    expect(foldOffice(tl.envs)).toEqual(foldOffice(envs));
    expect(foldHistory(tl.envs)).toEqual(foldHistory(envs));
  });

  it("rebuilds the same store by seeking as by playing, at every stage start", () => {
    for (const mark of jumpMarks(tl)) {
      const k = cursorAt(tl, mark);
      let played = replayStart(tl);
      for (let i = 0; i <= k; i += 97) played = advance(played, tl, Math.min(i, k), tl.times[Math.max(0, Math.min(i, k) - 1)] ?? tl.t0);
      played = advance(played, tl, k, mark);
      expect(played.store).toEqual(advance(replayStart(tl), tl, k, mark).store);
    }
  });

  it("collapses the two human waits to three seconds each by default", () => {
    const map = playbackMap(tl, { includeWaits: false });
    expect(map.collapsed.map((g) => g.id)).toEqual(["H1", "H2"]);
    expect(map.duration).toBe(inspection.run.durationMs - 4122 - 17892 + 6000);
    expect(playbackMap(tl, { includeWaits: true }).duration).toBe(inspection.run.durationMs);
  });
});
