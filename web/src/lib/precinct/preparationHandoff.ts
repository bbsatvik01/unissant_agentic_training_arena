/** Explicit next-run handoff. This memory-only offer is never inferred from a matching case alone. */
import type { NotebookDocument } from "./notebook";

export interface PreparationContext {
  readonly caseId: string | null;
  readonly source: "idle" | "live" | "recording";
  /** The actual running local session key, never a pending-start key or a recording's ID. */
  readonly runKey: string | null;
}
export interface PreparationOffer {
  readonly document: NotebookDocument;
  readonly runKey: string | null;
}

export function createPreparationHandoff() {
  let snapshot: PreparationOffer | null = null;
  let sawLive = false;
  const listeners = new Set<() => void>();
  const publish = (next: PreparationOffer | null) => { snapshot = next; for (const listener of listeners) listener(); };
  const clear = () => { sawLive = false; if (snapshot !== null) publish(null); };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Call only at the explicit NEW local-run start, not Resume or a historical-file load. */
    arm: (document: NotebookDocument) => {
      clear();
      if (document.entries.length > 0) publish({ document, runKey: null });
    },
    clear,
    update: ({ caseId, source, runKey }: PreparationContext) => {
      if (snapshot === null) return;
      if (source === "recording" || caseId !== snapshot.document.caseId || (source === "idle" && sawLive)) { clear(); return; }
      if (source !== "live") return;
      sawLive = true;
      if (runKey === null) return;
      if (snapshot.runKey === null) publish({ ...snapshot, runKey });
      else if (snapshot.runKey !== runKey) clear();
    },
  };
}
