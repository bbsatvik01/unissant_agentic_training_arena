// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { emptyEvidenceTable, publicEvidenceSources, reduceEvidenceTable } from "../../lib/precinct/evidenceTable";
import { initialTrialState, trialReducer, type TrialView } from "../../lib/trial/trialReducer";
import { initialVoiceState } from "../../lib/voice/voiceMachine";
import { CASES } from "../../lib/world/cases";
import type { CaseDocument } from "../../lib/world/recording";
import { LogBuilder, snapshot } from "../../test/trial-log";
import { InterviewStationPanel, type InterviewStationPanelProps, type InterviewStationSession, type InterviewTab } from "./InterviewStationPanel";

const documents: readonly CaseDocument[] = [{ doc_id: "doc-01", title: "Opening report", kind: "record", content: { body: "Original public source text.\nRead this whole record.", table: { columns: ["Time", "Event"], rows: [["09:30", "Public entry"]] } } }];
function trial(): TrialView {
  const log = new LogBuilder().ask({ releaseAfter: "rec-01" });
  let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot({ requestable: [{ record_id: "not-released", kind: "badge_log", title: "Unreleased badge log", description: "Requestable metadata only", requestable_after_exchanges: 1 }] }) });
  for (const frame of log.frames) state = trialReducer(state, { type: "frame", frame });
  if (state.view === null) throw new Error("Expected projected test view");
  return { ...state.view, cards: state.view.cards.map((entry) => ({ ...entry, card: { ...entry.card, flags: entry.card.flags.map((flag) => ({ ...flag, quote: "Answer 1." })) } })) };
}
function session(overrides: Partial<InterviewStationSession> = {}): InterviewStationSession {
  const view = trial();
  return {
    backend: "connected", backendError: null, me: null, selectedCase: CASES[0] ?? null, source: "live", canStart: false, modes: ["practice", "assessment"],
    startInterview: vi.fn(), connectLocalBackend: vi.fn(() => Promise.resolve()), disconnectLocalBackend: vi.fn(), acknowledgeGroundRule: vi.fn(() => Promise.resolve(true)),
    live: { phase: "running", error: null, connectionError: null, failedQuestion: null, debriefFailed: false, resumable: null, reconnect: vi.fn(), retryDebrief: vi.fn() },
    view, subjectName: "Case Subject", isVoice: false, voice: { state: initialVoiceState("live"), captureAboveFloor: false, error: null, open: vi.fn(), decline: vi.fn(), consent: vi.fn(), stop: vi.fn(), interrupt: vi.fn(), reconnect: vi.fn() },
    draft: "", updateDraft: vi.fn(), ask: vi.fn(() => Promise.resolve(true)), questionReason: null, retryQuestion: vi.fn(() => Promise.resolve()), stopSession: vi.fn(),
    playback: { trial: initialTrialState(), arrivals: new Map(), world: null, clock: { current: 0 }, playing: false, speed: 1, duration: 10000, play: vi.fn(), pause: vi.fn(), setSpeed: vi.fn(), seekTo: vi.fn() },
    sound: false, setSound: vi.fn(), readAloudError: null, earpiece: false, setEarpiece: vi.fn(), coachSpeaking: false,
    sessionKey: "test-session", documents, released: view.released, transcriptExchanges: [], canAct: true, requestEvidence: vi.fn(() => Promise.resolve(null)), commitFinding: vi.fn(() => Promise.resolve(true)), ...overrides,
  };
}
function props(current = session()): InterviewStationPanelProps {
  return { session: current, still: true, tab: "transcript", onTabChange: vi.fn(), citation: null, onCite: vi.fn(), evidenceScope: "one", evidenceState: emptyEvidenceTable("one"), onEvidenceAction: vi.fn(), onUseEvidenceQuestion: vi.fn(), freshRecordId: null, startInterview: vi.fn(), called: false, seated: false, onCallSubject: vi.fn(), onSit: vi.fn(), onExitSeat: vi.fn() };
}
function Interactive({ initial }: { readonly initial: InterviewStationPanelProps }) {
  const [tab, setTab] = useState<InterviewTab>(initial.tab);
  const [table, setTable] = useState(initial.evidenceState);
  return <InterviewStationPanel {...initial} tab={tab} onTabChange={(next) => { initial.onTabChange(next); setTab(next); }} evidenceState={table} onEvidenceAction={(action) => {
    initial.onEvidenceAction(action);
    setTable((value) => reduceEvidenceTable(value, action, initial.evidenceScope, publicEvidenceSources(initial.session.documents, initial.session.released), initial.session.source === "recording"));
  }} />;
}
function disabled(name: string): boolean { return screen.getByRole<HTMLButtonElement>("button", { name }).disabled; }

beforeEach(() => { Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("interview station content", () => {
  it("mounts the original controls with no start, intercom, voice, sound, score or table side effects", () => {
    const initial = props();
    const { container } = render(<InterviewStationPanel {...initial} />);
    expect(screen.getAllByText(EX4_TEXT).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Interview controls" })).toBeTruthy();
    expect(screen.getByRole("log")).toBeTruthy();
    expect(container.querySelector("canvas, iframe, dialog")).toBeNull();
    for (const callback of [initial.startInterview, initial.session.startInterview, initial.onCallSubject, initial.onSit, initial.session.voice.open, initial.session.voice.consent, initial.session.setSound, initial.session.ask, initial.session.commitFinding, initial.onEvidenceAction]) expect(callback).not.toHaveBeenCalled();
  });
  it("keeps intercom, sitting and explicit seat exit separate from session and voice starts", () => {
    const initial = props();
    const { rerender } = render(<InterviewStationPanel {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Call subject to room" }));
    expect(initial.onCallSubject).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Sit at interview table" }));
    expect(initial.onSit).toHaveBeenCalledOnce();
    rerender(<InterviewStationPanel {...initial} called seated />);
    expect(disabled("Call subject to room")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Leave interview seat" }));
    expect(initial.onExitSeat).toHaveBeenCalledOnce();
    expect(initial.startInterview).not.toHaveBeenCalled();
    expect(initial.session.voice.open).not.toHaveBeenCalled();
  });
  it("routes explicit practice, assessment and voice preparation through the supplied guarded start callback", () => {
    const initial = props(session({ source: "idle", canStart: true, view: null, live: { ...session().live, phase: "idle" } }));
    render(<InterviewStationPanel {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Start text practice" }));
    fireEvent.click(screen.getByRole("button", { name: "Start assessment" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare voice practice" }));
    expect(initial.startInterview).toHaveBeenNthCalledWith(1, "practice");
    expect(initial.startInterview).toHaveBeenNthCalledWith(2, "assessment");
    expect(initial.startInterview).toHaveBeenNthCalledWith(3, "voice");
    expect(initial.session.startInterview).not.toHaveBeenCalled();
    expect(initial.session.voice.consent).not.toHaveBeenCalled();
  });
  it("keeps offline send, record request, source question and finding disabled", () => {
    const current = session({ source: "idle", backend: "offline", canAct: false, canStart: false, questionReason: "Offline: recorded runs only." });
    const initial = { ...props(current), tab: "evidence" as const, evidenceState: { scope: "one", selected: { kind: "document" as const, id: "doc-01" }, presented: null } };
    render(<Interactive initial={initial} />);
    expect(disabled("Send")).toBe(true);
    expect(disabled("Use source in question draft")).toBe(true);
    fireEvent.click(screen.getByText("All public sources and record requests"));
    expect(disabled("Request")).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Finding" }));
    expect(disabled("Confirm finding")).toBe(true);
    expect(screen.queryByRole("button", { name: "Start text practice" })).toBeNull();
    expect(current.connectLocalBackend).not.toHaveBeenCalled();
    expect(current.requestEvidence).not.toHaveBeenCalled();
    expect(current.commitFinding).not.toHaveBeenCalled();
  });
  it("is read-only for recorded interactions while the saved transcript remains readable", () => {
    const current = session({ source: "recording", backend: "offline", canAct: false, questionReason: "Recorded interview is read-only." });
    const initial = { ...props(current), tab: "evidence" as const, evidenceState: { scope: "one", selected: { kind: "document" as const, id: "doc-01" }, presented: { kind: "record" as const, id: "rec-01" } } };
    render(<Interactive initial={initial} />);
    expect(disabled("Call subject to room")).toBe(true);
    expect(disabled("Lay selected source on table")).toBe(true);
    expect(disabled("Use source in question draft")).toBe(true);
    expect(disabled("Clear table")).toBe(true);
    expect(screen.getByText("The table is clear.")).toBeTruthy();
    expect(screen.getByText(/The original v1 file has no evidence-table handling history/)).toBeTruthy();
    expect(current.playback.play).not.toHaveBeenCalled();
    expect(current.setSound).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Finding" }));
    expect(screen.getByRole("radio", { name: "Truthful" }).closest("fieldset.precinct-finding-boundary")?.hasAttribute("disabled")).toBe(true);
    expect(disabled("Confirm finding")).toBe(true);
  });
  it("withholds every coach panel in assessment, including a stale requested coach tab", () => {
    const practice = trial();
    const current = session({ view: { ...practice, mode: "assessment" } });
    const initial = { ...props(current), tab: "coach" as const };
    const { container } = render(<InterviewStationPanel {...initial} />);
    expect(screen.queryByRole("tab", { name: "Practice coach" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".coach")).toBeNull();
    expect(screen.queryByText("Use this question")).toBeNull();
    expect(screen.getByText(/Assessment: coaching is withheld here/)).toBeTruthy();
  });
  it("does not expose text coaching in voice or open the microphone on render", () => {
    const current = session({ isVoice: true, view: { ...trial(), channel: "voice" } });
    render(<InterviewStationPanel {...props(current)} />);
    expect(screen.queryByRole("tab", { name: "Practice coach" })).toBeNull();
    expect(current.voice.open).not.toHaveBeenCalled();
    expect(current.voice.consent).not.toHaveBeenCalled();
    expect(screen.getByText(/Voice consent remains separate/)).toBeTruthy();
  });
  it("uses existing roving keyboard tabs and preserves the transcript node and finding draft", () => {
    render(<Interactive initial={props()} />);
    const log = screen.getByRole("log");
    const transcript = screen.getByRole("tab", { name: "Transcript" });
    transcript.focus();
    fireEvent.keyDown(transcript, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Evidence table" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Finding" }));
    fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "Preserved while reading." } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Home" });
    expect(screen.getByRole("log")).toBe(log);
    fireEvent.click(screen.getByRole("tab", { name: "Finding" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("Rationale").value).toBe("Preserved while reading.");
  });
  it("presents only a public source and seeds a neutral question without sending it", () => {
    const initial = { ...props(), tab: "evidence" as const };
    render(<Interactive initial={initial} />);
    const selector = screen.getByRole("combobox", { name: "Public source" });
    expect(within(selector).queryByRole("option", { name: /not-released/ })).toBeNull();
    fireEvent.change(selector, { target: { value: "0" } });
    const selectedSource = within(screen.getByRole("region", { name: "Read, present, then ask" }));
    expect(selectedSource.getByText(/Original public source text/)).toBeTruthy();
    expect(selectedSource.getByRole("cell", { name: "Public entry" })).toBeTruthy();
    expect(selectedSource.getByText(/Original public source text/).closest("details")?.open).toBe(true);
    expect(initial.onEvidenceAction).toHaveBeenCalledWith({ type: "select", source: { kind: "document", id: "doc-01" } });
    expect(initial.onUseEvidenceQuestion).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Lay selected source on table" }));
    expect(screen.getByText("On the table: doc-01 · Opening report")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use source in question draft" }));
    expect(initial.onUseEvidenceQuestion).toHaveBeenCalledWith("Looking at document doc-01, what can you tell me about the information shown here?", { kind: "document", id: "doc-01" });
    expect(initial.session.ask).not.toHaveBeenCalled();
    expect(initial.session.requestEvidence).not.toHaveBeenCalled();
  });
  it("delegates requestable eligibility to the original evidence panel without presenting a request", () => {
    const initial = { ...props(), tab: "evidence" as const };
    render(<InterviewStationPanel {...initial} />);
    fireEvent.click(screen.getByText("All public sources and record requests"));
    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    expect(initial.session.requestEvidence).toHaveBeenCalledWith("not-released");
    expect(initial.onEvidenceAction).not.toHaveBeenCalled();
  });
  it("routes checked coach citations back to the existing transcript and question drafts to the composer", () => {
    const initial = { ...props(), tab: "coach" as const };
    render(<Interactive initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "Use this question" }));
    expect(initial.session.updateDraft).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Turn 1: Answer 1." }));
    expect(initial.onCite).toHaveBeenCalledWith(1, "Answer 1.");
    expect(screen.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected")).toBe("true");
  });
  it("retains original finding validation and converts cited reasons through draftToFinding", () => {
    const initial = { ...props(), tab: "finding" as const };
    render(<InterviewStationPanel {...initial} />);
    expect(disabled("Confirm finding")).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "not-released" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Truthful" }));
    fireEvent.change(screen.getByLabelText("Likelihood that the subject is concealing involvement"), { target: { value: "very_unlikely" } });
    fireEvent.click(screen.getByRole("radio", { name: "moderate" }));
    fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "  The cited public records support this finding.  " } });
    expect(disabled("Confirm finding")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "T1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "doc-01" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "rec-01" }));
    expect(disabled("Confirm finding")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm finding" }));
    expect(initial.session.commitFinding).toHaveBeenCalledWith({ label: "truthful", likelihood: "very_unlikely", confidence: "moderate", basis_flag_refs: [], cited_turns: [1], cited_records: ["doc-01", "rec-01"], corroboration_needed: [], rationale: "The cited public records support this finding." });
  });
});
