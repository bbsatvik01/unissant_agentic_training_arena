import { describe, expect, it } from "vitest";

import type { RunEvent, RunEventEnvelope, WarRoomSnapshot } from "@/lib/contracts/run-events";

import { cellLane, EMPTY_TOWER, foldTower, isTowerEvent, latestAt, unpoint } from "./record";

const T0 = Date.parse("2026-10-05T04:42:34Z");
let n = 0;
function env(event: RunEvent, at: number, seq?: number): RunEventEnvelope {
  n += 1;
  return { seq: seq ?? n, runId: "r", idemKey: `k${n}`, ts: new Date(at).toISOString(), event };
}
const act = (activityType: string, content: unknown) => ({ type: "ACTIVITY_SNAPSHOT", messageId: `a${n}`, activityType, content }) as unknown as RunEvent;
const fetchEv = (subject: string, host: string) => act("fetch", { subject, evidenceId: "e#1", host, sourceType: "web", tier: "other", status: "ok", column: "corporate" });
const verifyEv = (verdict: "supported" | "partially_supported" | "unsupported", sourceUnreachable = false) => act("verify", { claimId: "c", claim: "x", verdict, sourceUnreachable });
const delta = (...ops: [string, unknown][]): RunEvent => ({ type: "STATE_DELTA", delta: ops.map(([path, value]) => ({ op: "replace", path, value })) });
const cell = (subject: string, column = "past_performance") => ({ subject, column, state: "verified", rows: 1, supported: 1, partial: 0, unsupported: 0 });
const snapshot = (subjects: string[]): WarRoomSnapshot => ({
  runId: "r",
  opportunity: "o",
  lanes: Object.fromEntries(subjects.map((s) => [s, { subject: s, label: s, home: false, status: "queued", fetches: 0, activity: "" }])),
  laneOrder: subjects,
  columns: [],
  cells: {},
  cost: { usd: 0, capUsd: 1 },
  counters: { fetches: 0, rows: 0, claimsChecked: 0, supported: 0, partial: 0, unsupported: 0, withheld: 0 },
  stages: {},
});

describe("foldTower", () => {
  it("keeps each lane's activity lines and status changes, in ledger order", () => {
    n = 0;
    const r = foldTower([
      env({ type: "STEP_STARTED", stepName: "S4" }, T0),
      env(delta(["/lanes/LEIDOS, INC./status", "running"], ["/lanes/LEIDOS, INC./activity", "Reading federal records for LEIDOS, INC."]), T0 + 10),
      env(delta(["/lanes/LEIDOS, INC./activity", "GET api.sam.gov (sam.entity)"], ["/cost/usd", 0]), T0 + 20),
      env(delta(["/lanes/LEIDOS, INC./activity", "   "], ["/lanes/LEIDOS, INC./status", "weird"]), T0 + 25),
      env(delta(["/lanes/LEIDOS, INC./status", "done"], ["/lanes/LEIDOS, INC./activity", "142 rows kept from 27 fetches"]), T0 + 30),
      env(delta(["/lanes/A~1B/activity", "Drafting the dossier"]), T0 + 40),
    ]);
    expect(r.lines["LEIDOS, INC."]?.map((l) => l.text)).toEqual(["Reading federal records for LEIDOS, INC.", "GET api.sam.gov (sam.entity)", "142 rows kept from 27 fetches"]);
    expect(r.marks["LEIDOS, INC."]?.map((m) => m.status)).toEqual(["running", "done"]);
    // an escaped slash in the subject is unescaped and folded to the pod key
    expect(r.lines["A/B"]?.[0]?.text).toBe("Drafting the dossier");
    expect(r.first?.seq).toBe(1);
    expect(r.last?.seq).toBe(6);
  });

  it("attributes a verdict to the rival its own paired delta names (by idem key, in any order), and keeps sourceUnreachable", () => {
    n = 0;
    const keyed = (e: RunEventEnvelope, idemKey: string): RunEventEnvelope => ({ ...e, idemKey });
    const r = foldTower([
      keyed(env(verifyEv("supported"), T0, 10), "g:S7:A:verdict:c1"),
      // another verdict's delta recorded right after it names a different rival: not this verdict's
      keyed(env(delta(["/cells/BETA:past_performance", cell("BETA")]), T0 + 11, 11), "g:S7:B:verdict:c9:delta"),
      keyed(env(delta(["/cells/DYNAMIC ANIMATION SYSTEMS, INC.:past_performance", cell("DYNAMIC ANIMATION SYSTEMS, INC.")], ["/counters/supported", 1]), T0 + 40, 13), "g:S7:A:verdict:c1:delta"),
      keyed(env(verifyEv("unsupported", true), T0 + 30, 12), "g:S7:A:verdict:c2"),
      keyed(env(verifyEv("partially_supported"), T0 + 60, 14), "g:S7:A:verdict:c3"),
      keyed(env(delta(["/counters/supported", 2]), T0 + 62, 15), "g:S7:A:verdict:c3:delta"),
    ]);
    expect(r.verdicts.map((v) => [v.verdict, v.lane, v.unreachable])).toEqual([
      ["supported", "DYNAMIC ANIMATION SYSTEMS, INC.", false],
      ["withheld", null, true],
      ["partly", null, false],
    ]);
  });

  it("notes when each lane was first named, by the snapshot or a fetch, and phase starts", () => {
    n = 0;
    const r = foldTower([
      env({ type: "RUN_STARTED", threadId: "t", runId: "r", phase: "execute" }, T0),
      env({ type: "STATE_SNAPSHOT", snapshot: snapshot(["Acme Corp", "Beta"]) }, T0 + 100),
      env(fetchEv("acme  corp", "a.example"), T0 + 200),
      env(fetchEv("Gamma", "g.example"), T0 + 300),
    ]);
    expect(r.laneSeen["ACME CORP"]?.ts).toBe(T0 + 100);
    expect(r.laneSeen.BETA?.seq).toBe(2);
    expect(r.laneSeen.GAMMA?.ts).toBe(T0 + 300);
    expect(r.starts).toEqual([{ seq: 1, ts: T0, phase: "execute" }]);
  });

  it("ignores duplicate seqs and unreadable times, in any order; an empty stream is empty", () => {
    n = 0;
    const a = env(delta(["/lanes/Z/activity", "one"]), T0, 5);
    const dup = env(delta(["/lanes/Z/activity", "two"]), T0, 5);
    const bad = { ...env(delta(["/lanes/Z/activity", "three"]), T0, 6), ts: "nope" };
    const r = foldTower([bad, dup, a]);
    // one line per seq, whichever copy arrived; the unreadable frame adds nothing
    expect(r.lines.Z).toHaveLength(1);
    expect(r.last?.seq).toBe(5);
    expect(foldTower([])).toEqual(EMPTY_TOWER);
  });
});

describe("helpers", () => {
  it("selects lane and cell deltas and phase starts from a stream", () => {
    n = 0;
    expect(isTowerEvent(env(delta(["/lanes/A/activity", "x"]), T0))).toBe(true);
    expect(isTowerEvent(env(delta(["/cells/A:col", cell("A")]), T0))).toBe(true);
    expect(isTowerEvent(env(delta(["/counters/fetches", 3]), T0))).toBe(false);
    expect(isTowerEvent(env({ type: "STATE_DELTA", delta: [] }, T0))).toBe(false);
    expect(isTowerEvent(env({ type: "RUN_STARTED", threadId: "t", runId: "r", phase: "prepare" }, T0))).toBe(true);
    expect(isTowerEvent(env(fetchEv("A", "a"), T0))).toBe(false);
  });

  it("reads JSON pointers and cell paths", () => {
    expect(unpoint("a~1b~0c")).toBe("a/b~c");
    expect(cellLane("/cells/Acme  Corp:past_performance")).toBe("ACME CORP");
    expect(cellLane("/cells/A:B:col")).toBe("A:B");
    expect(cellLane("/cells/:col")).toBeNull();
    expect(cellLane("/lanes/A/status")).toBeNull();
  });

  it("finds the latest item shown by a time", () => {
    const items = [{ at: 1 }, { at: 5 }, { at: 9 }];
    expect(latestAt(items, (i) => i.at, 6)).toEqual({ at: 5 });
    expect(latestAt(items, (i) => i.at, 0)).toBeNull();
    expect(latestAt(undefined, (i: { at: number }) => i.at, 6)).toBeNull();
  });
});
