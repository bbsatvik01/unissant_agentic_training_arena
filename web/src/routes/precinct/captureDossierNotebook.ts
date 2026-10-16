/** Typed accepted-user-action seam. Never observes DOM, device storage, or unrelated dossier events. */
import type { DossierUiEvent } from "../../components/precinct/DossierPanel";
import type { NotebookDocument } from "../../lib/precinct/notebook";
import type { NotebookInput } from "../../lib/world/worldEvents";

export type DossierCaptureResult = "captured" | "ignored" | "refused";

function documentInputs(document: Omit<NotebookDocument, "schema"> & { readonly schema: unknown }, caseId: string): readonly NotebookInput[] | null {
  if (document.schema !== "arena.notebook.v1" || document.caseId !== caseId || document.entries.length > 60) return null;
  const seen = new Set<string>();
  const inputs: NotebookInput[] = [{ action: "notebook", operation: "clear" }];
  for (const entry of document.entries) {
    if (seen.has(entry.id)) return null;
    seen.add(entry.id);
    inputs.push({ action: "notebook", operation: "upsert", note_id: entry.id, text: entry.text,
      metadata: { kind: entry.kind, citations: entry.citations, createdAtMs: entry.createdAtMs, updatedAtMs: entry.updatedAtMs } });
  }
  return inputs;
}

/**
 * Call synchronously inside the parent's accepted DossierUiEvent handler, with its current case ID.
 * Successful changes carry result.document, not the possibly stale React render snapshot. The capture
 * controller assigns one canonical timestamp and accepts every replacement sample or none locally.
 */
export function captureDossierNotebook(capture: { input(data: NotebookInput): boolean; inputs(data: readonly NotebookInput[]): boolean }, event: DossierUiEvent, caseId: string): DossierCaptureResult {
  if (event.type === "notebook.draft") return capture.input({ action: "notebook", operation: "draft",
    draft: { ...event.draft, editingId: event.editingId } }) ? "captured" : "refused";
  let document: NotebookDocument;
  switch (event.type) {
    case "notebook.change":
    case "notebook.carry": document = event.document; break;
    case "notebook.persistence":
      // Explicit Enable can restore an empty notebook too. Disable/Forget don't change its contents.
      if (!event.ok || event.document === null || (event.action !== "enable" && event.action !== "restore")) return "ignored";
      document = event.document; break;
    default: return "ignored";
  }
  const inputs = documentInputs(document, caseId);
  return inputs !== null && capture.inputs(inputs) ? "captured" : "refused";
}
