import { describe, expect, it } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import type { Debrief, TrialFrame } from "../contracts/generated/types";
import { fixture } from "../../test/wire-fixtures";
import { LogBuilder, SESSION_ID, TRIAL_ID, snapshot, voiceSnapshot } from "../../test/trial-log";
import { initialTrialState, trialReducer } from "../trial/trialReducer";
import { createFreshClientCapture } from "./freshClientCapture";
import { CLIENT_CAPTURE_REASONS, MAX_CLIENT_DOCUMENT_BYTES, MAX_CLIENT_FRAMES } from "./clientCaptureSchema";
import { END_TAIL_MS, mergeRecordingEvents, seek, startCursor } from "./recording";
import { parseRecording } from "./parseRecording";
import { recordingJson } from "./recordingFiles";
import { MAX_WORLD_EVENTS, MAX_WORLD_TIME_MS } from "./worldEvents";

const started = { session_id: SESSION_ID, trial_id: TRIAL_ID, mode: "practice" as const, case_id: raw.case.case_id };
const debrief = fixture("debrief:scored") as Debrief;
function setup() {
  let now = 0;
  const capture = createFreshClientCapture();
  expect(capture.arm(raw.case, "capture-test")).toBe(true);
  const binding = capture.begin(started, () => now);
  if (binding === null) throw new Error("missing capture binding");
  binding.observer.observe({ type: "opening", snapshot: snapshot() });
  return { capture, binding, at: (value: number) => { now = value; }, send: (frame: TrialFrame) => { binding.observer.observe({ type: "frame", frame }); } };
}
function complete() {
  const h = setup();
  const frames = new LogBuilder().ask({ coach: "failed" }).commit().debriefReady().frames;
  frames.forEach((frame, i) => { h.at(i * 10 + 10); h.send(frame); });
  h.at(500); h.binding.observer.observe({ type: "terminal", equivalent: true });
  h.at(900); h.binding.observer.observe({ type: "debrief", debrief });
  const result = h.capture.exportRecording();
  if (!result.ok) throw new Error(result.errors.join("; "));
  return { ...h, recording: result.recording };
}

describe("fresh accepted-client capture", () => {
  it("requires explicit arm and a new opening, never copies a previous trial", () => {
    const capture = createFreshClientCapture();
    expect(capture.begin(started, () => 0)).toBeNull();
    expect(capture.exportRecording().ok).toBe(false);
    expect(capture.arm({ ...raw.case, private_role: "hidden" } as typeof raw.case, "id")).toBe(false);
    expect(capture.arm(raw.case, "")).toBe(false);
    expect(capture.arm(raw.case, "x".repeat(161))).toBe(false);
    expect(capture.arm({ ...raw.case, objective: "x".repeat(MAX_CLIENT_DOCUMENT_BYTES) }, "id")).toBe(false);
    expect(capture.arm(raw.case, "id")).toBe(true);
    expect(capture.arm(raw.case, "id2")).toBe(false);
    expect(capture.begin({ ...started, case_id: "other" }, () => 0)).toBeNull();
    expect(capture.getSnapshot().reason).toBe("scope-replaced");
  });
  it("captures actual text frames and publication timing, and normalizes safe export", () => {
    const h = complete();
    expect(h.capture.getSnapshot().phase).toBe("complete");
    expect(h.recording.events.map((entry) => entry.frame.type)).toContain("subject.answer");
    expect(h.recording.published_at_ms).toBe(900);
    expect(h.recording.durationMs).toBe(900 + END_TAIL_MS);
    expect(h.recording.final_snapshot).toBeNull();
    expect(h.recording.client_capture).toMatchObject({ status: "complete", original_audio: "absent", origin: "client-experienced" });
    const text = recordingJson(h.recording);
    expect(text).not.toContain("client_order");
    expect(parseRecording(JSON.parse(text) as unknown)).toEqual({ ok: true, recording: h.recording });
    h.capture.fail("scope-replaced"); h.binding.observer.observe({ type: "disposed" });
    expect(h.capture.getSnapshot().phase).toBe("complete");
  });
  it.each(["keys", "changed-value", "changed-array-order"] as const)("compares repeated debrief content before terminal completion: %s", (kind) => {
    if (!debrief.scored) throw new Error("expected scored fixture");
    const h = setup();
    for (const frame of new LogBuilder().ask({ coach: "failed" }).commit().debriefReady().frames) { h.at(10); h.send(frame); }
    h.at(500); h.binding.observer.observe({ type: "debrief", debrief });
    expect(h.capture.getSnapshot().phase).toBe("recording");
    const reordered: Debrief = {
      provenance: { scorer_git_sha: debrief.provenance.scorer_git_sha, referee_model_ids: debrief.provenance.referee_model_ids,
        r3_prompt_sha256: debrief.provenance.r3_prompt_sha256, rubric_sha256: debrief.provenance.rubric_sha256 },
      scorecards: debrief.scorecards, rubric: debrief.rubric, outcome: debrief.outcome,
      scored: true, session_id: debrief.session_id, schema_version: debrief.schema_version,
    };
    const repeated = kind === "keys" ? reordered : kind === "changed-value"
      ? { ...debrief, outcome: { ...debrief.outcome, resolution: "Changed published fixture content" } }
      : { ...debrief, provenance: { ...debrief.provenance, r3_prompt_sha256: [...debrief.provenance.r3_prompt_sha256].reverse() } };
    h.at(600); h.binding.observer.observe({ type: "debrief", debrief: repeated });
    expect(h.capture.getSnapshot().phase).toBe(kind === "keys" ? "recording" : "incomplete");
    h.at(700); h.binding.observer.observe({ type: "terminal", equivalent: true });
    expect(h.capture.getSnapshot()).toMatchObject(kind === "keys" ? { phase: "complete", reason: null } : { phase: "incomplete", reason: "invalid-data" });
    const result = h.capture.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.recording.debrief).toEqual(debrief);
    expect(result.recording.published_at_ms).toBe(500);
  });
  it("keeps failed journals as explicitly incomplete and never resumes them", () => {
    const h = setup();
    h.at(4); expect(h.binding.input({ action: "text", field_id: "question-draft", value: "Actual typed question?" })).toBe(true);
    h.capture.fail("resync");
    expect(h.binding.input({ action: "text", field_id: "question-draft", value: "late" })).toBe(false);
    const result = h.capture.exportRecording();
    expect(result.ok && result.recording.client_capture).toMatchObject({ status: "incomplete", reason: "resync" });
    h.capture.fail("observer-failed"); expect(h.capture.getSnapshot().reason).toBe("resync");
    expect(h.capture.clear()).toBe(true);
    expect(h.binding.ui({ action: "panel", panel_id: "interview", open: true })).toBe(false);
    expect(h.capture.getSnapshot().phase).toBe("idle");
  });
  it.each(CLIENT_CAPTURE_REASONS)("retains explicit incomplete reason %s", (reason) => {
    const h = setup(); h.capture.fail(reason); expect(h.capture.getSnapshot()).toMatchObject({ phase: "incomplete", reason });
  });
  it.each([-1, NaN, Infinity, MAX_WORLD_TIME_MS + 1])("stops on bad clock %s", (at) => {
    const h = setup(); h.at(at); h.binding.ui({ action: "panel", panel_id: "interview", open: true });
    expect(h.capture.getSnapshot().reason).toBe("clock-reset");
  });
  it("stops on backward time and isolates a throwing clock", () => {
    const h = setup(); h.at(2); h.binding.ui({ action: "panel", panel_id: "interview", open: true }); h.at(1);
    expect(h.binding.camera({ mode: "first", position: [0, 0, 0], quaternion: [0, 0, 0, 1], fov: 60 })).toBe(false);
    expect(h.capture.getSnapshot().reason).toBe("clock-reset");
    const c = createFreshClientCapture(); c.arm(raw.case, "id");
    c.begin(started, () => { throw new Error("clock"); })?.observer.observe({ type: "opening", snapshot: snapshot() });
    expect(c.getSnapshot().reason).toBe("observer-failed");
  });
  it.each([snapshot({ last_seq: 1 }), snapshot({ exchanges_used: 1 }), snapshot({ status: "completed" }), voiceSnapshot(), snapshot({ mode: "assessment" })])("refuses non-fresh or mismatched openings", (opening) => {
    const c = createFreshClientCapture(); c.arm(raw.case, "id");
    c.begin(started, () => 0)?.observer.observe({ type: "opening", snapshot: opening });
    expect(c.getSnapshot().reason).toBe("not-fresh");
  });
  it("refuses nonzero opening, repeat bind and pre-opening accepted notebook actions", () => {
    for (const kind of ["time", "bind", "input"] as const) {
      const c = createFreshClientCapture(); c.arm(raw.case, "id"); const b = c.begin(started, () => kind === "time" ? 1 : 0);
      if (kind === "time") b?.observer.observe({ type: "opening", snapshot: snapshot() });
      if (kind === "bind") c.begin(started, () => 0);
      if (kind === "input") b?.input({ action: "notebook", operation: "clear" });
      expect(c.getSnapshot().phase).toBe("incomplete");
    }
  });
  it("refuses resync, disposals, missing readiness, terminal mismatch and sequence gaps", () => {
    const gap = setup(); gap.send({ ...new LogBuilder().ask().frames[0], seq: 2 } as TrialFrame);
    expect(gap.capture.getSnapshot().reason).toBe("sequence-gap");
    const rest = setup(); rest.binding.observer.observe({ type: "debrief", debrief }); expect(rest.capture.getSnapshot().reason).toBe("rest-before-ready");
    const mismatch = setup(); mismatch.binding.observer.observe({ type: "terminal", equivalent: false }); expect(mismatch.capture.getSnapshot().reason).toBe("terminal-mismatch");
    const disposed = setup(); disposed.binding.observer.observe({ type: "disposed" }); expect(disposed.capture.getSnapshot().reason).toBe("scope-replaced");
    const unsupported = setup(); unsupported.binding.observer.observe({ type: "unsupported", reason: "disposition" }); expect(unsupported.capture.getSnapshot().reason).toBe("disposition");
  });
  it.each(["foreign-session", "before-ended"] as const)("preserves the valid prefix when readiness is rejected: %s", (kind) => {
    const h = setup(); const builder = new LogBuilder().ask({ coach: "failed" });
    if (kind === "foreign-session") builder.commit();
    const accepted = [...builder.frames];
    for (const frame of accepted) { h.at(10); h.send(frame); }
    builder.debriefReady(); const candidate = builder.frames.at(-1);
    if (candidate?.type !== "debrief.ready") throw new Error("missing readiness");
    const rejected = kind === "foreign-session" ? { ...candidate, data: { session_id: "00000000-0000-4000-8000-000000000001" } } : candidate;
    h.at(20); h.send(rejected);
    expect(h.capture.getSnapshot()).toMatchObject({ phase: "incomplete", reason: "invalid-data", frames: accepted.length });
    const result = h.capture.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.recording.events.map((entry) => entry.frame)).toEqual(accepted);
    expect(result.recording.client_capture).toMatchObject({ status: "incomplete", reason: "invalid-data" });
    expect(result.recording.debrief).toBeNull(); expect(result.recording.published_at_ms).toBeUndefined();
    expect(parseRecording(JSON.parse(recordingJson(result.recording)) as unknown).ok).toBe(true);
  });
  it("bounds world memory and refuses unrelated fields and hidden citations atomically", () => {
    const hidden = setup(); expect(hidden.binding.inputs([{ action: "notebook", operation: "clear" }, { action: "notebook", operation: "upsert", note_id: "n", text: "note", metadata: { kind: "observation", citations: [{ kind: "record", id: "hidden" }], createdAtMs: 1, updatedAtMs: 1 } }])).toBe(false);
    expect(hidden.capture.getSnapshot().worldSamples).toBe(0);
    const text = setup(); expect(text.binding.input({ action: "text", field_id: "password", value: "unrelated" })).toBe(false);
    const bound = setup();
    for (let i = 0; i <= MAX_WORLD_EVENTS; i += 1) bound.binding.ui({ action: "panel", panel_id: "a", open: true });
    expect(bound.capture.getSnapshot()).toMatchObject({ phase: "incomplete", reason: "bounds", worldSamples: MAX_WORLD_EVENTS });
    expect(bound.capture.clear()).toBe(true);
  });
  it("bounds accepted frame count without retaining unbounded hints", () => {
    const h = setup(); const first = new LogBuilder().notice("paused").frames[0];
    if (first === undefined) throw new Error("missing frame");
    for (let i = 0; i <= MAX_CLIENT_FRAMES; i += 1) h.send(first);
    expect(h.capture.getSnapshot()).toMatchObject({ phase: "incomplete", reason: "bounds", frames: MAX_CLIENT_FRAMES });
  });
  it("keeps finding submit/failure and subsequent genuine frames in exact order at tied clocks", () => {
    const h = setup(); let live = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    const add = (operation: "submitted" | "failed") => {
      h.binding.observer.observe({ type: "finding", operation });
      live = trialReducer(live, { type: operation === "submitted" ? "finding_submitted" : "finding_failed" });
    };
    h.at(100); add("submitted"); expect(live.view?.status).toBe("finalizing"); add("failed"); expect(live.view?.status).toBe("awaiting_question");
    for (const frame of new LogBuilder().ask({ coach: "failed" }).frames) { h.send(frame); live = trialReducer(live, { type: "frame", frame }); }
    add("submitted"); h.capture.stop();
    const result = h.capture.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    const at = seek(result.recording, startCursor(result.recording), 100);
    expect(at.state).toEqual(live);
    expect(seek(result.recording, at, 99).state.view?.status).toBe("awaiting_question");
    expect(seek(result.recording, seek(result.recording, at, 99), 100).state).toEqual(live);
    expect(mergeRecordingEvents(result.recording).map((event) => event.source).slice(0, 2)).toEqual(["world", "world"]);
  });
});

describe("fresh packet and local-only finding boundary", () => {
  it("uses a refreshed public packet before binding and refuses preparation after binding", () => {
    const c = createFreshClientCapture(); c.arm(raw.case, "id");
    expect(c.prepare({ ...raw.case, title: "Current public title" })).toBe(true);
    const b = c.begin(started, () => 0); if (b === null) throw new Error("missing binding");
    expect(c.prepare(raw.case)).toBe(false);
    b.observer.observe({ type: "opening", snapshot: snapshot() });
    b.ui({ action: "panel", panel_id: "interview", open: true }); c.stop();
    const result = c.exportRecording(); expect(result.ok && result.recording.case.title).toBe("Current public title");
  });
  it("refuses changed/private/oversize public preparation without copying it", () => {
    const c = createFreshClientCapture(); c.arm(raw.case, "id");
    expect(c.prepare({ ...raw.case, case_id: "other" })).toBe(false);
    expect(c.prepare({ ...raw.case, secret: "hidden" } as typeof raw.case)).toBe(false); expect(c.getSnapshot().reason).toBe("invalid-data");
    const b = createFreshClientCapture(); b.arm(raw.case, "id");
    expect(b.prepare({ ...raw.case, title: "x".repeat(MAX_CLIENT_DOCUMENT_BYTES) })).toBe(false); expect(b.getSnapshot().reason).toBe("bounds");
  });
});
