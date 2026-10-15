import { describe, expect, it, vi } from "vitest";
import type { NotebookDocument } from "./notebook";
import { createPreparationHandoff, type PreparationContext } from "./preparationHandoff";

const document: NotebookDocument = { schema: "arena.notebook.v1", caseId: "case-a", entries: [{ id: "prep-1", kind: "question", text: "What task was assigned?", citations: [], createdAtMs: 1, updatedAtMs: 2 }] };
const idle: PreparationContext = { caseId: "case-a", source: "idle", runKey: null };
const pending: PreparationContext = { caseId: "case-a", source: "live", runKey: null };
const live: PreparationContext = { caseId: "case-a", source: "live", runKey: "new-run" };

describe("explicit preparation handoff", () => {
  it("does nothing without explicit arming and ignores empty notebooks", () => {
    const handoff = createPreparationHandoff();
    handoff.update(live);
    expect(handoff.getSnapshot()).toBeNull();
    handoff.arm({ ...document, entries: [] });
    expect(handoff.getSnapshot()).toBeNull();
  });
  it("waits through preparation and a pending start, binding only the first actual same-case run", () => {
    const handoff = createPreparationHandoff();
    const changed = vi.fn();
    const unsubscribe = handoff.subscribe(changed);
    handoff.arm(document);
    const armed = handoff.getSnapshot();
    handoff.update(idle); handoff.update(pending);
    expect(handoff.getSnapshot()).toBe(armed);
    handoff.update(live);
    expect(handoff.getSnapshot()).toEqual({ document, runKey: "new-run" });
    const bound = handoff.getSnapshot();
    handoff.update(live);
    expect(handoff.getSnapshot()).toBe(bound);
    expect(changed).toHaveBeenCalledTimes(2);
    unsubscribe();
    handoff.clear();
    expect(handoff.getSnapshot()).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...idle, caseId: "other-case" },
    { ...idle, caseId: null },
    { ...live, source: "recording" as const },
    { ...live, runKey: "unrelated-run" },
    idle,
  ])("discards a bound offer on a different case, recording, run or stopped run: %j", (next) => {
    const handoff = createPreparationHandoff();
    handoff.arm(document); handoff.update(live); handoff.update(next);
    expect(handoff.getSnapshot()).toBeNull();
  });
  it("allows the caller to cancel an armed offer before a historical Resume", () => {
    const handoff = createPreparationHandoff();
    handoff.arm(document); handoff.clear(); handoff.update({ ...live, runKey: "historical-resume" });
    expect(handoff.getSnapshot()).toBeNull();
  });
});
