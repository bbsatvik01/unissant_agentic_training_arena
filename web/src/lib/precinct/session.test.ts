import { describe, expect, it } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import coached from "../../fixtures/recordings/F01-coached.json";
import { debrief_v1, events, snapshot } from "../contracts/compiled/validators.js";
import { initialTrialState, trialReducer, type TrialView } from "../trial/trialReducer";
import { parseRecording } from "../world/parseRecording";
import { deriveWorld } from "../world/worldState";
import { seek, startCursor } from "../world/recording";
import { canSubmitSessionAction, isLoopbackOrigin, publicPacket, questionDisabledReason, recordingCaseCard, SESSION_STATUS, visibleRecordedDebrief } from "./session";

const parsed = parseRecording(raw);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const recording = parsed.recording;
const opened = trialReducer(initialTrialState(), { type: "snapshot", snapshot: recording.snapshot }).view;
if (opened === null) throw new Error("Missing fixture view");
const view: TrialView = opened;

describe("original coached recording contracts", () => {
  it("accepts the unchanged real fixture through the actual compiled validators and whole-recording parser", () => {
    expect(snapshot(coached.snapshot)).toBe(true);
    expect(snapshot(coached.final_snapshot)).toBe(true);
    expect(debrief_v1(coached.debrief)).toBe(true);
    for (const event of coached.events) expect(events(event.frame)).toBe(true);
    const checked = parseRecording(coached);
    if (!checked.ok) throw new Error(checked.errors.join("; "));
    expect(checked.recording.case.case_id).toBe("C-H3N8RW5B");
    expect(checked.recording.events).toHaveLength(75);
    expect(checked.recording.debrief).toEqual(coached.debrief);
    if (checked.recording.debrief?.scored !== true) throw new Error("Expected the original scored debrief");
    expect(checked.recording.debrief.provenance.referee_model_ids).toEqual(["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]);
    expect(checked.recording.final_snapshot).toEqual(coached.final_snapshot);
    expect(recordingCaseCard(checked.recording).case_id).not.toBe(recording.case.case_id);
  });

  it("still refuses a malformed real recording rather than relaxing the historical contract", () => {
    const invalid = { ...coached, debrief: { ...coached.debrief, scored: "true" } };
    expect(debrief_v1(invalid.debrief)).toBe(false);
    expect(parseRecording(invalid)).toEqual({ ok: false, errors: ["debrief: fails the debrief.v1 wire schema"] });
  });
});

describe("precinct session public boundary", () => {
  it.each(["127.0.0.1", "localhost", "[::1]", "::1"])("allows only explicit loopback %s", (hostname) => {
    expect(isLoopbackOrigin({ protocol: "http:", hostname })).toBe(true);
    expect(isLoopbackOrigin({ protocol: "https:", hostname })).toBe(true);
  });
  it.each(["localhost.evil.test", "127.0.0.1.evil.test", "arena.example.com", "192.168.1.2", "0.0.0.0", ""])("refuses nonloopback %s", (hostname) => {
    expect(isLoopbackOrigin({ protocol: "https:", hostname })).toBe(false);
  });
  it("refuses non-HTTP origins even on localhost", () => {
    expect(isLoopbackOrigin({ protocol: "file:", hostname: "localhost" })).toBe(false);
  });
  it("copies only public case/document fields and preserves table cells exactly", () => {
    const card = { ...recordingCaseCard(recording), role: "secret", outcome: "secret" };
    const packet = publicPacket(card, recording.case.initial_documents);
    expect(packet).toEqual(recording.case);
    expect(packet).not.toHaveProperty("role"); expect(packet).not.toHaveProperty("outcome");
    expect(packet.initial_documents).not.toBe(recording.case.initial_documents);
    expect(packet.initial_documents[0]?.content.table).not.toBe(recording.case.initial_documents[0]?.content.table);
    expect(publicPacket(card, [{ doc_id: "empty", title: "Empty table", kind: "memo", content: { body: "Body", table: null } }]).initial_documents[0]?.content).toEqual({ body: "Body" });
    expect(card.initial_documents).toBe(recording.case.initial_documents.length);
    expect(card.requestable_records).toBe(recording.snapshot.requestable.length);
  });
});

describe("precinct session action gates", () => {
  it("keeps recordings read-only whether a local server is connected or not", () => {
    expect(questionDisabledReason("recording", view, "connected")).toContain("Recorded run");
    expect(canSubmitSessionAction("recording", view, "connected")).toBe(false);
    expect(questionDisabledReason("idle", null, "offline")).toContain("Offline");
    expect(questionDisabledReason("idle", view, "connected")).toContain("start an interview");
    expect(questionDisabledReason("live", null, "connected")).toContain("start an interview");
    expect(canSubmitSessionAction("live", null, "connected")).toBe(false);
    expect(canSubmitSessionAction("live", view, "error")).toBe(false);
  });
  it("enables questions only at the correct text lifecycle state", () => {
    expect(questionDisabledReason("live", { ...view, status: "awaiting_question" }, "connected")).toBeNull();
    expect(questionDisabledReason("live", { ...view, channel: "voice" }, "connected")).toContain("microphone");
    expect(questionDisabledReason("live", { ...view, status: "cap_reached" }, "connected")).toContain("length limit");
    for (const status of ["ended", "finalizing"] as const) expect(questionDisabledReason("live", { ...view, status }, "connected")).toContain("over");
    for (const status of ["subject_answering", "coach_working"] as const) expect(questionDisabledReason("live", { ...view, status }, "connected")).toContain("Wait");
    for (const status of ["awaiting_question", "cap_reached"] as const) expect(canSubmitSessionAction("live", { ...view, status }, "connected")).toBe(true);
    expect(canSubmitSessionAction("live", { ...view, status: "ended" }, "connected")).toBe(false);
    expect(SESSION_STATUS.connecting).toBe("Opening interview");
  });
  it("releases only the loaded run's own debrief at its published end", () => {
    const end = seek(recording, startCursor(recording), recording.durationMs);
    const world = deriveWorld({ view: end.state.view, nowMs: end.t, arrivals: end.arrivals, subjectName: recording.case.subject.display_name, investigatorActive: false, reducedMotion: true, paused: true });
    expect(visibleRecordedDebrief(recording, view, world)).toBeNull();
    expect(visibleRecordedDebrief(recording, end.state.view, null)).toBeNull();
    expect(visibleRecordedDebrief(null, end.state.view, world)).toBeNull();
    expect(visibleRecordedDebrief(recording, end.state.view, world)).toBe(recording.debrief);
    expect(visibleRecordedDebrief({ ...recording, debrief: null }, end.state.view, world)).toBeNull();
    expect(visibleRecordedDebrief(recording, null, world)).toBeNull();
  });
});
