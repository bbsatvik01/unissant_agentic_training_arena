/** Content only; the route retains table refs and records accepted commands on its canonical clock. */
import { useId } from "react";
import type { SnapshotRelease } from "../../lib/contracts/generated/types";
import type { CaseDocument } from "../../lib/world/recording";
import { evidenceQuestion, publicEvidenceSource, publicEvidenceSources, reconcileEvidenceTable, sameEvidenceRef, type EvidenceTableAction, type EvidenceTableState, type PublicEvidenceRef } from "../../lib/precinct/evidenceTable";
import { EvidencePanel } from "../overlay/EvidencePanel";

export interface PublicEvidenceTableProps {
  readonly documents: readonly CaseDocument[];
  readonly released: readonly SnapshotRelease[];
  readonly scope: string;
  readonly state: EvidenceTableState;
  readonly readOnly: boolean;
  readonly onAction: (action: EvidenceTableAction) => void;
  /** Null unless the canonical live text composer can accept a draft. This never sends a question. */
  readonly onUseQuestion: ((question: string, source: PublicEvidenceRef) => void) | null;
}

export function PublicEvidenceTable({ documents, released, scope, state, readOnly, onAction, onUseQuestion }: PublicEvidenceTableProps) {
  const id = useId();
  const sources = publicEvidenceSources(documents, released);
  const current = reconcileEvidenceTable(state, scope, sources, readOnly);
  const selected = publicEvidenceSource(current.selected, sources);
  const presented = publicEvidenceSource(current.presented, sources);
  const question = evidenceQuestion(current.selected, sources);
  const selectedIndex = sources.findIndex((source) => sameEvidenceRef(source.ref, current.selected));
  return <section className="precinct-evidence-table" aria-labelledby={`${id}-heading`}>
    <div className="precinct-interview-kicker">PUBLIC SOURCE TABLE</div>
    <h3 id={`${id}-heading`}>Read, present, then ask</h3>
    <p>Choose an opening document or an already released record. Read it in context before deciding what to ask.</p>
    <label className="field" htmlFor={`${id}-source`}><span>Public source</span>
      <select id={`${id}-source`} value={selectedIndex < 0 ? "" : String(selectedIndex)} onChange={(event) => {
        if (event.target.value === "") return;
        const source = sources[Number(event.target.value)];
        if (source !== undefined) onAction({ type: "select", source: source.ref });
      }}>
        <option value="">Choose a source</option>
        {sources.map((source, index) => <option key={JSON.stringify([source.ref.kind, source.ref.id])} value={index}>{source.ref.kind === "document" ? "Opening document" : "Released record"} · {source.ref.id} · {source.title}</option>)}
      </select>
    </label>
    {sources.length === 0 ? <p className="precinct-note">No public sources are available for this case at the current point in the interview.</p> : null}
    <div className="precinct-evidence-actions">
      <button type="button" className="precinct-primary" disabled={selected === null || readOnly || sameEvidenceRef(current.selected, current.presented)} onClick={() => {
        if (selected !== null && !readOnly) onAction({ type: "present", source: selected.ref });
      }}>Lay selected source on table</button>
      <button type="button" className="precinct-secondary" disabled={selected === null || question === null || readOnly || onUseQuestion === null} onClick={() => {
        if (selected !== null && question !== null && !readOnly) onUseQuestion?.(question, selected.ref);
      }}>Use source in question draft</button>
      <button type="button" className="precinct-text-button" disabled={presented === null || readOnly} onClick={() => { if (!readOnly) onAction({ type: "clear" }); }}>Clear table</button>
    </div>
    <p className="precinct-table-status" role="status">{presented === null ? "The table is clear." : `On the table: ${presented.ref.id} · ${presented.title}`}</p>
    {readOnly ? <p className="precinct-note">Read-only recording. The original v1 file has no evidence-table handling history; browsing a source does not change this run.</p> : <p className="precinct-note">Presenting a source changes only this table. A question draft is not sent until you choose Send.</p>}
    {selected === null ? null : <div className="precinct-selected-source" aria-label={`Read selected source: ${selected.title}`}>
      <EvidencePanel documents={selected.ref.kind === "document" ? documents.filter((document) => document.doc_id === selected.ref.id) : []} released={selected.ref.kind === "record" ? released.filter((record) => record.record_id === selected.ref.id) : []} requestable={[]} exchangesUsed={0} freshId={null} onRequest={null} openSource={selected.ref} />
    </div>}
  </section>;
}
