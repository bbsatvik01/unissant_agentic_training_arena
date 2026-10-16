/** Projects only an accepted single-table action. The canonical table still owns all state. */
import { publicEvidenceSource, sameEvidenceRef, type EvidenceTableAction, type EvidenceTableState, type PublicEvidenceRef, type PublicEvidenceSource } from "../../lib/precinct/evidenceTable";
import type { InputData } from "../../lib/world/worldEvents";

type EvidenceInput = Extract<InputData, { action: "evidence" }>;
export type EvidenceCapturePlan = { readonly ok: true; readonly inputs: readonly EvidenceInput[] } | { readonly ok: false };
const same = (left: PublicEvidenceRef | null, right: PublicEvidenceRef | null) => left === null ? right === null : sameEvidenceRef(left, right);

/** Read before/after from actions.getSnapshot(), not a potentially stale React render. */
export function evidenceTableInputs(before: EvidenceTableState, after: EvidenceTableState, action: EvidenceTableAction, accepted: boolean, sources: readonly PublicEvidenceSource[]): EvidenceCapturePlan {
  if (!accepted) return { ok: true, inputs: [] };
  if (before.scope !== after.scope) return { ok: false };
  const representable = (ref: PublicEvidenceRef) => publicEvidenceSource(ref, sources) !== null
    && sources.filter((source) => source.ref.id === ref.id).length === 1;
  const input = (operation: EvidenceInput["operation"], ref: PublicEvidenceRef): EvidenceInput => ({ action: "evidence", operation, record_id: ref.id });
  if (action.type === "select") {
    if (!same(before.presented, after.presented) || !same(after.selected, action.source) || !representable(action.source)) return { ok: false };
    return { ok: true, inputs: same(before.selected, after.selected) ? [] : [input("inspect", action.source)] };
  }
  const target = action.type === "clear" ? null : action.source;
  if (!same(after.presented, target)) return { ok: false };
  if (same(before.presented, after.presented)) return { ok: true, inputs: [] };
  // The existing world schema uses raw IDs. Cross-kind ID collisions cannot be represented faithfully.
  if ((before.presented !== null && !representable(before.presented)) || (after.presented !== null && !representable(after.presented))) return { ok: false };
  const inputs: EvidenceInput[] = [];
  if (before.presented !== null) inputs.push(input("unpin", before.presented));
  if (after.presented !== null) inputs.push(input("pin", after.presented));
  return { ok: true, inputs };
}
