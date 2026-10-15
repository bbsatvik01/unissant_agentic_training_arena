import type { WorldReplayState } from "../../lib/world/worldEvents";

/** Display-only captured state. Never calls notebook/evidence setters or reopens recorded dialogs. */
export function RecordedWorldStatePanel({ world, notebookOnly = false }: { readonly world: WorldReplayState; readonly notebookOnly?: boolean }) {
  return <section aria-label="Recorded world state"><h4>Recorded notebook · read-only</h4>
    {world.notes.size === 0 ? <p>No notebook entries were captured by this replay moment. Device notes are not substituted.</p> : <ol>{[...world.notes.values()].map((note) => <li key={note.id}>
      <p>{note.text}</p><p>Captured at {note.updatedAtMs} ms</p>
      {note.metadata === undefined ? <p>Original note kind, citations and timestamps were not captured.</p> : <>
        <p>{note.metadata.kind === "contradiction" ? "Possible contradiction · trainee note, not a finding" : note.metadata.kind}</p>
        <p>Sources: {note.metadata.citations.map((ref) => `${ref.kind}: ${ref.id}`).join(", ") || "none cited"}</p>
        <p>Original note times (ms): created {note.metadata.createdAtMs}; updated {note.metadata.updatedAtMs}</p>
      </>}
    </li>)}</ol>}
    {world.notebookDraft !== null && <div><p>Captured draft ({world.notebookDraft.kind}): {world.notebookDraft.text || "(empty)"}</p>
      <p>Draft citations: {world.notebookDraft.citations.map((ref) => `${ref.kind}: ${ref.id}`).join(", ") || "none"}</p>
      <p>{world.notebookDraft.editingId === null ? "New note" : `Editing ${world.notebookDraft.editingId}`}</p></div>}
    {!notebookOnly && <><h4>Recorded evidence and panel markers</h4><p>These markers do not request records or change the currently open dialog.</p>
      <p>Pinned IDs: {[...world.pinnedEvidence].join(", ") || "none captured"}</p><p>Inspected ID: {world.inspectedEvidence ?? "none captured"}</p>
      <p>Request markers: {[...world.requestedEvidence].join(", ") || "none captured"}</p>
      <p>Open panel IDs: {[...world.openPanels].join(", ") || "none captured"}</p>
      <p>File pages: {[...world.filePages].map(([id, page]) => `${id}: ${String(page)}`).join(", ") || "none captured"}</p>
      <p>Legacy evidence IDs have no source-kind metadata. Ambiguous IDs are not resolved to an invented document or record.</p></>}
  </section>;
}
