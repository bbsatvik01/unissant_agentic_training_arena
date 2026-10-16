import { describe, expect, it } from "vitest";
import { dossierPacket, dossierRelease } from "../../test/dossier-fixtures";
import { dossierSources, dossierTimeline, sourceKey } from "./dossier";

describe("public dossier projections", () => {
  it("projects only initial documents and the releases passed by the parent", () => {
    const initial = dossierSources(dossierPacket, []);
    expect(initial.map((source) => source.ref.id)).toEqual(["doc-01", "doc-02"]);
    expect(initial[0]?.release).toBeNull();
    expect(initial[0]?.content).toBe(dossierPacket.initial_documents[0]?.content);
    const full = dossierSources(dossierPacket, [dossierRelease]);
    expect(full[2]).toMatchObject({ ref: { kind: "record", id: "rec-01" }, release: { turn: 2, trigger: "requested" }, date: "2026-03-12", kind: "dispatch_log" });
  });
  it("deduplicates same-kind IDs without dropping distinct document and record IDs", () => {
    const sources = dossierSources({ ...dossierPacket, initial_documents: [...dossierPacket.initial_documents, ...dossierPacket.initial_documents] }, [dossierRelease, dossierRelease, { ...dossierRelease, record_id: "doc-01", doc_kind: null }]);
    expect(sources).toHaveLength(4);
    expect(sources[3]?.kind).toBe("record");
    expect(sourceKey({ kind: "record", id: "doc-01" })).not.toBe(sourceKey({ kind: "document", id: "doc-01" }));
  });
  it("quotes explicitly labeled time cells and metadata without inferring a chronology", () => {
    const events = dossierTimeline(dossierSources(dossierPacket, [dossierRelease]));
    expect(events.map((event) => event.when)).toEqual(["14:07:12", "14:09:40", "2026-03-12", "14:01"]);
    expect(events[0]).toMatchObject({ label: "Time", row: 1, source: { kind: "document", id: "doc-01" }, cells: [{ column: "Time", value: "14:07:12" }, { column: "Door", value: "Vault B" }, { column: "Event", value: "Access granted" }] });
    expect(events[2]).toMatchObject({ label: "Record date (metadata)", row: null, cells: [] });
    expect(events.some((event) => event.when.includes("16:00"))).toBe(false);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  });
  it("preserves distinct same-time events, recognizes raised/cleared columns, and handles incomplete cells", () => {
    const sources = dossierSources({ ...dossierPacket, initial_documents: [{ doc_id: "a", kind: "alarm_log", title: "Undated alarms", content: { body: "No inferred date.", table: { columns: [" Raised ", "Cleared", "Other"], rows: [["11:20", "11:20", "Alert", "extra"], ["-", "", "14:33"], []] } } }] }, [{ ...dossierRelease, date: " ", content: { body: "No table", table: null } }]);
    const events = dossierTimeline(sources);
    expect(events).toHaveLength(2);
    expect(events[0]?.cells[3]).toEqual({ column: "Column 4", value: "extra" });
    expect(events[0]?.id).not.toBe(events[1]?.id);
    expect(events[0]?.when).toBe("11:20");
  });
  it("does not mine dates from prose, titles, unsupported table headings, or private extras", () => {
    const packet = { ...dossierPacket, initial_documents: [{ doc_id: "x", kind: "statement", title: "Statement dated 12 March 2026", content: { body: "I arrived at 13:00.", table: { columns: ["Claim"], rows: [["14:00"]] } } }] };
    expect(dossierTimeline(dossierSources(packet, []))).toEqual([]);
    expect(dossierTimeline([])).toEqual([]);
  });
});
