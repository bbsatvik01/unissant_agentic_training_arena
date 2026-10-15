import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SnapshotRelease } from "../../lib/contracts/generated/types";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { dossierSources, dossierTimeline, sourceKey, type DossierSource, type DossierSourceRef } from "../../lib/precinct/dossier";
import { isNoteKind, NOTE_KIND_LABELS, NOTE_KINDS, NOTEBOOK_LIMITS, type NotebookCommand, type NotebookDocument, type NotebookDraft, type NotebookEntry, type NotebookResult } from "../../lib/precinct/notebook";
import type { NotebookActions, NotebookSnapshot } from "../../lib/precinct/notebookController";
import type { RecordingCase } from "../../lib/world/recording";
import "../../styles/dossier.css";

const PAGES = [
  { id: "overview", label: "Overview" }, { id: "documents", label: "Documents" }, { id: "subject", label: "Subject" },
  { id: "evidence", label: "Evidence" }, { id: "timeline", label: "Timeline" }, { id: "notebook", label: "Notebook" },
] as const;
export type DossierPage = (typeof PAGES)[number]["id"];
type PersistenceAction = "enable" | "disable" | "restore" | "forget";
export type DossierUiEvent =
  | { readonly type: "page.open"; readonly page: DossierPage }
  | { readonly type: "source.open"; readonly source: DossierSourceRef }
  | { readonly type: "evidence.present"; readonly source: DossierSourceRef }
  | { readonly type: "reading.scale"; readonly percent: number }
  | { readonly type: "notebook.draft"; readonly draft: NotebookDraft; readonly editingId: string | null }
  | { readonly type: "notebook.change"; readonly command: NotebookCommand; readonly document: NotebookDocument }
  | { readonly type: "notebook.carry"; readonly document: NotebookDocument }
  | { readonly type: "notebook.persistence"; readonly action: PersistenceAction; readonly ok: boolean; readonly document: NotebookDocument | null };

export interface DossierPanelProps {
  readonly packet: RecordingCase;
  readonly released: readonly SnapshotRelease[];
  readonly notebook: NotebookSnapshot;
  readonly notebookActions: NotebookActions;
  /** V1 playback has no notebook event history; never mount a working/device notebook in replay. */
  readonly notebookReadOnly?: boolean;
  readonly recordedNotebook?: ReactNode;
  readonly onUiEvent: (event: DossierUiEvent) => void;
  /** Optional world affordance. Only already-public sources can be presented. */
  readonly onPresentEvidence?: (source: DossierSourceRef) => void;
}

function SourceLabel({ source }: { readonly source: DossierSource }) {
  return <><span className="dossier-source-id">{source.ref.id}</span>{" "}<span>{source.title}</span></>;
}

function SourceReader({ source }: { readonly source: DossierSource }) {
  const table = source.content.table;
  return <article className="dossier-paper" aria-label={`Original source: ${source.title}`}>
    <div className="dossier-paper-masthead"><span>PUBLIC CASE MATERIAL</span><span>{source.ref.id}</span></div>
    <div className="dossier-source-kind">{source.kind.replaceAll("_", " ")}</div>
    <h4>{source.title}</h4>
    {source.release === null ? <p className="dossier-caption">Available in the opening packet</p> : <p className="dossier-caption">Released at interview turn {source.release.turn} · {source.release.trigger}{source.date === null ? "" : ` · Record date: ${source.date}`}</p>}
    <p className="dossier-document-body">{source.content.body}</p>
    {table == null ? null : <div className="dossier-table-scroll" role="region" aria-label={`${source.title} table, scroll horizontally if needed`} tabIndex={0}>
      <table><caption>{source.title} · Original table</caption><thead><tr>{table.columns.map((column, index) => <th scope="col" key={index}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>
    </div>}
    <footer className="dossier-paper-footer"><span>SOURCE {source.ref.id}</span><span>Original public text · Read in context</span></footer>
  </article>;
}

const EMPTY_DRAFT: NotebookDraft = { kind: "observation", text: "", citations: [] };

function Notebook({ snapshot, actions, sources, onUiEvent, onOpenSource }: {
  readonly snapshot: NotebookSnapshot;
  readonly actions: NotebookActions;
  readonly sources: readonly DossierSource[];
  readonly onUiEvent: (event: DossierUiEvent) => void;
  readonly onOpenSource: (source: DossierSourceRef) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<NotebookDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"clear" | "forget" | "restore" | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const available = new Map(sources.map((source) => [sourceKey(source.ref), source]));
  const updateDraft = (next: NotebookDraft, nextEditingId: string | null = editingId) => {
    setDraft(next); setEditingId(nextEditingId); setError(null);
    onUiEvent({ type: "notebook.draft", draft: next, editingId: nextEditingId });
  };
  const complete = (result: NotebookResult): boolean => {
    if (!result.ok) { setError(result.error); return false; }
    setError(null);
    if (result.command !== null) onUiEvent({ type: "notebook.change", command: result.command, document: result.document });
    return true;
  };
  const persist = (action: PersistenceAction) => {
    const method = { enable: actions.enableSaving, disable: actions.disableSaving, restore: actions.restoreSaved, forget: actions.forgetSaved }[action];
    const result = method();
    complete(result);
    onUiEvent({ type: "notebook.persistence", action, ok: result.ok, document: result.ok ? result.document : null });
    if (result.ok && action === "restore") updateDraft(EMPTY_DRAFT, null);
    setConfirm(null);
  };
  const edit = (entry: NotebookEntry) => {
    updateDraft({ kind: entry.kind, text: entry.text, citations: entry.citations }, entry.id);
    editor.current?.focus();
  };
  return <div className="dossier-notebook">
    <div className="dossier-section-intro"><span className="dossier-eyebrow">YOUR WORKING NOTES</span><h4>Leave a trail of reasoning.</h4><p>Capture questions, source references, and possibilities to test. A possible contradiction is your note, not an established fact or a finding.</p></div>
    <div className="dossier-notebook-grid">
      <form className="dossier-note-form" onSubmit={(event) => {
        event.preventDefault();
        if (complete(editingId === null ? actions.add(draft) : actions.edit(editingId, draft))) updateDraft(EMPTY_DRAFT, null);
      }}>
        <label htmlFor={`${id}-kind`}>Note type</label><select id={`${id}-kind`} value={draft.kind} onChange={(event) => { if (isNoteKind(event.target.value)) updateDraft({ ...draft, kind: event.target.value }); }}>{NOTE_KINDS.map((kind) => <option key={kind} value={kind}>{NOTE_KIND_LABELS[kind]}</option>)}</select>
        <label htmlFor={`${id}-text`}>{editingId === null ? "New note" : "Edit note"}</label><textarea ref={editor} id={`${id}-text`} value={draft.text} rows={7} maxLength={NOTEBOOK_LIMITS.text} placeholder="What does the source say? What still needs to be checked?" aria-describedby={`${id}-limit`} onChange={(event) => { updateDraft({ ...draft, text: event.target.value }); }} />
        <p className="dossier-caption" id={`${id}-limit`}>{draft.text.length} / {NOTEBOOK_LIMITS.text} characters · {snapshot.document.entries.length} / {NOTEBOOK_LIMITS.entries} notes</p>
        <fieldset><legend>Cite public sources <span>(up to {NOTEBOOK_LIMITS.citations})</span></legend>{sources.length === 0 ? <p className="dossier-caption">No public sources are available yet.</p> : <div className="dossier-citation-picker">{sources.map((source) => {
          const checked = draft.citations.some((ref) => sourceKey(ref) === sourceKey(source.ref));
          return <label key={sourceKey(source.ref)}><input type="checkbox" checked={checked} disabled={!checked && draft.citations.length >= NOTEBOOK_LIMITS.citations} onChange={() => { updateDraft({ ...draft, citations: checked ? draft.citations.filter((ref) => sourceKey(ref) !== sourceKey(source.ref)) : [...draft.citations, source.ref] }); }} /><span><SourceLabel source={source} /></span></label>;
        })}</div>}</fieldset>
        <div className="dossier-actions"><button className="dossier-button dossier-button-primary" type="submit">{editingId === null ? "Add note" : "Save changes"}</button>{editingId === null ? null : <button className="dossier-button" type="button" onClick={() => { updateDraft(EMPTY_DRAFT, null); }}>Cancel edit</button>}</div>
        {error === null ? null : <p className="dossier-error" role="alert">{error}</p>}
      </form>
      <div className="dossier-note-list" aria-label="Saved working notes">
        {snapshot.document.entries.length === 0 ? <div className="dossier-empty"><span aria-hidden="true">01</span><h5>A fresh page.</h5><p>Your notes will appear here. Keep observations separate from assumptions.</p></div> : snapshot.document.entries.map((entry, index) => <article className="dossier-note" key={entry.id}>
          <div className="dossier-note-heading"><span>{String(index + 1).padStart(2, "0")} / {NOTE_KIND_LABELS[entry.kind]}</span><span className="dossier-caption">Trainee note</span></div>
          <p>{entry.text}</p><div className="dossier-note-citations">{entry.citations.map((ref) => { const source = available.get(sourceKey(ref)); return source === undefined ? <span className="dossier-caption" key={sourceKey(ref)}>Source unavailable in this packet</span> : <button type="button" key={sourceKey(ref)} className="dossier-cite" onClick={() => { onOpenSource(ref); }} aria-label={`Open cited source ${ref.id}: ${source.title}`}>{ref.id}</button>; })}</div>
          <div className="dossier-actions"><button type="button" className="dossier-text-button" onClick={() => { edit(entry); }} aria-label={`Edit note ${String(index + 1)}`}>Edit</button><button type="button" className="dossier-text-button" onClick={() => { if (complete(actions.remove(entry.id)) && editingId === entry.id) updateDraft(EMPTY_DRAFT, null); }} aria-label={`Remove note ${String(index + 1)}`}>Remove</button></div>
        </article>)}
      </div>
    </div>
    <section className="dossier-storage" aria-label="Notebook device storage"><div><strong>{snapshot.savingEnabled ? "Device saving is on" : "Device saving is off"}</strong><p role="status" aria-live="polite" className={snapshot.persistence === "error" ? "dossier-error" : "dossier-caption"}>{snapshot.message}</p><p className="dossier-caption">Anyone using this browser profile may be able to read saved notes. Clearing session notes and forgetting the saved copy are separate actions.</p></div><div className="dossier-actions">
      <button type="button" className="dossier-button" onClick={() => { persist(snapshot.savingEnabled && snapshot.persistence !== "error" ? "disable" : "enable"); }}>{snapshot.savingEnabled ? snapshot.persistence === "error" ? "Retry device save" : "Turn saving off" : "Save on this device"}</button>
      <button type="button" className="dossier-text-button" onClick={() => { setConfirm("restore"); }}>Restore saved copy</button>
      <button type="button" className="dossier-text-button" onClick={() => { setConfirm("forget"); }}>Forget saved copy</button>
      <button type="button" className="dossier-text-button" disabled={snapshot.document.entries.length === 0} onClick={() => { setConfirm("clear"); }}>Clear session notes</button>
    </div>
      {confirm === null ? null : <div className="dossier-confirm" role="group" aria-label="Confirm notebook action"><p>{confirm === "clear" ? `Clear all notes in this session?${snapshot.savingEnabled ? " The saved copy will also be updated if device saving succeeds." : " A previously saved copy will remain."}` : confirm === "restore" ? "Replace current notes with the saved copy and turn on device saving? An unreadable or unavailable saved copy will leave current notes unchanged." : "Remove the saved notebook from this browser and turn off device saving? Current session notes will remain."}</p><div className="dossier-actions"><button type="button" className="dossier-button" onClick={() => { if (confirm === "clear") { if (complete(actions.clear())) updateDraft(EMPTY_DRAFT, null); setConfirm(null); } else persist(confirm); }}>Confirm {confirm === "clear" ? "clear" : confirm === "restore" ? "restore" : "forget"}</button><button type="button" className="dossier-text-button" onClick={() => { setConfirm(null); }}>Cancel</button></div></div>}
    </section>
  </div>;
}

/** Dialog CONTENT only. The parent owns modal focus, Escape, movement suppression, and lifecycle. */
export function DossierPanel({ packet, released, notebook, notebookActions, notebookReadOnly = false, recordedNotebook, onUiEvent, onPresentEvidence }: DossierPanelProps) {
  const id = useId();
  const [page, setPage] = useState<DossierPage>("overview");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [scale, setScale] = useState(100);
  const tabs = useRef(new Map<DossierPage, HTMLButtonElement>());
  const sources = dossierSources(packet, released);
  const selected = sources.find((source) => sourceKey(source.ref) === selectedKey) ?? sources[0];
  const timeline = dossierTimeline(sources);
  const notebookMatchesCase = notebook.document.caseId === packet.case_id;
  const openPage = (next: DossierPage) => { setPage(next); onUiEvent({ type: "page.open", page: next }); };
  const openSource = (ref: DossierSourceRef) => {
    if (!sources.some((source) => sourceKey(source.ref) === sourceKey(ref))) return;
    setSelectedKey(sourceKey(ref)); openPage("documents"); tabs.current.get("documents")?.focus(); onUiEvent({ type: "source.open", source: ref });
  };
  const navigateTabs = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    let next: number;
    if (event.key === "ArrowRight") next = (current + 1) % PAGES.length;
    else if (event.key === "ArrowLeft") next = (current + PAGES.length - 1) % PAGES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PAGES.length - 1;
    else return;
    event.preventDefault();
    const target = PAGES[next];
    if (target !== undefined) { openPage(target.id); tabs.current.get(target.id)?.focus(); }
  };
  return <section className="dossier-panel" aria-label={`Case dossier ${packet.case_id}`} data-reading-scale={scale}>
    <div className="dossier-cover-line"><span className="dossier-eyebrow">CASE FILE / {packet.case_id}</span><span className="dossier-stamp">SYNTHETIC TRAINING CASE</span></div>
    <div className="dossier-title-row"><h3>{packet.title}</h3><label className="dossier-reading-control">Reading size<select aria-label="Dossier reading size" value={scale} onChange={(event) => { const percent = Number(event.target.value); setScale(percent); onUiEvent({ type: "reading.scale", percent }); }}>{[100, 115, 130, 150].map((percent) => <option key={percent} value={percent}>{percent}%</option>)}</select></label></div>
    <div className="dossier-tabs" role="tablist" aria-label="Case dossier pages">{PAGES.map((item, index) => <button key={item.id} ref={(node) => { if (node === null) tabs.current.delete(item.id); else tabs.current.set(item.id, node); }} type="button" role="tab" id={`${id}-tab-${item.id}`} aria-controls={`${id}-page-${item.id}`} aria-selected={page === item.id} tabIndex={page === item.id ? 0 : -1} onClick={() => { openPage(item.id); }} onKeyDown={(event) => { navigateTabs(event, index); }}><span className="dossier-tab-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>{item.label}{item.id === "notebook" && !notebookReadOnly && notebookMatchesCase && notebook.document.entries.length > 0 ? <span className="dossier-tab-count">{notebook.document.entries.length}</span> : null}</button>)}</div>
    {PAGES.map((item) => <div key={item.id} role="tabpanel" id={`${id}-page-${item.id}`} aria-labelledby={`${id}-tab-${item.id}`} hidden={page !== item.id} tabIndex={0} className="dossier-page">
      {item.id === "overview" ? <div className="dossier-overview"><article><span className="dossier-eyebrow">THE ASSIGNMENT</span><h4>Start with what is known.</h4><p className="dossier-objective">{packet.objective}</p><div className="dossier-overview-facts"><div><span>Domain</span><strong>{packet.domain.replaceAll("_", " ")}</strong></div><div><span>Case difficulty</span><strong>Level {packet.difficulty_level}</strong></div><div><span>Opening documents</span><strong>{packet.initial_documents.length}</strong></div><div><span>Released records</span><strong>{sources.filter((source) => source.ref.kind === "record").length}</strong></div></div><button type="button" className="dossier-button dossier-button-primary" onClick={() => { if (selected === undefined) openPage("documents"); else openSource(selected.ref); }}>Open the documents <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14" /></svg></button></article><aside className="dossier-brief-card"><span className="dossier-eyebrow">INTERVIEW CONTEXT</span><h5>{packet.subject.display_name}</h5><p className="dossier-caption">{packet.subject.position}</p><hr /><p>{packet.setting}</p><span className="dossier-margin-note">Listen carefully.<br />Check the source.<br />Test another explanation.</span></aside></div> : null}
      {item.id === "documents" ? sources.length === 0 ? <p className="dossier-empty">This packet has no documents or released records yet.</p> : <div className="dossier-reader"><nav className="dossier-source-index" aria-label="Public source index"><span className="dossier-eyebrow">SOURCE INDEX</span>{sources.map((source) => <button type="button" key={sourceKey(source.ref)} aria-current={selected === source ? "page" : undefined} onClick={() => { openSource(source.ref); }}><SourceLabel source={source} /><small>{source.release === null ? "Opening document" : `Released · turn ${String(source.release.turn)}`}</small></button>)}</nav>{selected === undefined ? null : <div><SourceReader source={selected} /><div className="dossier-reader-controls"><span className="dossier-caption">Source {sources.indexOf(selected) + 1} of {sources.length}</span><div className="dossier-actions"><button type="button" className="dossier-button" disabled={sources.indexOf(selected) === 0} onClick={() => { const previous = sources[sources.indexOf(selected) - 1]; if (previous !== undefined) openSource(previous.ref); }}>Previous</button><button type="button" className="dossier-button" disabled={sources.indexOf(selected) === sources.length - 1} onClick={() => { const next = sources[sources.indexOf(selected) + 1]; if (next !== undefined) openSource(next.ref); }}>Next</button></div></div></div>}</div> : null}
      {item.id === "subject" ? <div className="dossier-profile"><div className="dossier-profile-monogram" aria-hidden="true">{packet.subject.display_name.split(/\s+/).map((word) => word[0] ?? "").slice(0, 2).join("")}</div><article><span className="dossier-eyebrow">PUBLIC SUBJECT PROFILE</span><h4>{packet.subject.display_name}</h4><dl><div><dt>Position</dt><dd>{packet.subject.position}</dd></div><div><dt>Interview setting</dt><dd>{packet.setting}</dd></div><div><dt>Profile source</dt><dd>Public case metadata · {packet.case_id}</dd></div></dl><p className="dossier-profile-note">This profile contains only the supplied public details. Nervousness, demeanor, accent and stress are never evidence.</p></article></div> : null}
      {item.id === "evidence" ? <><div className="dossier-section-intro"><span className="dossier-eyebrow">PUBLIC MATERIALS</span><h4>Keep the source in view.</h4><p>Opening documents and records already released in this session. Each source can be read in full.</p></div><ul className="dossier-evidence-list">{sources.map((source) => <li key={sourceKey(source.ref)}><span className="dossier-evidence-mark" aria-hidden="true">{source.ref.kind === "document" ? "D" : "R"}</span><div><SourceLabel source={source} /><p className="dossier-caption">{source.kind.replaceAll("_", " ")} · {source.release === null ? "Opening packet" : `Released at turn ${String(source.release.turn)} · ${source.release.trigger}`}</p></div><div className="dossier-actions"><button type="button" className="dossier-button" aria-label={`Read ${source.title}`} onClick={() => { openSource(source.ref); }}>Read</button>{onPresentEvidence === undefined ? null : <button type="button" className="dossier-text-button" aria-label={`Place on table ${source.title}`} onClick={() => { onPresentEvidence(source.ref); onUiEvent({ type: "evidence.present", source: source.ref }); }}>Place on table</button>}</div></li>)}</ul>{sources.length === 0 ? <p className="dossier-empty">No public materials are available yet.</p> : null}</> : null}
      {item.id === "timeline" ? <><div className="dossier-section-intro"><span className="dossier-eyebrow">SOURCE-LED TIMELINE</span><h4>Read the recorded sequence.</h4><p>Explicit table dates and times, shown in source order. Dates, time zones, and gaps are not inferred. Record dates are labeled as metadata. This is a reading aid, not a complete chronology.</p></div>{timeline.length === 0 ? <p className="dossier-empty">No explicitly labeled date or time cells are available. Read the original documents for narrative context.</p> : <ol className="dossier-timeline">{timeline.map((entry) => <li key={entry.id}><div className="dossier-timeline-time"><span>{entry.label}</span><strong>{entry.when}</strong></div><div><button type="button" className="dossier-cite" onClick={() => { openSource(entry.source); }}>{entry.source.id}{entry.row === null ? " · metadata" : ` · row ${String(entry.row)}`}</button><h5>{entry.sourceTitle}</h5><dl>{entry.cells.map((cell, index) => <div key={index}><dt>{cell.column}</dt><dd>{cell.value}</dd></div>)}</dl></div></li>)}</ol>}</> : null}
      {item.id === "notebook" ? notebookReadOnly ? (recordedNotebook ?? <p className="dossier-empty" role="status">This v1 recording does not contain notebook history. Device notes are not loaded into replay.</p>) : notebookMatchesCase ? <Notebook key={packet.case_id} snapshot={notebook} actions={notebookActions} sources={sources} onUiEvent={onUiEvent} onOpenSource={openSource} /> : <p role="alert" className="dossier-error">The notebook is not ready for this case. No notes from another case are shown.</p> : null}
    </div>)}
    <aside className="dossier-ground-rule"><strong>Evidence first. Always.</strong><p>{EX4_TEXT}</p></aside>
  </section>;
}
