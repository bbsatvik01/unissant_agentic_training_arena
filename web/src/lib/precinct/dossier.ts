/** Public-only projections. This module never receives a trial, evaluator, or complete recording. */
import type { Content, SnapshotRelease } from "../contracts/generated/types";
import type { RecordingCase } from "../world/recording";

export interface DossierSourceRef {
  readonly kind: "document" | "record";
  readonly id: string;
}

export interface DossierSource {
  readonly ref: DossierSourceRef;
  readonly title: string;
  readonly kind: string;
  readonly content: Content;
  readonly release: { readonly turn: number; readonly trigger: string } | null;
  readonly date: string | null;
}

/** Kind is part of the key: a public document and record may legitimately share an ID. */
export function sourceKey(ref: DossierSourceRef): string {
  return JSON.stringify([ref.kind, ref.id]);
}

export function dossierSources(packet: RecordingCase, released: readonly SnapshotRelease[]): readonly DossierSource[] {
  const sources: DossierSource[] = [];
  const seen = new Set<string>();
  const append = (source: DossierSource) => {
    const key = sourceKey(source.ref);
    if (!seen.has(key)) { sources.push(source); seen.add(key); }
  };
  for (const document of packet.initial_documents) append({
    ref: { kind: "document", id: document.doc_id }, title: document.title, kind: document.kind,
    content: document.content, release: null, date: null,
  });
  for (const record of released) append({
    ref: { kind: "record", id: record.record_id }, title: record.title, kind: record.doc_kind ?? record.kind,
    content: record.content, release: { turn: record.released_at_turn, trigger: record.trigger }, date: record.date,
  });
  return sources;
}

export interface DossierTimelineEntry {
  readonly id: string;
  readonly source: DossierSourceRef;
  readonly sourceTitle: string;
  readonly label: string;
  /** Verbatim source value, never an inferred date, timezone, or converted instant. */
  readonly when: string;
  readonly cells: readonly { readonly column: string; readonly value: string }[];
  /** One-based original table row; null denotes record-date metadata, not a case event. */
  readonly row: number | null;
}

const TIME_COLUMNS = new Set(["time", "date", "date/time", "date time", "timestamp", "created", "raised", "cleared", "start time", "end time"]);

/**
 * A source-order reading aid, not reconstructed chronology. Only explicitly labeled table time/date
 * cells and released-record date metadata appear. No NLP, title-date guessing, or hidden facts.
 * Repeated times remain distinct; each entry cites its original row and includes all other cells.
 */
export function dossierTimeline(sources: readonly DossierSource[]): readonly DossierTimelineEntry[] {
  const entries: DossierTimelineEntry[] = [];
  for (const source of sources) {
    const key = sourceKey(source.ref);
    if (source.date !== null && source.date.trim() !== "") entries.push({
      id: `${key}:date`, source: source.ref, sourceTitle: source.title,
      label: "Record date (metadata)", when: source.date, cells: [], row: null,
    });
    const table = source.content.table;
    if (table == null) continue;
    table.rows.forEach((row, rowIndex) => {
      table.columns.forEach((column, columnIndex) => {
        const value = row[columnIndex];
        if (!TIME_COLUMNS.has(column.trim().toLowerCase()) || value === undefined || value.trim() === "" || value.trim() === "-") return;
        entries.push({
          id: `${key}:row:${String(rowIndex)}:column:${String(columnIndex)}`,
          source: source.ref, sourceTitle: source.title, label: column, when: value, row: rowIndex + 1,
          cells: row.map((cell, index) => ({ column: table.columns[index] ?? `Column ${String(index + 1)}`, value: cell })),
        });
      });
    });
  }
  return entries;
}
