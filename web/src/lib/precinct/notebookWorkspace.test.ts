import { describe, expect, it, vi } from "vitest";
import { serializeNotebook } from "./notebook";
import { notebookStorageKey } from "./notebookController";
import { createNotebookWorkspace } from "./notebookWorkspace";

const draft = { kind: "question", text: "What task was assigned?", citations: [] } as const;
function setup(readOnly = false) {
  const values = new Map<string, string>();
  const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: vi.fn((key: string) => { values.delete(key); }) };
  const acquire = vi.fn(() => storage);
  let nextId = 0;
  const controller = createNotebookWorkspace({ caseId: "case-a", scope: "user-a:session-a", readOnly, storage: acquire, now: () => 10, createId: () => `note-${String(++nextId)}` });
  return { controller, storage, acquire, values };
}

describe("notebook workspace", () => {
  it("does not acquire device storage for construction, subscribing, or ordinary editing", () => {
    const { controller, acquire } = setup();
    const changed = vi.fn();
    const stop = controller.subscribe(changed);
    expect(controller.actions.add(draft).ok).toBe(true);
    expect(controller.actions.edit("note-1", { ...draft, text: "Which dispatch assigned it?" }).ok).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(acquire).not.toHaveBeenCalled();
    stop();
    controller.actions.clear();
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it("clamps new note and edit times to the restored notebook when the device clock is behind", () => {
    const { controller, values, storage } = setup();
    const key = notebookStorageKey("user-a:session-a", "case-a");
    values.set(key, serializeNotebook({ schema: "arena.notebook.v1", caseId: "case-a", entries: [{ ...draft, id: "saved", createdAtMs: 1000, updatedAtMs: 1200 }] }));
    expect(controller.actions.restoreSaved().ok).toBe(true);
    expect(controller.actions.edit("saved", draft).ok).toBe(true);
    expect(controller.getSnapshot().document.entries[0]?.updatedAtMs).toBe(1200);
    expect(controller.actions.add(draft).ok).toBe(true);
    expect(controller.getSnapshot().document.entries[1]?.createdAtMs).toBe(1200);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });
  it("refuses every mutation and persistence action in v1 recording mode without acquiring storage", () => {
    const { controller, acquire } = setup(true);
    const snapshot = controller.getSnapshot();
    const changed = vi.fn();
    const stop = controller.subscribe(changed);
    controller.setSources([{ kind: "record", id: "future-record" }]);
    const results = [controller.actions.add(draft), controller.actions.edit("x", draft), controller.actions.remove("x"), controller.actions.clear(), controller.actions.enableSaving(), controller.actions.disableSaving(), controller.actions.restoreSaved(), controller.actions.forgetSaved(), controller.carryPreparation(snapshot.document)];
    expect(results.every((result) => !result.ok)).toBe(true);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(snapshot.document.entries).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    stop();
  });
});
