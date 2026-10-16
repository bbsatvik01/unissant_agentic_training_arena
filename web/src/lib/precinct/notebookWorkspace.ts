/** Notebook lifecycle adapter. It acquires device storage only after an explicit controller action. */
import { emptyNotebook, type NotebookResult } from "./notebook";
import { createNotebookController, type NotebookController, type NotebookSnapshot, type NotebookStorage } from "./notebookController";

export interface NotebookWorkspaceOptions {
  readonly caseId: string;
  readonly scope: string;
  readonly readOnly: boolean;
  readonly storage?: () => NotebookStorage;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export function createNotebookWorkspace({ caseId, scope, readOnly, storage = () => window.localStorage, now = () => Date.now(), createId = () => crypto.randomUUID() }: NotebookWorkspaceOptions): NotebookController {
  if (readOnly) {
    // V1 files carry no notebook input history. Never substitute this device's future/live notes.
    const snapshot: NotebookSnapshot = {
      document: emptyNotebook(caseId), savingEnabled: false, persistence: "memory", hasSavedCopy: null,
      message: "This v1 recording does not contain notebook history. Device notes are not loaded into replay.",
    };
    const refuse = (): NotebookResult => ({ ok: false, error: "The recorded notebook is read-only." });
    return {
      getSnapshot: () => snapshot, subscribe: () => () => undefined, setSources: () => undefined, carryPreparation: refuse,
      actions: { add: refuse, edit: refuse, remove: refuse, clear: refuse, enableSaving: refuse, disableSaving: refuse, restoreSaved: refuse, forgetSaved: refuse },
    };
  }
  let clock = 0;
  const controller = createNotebookController({
    caseId, scope, sources: [], storage, createId,
    now: () => {
      // A saved note may be newer than the device clock. Preserve valid edit ordering after restore.
      const savedClock = controller.getSnapshot().document.entries.reduce((latest, entry) => Math.max(latest, entry.createdAtMs, entry.updatedAtMs), 0);
      clock = Math.max(clock, savedClock, now());
      return clock;
    },
  });
  return controller;
}
