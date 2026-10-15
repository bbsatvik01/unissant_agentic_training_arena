/**
 * The evidence list (S6 4.4, court-record pattern): initial documents, released records with the turn and trigger
 * of their release, and the records that can be requested. Content is shown whole: the body as text and the table,
 * when present, with its header row, every cell a text node. Records are never tagged with what they contradict.
 */
import type { Content, RequestableRecord, SnapshotRelease } from "../../lib/contracts/generated/types";
import type { CaseDocument } from "../../lib/world/recording";

function Body({ content }: { content: Content }) {
  return (
    <div className="record-content">
      <p>{content.body}</p>
      {content.table == null ? null : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {content.table.columns.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface EvidencePanelProps {
  readonly documents: readonly CaseDocument[];
  readonly released: readonly SnapshotRelease[];
  readonly requestable: readonly RequestableRecord[];
  readonly exchangesUsed: number;
  /** The record just released, opened and marked (evidence released). */
  readonly freshId: string | null;
  /** Null in playback: requests come from the recording. */
  readonly onRequest: ((recordId: string) => void) | null;
  /** Explicit public-source selection. Omitted by existing callers, preserving their disclosure behavior. */
  readonly openSource?: { readonly kind: "document" | "record"; readonly id: string } | null;
}

export function EvidencePanel({ documents, released, requestable, exchangesUsed, freshId, onRequest, openSource = null }: EvidencePanelProps) {
  const releasedIds = new Set(released.map((r) => r.record_id));
  const open = requestable.filter((r) => !releasedIds.has(r.record_id));
  return (
    <div className="evidence">
      <span className="eyebrow">Initial documents</span>
      {documents.map((d) => (
        <details key={d.doc_id} className="record" open={openSource?.kind === "document" && openSource.id === d.doc_id ? true : undefined}>
          <summary>
            <span className="mono">{d.doc_id}</span> {d.title}
          </summary>
          <Body content={d.content} />
        </details>
      ))}
      <span className="eyebrow">Released records</span>
      {released.length === 0 ? <p className="empty">No records released yet.</p> : null}
      {released.map((r) => (
        <details key={r.record_id} className="record" data-fresh={r.record_id === freshId ? "true" : "false"} open={r.record_id === freshId || (openSource?.kind === "record" && openSource.id === r.record_id) ? true : undefined}>
          <summary>
            <span className="mono">{r.record_id}</span> {r.title}
            <span className="record-meta">
              {r.doc_kind === null ? "" : `${r.doc_kind.replaceAll("_", " ")}, `}Released at T{r.released_at_turn}, {r.trigger}
              {r.date === null ? "" : `, ${r.date}`}
            </span>
          </summary>
          <Body content={r.content} />
        </details>
      ))}
      {open.length === 0 ? null : (
        <>
          <span className="eyebrow">Requestable records</span>
          {open.map((r) => {
            const ready = exchangesUsed >= r.requestable_after_exchanges;
            return (
              <div key={r.record_id} className="requestable">
                <div>
                  <span className="mono">{r.record_id}</span> {r.title}
                  <p className="fine">{r.description}</p>
                </div>
                <button
                  type="button"
                  className="btn-secondary-sm"
                  disabled={onRequest === null || !ready}
                  onClick={() => {
                    onRequest?.(r.record_id);
                  }}
                >
                  {ready ? "Request" : `After ${String(r.requestable_after_exchanges)} exchanges`}
                </button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
