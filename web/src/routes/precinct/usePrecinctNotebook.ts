/** Route-owned notebook and explicit preparation-to-new-run handoff; never automatic device reads. */
import { useCallback, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { SnapshotRelease } from "../../lib/contracts/generated/types";
import { dossierSources } from "../../lib/precinct/dossier";
import type { NotebookResult } from "../../lib/precinct/notebook";
import { createNotebookWorkspace } from "../../lib/precinct/notebookWorkspace";
import { createPreparationHandoff, type PreparationContext } from "../../lib/precinct/preparationHandoff";
import type { RecordingCase } from "../../lib/world/recording";

export interface PrecinctNotebookOptions extends PreparationContext {
  readonly packet: RecordingCase | null;
  readonly released: readonly SnapshotRelease[];
  /** Source + sessionKey; live scope also includes the authenticated user. */
  readonly scope: string;
  readonly readOnly: boolean;
}

export function usePrecinctNotebook({ packet, released, scope, readOnly, caseId: selectedCaseId, source, runKey }: PrecinctNotebookOptions) {
  const caseId = packet?.case_id ?? selectedCaseId ?? "unselected";
  const controller = useMemo(() => createNotebookWorkspace({ caseId, scope, readOnly }), [caseId, scope, readOnly]);
  const handoff = useMemo(() => createPreparationHandoff(), []);
  // Update allowlists before a user can act. Source arrivals do not replace the controller.
  useLayoutEffect(() => {
    controller.setSources(packet === null ? [] : dossierSources(packet, released).map((item) => item.ref));
    handoff.update({ caseId: selectedCaseId, source, runKey });
  }, [controller, packet, released, handoff, selectedCaseId, source, runKey]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const offer = useSyncExternalStore(handoff.subscribe, handoff.getSnapshot, handoff.getSnapshot);
  const carryAvailable = !readOnly && source === "live" && runKey !== null && offer !== null && offer.runKey === runKey && packet !== null && packet.case_id === offer.document.caseId;
  const prepareForNewRun = useCallback(() => {
    handoff.clear();
    if (readOnly || source !== "idle" || packet === null || packet.case_id !== selectedCaseId) return false;
    const document = controller.getSnapshot().document;
    handoff.arm(document);
    return document.entries.length > 0;
  }, [controller, handoff, packet, readOnly, selectedCaseId, source]);
  const carryPreparation = useCallback((): NotebookResult => {
    if (!carryAvailable) return { ok: false, error: "No preparation notes are offered for this new run." };
    const result = controller.carryPreparation(offer.document);
    if (result.ok) handoff.clear();
    return result;
  }, [carryAvailable, controller, handoff, offer]);
  return { key: JSON.stringify([scope, caseId, readOnly]), snapshot, actions: controller.actions, readOnly,
    prepareForNewRun, discardPreparation: handoff.clear, carryAvailable, carryCount: carryAvailable ? offer.document.entries.length : 0, carryPreparation };
}

export type PrecinctNotebook = ReturnType<typeof usePrecinctNotebook>;
