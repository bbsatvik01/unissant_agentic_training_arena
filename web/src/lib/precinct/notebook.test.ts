import { describe, expect, it } from "vitest";
import type { DossierSourceRef } from "./dossier";
import { changeNotebook, emptyNotebook, isNoteKind, NOTEBOOK_LIMITS, parseNotebook, validateNotebookDraft, type NotebookDocument, type NotebookDraft, type NotebookEntry, type NotebookResult } from "./notebook";

const source: DossierSourceRef = { kind: "document", id: "doc-01" };
const sources = [source];
const draft: NotebookDraft = { kind: "question", text: "What task explains this entry?", citations: [source] };
const entry: NotebookEntry = { ...draft, id: "note-1", createdAtMs: 10, updatedAtMs: 10 };
const empty = emptyNotebook("case-1");
function documentOf(result: NotebookResult): NotebookDocument { if (!result.ok) throw new Error(result.error); return result.document; }
function withNote(): NotebookDocument { return documentOf(changeNotebook(empty, { type: "add", entry }, sources)); }

describe("bounded notebook model", () => {
  it("creates immutable plain-text notes with namespaced public citations", () => {
    const mutableRef = { ...source };
    const citations = [mutableRef];
    const note = { ...entry, text: '<img src=x>\nA possible contradiction is only my hypothesis.', citations };
    const next = documentOf(changeNotebook(empty, { type: "add", entry: note }, sources));
    expect(next.entries[0]?.text).toBe(note.text);
    expect(empty.entries).toEqual([]);
    mutableRef.id = "changed";
    expect(next.entries[0]?.citations[0]?.id).toBe("doc-01");
    expect(isNoteKind("contradiction")).toBe(true);
    expect(isNoteKind("confirmed_violation")).toBe(false);
  });
  it("allows uncited questions while rejecting whitespace, oversized text, unknown and repeated citations", () => {
    expect(validateNotebookDraft({ ...draft, citations: [] }, [])).toBeNull();
    expect(validateNotebookDraft({ ...draft, text: " \n " }, sources)).toContain("Write a note");
    expect(validateNotebookDraft({ ...draft, text: "a".repeat(2_001) }, sources)).toContain("2000");
    expect(validateNotebookDraft({ ...draft, citations: Array.from({ length: 9 }, () => source) }, sources)).toContain("8 sources");
    expect(validateNotebookDraft({ ...draft, citations: [{ kind: "record", id: source.id }] }, sources)).toContain("not available");
    expect(validateNotebookDraft({ ...draft, citations: [source, source] }, sources)).toContain("once");
    expect(validateNotebookDraft({ ...draft, kind: "invalid" as NotebookDraft["kind"] }, sources)).toContain("note type");
  });
  it("caps entry count and rejects missing, long, or duplicate IDs", () => {
    let document = empty;
    for (let index = 0; index < NOTEBOOK_LIMITS.entries; index++) document = documentOf(changeNotebook(document, { type: "add", entry: { ...entry, id: `n${String(index)}` } }, sources));
    const overflow = changeNotebook(document, { type: "add", entry }, sources);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toContain("60 notes");
    for (const id of ["", " ", "x".repeat(181)]) expect(changeNotebook(empty, { type: "add", entry: { ...entry, id } }, sources).ok).toBe(false);
    expect(changeNotebook(withNote(), { type: "add", entry }, sources).ok).toBe(false);
    expect(changeNotebook(empty, { type: "add", entry: { ...entry, text: "" } }, sources).ok).toBe(false);
  });
  it("rejects nonfinite, negative, or reversed note times", () => {
    for (const value of [-1, NaN, Infinity]) {
      expect(changeNotebook(empty, { type: "add", entry: { ...entry, createdAtMs: value } }, sources).ok).toBe(false);
      expect(changeNotebook(empty, { type: "add", entry: { ...entry, updatedAtMs: value } }, sources).ok).toBe(false);
    }
    expect(changeNotebook(empty, { type: "add", entry: { ...entry, updatedAtMs: 0 } }, sources).ok).toBe(false);
  });
  it("edits one note without changing creation time, and removes and clears deterministically", () => {
    const first = withNote();
    const two = documentOf(changeNotebook(first, { type: "add", entry: { ...entry, id: "note-2" } }, sources));
    const edited = documentOf(changeNotebook(two, { type: "edit", id: entry.id, atMs: 20, draft: { ...draft, kind: "contradiction", text: "Test another explanation." } }, sources));
    expect(edited.entries[0]).toMatchObject({ createdAtMs: 10, updatedAtMs: 20, kind: "contradiction", text: "Test another explanation." });
    expect(edited.entries[1]).toBe(two.entries[1]);
    expect(first.entries[0]?.text).toBe(draft.text);
    const removed = documentOf(changeNotebook(edited, { type: "remove", id: entry.id }, sources));
    expect(removed.entries.map((note) => note.id)).toEqual(["note-2"]);
    expect(documentOf(changeNotebook(removed, { type: "clear" }, sources)).entries).toEqual([]);
  });
  it("rejects edits/removals of absent notes and edits with invalid sources, text or times", () => {
    expect(changeNotebook(empty, { type: "edit", id: "missing", draft, atMs: 20 }, sources).ok).toBe(false);
    expect(changeNotebook(empty, { type: "remove", id: "missing" }, sources).ok).toBe(false);
    expect(changeNotebook(withNote(), { type: "edit", id: entry.id, draft: { ...draft, text: "" }, atMs: 20 }, sources).ok).toBe(false);
    for (const atMs of [NaN, -1, 0]) expect(changeNotebook(withNote(), { type: "edit", id: entry.id, draft, atMs }, sources).ok).toBe(false);
  });
});

describe("untrusted notebook import", () => {
  it("round-trips public notes and reconstructs only allowed fields", () => {
    const document = withNote();
    const parsed = parseNotebook(JSON.stringify({ ...document, secret: "never retained", entries: document.entries.map((note) => ({ ...note, verdict: "never retained" })) }), "case-1", sources);
    expect(documentOf(parsed)).toEqual(document);
  });
  it("refuses malformed JSON, wrong schema/case, oversized payloads and excess notes", () => {
    expect(parseNotebook("{", "case-1", sources).ok).toBe(false);
    expect(parseNotebook(" ".repeat(NOTEBOOK_LIMITS.serialized + 1), "case-1", sources).ok).toBe(false);
    for (const data of [null, [], 1, {}, { ...empty, schema: "v2" }, { ...empty, caseId: "another" }, { ...empty, entries: {} }]) expect(parseNotebook(JSON.stringify(data), "case-1", sources).ok).toBe(false);
    expect(parseNotebook(JSON.stringify({ ...empty, entries: Array.from({ length: 61 }, () => entry) }), "case-1", sources).ok).toBe(false);
  });
  it("fails the whole packet for malformed entries or refs rather than opening a partial notebook", () => {
    for (const invalid of [null, [], 2, {}, { ...entry, kind: "verdict" }, { ...entry, id: 3 }, { ...entry, text: 5 }, { ...entry, createdAtMs: "now" }, { ...entry, updatedAtMs: null }, { ...entry, citations: {} }, ...[null, {}, [], { kind: "secret", id: "x" }, { kind: "record", id: 3 }, { kind: "document", id: "" }].map((ref) => ({ ...entry, citations: [ref] }))]) {
      expect(parseNotebook(JSON.stringify({ ...empty, entries: [entry, invalid] }), "case-1", sources).ok).toBe(false);
    }
  });
  it("rejects duplicate IDs and unreleased citations even in otherwise valid saved notes", () => {
    expect(parseNotebook(JSON.stringify({ ...empty, entries: [entry, entry] }), "case-1", sources).ok).toBe(false);
    expect(parseNotebook(JSON.stringify(withNote()), "case-1", []).ok).toBe(false);
  });
});
