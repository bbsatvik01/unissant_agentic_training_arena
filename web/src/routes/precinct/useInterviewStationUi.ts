import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { InterviewCitation, InterviewTab } from "../../components/precinct/InterviewStationPanel";
import { emptyEvidenceTable, reconcileEvidenceTable, reduceEvidenceTable, type EvidenceTableAction, type EvidenceTableState, type PublicEvidenceSource } from "../../lib/precinct/evidenceTable";

interface InterviewUiState {
  readonly called: boolean;
  readonly seated: boolean;
  readonly tab: InterviewTab;
  readonly citation: InterviewCitation | null;
  readonly table: EvidenceTableState;
}

function createStationUi(scope: string) {
  let sources: readonly PublicEvidenceSource[] = [];
  let readOnly = false;
  let snapshot: InterviewUiState = { called: false, seated: false, tab: "transcript", citation: null, table: emptyEvidenceTable(scope) };
  const listeners = new Set<() => void>();
  const publish = (next: InterviewUiState) => {
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return false;
    snapshot = next; for (const listener of listeners) listener();
    return true;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    configure: (nextScope: string, nextSources: readonly PublicEvidenceSource[], nextReadOnly: boolean) => {
      sources = nextSources; readOnly = nextReadOnly;
      publish({ ...snapshot, ...(snapshot.table.scope === nextScope ? {} : { tab: "transcript" as const, citation: null }), table: reconcileEvidenceTable(snapshot.table, nextScope, sources, readOnly) });
    },
    call: () => publish({ ...snapshot, called: true }),
    sit: () => publish({ ...snapshot, seated: true }),
    leave: () => publish({ ...snapshot, seated: false }),
    tab: (tab: InterviewTab) => publish({ ...snapshot, tab }),
    cite: (turn: number, quote: string) => publish({ ...snapshot, citation: { turn, quote, nonce: (snapshot.citation?.nonce ?? 0) + 1 } }),
    evidence: (action: EvidenceTableAction) => publish({ ...snapshot, table: reduceEvidenceTable(snapshot.table, action, snapshot.table.scope, sources, readOnly) }),
  };
}

/** Public scope resets table/citations/tabs; only an explicit new-start owner may retain call/seat. */
export function useInterviewStationUi(scope: string, sources: readonly PublicEvidenceSource[], readOnly: boolean, roomScope = scope) {
  const actions = useMemo(() => createStationUi(roomScope), [roomScope]);
  useLayoutEffect(() => { actions.configure(scope, sources, readOnly); }, [actions, scope, sources, readOnly]);
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
  return { state, actions };
}
