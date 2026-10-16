import { describe, expect, it } from "vitest";
import type { SnapshotRelease } from "../contracts/generated/types";
import type { CaseDocument } from "../world/recording";
import { emptyEvidenceTable, evidenceQuestion, publicEvidenceSource, publicEvidenceSources, reconcileEvidenceTable, reduceEvidenceTable, sameEvidenceRef, type EvidenceTableState } from "./evidenceTable";

const document: CaseDocument = { doc_id: "doc-01", kind: "record", title: "Opening file", content: { body: "Original document." } };
const record: SnapshotRelease = { record_id: "rec-01", kind: "record", title: "Released ledger", content: { body: "Original released text." }, released_at_turn: 2, transcript_version: 1, event_seq: 1, trigger: "requested", doc_kind: null, date: null };
const sources = publicEvidenceSources([document], [record]);
const doc = { kind: "document", id: "doc-01" } as const;
const rec = { kind: "record", id: "rec-01" } as const;
const state: EvidenceTableState = { scope: "one", selected: doc, presented: rec };

describe("public evidence table", () => {
  it("projects only public IDs and titles, deduplicating each namespace", () => {
    expect(sources).toEqual([{ ref: doc, title: "Opening file" }, { ref: rec, title: "Released ledger" }]);
    const sameId = publicEvidenceSources([document, document], [record, { ...record, record_id: "doc-01" }, record]);
    expect(sameId).toHaveLength(3);
    expect(sameId.map((source) => source.ref)).toContainEqual({ kind: "record", id: "doc-01" });
  });
  it("starts empty and treats null and different namespaces as distinct", () => {
    expect(emptyEvidenceTable("one")).toEqual({ scope: "one", selected: null, presented: null });
    expect(sameEvidenceRef(null, null)).toBe(false);
    expect(sameEvidenceRef(doc, null)).toBe(false);
    expect(sameEvidenceRef(null, doc)).toBe(false);
    expect(sameEvidenceRef(doc, { kind: "record", id: doc.id })).toBe(false);
    expect(sameEvidenceRef(doc, { kind: "document", id: "other" })).toBe(false);
    expect(publicEvidenceSource(null, sources)).toBeNull();
  });
  it("selects without presenting, and presents only after an explicit separate command", () => {
    const selected = reduceEvidenceTable(emptyEvidenceTable("one"), { type: "select", source: doc }, "one", sources, false);
    expect(selected).toEqual({ scope: "one", selected: doc, presented: null });
    expect(reduceEvidenceTable(selected, { type: "present", source: doc }, "one", sources, false)).toEqual({ scope: "one", selected: doc, presented: doc });
  });
  it("refuses unknown or requestable-only refs instead of releasing them", () => {
    const unavailable = { kind: "record", id: "requestable-but-unreleased" } as const;
    for (const type of ["select", "present"] as const) expect(reduceEvidenceTable(state, { type, source: unavailable }, "one", sources, false)).toEqual(state);
    expect(evidenceQuestion(unavailable, sources)).toBeNull();
  });
  it("clears stale case/run state and drops revoked records on rewind", () => {
    expect(reconcileEvidenceTable(state, "another-run", sources, false)).toEqual(emptyEvidenceTable("another-run"));
    expect(reconcileEvidenceTable(state, "one", publicEvidenceSources([document], []), false)).toEqual({ scope: "one", selected: doc, presented: null });
    expect(reconcileEvidenceTable(state, "one", [], false)).toEqual(emptyEvidenceTable("one"));
  });
  it("permits source browsing but no table mutation in recorded playback", () => {
    expect(reconcileEvidenceTable(state, "one", sources, true)).toEqual({ scope: "one", selected: doc, presented: null });
    expect(reduceEvidenceTable(state, { type: "present", source: rec }, "one", sources, true)).toEqual({ scope: "one", selected: doc, presented: null });
    expect(reduceEvidenceTable(state, { type: "select", source: rec }, "one", sources, true)).toEqual({ scope: "one", selected: rec, presented: null });
  });
  it("clear keeps the current reading selection and repeated presentation stays bounded", () => {
    expect(reduceEvidenceTable(state, { type: "clear" }, "one", sources, false)).toEqual({ scope: "one", selected: doc, presented: null });
    let repeated = state;
    for (let i = 0; i < 1000; i += 1) repeated = reduceEvidenceTable(repeated, { type: "present", source: i % 2 === 0 ? doc : rec }, "one", sources, false);
    expect(repeated).toEqual({ scope: "one", selected: rec, presented: rec });
    expect(Object.keys(repeated).sort()).toEqual(["presented", "scope", "selected"]);
  });
  it("seeds neutral, exact-source-citing drafts without using title/body interpretations", () => {
    expect(evidenceQuestion(doc, sources)).toBe("Looking at document doc-01, what can you tell me about the information shown here?");
    expect(evidenceQuestion(rec, sources)).toBe("Looking at record rec-01, what can you tell me about the information shown here?");
    expect(evidenceQuestion(doc, [{ ref: doc, title: "PRIVATE <script> and accusatory title" }])).not.toMatch(/PRIVATE|script|accusatory/);
    expect(evidenceQuestion(null, sources)).toBeNull();
    const long = { kind: "document", id: "x".repeat(600) } as const;
    expect(evidenceQuestion(long, [{ ref: long, title: "Too long" }])).toBeNull();
  });
});
