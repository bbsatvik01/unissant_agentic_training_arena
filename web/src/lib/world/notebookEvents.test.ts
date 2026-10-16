import { describe, expect, it } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "./parseRecording";
import { seek, startCursor } from "./recording";
import { createWorldCapture, type CaptureContext } from "./worldCapture";
import { initialWorldReplayState, isWorldEvent, notebookSourceKey, reduceWorldEvent, type InputData, type NotebookMetadata, type WorldEvent } from "./worldEvents";

const metadata: NotebookMetadata = { kind: "contradiction", citations: [{ kind: "document", id: "doc" }], createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_000_001 };
const note: InputData = { action: "notebook", operation: "upsert", note_id: "n", text: "A possibility to check", metadata };
const draft: InputData = { action: "notebook", operation: "draft", draft: { kind: "question", text: "", citations: [], editingId: null } };
function event(data: InputData, t_ms = 3): WorldEvent { return { t_ms, kind: "input", data }; }
function shape(data: unknown): unknown { return { t_ms: 0, kind: "input", data }; }
const original = parseRecording(raw); if (!original.ok) throw new Error("fixture");
const recording = original.recording;

describe("strict bounded public notebook samples", () => {
  it.each([note, draft, { action: "notebook", operation: "clear" }, { action: "notebook", operation: "delete", note_id: "n" }] as const)("accepts $operation", (data) => { expect(isWorldEvent(shape(data))).toBe(true); });
  it.each([
    null, {}, { ...metadata, kind: "truth" }, { ...metadata, private: "hidden" }, { ...metadata, citations: null },
    { ...metadata, citations: Array<unknown>(1) }, { ...metadata, citations: Array.from({ length: 9 }, (_, i) => ({ kind: "document", id: String(i) })) },
    { ...metadata, citations: [{ kind: "document", id: "doc" }, { kind: "document", id: "doc" }] },
    { ...metadata, citations: [{ kind: "hidden", id: "doc" }] }, { ...metadata, citations: [{ kind: "record", id: "" }] },
    { ...metadata, citations: [{ kind: "document", id: "x".repeat(181) }] }, { ...metadata, citations: [{ kind: "document", id: "doc", secret: true }] },
    { ...metadata, createdAtMs: -1 }, { ...metadata, createdAtMs: NaN }, { ...metadata, createdAtMs: Infinity },
    { ...metadata, createdAtMs: Number.MAX_SAFE_INTEGER + 1 }, { ...metadata, updatedAtMs: 0 }, { ...metadata, updatedAtMs: Infinity },
    { ...metadata, updatedAtMs: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects bad metadata whole %#", (value) => { expect(isWorldEvent(shape({ ...note, metadata: value }))).toBe(false); });
  it.each([
    { ...note, metadata: undefined }, { ...note, note_id: "x".repeat(181) }, { ...note, text: " " }, { ...note, text: "x".repeat(2_001) },
    { action: "notebook", operation: "clear", note_id: "n" },
    { ...draft, draft: null }, { ...draft, draft: { kind: "question", text: "", citations: [] } },
    { ...draft, draft: { kind: "question", text: "x".repeat(2_001), citations: [], editingId: null } },
    { ...draft, draft: { kind: "other", text: "", citations: [], editingId: null } },
    { ...draft, draft: { kind: "question", text: "", citations: [], editingId: " " } },
  ])("rejects bad note/draft fields %#", (data) => { expect(isWorldEvent(shape(data))).toBe(false); });
  it("accepts exact bounds and namespaced citations without confusing wall time and capture time", () => {
    const citations = Array.from({ length: 8 }, (_, i) => ({ kind: "document" as const, id: String(i).padEnd(180, "x") }));
    expect(isWorldEvent(shape({ ...note, note_id: "n".repeat(180), text: "x".repeat(2_000), metadata: { ...metadata, citations, createdAtMs: 0, updatedAtMs: Number.MAX_SAFE_INTEGER } }))).toBe(true);
    expect(isWorldEvent(shape({ ...note, metadata: { ...metadata, citations: [{ kind: "document", id: "x" }, { kind: "record", id: "x" }] } }))).toBe(true);
    expect(isWorldEvent(shape({ ...draft, draft: { kind: "timeline", text: "x".repeat(2_000), citations, editingId: "n".repeat(180) } }))).toBe(true);
    expect(isWorldEvent(shape({ ...note, metadata: { ...metadata, kind: "observation" } }))).toBe(true);
  });
  it("preserves owned metadata and drafts and labels legacy notes by absence rather than invented times", () => {
    const initial = initialWorldReplayState(); const state = reduceWorldEvent(reduceWorldEvent(initial, event(note)), event(draft, 4));
    expect(state.notes.get("n")).toEqual({ id: "n", text: note.text, updatedAtMs: 3, metadata });
    expect(state.notes.get("n")?.metadata).not.toBe(metadata); expect(state.notebookDraft).toEqual(draft.draft);
    expect(reduceWorldEvent(state, event({ action: "notebook", operation: "clear" })).notes.size).toBe(0);
    const legacy = reduceWorldEvent(state, event({ action: "notebook", operation: "upsert", note_id: "n", text: "legacy" }));
    expect(legacy.notes.get("n")?.metadata).toBeUndefined(); expect(initial.notebookDraft).toBeNull();
  });
});

describe("notebook capture and upload public-source boundary", () => {
  function setup(maxEvents = 100) {
    let context: CaptureContext = { sessionKey: "s", trialId: recording.trial_id, clockMs: 7, writable: true,
      publicEvidenceIds: new Set(["hidden"]), publicTextFields: new Set(), publicNotebookSources: new Set([notebookSourceKey(metadata.citations[0] ?? { kind: "document", id: "doc" })]) };
    const capture = createWorldCapture({ context: () => context, maxEvents }); capture.start();
    return { capture, sources: (values: string[]) => { context = { ...context, publicNotebookSources: new Set(values) }; } };
  }
  it("captures a replacement transaction once or none and never drops earlier accepted notes", () => {
    const { capture } = setup(2); expect(capture.inputs([{ action: "notebook", operation: "clear" }, note])).toBe(true);
    expect(capture.exportEvents().events.map((value) => value.t_ms)).toEqual([7, 7]);
    expect(capture.inputs([draft])).toBe(false); expect(capture.getSnapshot()).toMatchObject({ count: 2, issue: "memory-limit" });
    const fresh = setup(1).capture; expect(fresh.inputs([{ action: "notebook", operation: "clear" }, note])).toBe(false); expect(fresh.getSnapshot().count).toBe(0);
  });
  it("does not retain a prefix of a private or malformed replacement and rechecks current public sources", () => {
    const { capture, sources } = setup(); expect(capture.inputs([])).toBe(true); sources([]);
    expect(capture.inputs([{ action: "notebook", operation: "clear" }, note])).toBe(false); expect(capture.getSnapshot()).toMatchObject({ count: 0, issue: "private-input" });
    const second = setup().capture;
    expect(second.inputs([{ action: "notebook", operation: "clear" }, { ...note, text: "" }])).toBe(false); expect(second.getSnapshot().count).toBe(0);
    const third = setup().capture;
    expect(third.input({ action: "notebook", operation: "draft", draft: { ...draft.draft, citations: [{ kind: "record", id: "hidden" }] } })).toBe(false);
    const missingAllowlist = createWorldCapture({ context: () => ({ sessionKey: "s", trialId: "t", clockMs: 0, writable: true, publicEvidenceIds: new Set(), publicTextFields: new Set() }) });
    missingAllowlist.start(); expect(missingAllowlist.input(note)).toBe(false);
  });
  it("requires citations to be public at that exact time, never merely requestable/future/final", () => {
    const release = recording.events.find((value) => value.frame.type === "evidence.released");
    if (release?.frame.type !== "evidence.released") throw new Error("fixture release");
    const data: InputData = { ...note, metadata: { ...metadata, citations: [{ kind: "record", id: release.frame.data.record_id }] } };
    const load = (samples: WorldEvent[]) => parseRecording({ ...recording, format: "arena.recording.v2", world_events: samples });
    expect(load([event(data, release.at_ms - 1)]).ok).toBe(false);
    const checked = load([event(data, release.at_ms)]); expect(checked.ok).toBe(true);
    expect(load([event({ ...note, metadata: { ...metadata, citations: [{ kind: "document", id: release.frame.data.record_id }] } }, release.at_ms)]).ok).toBe(false);
    expect(load([event({ ...note, metadata: { ...metadata, citations: [{ kind: "record", id: "never-released" }] } }, recording.durationMs)]).ok).toBe(false);
    const doc = recording.case.initial_documents[0]; if (doc === undefined) throw new Error("fixture document");
    expect(load([event({ ...note, metadata: { ...metadata, citations: [{ kind: "document", id: doc.doc_id }] } }, 0)]).ok).toBe(true);
    expect(load([event({ action: "notebook", operation: "draft", draft: { ...draft.draft, citations: [{ kind: "record", id: release.frame.data.record_id }] } }, 0)]).ok).toBe(false);
    if (!checked.ok) throw new Error("fixture");
    const end = seek(checked.recording, startCursor(checked.recording), Infinity);
    expect(end.world.notes.get("n")?.metadata).toEqual(data.metadata);
    expect(seek(checked.recording, end, 0).world.notes.size).toBe(0);
    const snapshotPublic = parseRecording({ ...recording, snapshot: { ...recording.snapshot, last_seq: release.frame.seq, released: [{ ...release.frame.data, transcript_version: release.frame.transcript_version, event_seq: release.frame.seq }] }, format: "arena.recording.v2", world_events: [event(data, 0)] });
    expect(snapshotPublic.ok).toBe(true);
  });
});
