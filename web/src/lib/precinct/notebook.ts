/** Bounded, deterministic trainee notes. A contradiction is a trainee hypothesis, never a finding. */
import { sourceKey, type DossierSourceRef } from "./dossier";

export const NOTEBOOK_LIMITS = { entries: 60, text: 2_000, citations: 8, id: 180, serialized: 180_000 } as const;
export const NOTE_KINDS = ["observation", "question", "timeline", "contradiction"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_KIND_LABELS: Readonly<Record<NoteKind, string>> = {
  observation: "Observation", question: "Question to ask", timeline: "Timeline note", contradiction: "Possible contradiction",
};

export interface NotebookDraft {
  readonly kind: NoteKind;
  readonly text: string;
  readonly citations: readonly DossierSourceRef[];
}
export interface NotebookEntry extends NotebookDraft {
  readonly id: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}
export interface NotebookDocument {
  readonly schema: "arena.notebook.v1";
  readonly caseId: string;
  readonly entries: readonly NotebookEntry[];
}
export type NotebookCommand =
  | { readonly type: "add"; readonly entry: NotebookEntry }
  | { readonly type: "edit"; readonly id: string; readonly draft: NotebookDraft; readonly atMs: number }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "clear" };
export type NotebookResult =
  | { readonly ok: true; readonly document: NotebookDocument; readonly command: NotebookCommand | null }
  | { readonly ok: false; readonly error: string };

export function emptyNotebook(caseId: string): NotebookDocument {
  return { schema: "arena.notebook.v1", caseId, entries: [] };
}
export function isNoteKind(value: unknown): value is NoteKind {
  return NOTE_KINDS.some((kind) => kind === value);
}
function validTime(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function validId(value: string): boolean { return value.trim().length > 0 && value.length <= NOTEBOOK_LIMITS.id; }

export function validateNotebookDraft(draft: NotebookDraft, sources: readonly DossierSourceRef[]): string | null {
  if (!isNoteKind(draft.kind)) return "Choose a note type.";
  if (draft.text.trim().length === 0) return "Write a note before saving.";
  if (draft.text.length > NOTEBOOK_LIMITS.text) return `Keep notes to ${String(NOTEBOOK_LIMITS.text)} characters.`;
  if (draft.citations.length > NOTEBOOK_LIMITS.citations) return `Use at most ${String(NOTEBOOK_LIMITS.citations)} sources per note.`;
  const available = new Set(sources.map(sourceKey));
  const seen = new Set<string>();
  for (const ref of draft.citations) {
    const key = sourceKey(ref);
    if (!available.has(key)) return "A cited source is not available in this public packet yet.";
    if (seen.has(key)) return "Each source can be cited once per note.";
    seen.add(key);
  }
  return null;
}

export function changeNotebook(document: NotebookDocument, command: NotebookCommand, sources: readonly DossierSourceRef[]): NotebookResult {
  let entries: readonly NotebookEntry[];
  switch (command.type) {
    case "add": {
      const entry = command.entry;
      const error = validateNotebookDraft(entry, sources);
      if (error !== null) return { ok: false, error };
      if (!validId(entry.id) || document.entries.some((note) => note.id === entry.id)) return { ok: false, error: "The note ID is missing or already in use." };
      if (!validTime(entry.createdAtMs) || !validTime(entry.updatedAtMs) || entry.updatedAtMs < entry.createdAtMs) return { ok: false, error: "The note time is invalid." };
      if (document.entries.length >= NOTEBOOK_LIMITS.entries) return { ok: false, error: `This notebook holds ${String(NOTEBOOK_LIMITS.entries)} notes. Remove a note to make room.` };
      entries = [...document.entries, { ...entry, citations: entry.citations.map((ref) => ({ ...ref })) }];
      break;
    }
    case "edit": {
      const entry = document.entries.find((note) => note.id === command.id);
      if (entry === undefined) return { ok: false, error: "This note is no longer in the notebook." };
      const error = validateNotebookDraft(command.draft, sources);
      if (error !== null) return { ok: false, error };
      if (!validTime(command.atMs) || command.atMs < entry.createdAtMs) return { ok: false, error: "The note time is invalid." };
      entries = document.entries.map((note) => note.id === command.id ? { ...note, ...command.draft, citations: command.draft.citations.map((ref) => ({ ...ref })), updatedAtMs: command.atMs } : note);
      break;
    }
    case "remove":
      if (!document.entries.some((note) => note.id === command.id)) return { ok: false, error: "This note is no longer in the notebook." };
      entries = document.entries.filter((note) => note.id !== command.id);
      break;
    case "clear": entries = []; break;
  }
  return { ok: true, document: { ...document, entries }, command };
}

/** Stable key order also makes equivalent restored/current notebooks compare correctly. */
export function serializeNotebook(document: NotebookDocument): string {
  return JSON.stringify({
    schema: document.schema, caseId: document.caseId,
    entries: document.entries.map((entry) => ({
      id: entry.id, kind: entry.kind, text: entry.text,
      citations: entry.citations.map((ref) => ({ kind: ref.kind, id: ref.id })),
      createdAtMs: entry.createdAtMs, updatedAtMs: entry.updatedAtMs,
    })),
  });
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function parseRef(value: unknown): DossierSourceRef | null {
  if (!object(value) || (value["kind"] !== "document" && value["kind"] !== "record") || typeof value["id"] !== "string" || !validId(value["id"])) return null;
  return { kind: value["kind"], id: value["id"] };
}
function parseEntry(value: unknown): NotebookEntry | null {
  if (!object(value) || !isNoteKind(value["kind"]) || typeof value["id"] !== "string" || typeof value["text"] !== "string" || typeof value["createdAtMs"] !== "number" || typeof value["updatedAtMs"] !== "number" || !Array.isArray(value["citations"])) return null;
  const raw: readonly unknown[] = value["citations"];
  const citations: DossierSourceRef[] = [];
  for (const ref of raw) { const parsed = parseRef(ref); if (parsed === null) return null; citations.push(parsed); }
  return { id: value["id"], kind: value["kind"], text: value["text"], createdAtMs: value["createdAtMs"], updatedAtMs: value["updatedAtMs"], citations };
}

/** Reject the entire saved packet on corruption, wrong case, unknown citations, or a limit violation. */
export function parseNotebook(serialized: string, caseId: string, sources: readonly DossierSourceRef[]): NotebookResult {
  if (serialized.length > NOTEBOOK_LIMITS.serialized) return { ok: false, error: "The saved notebook is too large to open safely." };
  let data: unknown;
  try { data = JSON.parse(serialized); } catch { return { ok: false, error: "The saved notebook is not readable JSON." }; }
  if (!object(data) || data["schema"] !== "arena.notebook.v1" || data["caseId"] !== caseId || !Array.isArray(data["entries"])) return { ok: false, error: "The saved notebook does not match this case or notebook format." };
  let document = emptyNotebook(caseId);
  const raw: readonly unknown[] = data["entries"];
  if (raw.length > NOTEBOOK_LIMITS.entries) return { ok: false, error: "The saved notebook exceeds the note limit." };
  for (const value of raw) {
    const entry = parseEntry(value);
    if (entry === null) return { ok: false, error: "A saved note has an invalid structure." };
    const result = changeNotebook(document, { type: "add", entry }, sources);
    if (!result.ok) return result;
    document = result.document;
  }
  return { ok: true, document, command: null };
}
