/** Local-only controller. The storage capability is acquired only after an explicit user action. */
import type { DossierSourceRef } from "./dossier";
import { changeNotebook, emptyNotebook, NOTEBOOK_LIMITS, parseNotebook, serializeNotebook, type NotebookCommand, type NotebookDocument, type NotebookDraft, type NotebookResult } from "./notebook";

export interface NotebookStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}
export interface NotebookSnapshot {
  readonly document: NotebookDocument;
  readonly savingEnabled: boolean;
  readonly persistence: "memory" | "saved" | "error";
  readonly hasSavedCopy: boolean | null;
  readonly message: string;
}
export interface NotebookActions {
  readonly add: (draft: NotebookDraft) => NotebookResult;
  readonly edit: (id: string, draft: NotebookDraft) => NotebookResult;
  readonly remove: (id: string) => NotebookResult;
  readonly clear: () => NotebookResult;
  readonly enableSaving: () => NotebookResult;
  readonly disableSaving: () => NotebookResult;
  readonly restoreSaved: () => NotebookResult;
  readonly forgetSaved: () => NotebookResult;
}
export interface NotebookController {
  readonly getSnapshot: () => NotebookSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly actions: NotebookActions;
  /** Explicit same-case preparation transfer into an empty, memory-only new run. */
  readonly carryPreparation: (document: NotebookDocument) => NotebookResult;
  /** Called by the parent as public records are released; never pass requestable/private records. */
  readonly setSources: (sources: readonly DossierSourceRef[]) => void;
}
export interface NotebookControllerOptions {
  readonly caseId: string;
  /** A stable user/session or trial scope. Different runs must not share a storage key. */
  readonly scope: string;
  readonly sources: readonly DossierSourceRef[];
  readonly storage: () => NotebookStorage;
  readonly now: () => number;
  readonly createId: () => string;
}
export function notebookStorageKey(scope: string, caseId: string): string {
  return `arena.notebook.v1:${encodeURIComponent(scope)}:${encodeURIComponent(caseId)}`;
}

export function createNotebookController(options: NotebookControllerOptions): NotebookController {
  const key = notebookStorageKey(options.scope, options.caseId);
  let sources = options.sources;
  let snapshot: NotebookSnapshot = {
    document: emptyNotebook(options.caseId), savingEnabled: false, persistence: "memory", hasSavedCopy: null,
    message: "Notes stay in this session unless you choose to save on this device.",
  };
  const listeners = new Set<() => void>();
  const publish = (next: NotebookSnapshot) => { snapshot = next; for (const listener of listeners) listener(); };
  const success = (command: NotebookCommand | null = null): NotebookResult => ({ ok: true, document: snapshot.document, command });
  const fail = (error: string): NotebookResult => {
    publish({ ...snapshot, persistence: "error", message: error });
    return { ok: false, error };
  };
  const save = (): NotebookResult => {
    try {
      const serialized = serializeNotebook(snapshot.document);
      if (serialized.length > NOTEBOOK_LIMITS.serialized) return fail("Notes are in memory, but the saved notebook would exceed the device-storage limit.");
      options.storage().setItem(key, serialized);
      publish({ ...snapshot, persistence: "saved", hasSavedCopy: true, message: "Saved on this browser and device. Notes are not synced to an account." });
      return success();
    } catch {
      return fail("Device saving failed. Your current notes are still in memory; an older saved copy may remain. Retry saving or forget the saved copy.");
    }
  };
  const apply = (command: NotebookCommand): NotebookResult => {
    const result = changeNotebook(snapshot.document, command, sources);
    if (!result.ok) return result;
    snapshot = { ...snapshot, document: result.document };
    if (snapshot.savingEnabled) save();
    else publish(snapshot);
    // A storage failure does not undo a successful in-memory edit; status remains visible in snapshot.
    return result;
  };
  const load = (): NotebookResult => {
    let saved: string | null;
    try { saved = options.storage().getItem(key); }
    catch { return fail("Device storage could not be read. Current notes are unchanged."); }
    if (saved === null) {
      publish({ ...snapshot, hasSavedCopy: false });
      return { ok: true, document: emptyNotebook(options.caseId), command: null };
    }
    const parsed = parseNotebook(saved, options.caseId, sources);
    if (!parsed.ok) { publish({ ...snapshot, hasSavedCopy: true }); return fail(`${parsed.error} Current notes and the saved copy are unchanged.`); }
    publish({ ...snapshot, hasSavedCopy: true });
    return parsed;
  };
  const actions: NotebookActions = {
    add(draft) {
      const atMs = options.now();
      return apply({ type: "add", entry: { ...draft, id: options.createId(), createdAtMs: atMs, updatedAtMs: atMs } });
    },
    edit(id, draft) { return apply({ type: "edit", id, draft, atMs: options.now() }); },
    remove(id) { return apply({ type: "remove", id }); },
    clear() { return apply({ type: "clear" }); },
    enableSaving() {
      if (snapshot.savingEnabled) return save();
      const loaded = load();
      if (!loaded.ok) return loaded;
      if (snapshot.document.entries.length > 0 && loaded.document.entries.length > 0 && serializeNotebook(snapshot.document) !== serializeNotebook(loaded.document)) {
        return fail("A different saved notebook exists. Restore that copy to replace current notes, or forget it before saving current notes.");
      }
      snapshot = { ...snapshot, savingEnabled: true, document: snapshot.document.entries.length === 0 ? loaded.document : snapshot.document };
      return save();
    },
    disableSaving() {
      publish({ ...snapshot, savingEnabled: false, persistence: "memory", message: "Device saving is off. Any previously saved copy remains until you forget it." });
      return success();
    },
    restoreSaved() {
      const loaded = load();
      if (!loaded.ok) return loaded;
      if (snapshot.hasSavedCopy === false) return fail("No saved notebook was found. Current notes are unchanged.");
      publish({ ...snapshot, document: loaded.document, savingEnabled: true, persistence: "saved", message: "Saved notes restored. Further changes will be saved on this device." });
      return success();
    },
    forgetSaved() {
      snapshot = { ...snapshot, savingEnabled: false };
      try {
        const storage = options.storage();
        storage.removeItem(key);
        if (storage.getItem(key) !== null) return fail("The saved copy could not be removed. Device saving is off; current notes remain in memory.");
        publish({ ...snapshot, persistence: "memory", hasSavedCopy: false, message: "Saved copy removed from this browser. Current notes remain in memory; device saving is off." });
        return success();
      } catch {
        return fail("The saved copy could not be removed from this browser. Device saving is off; current notes remain in memory.");
      }
    },
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    actions,
    carryPreparation(document) {
      if (snapshot.document.entries.length > 0 || snapshot.savingEnabled) return { ok: false, error: "Preparation notes can be carried only into an empty notebook with device saving off. Current notes are unchanged." };
      const checked = parseNotebook(serializeNotebook(document), options.caseId, sources);
      if (!checked.ok) return checked;
      publish({ ...snapshot, document: checked.document, persistence: "memory", message: "Preparation notes carried into this run in memory. Choose Save on this device separately if wanted." });
      return success();
    },
    setSources(next) { sources = next; },
  };
}
