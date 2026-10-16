import { describe, expect, it } from "vitest";
import { emptyEvidenceTable, reduceEvidenceTable, type EvidenceTableAction, type EvidenceTableState, type PublicEvidenceSource } from "../../lib/precinct/evidenceTable";
import { createWorldCapture } from "../../lib/world/worldCapture";
import { initialWorldReplayState, reduceWorldEvent } from "../../lib/world/worldEvents";
import { evidenceTableInputs } from "./captureEvidenceTable";

const a = { kind: "document", id: "a" } as const;
const b = { kind: "record", id: "b" } as const;
const sources: readonly PublicEvidenceSource[] = [{ ref: a, title: "Public A" }, { ref: b, title: "Public B" }];
const presented = (source: typeof a | typeof b): EvidenceTableState => ({ scope: "run", selected: source, presented: source });

describe("accepted single-table evidence capture", () => {
  it("replays A to B to clear without retaining A, with atomic same-time unpin before pin", () => {
    let table = emptyEvidenceTable("run"); let time = 0;
    const capture = createWorldCapture({ localOnly: true, context: () => ({ sessionKey: "run", trialId: "trial", clockMs: time++, writable: true, publicEvidenceIds: new Set(["a", "b"]), publicTextFields: new Set<string>() }) });
    capture.start();
    const apply = (action: EvidenceTableAction) => {
      const next = reduceEvidenceTable(table, action, "run", sources, false);
      const plan = evidenceTableInputs(table, next, action, JSON.stringify(table) !== JSON.stringify(next), sources);
      if (!plan.ok) throw new Error("unexpected refusal");
      expect(capture.inputs(plan.inputs)).toBe(true); table = next;
    };
    apply({ type: "present", source: a }); apply({ type: "present", source: b });
    let events = capture.exportEvents().events;
    expect(events.map((event) => event.kind === "input" ? event.data : null)).toEqual([
      { action: "evidence", operation: "pin", record_id: "a" },
      { action: "evidence", operation: "unpin", record_id: "a" },
      { action: "evidence", operation: "pin", record_id: "b" },
    ]);
    expect(events[1]?.t_ms).toBe(events[2]?.t_ms);
    expect(events.reduce(reduceWorldEvent, initialWorldReplayState()).pinnedEvidence).toEqual(new Set(["b"]));
    apply({ type: "clear" }); events = capture.exportEvents().events;
    expect(events.at(-1)).toMatchObject({ kind: "input", data: { operation: "unpin", record_id: "b" } });
    expect(events.reduce(reduceWorldEvent, initialWorldReplayState()).pinnedEvidence.size).toBe(0);
    expect(table.presented).toBeNull();
  });
  it("records no rejected or no-op markers and captures accepted inspect separately", () => {
    const empty = emptyEvidenceTable("run");
    expect(evidenceTableInputs(empty, empty, { type: "present", source: a }, false, sources)).toEqual({ ok: true, inputs: [] });
    expect(evidenceTableInputs(empty, empty, { type: "clear" }, true, sources)).toEqual({ ok: true, inputs: [] });
    expect(evidenceTableInputs(presented(a), presented(a), { type: "present", source: a }, true, sources)).toEqual({ ok: true, inputs: [] });
    expect(evidenceTableInputs(presented(a), presented(a), { type: "select", source: a }, true, sources)).toEqual({ ok: true, inputs: [] });
    const selected = reduceEvidenceTable(presented(a), { type: "select", source: b }, "run", sources, false);
    expect(evidenceTableInputs(presented(a), selected, { type: "select", source: b }, true, sources)).toEqual({ ok: true, inputs: [{ action: "evidence", operation: "inspect", record_id: "b" }] });
  });
  it("compares source kind as well as ID and refuses ambiguous IDs without a partial batch", () => {
    const other = { kind: "record", id: "a" } as const;
    const ambiguous = [...sources, { ref: other, title: "Different public source" }];
    const after = { scope: "run", selected: other, presented: other };
    expect(evidenceTableInputs(presented(a), after, { type: "present", source: other }, true, ambiguous)).toEqual({ ok: false });
    expect(evidenceTableInputs(presented(a), after, { type: "present", source: other }, true, [{ ref: other, title: "Only record A" }])).toEqual({ ok: false });
    expect(evidenceTableInputs(presented(a), emptyEvidenceTable("run"), { type: "clear" }, true, ambiguous)).toEqual({ ok: false });
  });
  it("refuses private sources, scope replacement and inconsistent accepted transitions", () => {
    expect(evidenceTableInputs(emptyEvidenceTable("run"), presented(a), { type: "present", source: a }, true, [])).toEqual({ ok: false });
    expect(evidenceTableInputs(presented(a), { ...presented(b), scope: "other" }, { type: "present", source: b }, true, sources)).toEqual({ ok: false });
    expect(evidenceTableInputs(presented(a), presented(b), { type: "clear" }, true, sources)).toEqual({ ok: false });
    expect(evidenceTableInputs(presented(a), presented(b), { type: "select", source: b }, true, sources)).toEqual({ ok: false });
  });
  it("keeps an accepted replacement atomic if the journal has capacity for only one marker", () => {
    const capture = createWorldCapture({ localOnly: true, maxEvents: 2, context: () => ({ sessionKey: "run", trialId: "trial", clockMs: 0, writable: true, publicEvidenceIds: new Set(["a", "b"]), publicTextFields: new Set<string>() }) });
    capture.start(); capture.input({ action: "evidence", operation: "pin", record_id: "a" });
    const plan = evidenceTableInputs(presented(a), presented(b), { type: "present", source: b }, true, sources);
    if (!plan.ok) throw new Error("unexpected refusal");
    expect(capture.inputs(plan.inputs)).toBe(false);
    expect(capture.exportEvents().events).toHaveLength(1);
  });
});
