import { describe, expect, it } from "vitest";

import type { RunEvent, RunEventEnvelope, WarRoomSnapshot } from "@/lib/contracts/run-events";

import {
  ACTIVITY_LIMIT,
  applyPatch,
  applyLiveSnapshot,
  applyResync,
  emptyStore,
  failResync,
  liveAnswer,
  nextEpoch,
  parseActiveStage,
  reduce,
  reduceAll,
  requestResync,
  RESYNC_BACKOFF_MS,
  seedFromSnapshot,
  snapshotAt,
} from "./state";

const snapshot = (): WarRoomSnapshot => ({
  runId: "r1",
  opportunity: "NCCS",
  lanes: { leidos: { subject: "leidos", label: "Leidos", home: false, status: "queued", fetches: 0, activity: "" } },
  laneOrder: ["leidos"],
  columns: [{ key: "teaming", label: "Teaming" }],
  cells: { "leidos:teaming": { subject: "leidos", column: "teaming", state: "pending", rows: 0, supported: 0, partial: 0, unsupported: 0 } },
  cost: { usd: 0, capUsd: 9.87 },
  counters: { fetches: 0, rows: 0, claimsChecked: 0, supported: 0, partial: 0, unsupported: 0, withheld: 0 },
  stages: { S4: "not_started" },
});

let seq = 0;
const e = (event: RunEvent, s?: number): RunEventEnvelope => {
  seq = s ?? seq + 1;
  return { seq, runId: "r1", idemKey: `k${seq}`, ts: `2026-09-25T13:00:${String(seq % 60).padStart(2, "0")}Z`, event };
};

describe("applyPatch", () => {
  it("replaces nested members immutably", () => {
    const doc = snapshot();
    const { doc: next, rejected } = applyPatch(doc, [{ op: "replace", path: "/cells/leidos:teaming/state", value: "anchored" }]);
    expect(rejected).toBe(0);
    expect(next.cells["leidos:teaming"]?.state).toBe("anchored");
    expect(doc.cells["leidos:teaming"]?.state).toBe("pending");
    expect(next.lanes).toBe(doc.lanes);
  });

  it("adds a new member with op add but not with replace", () => {
    const doc = snapshot();
    expect(applyPatch(doc, [{ op: "add", path: "/stages/S5", value: "running" }]).doc.stages.S5).toBe("running");
    expect(applyPatch(doc, [{ op: "replace", path: "/stages/S5", value: "running" }]).rejected).toBe(1);
  });

  it("rejects prototype keys, missing parents, empty segments and non-object parents", () => {
    const doc = snapshot();
    const bad = [
      { op: "add" as const, path: "/__proto__/polluted", value: 1 },
      { op: "add" as const, path: "/nope/x", value: 1 },
      { op: "add" as const, path: "/cells//x", value: 1 },
      { op: "add" as const, path: "/cost/usd/x", value: 1 },
      { op: "add" as const, path: "/laneOrder/0", value: "x" },
      { op: "add" as const, path: "no-slash", value: 1 },
    ];
    const { doc: next, rejected } = applyPatch(doc, bad);
    expect(rejected).toBe(bad.length);
    expect(next).toBe(doc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("decodes escaped pointer segments", () => {
    const doc = { a: { "x/y": 1, "m~n": 2 } };
    const { doc: next } = applyPatch(doc, [
      { op: "replace", path: "/a/x~1y", value: 3 },
      { op: "replace", path: "/a/m~0n", value: 4 },
    ]);
    expect(next.a).toEqual({ "x/y": 3, "m~n": 4 });
  });
});

describe("liveAnswer (what a live snapshot answer may do to the stream)", () => {
  it("ignores another epoch, releases an older answer, streams an active run, stops a parked or ended one", () => {
    expect(liveAnswer(1, 2, 9, 3, "running")).toBe("ignore");
    expect(liveAnswer(2, 2, 3, 4, "awaiting_plan_approval")).toBe("release"); // the stream moved past it: no status change
    expect(liveAnswer(2, 2, 4, 4, "queued")).toBe("stream");
    expect(liveAnswer(2, 2, 9, 4, "running")).toBe("stream");
    expect(liveAnswer(2, 2, 9, 4, "cancelled")).toBe("stop");
    expect(liveAnswer(2, 2, 9, 4, "interrupted")).toBe("stop");
  });

  it("a released answer frees the pending repair but keeps asking (with a backoff)", () => {
    const pending = { ...emptyStore(), needsResync: true, pendingResync: 3, lastSeq: 4 };
    const released = failResync(pending, pending.epoch);
    expect([released.pendingResync, released.needsResync, released.resyncFailures]).toEqual([null, true, 1]);
    expect(RESYNC_BACKOFF_MS(released.resyncFailures)).toBeGreaterThan(0);
  });
});

describe("applyLiveSnapshot (live runs)", () => {
  it("takes the run's status from the snapshot: a run approved in another tab streams on", () => {
    const parked = { ...seedFromSnapshot(emptyStore(), 5, snapshot(), "awaiting_plan_approval") };
    const s = applyLiveSnapshot(parked, parked.epoch, 6, snapshot(), "queued");
    expect([s.status, s.finalState, s.lastSeq, s.resyncs]).toEqual(["running", null, 6, 1]);
  });

  it("stops watching a run that was cancelled, reclaimed or failed without a closing event", () => {
    const running = seedFromSnapshot(emptyStore(), 9, snapshot(), "running");
    expect([applyLiveSnapshot(running, running.epoch, 9, snapshot(), "cancelled").status, applyLiveSnapshot(running, running.epoch, 9, snapshot(), "interrupted").finalState]).toEqual([
      "finished",
      "interrupted",
    ]);
    expect(applyLiveSnapshot(running, running.epoch, 9, snapshot(), "failed").status).toBe("error");
  });

  it("never moves the view backwards and ignores another epoch", () => {
    const ahead = { ...seedFromSnapshot(emptyStore(), 12, snapshot(), "running"), pendingResync: 12 };
    const older = applyLiveSnapshot(ahead, ahead.epoch, 10, { ...snapshot(), runId: "old" }, "awaiting_plan_approval");
    expect([older.view?.runId, older.lastSeq, older.pendingResync, older.status, older.finalState]).toEqual(["r1", 12, null, "running", null]);
    expect(applyLiveSnapshot(ahead, ahead.epoch + 1, 20, snapshot(), "decided")).toBe(ahead);
  });
});

describe("seedFromSnapshot (live runs)", () => {
  it("starts an active run running at the snapshot's seq", () => {
    const s = seedFromSnapshot(emptyStore(), 7, snapshot(), "running");
    expect([s.status, s.lastSeq, s.view?.runId, s.finalState]).toEqual(["running", 7, "r1", null]);
  });

  it("starts a run parked at a gate or ended as such, so nothing waits on an empty stream", () => {
    for (const status of ["awaiting_plan_approval", "awaiting_decision", "decided", "cancelled", "interrupted", "expired"]) {
      const s = seedFromSnapshot(emptyStore(), 19, snapshot(), status);
      expect([s.status, s.finalState]).toEqual(["finished", status]);
    }
    const failed = seedFromSnapshot(emptyStore(), 3, snapshot(), "failed");
    expect([failed.status, failed.error]).toEqual(["error", "the run failed"]);
  });

  it("never moves the cursor backwards", () => {
    const ahead = { ...emptyStore(), lastSeq: 30 };
    expect(seedFromSnapshot(ahead, 19, snapshot(), "running").lastSeq).toBe(30);
  });
});

describe("reduce", () => {
  it("keeps a finished stage's recorded status: a stub stays not_built, never done", () => {
    seq = 0;
    const s = reduceAll(emptyStore(), [
      e({ type: "STATE_SNAPSHOT", snapshot: snapshot() }),
      e({ type: "STEP_FINISHED", stepName: "S0", status: "not_built" }),
      e({ type: "STEP_FINISHED", stepName: "S6", status: "degraded" }),
      e({ type: "STEP_STARTED", stepName: "S4" }),
      e({ type: "STEP_FINISHED", stepName: "S4" }),
    ]);
    expect(s.view?.stages).toEqual({ S0: "not_built", S6: "degraded", S4: "done" });
    expect(s.feed.map((f) => f.stage)).toEqual([
      { id: "S4", edge: "finished" },
      { id: "S4", edge: "started" },
      { id: "S6", edge: "finished", status: "degraded" },
      { id: "S0", edge: "finished", status: "not_built" },
    ]);
  });

  it("shows CUSTOM frames in the feed by type and stage only, counts them, and keeps the sequence", () => {
    seq = 0;
    const s = reduceAll(emptyStore(), [
      e({ type: "STATE_SNAPSHOT", snapshot: snapshot() }),
      e({ type: "CUSTOM", name: "ACTIVITY_SNAPSHOT", value: { stage: "S4" } }),
      e({ type: "CUSTOM", name: "LANE_NOTE", value: {} }),
      e({ type: "CUSTOM", name: "AGENT_MESSAGE", value: { stage: "S9", oversize: true } }),
    ]);
    expect(s.unrendered).toBe(3);
    // never dropped silently, never rendered by content: the type, the stage and the oversize flag only
    expect(s.feed.map((f) => [f.kind, f.event])).toEqual([
      ["event", { name: "AGENT_MESSAGE", stage: "S9", oversize: true }],
      ["event", { name: "LANE_NOTE" }],
      ["event", { name: "ACTIVITY_SNAPSHOT", stage: "S4" }],
    ]);
    expect(s.lastSeq).toBe(4);
    expect(s.needsResync).toBe(false);
  });

  it("runs a stream from start to finish", () => {
    seq = 0;
    const s = reduceAll(emptyStore(), [
      e({ type: "RUN_STARTED", threadId: "t", runId: "r1", phase: "execute" }),
      e({ type: "STATE_SNAPSHOT", snapshot: snapshot() }),
      e({ type: "STEP_STARTED", stepName: "S4" }),
      e({ type: "ACTIVITY_SNAPSHOT", messageId: "f1", activityType: "fetch", content: { subject: "leidos", evidenceId: "leidos-E1", host: "sec.gov", sourceType: "sec_edgar", tier: "sec_filing", status: "ok", column: "corporate" } }),
      e({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/cost/usd", value: 1.25 }] }),
      e({ type: "ACTIVITY_SNAPSHOT", messageId: "v1", activityType: "verify", content: { claimId: "C1", claim: "x", verdict: "supported", sourceUnreachable: false } }),
      e({ type: "STEP_FINISHED", stepName: "S4" }),
      e({ type: "RUN_FINISHED", threadId: "t", runId: "r1", result: { state: "awaiting_decision" } }),
    ]);
    expect(s.status).toBe("finished");
    expect(s.finalState).toBe("awaiting_decision");
    expect(s.view?.cost.usd).toBe(1.25);
    expect(s.view?.stages.S4).toBe("done");
    expect(s.feed.map((f) => f.kind)).toEqual(["phase", "stage", "verify", "fetch", "stage", "phase"]);
    expect(s.feed[0]?.phase).toEqual({ edge: "finished", state: "awaiting_decision" });
    expect(s.feed.at(-1)?.phase).toEqual({ edge: "started", name: "execute" });
    expect(s.currentStage).toBeNull();
    expect(s.stageStartedTs).toBeNull();
    expect(s.startedTs).not.toBeNull();
    expect(s.gaps).toEqual([]);
  });

  it("ignores replays at or below the last seq", () => {
    seq = 0;
    const first = reduce(emptyStore(), e({ type: "RUN_STARTED", threadId: "t", runId: "r1", phase: "execute" }));
    const again = reduce(first, e({ type: "RUN_ERROR", message: "late" }, 1));
    expect(again).toBe(first);
  });

  it("records a gap and asks for a snapshot, which clears the flag", () => {
    seq = 0;
    let s = reduce(emptyStore(), e({ type: "RUN_STARTED", threadId: "t", runId: "r1", phase: "execute" }));
    s = reduce(s, e({ type: "STEP_STARTED", stepName: "S7" }, 5));
    expect(s.gaps).toEqual([{ after: 1, got: 5 }]);
    expect(s.needsResync).toBe(true);
    expect(s.currentStage).toBe("S7");
    s = reduce(s, e({ type: "STATE_SNAPSHOT", snapshot: snapshot() }, 6));
    expect(s.needsResync).toBe(false);
  });

  it("drops off-contract patch values instead of committing them to the view", () => {
    seq = 0;
    let s = reduceAll(emptyStore(), [e({ type: "STATE_SNAPSHOT", snapshot: snapshot() })]);
    const before = s.view;
    s = reduce(
      s,
      e({
        type: "STATE_DELTA",
        delta: [
          { op: "replace", path: "/cells/leidos:teaming/state", value: 5 },
          { op: "replace", path: "/cost/usd", value: "lots" },
          { op: "replace", path: "/lanes/leidos/fetches", value: 3 },
        ],
      }),
    );
    expect(s.rejectedPatches).toBe(2);
    expect(s.view?.cells["leidos:teaming"]).toEqual(before?.cells["leidos:teaming"]);
    expect(s.view?.cost.usd).toBe(0);
    expect(s.view?.lanes.leidos?.fetches).toBe(3);
  });

  it("counts deltas that arrive before any snapshot as rejected", () => {
    seq = 0;
    const s = reduce(emptyStore(), e({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/cost/usd", value: 1 }, { op: "replace", path: "/cost/usd", value: 2 }] }));
    expect(s.rejectedPatches).toBe(2);
    expect(s.needsResync).toBe(true);
  });

  it("tracks errors and a stage finishing that is not current", () => {
    seq = 0;
    let s = reduceAll(emptyStore(), [e({ type: "STEP_STARTED", stepName: "S8" }), e({ type: "STEP_FINISHED", stepName: "S4" })]);
    expect(s.currentStage).toBe("S8");
    expect(s.view).toBeNull();
    s = reduce(s, e({ type: "RUN_ERROR", message: "provider quota" }));
    expect(s.status).toBe("error");
    expect(s.error).toBe("provider quota");
  });

  it("caps the activity feed", () => {
    seq = 0;
    const many = Array.from({ length: ACTIVITY_LIMIT + 5 }, () => e({ type: "STEP_STARTED", stepName: "S4" }));
    expect(reduceAll(emptyStore(), many).feed).toHaveLength(ACTIVITY_LIMIT);
  });
});

describe("snapshot recovery", () => {
  const lost = () => {
    seq = 0;
    // The snapshot frame (seq 1) never arrived; deltas cannot apply and ask for a resync.
    return reduce(emptyStore(), e({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/cost/usd", value: 2 }] }, 2));
  };

  it("requests once, then installs an answer at or after the cursor", () => {
    let s = lost();
    expect(s.needsResync).toBe(true);
    s = requestResync(s, 0, 2);
    expect(s.pendingResync).toBe(2);
    expect(requestResync(s, 0, 2)).toBe(s);
    s = applyResync(s, 0, 2, { ...snapshot(), cost: { usd: 2, capUsd: 9.87 } });
    expect(s).toMatchObject({ needsResync: false, pendingResync: null, lastSeq: 2, resyncs: 1 });
    expect(s.view?.cost.usd).toBe(2);
    expect(requestResync(s, 0, 2)).toBe(s);
  });

  it("treats an answer older than the cursor as stale and keeps asking", () => {
    let s = requestResync(lost(), 0, 2);
    s = reduce(s, e({ type: "STEP_STARTED", stepName: "S7" }, 9));
    s = applyResync(s, 0, 2, snapshot());
    expect(s).toMatchObject({ needsResync: true, pendingResync: null, lastSeq: 9, view: null });
    s = requestResync(s, 0, 9);
    expect(s.pendingResync).toBe(9);
  });

  it("ignores answers and failures from an epoch that a restart replaced", () => {
    const old = requestResync(lost(), 0, 2);
    const fresh = nextEpoch(old);
    expect(fresh).toMatchObject({ epoch: 1, lastSeq: 0, view: null, needsResync: false });
    expect(applyResync(fresh, 0, 100, snapshot())).toBe(fresh);
    expect(failResync(fresh, 0)).toBe(fresh);
    expect(requestResync(fresh, 0, 5)).toBe(fresh);
  });

  it("counts failures for backoff and clears them on success", () => {
    let s = failResync(requestResync(lost(), 0, 2), 0);
    expect(s).toMatchObject({ pendingResync: null, resyncFailures: 1, needsResync: true });
    expect(RESYNC_BACKOFF_MS(0)).toBe(0);
    expect(RESYNC_BACKOFF_MS(1)).toBe(1000);
    expect(RESYNC_BACKOFF_MS(9)).toBe(15000);
    s = applyResync(requestResync(s, 0, 2), 0, 2, snapshot());
    expect(s.resyncFailures).toBe(0);
  });

  it("asks for a snapshot when a patch value is rejected", () => {
    seq = 0;
    let s = reduceAll(emptyStore(), [e({ type: "STATE_SNAPSHOT", snapshot: snapshot() })]);
    s = reduce(s, e({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/cells/leidos:teaming/state", value: 7 }] }));
    expect(s.needsResync).toBe(true);
  });

  it("computes the server-side snapshot from the recorded events", () => {
    seq = 0;
    const events = [
      e({ type: "STATE_SNAPSHOT", snapshot: snapshot() }),
      e({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/cost/usd", value: 1 }] }),
      e({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/cost/usd", value: 3 }] }),
    ];
    expect(snapshotAt(events, 2)).toMatchObject({ seq: 2, snapshot: { cost: { usd: 1 } } });
    expect(snapshotAt(events, 99)?.seq).toBe(3);
    expect(snapshotAt(events, 0)).toBeNull();
  });
});

describe("the stage working now (RUN1-SSE: the War Room never looks frozen)", () => {
  it("records when the current stage started and clears it when that stage finishes", () => {
    seq = 0;
    const started = reduceAll(emptyStore(), [e({ type: "STATE_SNAPSHOT", snapshot: snapshot() }), e({ type: "STEP_STARTED", stepName: "S6" })]);
    expect([started.currentStage, started.stageStartedTs]).toEqual(["S6", "2026-09-25T13:00:02Z"]);
    const other = reduce(started, e({ type: "STEP_FINISHED", stepName: "S4" }));
    expect([other.currentStage, other.stageStartedTs]).toEqual(["S6", "2026-09-25T13:00:02Z"]); // another stage's end
    const done = reduce(other, e({ type: "STEP_FINISHED", stepName: "S6", status: "degraded" }));
    expect([done.currentStage, done.stageStartedTs]).toEqual([null, null]);
  });

  it("a live run opened mid-stage starts from the snapshot's active stage and its start time", () => {
    const active = { stage: "S6" as const, startedAt: "2026-10-03T19:01:00+00:00" };
    const seeded = seedFromSnapshot(emptyStore(), 120, snapshot(), "running", active);
    expect([seeded.status, seeded.currentStage, seeded.stageStartedTs]).toEqual(["running", "S6", active.startedAt]);
    // a parked run has no working stage, whatever the events last said
    expect(seedFromSnapshot(emptyStore(), 120, snapshot(), "awaiting_decision", active).currentStage).toBeNull();
    // an answer that says nothing about the stage keeps what the stream holds
    expect(applyLiveSnapshot(seeded, seeded.epoch, 121, snapshot(), "running").currentStage).toBe("S6");
    expect(applyLiveSnapshot(seeded, seeded.epoch, 121, snapshot(), "running", null).currentStage).toBeNull();
  });

  it("takes the time of the run's last event from the snapshot, never moving it backwards", () => {
    const seeded = seedFromSnapshot(emptyStore(), 5, snapshot(), "running", null, "2026-10-03T19:02:00Z");
    expect(seeded.lastTs).toBe("2026-10-03T19:02:00Z");
    expect(applyLiveSnapshot(seeded, seeded.epoch, 6, snapshot(), "running", null, "2026-10-03T19:01:00Z").lastTs).toBe("2026-10-03T19:02:00Z");
    expect(applyLiveSnapshot(seeded, seeded.epoch, 6, snapshot(), "running", null, "garbage").lastTs).toBe("2026-10-03T19:02:00Z");
    expect(seedFromSnapshot(emptyStore(), 5, snapshot(), "running").lastTs).toBeNull();
    expect(applyLiveSnapshot(seeded, seeded.epoch, 7, snapshot(), "running", null, "2026-10-03T19:03:00Z").lastTs).toBe("2026-10-03T19:03:00Z");
  });

  it("checks bh-api's activeStage field", () => {
    expect(parseActiveStage(undefined)).toBeUndefined();
    expect(parseActiveStage(null)).toBeNull();
    expect(parseActiveStage({ stage: "S6", startedAt: "2026-10-03T19:01:00Z" })).toEqual({ stage: "S6", startedAt: "2026-10-03T19:01:00Z" });
    expect(parseActiveStage({ stage: "S6", startedAt: "yesterday" })).toEqual({ stage: "S6", startedAt: null });
    expect(parseActiveStage({ stage: "S99", startedAt: null })).toBeNull();
    expect(parseActiveStage(["S6"])).toBeNull();
  });

  it("puts phase edges in the feed: started, finished at a gate, failed with its code", () => {
    seq = 0;
    const s = reduceAll(emptyStore(), [
      e({ type: "RUN_STARTED", threadId: "t", runId: "r1", phase: "prepare" }),
      e({ type: "RUN_ERROR", message: "phase failed (vacuous_intake)", code: "vacuous_intake" }),
      e({ type: "RUN_ERROR", message: "phase failed" }),
    ]);
    expect(s.feed.map((f) => f.phase)).toEqual([
      { edge: "failed", code: "unrecorded" },
      { edge: "failed", code: "vacuous_intake" },
      { edge: "started", name: "prepare" },
    ]);
  });
});
