import { uiWorldSamples } from "../world/recordingTelemetry";
import { describe, expect, it, vi } from "vitest";
import type { Debrief, InvestigatorFinding, RequestableRecord, TrialFrame, TrialSnapshot } from "../contracts/generated/types";
import { parseTrialFrame, type TrialStreamOptions } from "../sse/trial-stream";
import { fixture } from "../../test/wire-fixtures";
import { isWire } from "../contracts/validate";
import { COMMITMENT_HASH, LogBuilder, SESSION_ID, TRIAL_ID, cardFor, finding, frame, snapshot } from "../../test/trial-log";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { createFreshClientCapture } from "../world/freshClientCapture";
import { seek, startCursor } from "../world/recording";
import { initialTrialState, trialReducer } from "./trialReducer";
import { createSessionController, type SessionApi } from "./sessionController";
import { isolatedSessionObserver, samePublicContent, terminalMatches, type SessionObservation, type SessionObserver } from "./sessionObservation";

function harness(observer?: SessionObserver) {
  let streamOptions: TrialStreamOptions | null = null;
  let snapshotValue = snapshot();
  const postFinding = vi.fn(() => Promise.resolve({ last_seq: 0 }));
  const api: SessionApi = {
    trialSnapshot: vi.fn(() => Promise.resolve(snapshotValue)), mintStreamTicket: vi.fn(() => Promise.resolve("ticket")),
    readDebrief: vi.fn(() => Promise.resolve(fixture("debrief:scored") as Debrief)),
    requestDebrief: vi.fn(() => Promise.resolve(fixture("debrief:scored") as Debrief)),
    ackCard: vi.fn(() => Promise.resolve()), reportContractViolation: vi.fn(() => Promise.resolve()),
    submitTurn: vi.fn(() => Promise.resolve({ last_seq: 0 })), requestEvidence: vi.fn(() => Promise.reject(new Error("unused"))), commitFinding: postFinding,
  };
  const controller = createSessionController({ trialId: TRIAL_ID, sessionId: SESSION_ID, api,
    ...(observer === undefined ? {} : { observer }), visibility: { hidden: () => false, subscribe: () => () => undefined },
    scheduler: { setTimeout: () => 1, clearTimeout: () => undefined }, newKey: () => "00000000-0000-4000-8000-000000000001",
    openStream: (options) => { streamOptions = options; return { lastSeq: 0, dropped: 0, current: null, lastEventId: null, close: () => undefined, finish: () => undefined, reconnect: () => undefined }; },
  });
  return { controller, api, postFinding, setSnapshot: (value: TrialSnapshot) => { snapshotValue = value; },
    send: (frame: TrialFrame) => { if (streamOptions === null) throw new Error("stream unopened"); const parsed = parseTrialFrame(JSON.stringify(frame), TRIAL_ID); if (typeof parsed === "string") throw new Error(parsed); return streamOptions.onFrame(parsed); },
    drop: () => { streamOptions?.onDrop?.("malformed", null); } };
}
const requestable: RequestableRecord = { record_id: "rec-01", kind: "alarm_log", title: "Record rec-01", description: "Public requestable metadata", requestable_after_exchanges: 0 };
const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

describe("optional accepted-session observer", () => {
  it("is inert when absent, isolated from throwing observers, and detached after failure", async () => {
    const seen = vi.fn(() => { throw new Error("observer"); }); const failed = vi.fn(() => { throw new Error("failure callback"); });
    const observed = harness({ observe: seen, failed }); const plain = harness();
    await observed.controller.start(); await plain.controller.start();
    for (const frame of new LogBuilder().ask().frames) { observed.send(frame); plain.send(frame); }
    expect(observed.controller.getState()).toEqual(plain.controller.getState());
    expect(observed.api.ackCard).toHaveBeenCalledTimes(1); expect(plain.api.ackCard).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1); expect(failed).toHaveBeenCalledTimes(1);
    observed.controller.dispose(); plain.controller.dispose();
  });
  it("passes a detached clone and observes accepted frames before subscribers, after acknowledgements", async () => {
    const ordering: string[] = []; const events: SessionObservation[] = [];
    const h = harness({ observe: (event) => { events.push(event); ordering.push(event.type); if (event.type === "opening") Object.assign(event.snapshot, { status: "completed" }); }, failed: () => undefined });
    h.controller.subscribe(() => { ordering.push("subscriber"); });
    await h.controller.start(); expect(h.controller.getState().trial.view?.serverStatus).toBe("running");
    const frames = new LogBuilder().ask().frames;
    for (const frame of frames) h.send(frame);
    const card = frames.find((frame) => frame.type === "coach.card"); if (card === undefined) throw new Error("missing card");
    expect(h.api.ackCard).toHaveBeenCalledTimes(1); h.send(card);
    expect(events.filter((event) => event.type === "frame")).toHaveLength(frames.length);
    expect(ordering.indexOf("opening")).toBeLessThan(ordering.indexOf("subscriber", ordering.indexOf("opening")));
    h.controller.dispose(); const count = events.length; h.send(card); expect(events).toHaveLength(count);
  });
  it("observes actual local sealing and failure transitions with no fabricated frame", async () => {
    const events: SessionObservation[] = []; const h = harness({ observe: (event) => { events.push(event); }, failed: () => undefined });
    await h.controller.start(); h.postFinding.mockRejectedValueOnce(new Error("request failed"));
    await expect(h.controller.submitFinding(finding() as InvestigatorFinding)).rejects.toThrow("request failed");
    expect(events.filter((event) => event.type === "finding")).toEqual([{ type: "finding", operation: "submitted" }, { type: "finding", operation: "failed" }]);
    expect(h.controller.getState().trial.view?.status).toBe("awaiting_question"); h.controller.dispose();
  });
  it("fails capture on dispositions without retaining rejected content", async () => {
    const c = createFreshClientCapture(); c.arm(raw.case, "id"); const b = c.begin({ case_id: raw.case.case_id, mode: "practice", trial_id: TRIAL_ID, session_id: SESSION_ID }, () => 0);
    if (b === null) throw new Error("missing binding"); const h = harness(b.observer); await h.controller.start(); h.drop();
    expect(c.getSnapshot()).toMatchObject({ phase: "incomplete", reason: "disposition" }); h.controller.dispose();
  });
  it.each([false, true])("captures the genuine text path with actual publication and requestable release=%s", async (withRelease) => {
    let now = 0; const capture = createFreshClientCapture(); capture.arm(raw.case, "id");
    const b = capture.begin({ case_id: raw.case.case_id, mode: "practice", trial_id: TRIAL_ID, session_id: SESSION_ID }, () => now);
    if (b === null) throw new Error("missing binding");
    const h = harness({ observe: (event) => { if (event.type !== "opening") now += 10; b.observer.observe(event); }, failed: b.observer.failed });
    const opening = snapshot({ requestable: withRelease ? [requestable] : [] });
    expect(isWire("snapshot", opening)).toBe(true);
    h.setSnapshot(opening); await h.controller.start();
    expect(capture.getSnapshot()).toMatchObject({ phase: "recording", reason: null });
    const builder = new LogBuilder().ask({ coach: "failed", ...(withRelease ? { releaseBefore: requestable.record_id } : {}) });
    for (const frame of builder.frames) { expect(h.send(frame)).toBe(true); }
    h.postFinding.mockRejectedValueOnce(new Error("retry"));
    await expect(h.controller.submitFinding(finding() as InvestigatorFinding)).rejects.toThrow("retry");
    await h.controller.submitFinding(finding());
    const prior = builder.frames.length; builder.commit();
    for (const frame of builder.frames.slice(prior)) h.send(frame);
    const before = h.controller.getState().trial.view; if (before === null) throw new Error("missing view");
    builder.debriefReady();
    const ready = builder.frames.at(-1); if (ready === undefined) throw new Error("missing readiness");
    h.setSnapshot(snapshot({ status: "completed", exchanges_used: 1, last_seq: ready.seq ?? 0,
      finding: finding(), commitment_hash: COMMITMENT_HASH, coach_failures: before.coachFailures, released: before.released, requestable: [],
      turns: before.turns.map((turn) => ({ ...turn, question: turn.question ?? "", source: turn.source ?? "investigator", question_seq: 1, answer_version: withRelease ? 3 : 2 })) }));
    h.send(ready); await settle();
    expect(h.controller.getState().connection).toBe("finished");
    expect(capture.getSnapshot()).toMatchObject({ phase: "complete", reason: null });
    const result = capture.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    const replay = seek(result.recording, startCursor(result.recording), Infinity);
    expect(replay.state.view?.turns).toEqual(h.controller.getState().trial.view?.turns);
    expect(replay.state.view?.commitmentHash).toBe(COMMITMENT_HASH);
    expect(replay.state.view?.released).toEqual(h.controller.getState().trial.view?.released);
    expect(h.controller.getState().trial.view?.requestable).toEqual([]);
    expect(result.recording.events.map((entry) => entry.frame)).toEqual(builder.frames);
    expect(uiWorldSamples(result.recording.world_events).filter((event) => event.kind === "input" && event.data.action === "finding")).toHaveLength(3);
    h.controller.dispose(); expect(capture.getSnapshot()).toMatchObject({ phase: "complete", reason: null });
  });
  it("recognizes only equivalent terminal public state, excluding compaction metadata", () => {
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    expect(terminalMatches(null, state.view)).toBe(false);
    for (const frame of new LogBuilder().commit().debriefReady().frames) state = trialReducer(state, { type: "frame", frame });
    expect(terminalMatches(state.view, state.view)).toBe(true);
    if (state.view === null) throw new Error("missing view");
    expect(terminalMatches(state.view, { ...state.view, debriefReady: null, committedFinding: state.view.committedFinding === null ? null : { ...state.view.committedFinding, by: null, committed_at: null } })).toBe(true);
    expect(terminalMatches(state.view, { ...state.view, commitmentHash: "other" })).toBe(false);
    expect(terminalMatches(state.view, { ...state.view, lastSeq: state.view.lastSeq + 1 })).toBe(false);
  });
  it("normalizes only observed-release omission and preserves every other public value and array order", () => {
    const later: RequestableRecord = { ...requestable, record_id: "rec-02" };
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot({ requestable: [requestable, later] }) });
    const builder = new LogBuilder(); builder.release(requestable.record_id); builder.commit().debriefReady();
    for (const frame of builder.frames) state = trialReducer(state, { type: "frame", frame });
    const before = state.view; if (before === null) throw new Error("missing view");
    const compacted = { ...before, requestable: [later] };
    expect(terminalMatches(before, compacted)).toBe(true);
    expect(terminalMatches(before, { ...compacted, requestable: [] })).toBe(false);
    expect(terminalMatches(before, { ...compacted, requestable: [later, { ...requestable, record_id: "new" }] })).toBe(false);
    expect(terminalMatches(before, { ...before, requestable: [{ ...requestable, title: "Changed released metadata" }, later] })).toBe(false);
    expect(terminalMatches(before, { ...compacted, requestable: [{ ...later, description: "Changed" }] })).toBe(false);
    expect(terminalMatches(before, { ...before, requestable: [later, requestable] })).toBe(false);
    expect(terminalMatches(before, { ...compacted, released: before.released.map((release) => ({ ...release, title: "Changed release" })) })).toBe(false);
    const withContent = { ...before, released: before.released.map((release) => ({ ...release, content: { body: "Public body", label: "Public label" } })) };
    const keyReordered = { ...withContent, requestable: before.requestable.map((record) => ({ requestable_after_exchanges: record.requestable_after_exchanges, description: record.description, title: record.title, kind: record.kind, record_id: record.record_id })),
      released: withContent.released.map((release) => ({ ...release, content: { label: "Public label", body: "Public body" } })) };
    expect(terminalMatches(withContent, keyReordered)).toBe(true);
    expect(terminalMatches(withContent, { ...keyReordered, released: keyReordered.released.map((release) => ({ ...release, content: { label: "Public label", body: "Changed" } })) })).toBe(false);
  });
  it.each(["stop", "close", "forbidden-frame"] as const)("keeps only the accepted assessment prefix after %s and late publication", async (ending) => {
    const capture = createFreshClientCapture(); capture.arm(raw.case, "assessment-capture");
    const binding = capture.begin({ case_id: raw.case.case_id, mode: "assessment", trial_id: TRIAL_ID, session_id: SESSION_ID }, () => 0);
    if (binding === null) throw new Error("missing binding");
    const h = harness(binding.observer); h.setSnapshot(snapshot({ mode: "assessment" })); await h.controller.start();
    const builder = new LogBuilder("assessment").ask();
    for (const accepted of builder.frames) h.send(accepted);
    let resolveDebrief: (value: Debrief) => void = () => undefined;
    const pendingDebrief = new Promise<Debrief>((resolve) => { resolveDebrief = resolve; });
    vi.mocked(h.api.requestDebrief).mockReturnValueOnce(pendingDebrief);
    const publication = h.controller.requestDebrief();
    if (ending === "stop") capture.stop();
    if (ending === "close") h.controller.dispose();
    const card = cardFor(1, builder.version);
    const forbidden = { ...card, finding: { ...card.finding, rationale: "ASSESSMENT_COACH_SENTINEL" } };
    expect(h.send(frame("coach.card", builder.seq + 1, builder.version, { turn_no: 1, card: forbidden }))).toBe(false);
    const before = h.controller.getState().trial.view; if (before === null) throw new Error("missing view");
    h.setSnapshot(snapshot({ mode: "assessment", status: "completed", exchanges_used: 1, last_seq: builder.seq + 1,
      cards: [{ turn_no: 1, card: forbidden, event_seq: builder.seq + 1 }],
      turns: before.turns.map((turn) => ({ ...turn, question: turn.question ?? "", source: turn.source ?? "investigator", question_seq: 1, answer_version: 2 })) }));
    resolveDebrief(fixture("debrief:scored") as Debrief); await publication; await settle();
    expect(capture.getSnapshot()).toMatchObject({ phase: "incomplete", frames: builder.frames.length,
      reason: ending === "stop" ? "stopped" : ending === "close" ? "scope-replaced" : "disposition" });
    const result = capture.exportRecording(); if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.recording.events.map((entry) => entry.frame)).toEqual(builder.frames);
    expect(result.recording.snapshot.cards).toEqual([]); expect(result.recording.debrief).toBeNull();
    expect(result.recording.final_snapshot).toBeNull(); expect(result.recording.published_at_ms).toBeUndefined();
    expect(JSON.stringify(result.recording)).not.toContain("ASSESSMENT_COACH_SENTINEL");
    expect(seek(result.recording, startCursor(result.recording), Infinity).state.view?.cards).toEqual([]);
    h.controller.dispose();
  });
  it("uses exact deterministic JSON key identity, including distinct Unicode keys with equal locale collation", () => {
    const composed = "\u00e9"; const decomposed = "e\u0301";
    expect(samePublicContent({ [composed]: "first", [decomposed]: "second" }, { [decomposed]: "second", [composed]: "first" })).toBe(true);
    expect(samePublicContent({ [composed]: "first" }, { [decomposed]: "first" })).toBe(false);
    expect(samePublicContent({ items: [1, 2] }, { items: [2, 1] })).toBe(false);
  });
  it("a detached observer accepts no live-state mutation path", () => {
    const source: SessionObservation = { type: "opening", snapshot: snapshot() };
    const observe = isolatedSessionObserver({ observe: (event) => { if (event.type === "opening") Object.assign(event.snapshot, { last_seq: 999 }); }, failed: () => undefined });
    observe(source); expect(source.snapshot.last_seq).toBe(0);
  });
});
