/** A single public source on a single table. No transcript interpretation or release inference. */
import type { SnapshotRelease } from "../contracts/generated/types";
import type { CaseDocument } from "../world/recording";
import type { DossierSourceRef } from "./dossier";

export type PublicEvidenceRef = DossierSourceRef;
export interface PublicEvidenceSource {
  readonly ref: PublicEvidenceRef;
  readonly title: string;
}
export interface EvidenceTableState {
  /** Route-owned case + source + actual session key. A change clears both references. */
  readonly scope: string;
  readonly selected: PublicEvidenceRef | null;
  readonly presented: PublicEvidenceRef | null;
}
export type EvidenceTableAction =
  | { readonly type: "select"; readonly source: PublicEvidenceRef }
  | { readonly type: "present"; readonly source: PublicEvidenceRef }
  | { readonly type: "clear" };

/** Only opening documents and records already in the current public reducer projection are eligible. */
export function publicEvidenceSources(documents: readonly CaseDocument[], released: readonly SnapshotRelease[]): readonly PublicEvidenceSource[] {
  const seen = new Set<string>();
  return [
    ...documents.map((document) => ({ ref: { kind: "document", id: document.doc_id } as const, title: document.title })),
    ...released.map((record) => ({ ref: { kind: "record", id: record.record_id } as const, title: record.title })),
  ].filter((source) => {
    const key = JSON.stringify([source.ref.kind, source.ref.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sameEvidenceRef(a: PublicEvidenceRef | null, b: PublicEvidenceRef | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.id === b.id;
}

export function publicEvidenceSource(ref: PublicEvidenceRef | null, sources: readonly PublicEvidenceSource[]): PublicEvidenceSource | null {
  return sources.find((source) => sameEvidenceRef(source.ref, ref)) ?? null;
}

export function emptyEvidenceTable(scope: string): EvidenceTableState {
  return { scope, selected: null, presented: null };
}

/** Revalidate on every projection, including rewind and changed case/run. Never retain revoked releases. */
export function reconcileEvidenceTable(state: EvidenceTableState, scope: string, sources: readonly PublicEvidenceSource[], readOnly: boolean): EvidenceTableState {
  if (state.scope !== scope) return emptyEvidenceTable(scope);
  return {
    scope,
    selected: publicEvidenceSource(state.selected, sources)?.ref ?? null,
    presented: readOnly ? null : publicEvidenceSource(state.presented, sources)?.ref ?? null,
  };
}

/** Bounded to two public refs. Requestable metadata has no input path and cannot be promoted to evidence. */
export function reduceEvidenceTable(state: EvidenceTableState, action: EvidenceTableAction, scope: string, sources: readonly PublicEvidenceSource[], readOnly: boolean): EvidenceTableState {
  const current = reconcileEvidenceTable(state, scope, sources, readOnly);
  if (action.type === "clear") return { ...current, presented: null };
  const source = publicEvidenceSource(action.source, sources);
  if (source === null) return current;
  if (action.type === "select") return { ...current, selected: source.ref };
  if (readOnly) return current;
  return { scope, selected: source.ref, presented: source.ref };
}

/** A neutral draft only. The user must still review and explicitly Send in the canonical composer. */
export function evidenceQuestion(ref: PublicEvidenceRef | null, sources: readonly PublicEvidenceSource[]): string | null {
  const source = publicEvidenceSource(ref, sources);
  if (source === null) return null;
  const question = `Looking at ${source.ref.kind === "document" ? "document" : "record"} ${source.ref.id}, what can you tell me about the information shown here?`;
  // Keep the composer limit intact even for an unexpectedly long public identifier. Never truncate a citation.
  return question.length <= 600 ? question : null;
}
