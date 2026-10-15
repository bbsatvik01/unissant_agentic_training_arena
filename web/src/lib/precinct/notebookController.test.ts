import { describe, expect, it, vi } from "vitest";
import type { DossierSourceRef } from "./dossier";
import { NOTEBOOK_LIMITS, type NotebookDraft } from "./notebook";
import { createNotebookController, notebookStorageKey, type NotebookStorage } from "./notebookController";

const source: DossierSourceRef = { kind: "document", id: "d1" };
const draft: NotebookDraft = { kind: "observation", text: "The source records a door entry.", citations: [source] };
function setup() {
  const values = new Map<string, string>();
  const storage: NotebookStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  const acquire = vi.fn(() => storage);
  let id = 0;
  const options = { caseId: "case-1", scope: "session-1", sources: [source], storage: acquire, now: () => 100, createId: () => `note-${String(++id)}` };
  return { controller: createNotebookController(options), options, values, storage, acquire, key: notebookStorageKey(options.scope, options.caseId) };
}

describe("opt-in notebook controller", () => {
  it("does not acquire, read or write browser storage before an explicit persistence action", () => {
    const { controller, acquire } = setup();
    expect(controller.getSnapshot()).toMatchObject({ persistence: "memory", savingEnabled: false, hasSavedCopy: null });
    controller.actions.add(draft);
    controller.actions.edit("note-1", { ...draft, text: "Revised" });
    controller.actions.remove("note-1");
    controller.actions.clear();
    controller.actions.disableSaving();
    expect(acquire).not.toHaveBeenCalled();
  });
  it("publishes stable snapshots and detaches subscribers", () => {
    const { controller } = setup();
    const before = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(before);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    const added = controller.actions.add(draft);
    expect(added).toMatchObject({ ok: true, command: { type: "add", entry: { id: "note-1", createdAtMs: 100 } } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).not.toBe(before);
    unsubscribe();
    controller.actions.clear();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(controller.actions.add({ ...draft, text: "" }).ok).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it("saves only after opt-in, keeps updates local to a scoped key, and clears the saved notebook when enabled", () => {
    const { controller, values, key } = setup();
    controller.actions.add(draft);
    expect(values.size).toBe(0);
    expect(controller.actions.enableSaving().ok).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ persistence: "saved", savingEnabled: true, hasSavedCopy: true });
    expect(values.get(key)).toContain(draft.text);
    controller.actions.edit("note-1", { ...draft, text: "Changed note" });
    expect(values.get(key)).toContain("Changed note");
    controller.actions.clear();
    expect(values.get(key)).toContain('"entries":[]');
    expect(notebookStorageKey("a:b", "c")).not.toBe(notebookStorageKey("a", "b:c"));
  });
  it("does not restore saved notes until the next controller explicitly opts in", () => {
    const { controller, options, acquire } = setup();
    controller.actions.add(draft); controller.actions.enableSaving();
    acquire.mockClear();
    const next = createNotebookController(options);
    expect(next.getSnapshot().document.entries).toHaveLength(0);
    expect(acquire).not.toHaveBeenCalled();
    expect(next.actions.enableSaving().ok).toBe(true);
    expect(next.getSnapshot().document.entries[0]?.text).toBe(draft.text);
  });
  it("turning saving off retains the saved copy; forgetting removes only that key and keeps current notes", () => {
    const { controller, values, key, storage } = setup();
    values.set("unrelated", "keep");
    controller.actions.add(draft); controller.actions.enableSaving(); controller.actions.disableSaving();
    const saved = values.get(key);
    controller.actions.edit("note-1", { ...draft, text: "Memory only" });
    expect(values.get(key)).toBe(saved);
    expect(controller.getSnapshot().message).toContain("remains");
    expect(controller.actions.forgetSaved().ok).toBe(true);
    expect(values.has(key)).toBe(false);
    expect(values.get("unrelated")).toBe("keep");
    expect(controller.getSnapshot()).toMatchObject({ savingEnabled: false, hasSavedCopy: false, persistence: "memory" });
    expect(controller.getSnapshot().document.entries[0]?.text).toBe("Memory only");
    expect(storage.removeItem).toHaveBeenCalledWith(key);
  });
  it("requires an explicit restore or forget before overwriting a different nonempty saved notebook", () => {
    const { controller, options, values, key } = setup();
    controller.actions.add(draft); controller.actions.enableSaving();
    const original = values.get(key);
    const next = createNotebookController(options);
    next.actions.add({ ...draft, text: "A different session draft" });
    const conflict = next.actions.enableSaving();
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error).toContain("different saved notebook");
    expect(next.getSnapshot().savingEnabled).toBe(false);
    expect(values.get(key)).toBe(original);
    expect(next.actions.restoreSaved().ok).toBe(true);
    expect(next.getSnapshot().document.entries[0]?.text).toBe(draft.text);
    expect(next.getSnapshot().savingEnabled).toBe(true);
  });
  it("can re-enable an unchanged saved notebook and explicitly restore without a prior save preference", () => {
    const { controller, options } = setup();
    controller.actions.add(draft); controller.actions.enableSaving(); controller.actions.disableSaving();
    expect(controller.actions.enableSaving().ok).toBe(true);
    const next = createNotebookController(options);
    expect(next.actions.restoreSaved().ok).toBe(true);
    expect(next.getSnapshot().message).toContain("restored");
  });
  it("missing or corrupt saved copies never replace current notes", () => {
    const { controller, values, key } = setup();
    controller.actions.add(draft);
    const missing = controller.actions.restoreSaved();
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("No saved notebook");
    values.set(key, "{broken");
    expect(controller.actions.enableSaving().ok).toBe(false);
    expect(controller.getSnapshot().hasSavedCopy).toBe(true);
    expect(controller.getSnapshot().document.entries[0]?.text).toBe(draft.text);
    expect(values.get(key)).toBe("{broken");
    expect(controller.actions.restoreSaved().ok).toBe(false);
  });
  it("storage acquisition and read failures keep memory notes and explain the failure", () => {
    const { controller, acquire } = setup();
    controller.actions.add(draft);
    acquire.mockImplementation(() => { throw new Error("SecurityError"); });
    expect(controller.actions.enableSaving().ok).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ persistence: "error", savingEnabled: false });
    expect(controller.getSnapshot().message).toContain("could not be read");
    expect(controller.getSnapshot().document.entries).toHaveLength(1);
  });
  it("a failed save or clear is honest about possibly stale device data and can be retried", () => {
    const { controller, storage, values, key } = setup();
    controller.actions.add(draft); controller.actions.enableSaving();
    vi.mocked(storage.setItem).mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const clear = controller.actions.clear();
    expect(clear.ok).toBe(true);
    expect(controller.getSnapshot().document.entries).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({ persistence: "error", savingEnabled: true });
    expect(controller.getSnapshot().message).toContain("older saved copy may remain");
    expect(values.get(key)).toContain(draft.text);
    expect(controller.actions.enableSaving().ok).toBe(false);
    vi.mocked(storage.setItem).mockImplementation((k, value) => { values.set(k, value); });
    expect(controller.actions.enableSaving().ok).toBe(true);
    expect(values.get(key)).toContain('"entries":[]');
  });
  it("failed or ineffective deletion never claims the saved copy was forgotten", () => {
    const { controller, storage } = setup();
    controller.actions.add(draft); controller.actions.enableSaving();
    vi.mocked(storage.removeItem).mockImplementation(() => { throw new Error("blocked"); });
    expect(controller.actions.forgetSaved().ok).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ savingEnabled: false, persistence: "error", hasSavedCopy: true });
    vi.mocked(storage.removeItem).mockImplementation(() => undefined);
    expect(controller.actions.forgetSaved().ok).toBe(false);
    expect(controller.getSnapshot().message).toContain("could not be removed");
  });
  it("only permits new citations after the parent releases those sources", () => {
    const { controller } = setup();
    const record: DossierSourceRef = { kind: "record", id: "r1" };
    const cited = { ...draft, citations: [record] };
    expect(controller.actions.add(cited).ok).toBe(false);
    controller.setSources([source, record]);
    expect(controller.actions.add(cited).ok).toBe(true);
  });
  it("enforces the serialized storage limit without losing valid in-memory notes", () => {
    const { controller } = setup();
    const longSources: DossierSourceRef[] = Array.from({ length: 8 }, (_, index) => ({ kind: "document", id: `${String(index)}${"x".repeat(179)}` }));
    controller.setSources(longSources);
    for (let index = 0; index < NOTEBOOK_LIMITS.entries; index++) expect(controller.actions.add({ ...draft, text: "x".repeat(NOTEBOOK_LIMITS.text), citations: longSources }).ok).toBe(true);
    const tooLarge = controller.actions.enableSaving();
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.error).toContain("device-storage limit");
    expect(controller.getSnapshot().document.entries).toHaveLength(NOTEBOOK_LIMITS.entries);
  });
});

describe("explicit preparation carry", () => {
  it("copies all validated notes atomically, retaining identities/times without acquiring storage", () => {
    const { controller: preparation } = setup();
    preparation.actions.add(draft);
    const document = preparation.getSnapshot().document;
    const { controller, acquire } = setup();
    expect(controller.carryPreparation(document)).toMatchObject({ ok: true, document, command: null });
    expect(controller.getSnapshot().document).toEqual(document);
    expect(controller.getSnapshot().document).not.toBe(document);
    expect(controller.getSnapshot().savingEnabled).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
  });
  it("refuses wrong-case or unavailable-source preparations without changing memory", () => {
    const { controller: preparation } = setup();
    preparation.actions.add(draft);
    const document = preparation.getSnapshot().document;
    const { controller, acquire } = setup();
    expect(controller.carryPreparation({ ...document, caseId: "another-case" }).ok).toBe(false);
    controller.setSources([]);
    expect(controller.carryPreparation(document).ok).toBe(false);
    expect(controller.getSnapshot().document.entries).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
  });
  it("refuses overwriting current notes or silently changing an enabled device notebook", () => {
    const { controller: preparation } = setup();
    preparation.actions.add(draft);
    const document = preparation.getSnapshot().document;
    const { controller } = setup();
    controller.actions.add({ ...draft, text: "Existing run note." });
    expect(controller.carryPreparation(document).ok).toBe(false);
    expect(controller.getSnapshot().document.entries[0]?.text).toBe("Existing run note.");
    controller.actions.clear(); controller.actions.enableSaving();
    expect(controller.carryPreparation(document).ok).toBe(false);
    expect(controller.getSnapshot().document.entries).toEqual([]);
  });
});
