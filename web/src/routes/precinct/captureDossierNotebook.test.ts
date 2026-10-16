import { describe, expect, it } from "vitest";
import type { DossierUiEvent } from "../../components/precinct/DossierPanel";
import type { NotebookDocument } from "../../lib/precinct/notebook";
import { createWorldCapture } from "../../lib/world/worldCapture";
import { initialWorldReplayState, notebookSourceKey, reduceWorldEvent, splitWorldEventBatches, worldEventBatchBytes } from "../../lib/world/worldEvents";
import { captureDossierNotebook } from "./captureDossierNotebook";

const document: NotebookDocument = { schema: "arena.notebook.v1", caseId: "case", entries: [{ id: "n", kind: "question", text: "When?", citations: [{ kind: "document", id: "doc" }], createdAtMs: 100, updatedAtMs: 200 }] };
function setup(maxEvents = 1000) {
  const capture = createWorldCapture({ maxEvents, context: () => ({ sessionKey: "s", trialId: "t", clockMs: 30, writable: true,
    publicEvidenceIds: new Set(), publicTextFields: new Set(), publicNotebookSources: new Set([notebookSourceKey({ kind: "document", id: "doc" })]) }) });
  capture.start(); return capture;
}
function state(capture: ReturnType<typeof setup>) { return capture.exportEvents().events.reduce(reduceWorldEvent, initialWorldReplayState()); }

describe("accepted Dossier notebook capture seam", () => {
  it.each([
    { type: "notebook.change", command: { type: "edit", id: "n", draft: { kind: "question", text: "When?", citations: [] }, atMs: 200 }, document },
    { type: "notebook.carry", document },
    { type: "notebook.persistence", action: "enable", ok: true, document },
    { type: "notebook.persistence", action: "restore", ok: true, document },
  ] as const)("captures the exact accepted $type document, preserving original creation time", (event) => {
    const capture = setup(); expect(captureDossierNotebook(capture, event, "case")).toBe("captured");
    expect(state(capture).notes.get("n")).toEqual({ id: "n", text: "When?", updatedAtMs: 30, metadata: { kind: "question", citations: document.entries[0]?.citations, createdAtMs: 100, updatedAtMs: 200 } });
    expect(capture.exportEvents().events.map((sample) => sample.t_ms)).toEqual([30, 30]);
  });
  it("replaces existing notes rather than merging future/device notes and captures explicit draft state", () => {
    const capture = setup(); captureDossierNotebook(capture, { type: "notebook.carry", document }, "case");
    expect(captureDossierNotebook(capture, { type: "notebook.change", command: { type: "clear" }, document: { ...document, entries: [] } }, "case")).toBe("captured");
    expect(state(capture).notes.size).toBe(0);
    const draft = { kind: "timeline" as const, text: "Paste 東京", citations: [] };
    expect(captureDossierNotebook(capture, { type: "notebook.draft", draft, editingId: "n" }, "case")).toBe("captured");
    expect(state(capture).notebookDraft).toEqual({ ...draft, editingId: "n" });
    capture.stop(); expect(captureDossierNotebook(capture, { type: "notebook.draft", draft, editingId: null }, "case")).toBe("refused");
  });
  it.each([
    { type: "notebook.persistence", action: "restore", ok: false, document: null },
    { type: "notebook.persistence", action: "enable", ok: true, document: null },
    { type: "notebook.persistence", action: "disable", ok: true, document },
    { type: "notebook.persistence", action: "forget", ok: true, document },
    { type: "page.open", page: "notebook" }, { type: "source.open", source: { kind: "document", id: "doc" } },
  ] as const)("ignores failures, non-mutating persistence and unrelated actions %#", (event) => {
    const capture = setup(); expect(captureDossierNotebook(capture, event, "case")).toBe("ignored"); expect(capture.getSnapshot().count).toBe(0);
  });
  it("refuses other cases, overlong/duplicate documents, private sources and budgets atomically", () => {
    const first = document.entries[0]; if (first === undefined) throw new Error("fixture");
    for (const invalid of [{ ...document, caseId: "elsewhere" }, { ...document, entries: [first, first] },
      { ...document, entries: Array.from({ length: 61 }, (_, i) => ({ ...first, id: String(i) })) },
      { ...document, entries: [{ ...first, citations: [{ kind: "record" as const, id: "hidden" }] }] }]) {
      const capture = setup(); expect(captureDossierNotebook(capture, { type: "notebook.carry", document: invalid }, "case")).toBe("refused"); expect(capture.getSnapshot().count).toBe(0);
    }
    const capture = setup(1); expect(captureDossierNotebook(capture, { type: "notebook.carry", document }, "case")).toBe("refused"); expect(capture.getSnapshot().count).toBe(0);
    const badSchema = { type: "notebook.carry", document: { ...document, schema: "unknown" } } as unknown as DossierUiEvent;
    expect(captureDossierNotebook(setup(), badSchema, "case")).toBe("refused");
  });
  it("accepts all 60 full-sized notes as one local transaction while splitting network bodies below 64 KB", () => {
    const first = document.entries[0]; if (first === undefined) throw new Error("fixture");
    const full = { ...document, entries: Array.from({ length: 60 }, (_, i) => ({ ...first, id: String(i), text: "東京".repeat(1000) })) };
    const capture = setup(); expect(captureDossierNotebook(capture, { type: "notebook.carry", document: full }, "case")).toBe("captured");
    expect(state(capture).notes.size).toBe(60); const batches = splitWorldEventBatches(capture.exportEvents().events);
    expect(batches.length).toBeGreaterThan(1); expect(batches.every((batch) => worldEventBatchBytes(batch) <= 64_000)).toBe(true);
  });
});
