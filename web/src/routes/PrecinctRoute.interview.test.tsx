// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import { STATIONS } from "../components/precinct/sceneTypes";
import type { PrecinctSession, PrecinctSessionOptions } from "./precinct/usePrecinctSession";
import { CASES, RECORDED_CASE_ID } from "../lib/world/cases";
import { initialTrialState, trialReducer } from "../lib/trial/trialReducer";
import { deriveWorld } from "../lib/world/worldState";
import { LogBuilder, snapshot } from "../test/trial-log";
import { PrecinctRoute, type PrecinctRouteProps } from "./PrecinctRoute";

type CanvasProps = ComponentProps<typeof PrecinctCanvas>;
const harness = vi.hoisted((): { patch: Partial<PrecinctSession>; latest: PrecinctSession | null } => ({ patch: {}, latest: null }));
const fetchSpy = vi.fn();
vi.mock("./precinct/usePrecinctSession", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctSession")>("./precinct/usePrecinctSession");
  return { usePrecinctSession(options: PrecinctSessionOptions) { const session = original.usePrecinctSession(options); harness.latest = session; return { ...session, ...harness.patch }; } };
});
vi.mock("../components/precinct/PrecinctCanvas", () => ({ default: vi.fn((props: CanvasProps) => <div data-testid="precinct-canvas" data-active={props.active} />) }));
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  harness.patch = {}; harness.latest = null; vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("fetch", fetchSpy);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const [name, original] of [["showModal", originalShow], ["close", originalClose]] as const) {
    if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, original);
  }
});
function canvas() { const result = vi.mocked(PrecinctCanvas).mock.lastCall?.[0]; if (result === undefined) throw new Error("Missing precinct canvas"); return result; }
async function enter(props: ComponentProps<typeof PrecinctRoute> = {}) {
  render(<MemoryRouter><PrecinctRoute {...props} /></MemoryRouter>);
  await screen.findByTestId("precinct-canvas"); act(() => { canvas().onReady(); });
  fireEvent.click(screen.getByRole("button", { name: "Skip arrival" }));
}
async function choose() {
  const card = CASES.find((item) => item.case_id === RECORDED_CASE_ID); if (card === undefined) throw new Error("Missing public case");
  act(() => { canvas().onInteract("case_board"); });
  fireEvent.click(screen.getByRole("button", { name: "Select case" }));
  await screen.findByText("Your public packet is ready at your desk.");
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
}
function openRoom(index: number, hotspot: string) {
  const station = STATIONS[index]; if (station === undefined) throw new Error("Missing station");
  act(() => { canvas().onPose({ position: station.anchor, yaw: station.yaw, speed: 0, hotspot }); canvas().onInteract(hotspot); });
}


const profile: NonNullable<PrecinctSession["me"]> = { user_id: "orientation-test-user", display_name: "Trainee", roles: [], ex4_acknowledged: "2026-01-01T00:00:00Z", study: null, console: false, csrf_token: "test-only" };
function refreshSession(patch: Partial<PrecinctSession>) {
  harness.patch = { ...harness.patch, ...patch };
  act(() => { canvas().onPose({ position: STATIONS[5].anchor, yaw: 0, speed: 0, hotspot: "interview" }); });
}
async function prepareCase() {
  await enter(); await choose();
  openRoom(0, "reception"); fireEvent.click(screen.getByRole("button", { name: "Check in for this shift" }));
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  openRoom(4, "briefing"); fireEvent.click(screen.getByRole("button", { name: "Acknowledge the briefing and ground rule" }));
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  openRoom(3, "personal_dossier"); fireEvent.click(screen.getByRole("button", { name: "Mark case file reviewed" }));
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
  expect(screen.getByRole("heading", { name: "Prepare your interview" })).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
}

describe("slice four precinct route", () => {
  it("puts only an explicitly presented public source into the scene and reopens its existing reader", async () => {
    await enter(); await choose(); openRoom(5, "interview");
    fireEvent.click(screen.getByRole("button", { name: "Call subject to room" }));
    fireEvent.click(screen.getByRole("tab", { name: "Evidence table" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Public source" }), { target: { value: "0" } });
    expect(canvas().interview?.evidence).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lay selected source on table" }));
    const document = harness.latest?.documents[0]; if (document === undefined) throw new Error("Missing opening document");
    expect(canvas().interview?.evidence).toEqual({ ref: { kind: "document", id: document.doc_id }, title: document.title });
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    act(() => { canvas().onInspectEvidence?.(); });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Evidence table" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Clear table" }));
    expect(canvas().interview?.evidence).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Lay selected source on table" }));
    refreshSession({ source: "recording", sessionKey: "saved-v1" });
    expect(canvas().interview?.evidence).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps explicit call and seat through controls → new start → failure/retry → bound run", async () => {
    const startInterview = vi.fn();
    harness.patch = { backend: "connected", me: profile, canStart: true, modes: ["practice"], startInterview };
    await enter(); await choose(); openRoom(5, "interview");
    const originalCanvas = screen.getByTestId("precinct-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Call subject to room" }));
    fireEvent.click(screen.getByRole("button", { name: "Sit at interview table" }));
    fireEvent.click(screen.getByRole("button", { name: "Interview controls" }));
    fireEvent.click(screen.getByRole("button", { name: "Start text practice" }));
    const baseline = harness.latest; if (baseline === null) throw new Error("Missing session");
    refreshSession({ source: "live", sessionKey: "starting:case", live: { ...baseline.live, phase: "starting" }, packet: null, packetState: "loading" });
    expect(canvas().interview?.seated).toBe(true); expect(canvas().cameraMode).toBe("first");
    expect(screen.getByRole("button", { name: "Leave interview seat" })).toBeTruthy();
    refreshSession({ live: { ...baseline.live, phase: "error", error: "Local start failed" } });
    expect(canvas().interview?.seated).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start text practice" }));
    expect(startInterview).toHaveBeenCalledTimes(2);
    const state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    refreshSession({ sessionKey: "seated-run", live: { ...baseline.live, phase: "running" }, view: state.view, packet: baseline.packet, packetState: "ready" });
    expect(canvas().interview?.seated).toBe(true); expect(canvas().interview?.present).toBe(true);
    expect(screen.getByTestId("precinct-canvas")).toBe(originalCanvas);
    refreshSession({ source: "recording", sessionKey: "saved-run" });
    expect(canvas().interview?.seated).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hands earned preparation into only the explicitly started same-user same-case run", async () => {
    const startInterview = vi.fn();
    harness.patch = { backend: "connected", me: profile, canStart: true, modes: ["practice"], startInterview };
    await prepareCase(); openRoom(5, "interview");
    fireEvent.click(screen.getByRole("button", { name: "Start text practice" }));
    expect(startInterview).toHaveBeenCalledWith("practice");
    const baseline = harness.latest; if (baseline === null) throw new Error("Missing session");
    refreshSession({ source: "live", sessionKey: "starting:case", live: { ...baseline.live, phase: "starting" }, packet: null, packetState: "loading" });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    const state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    refreshSession({ sessionKey: "prepared-run", live: { ...baseline.live, phase: "running" }, view: state.view, packet: baseline.packet, packetState: "ready" });
    expect(screen.getByRole("heading", { name: "Conduct your interview" })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    refreshSession({ me: { ...profile, user_id: "different-user" } });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    refreshSession({ me: profile, source: "idle", live: baseline.live, view: null, sessionKey: baseline.sessionKey });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("retains earned preparation on failed start and its explicit retry without granting interview completion", async () => {
    const startInterview = vi.fn();
    harness.patch = { backend: "connected", me: profile, canStart: true, modes: ["practice"], startInterview };
    await prepareCase(); openRoom(5, "interview");
    fireEvent.click(screen.getByRole("button", { name: "Start text practice" }));
    const baseline = harness.latest; if (baseline === null) throw new Error("Missing session");
    refreshSession({ source: "live", sessionKey: "starting:case", live: { ...baseline.live, phase: "error", error: "Local start failed" }, packet: null, packetState: "unavailable" });
    expect(screen.getByRole("heading", { name: "Prepare your interview" })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Start text practice" }));
    expect(startInterview).toHaveBeenCalledTimes(2);
    const state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    refreshSession({ sessionKey: "retry-run", live: { ...baseline.live, phase: "running" }, view: state.view, packet: baseline.packet, packetState: "ready" });
    expect(screen.getByRole("heading", { name: "Conduct your interview" })).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("3");
    refreshSession({ source: "recording", sessionKey: "saved-run" });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps implemented case, desk, interview, observation and debrief stations in one precinct session", async () => {
    await enter();
    for (const [index, hotspot] of [[1, "case_board"], [3, "personal_dossier"], [5, "interview"], [6, "observation"], [7, "debrief_replay"]] as const) {
      openRoom(index, hotspot);
      expect(screen.queryByRole("link", { name: /Open training session/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    }
  });
  it("calls and seats explicitly, then waits for restored walking pose before issuing travel", async () => {
    const onInterviewUiEvent = vi.fn<NonNullable<PrecinctRouteProps["onInterviewUiEvent"]>>();
    await enter({ onInterviewUiEvent }); await choose();
    fireEvent.keyDown(window, { code: "KeyV" }); expect(canvas().cameraMode).toBe("third");
    openRoom(5, "interview");
    expect(screen.getAllByTestId("precinct-canvas")).toHaveLength(1);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(canvas().interview?.present).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Call subject to room" }));
    expect(canvas().interview?.present).toBe(true);
    expect(harness.latest?.source).toBe("idle");
    fireEvent.click(screen.getByRole("button", { name: "Sit at interview table" }));
    expect(canvas().interview?.seated).toBe(true); expect(canvas().cameraMode).toBe("first");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Visit observation room" }));
    expect(canvas().interview?.seated).toBe(false);
    expect(canvas().travel.current).toBeNull();
    const restored = STATIONS[5];
    act(() => { canvas().onPose({ position: restored.anchor, yaw: restored.yaw, speed: 0, hotspot: "interview" }); });
    expect(canvas().travel.current).toEqual({ position: STATIONS[6].anchor, yaw: STATIONS[6].yaw, instant: true });
    expect(onInterviewUiEvent.mock.calls.map(([event]) => event)).toEqual([{ type: "intercom.call" }, { type: "seat.enter" }, { type: "seat.exit" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("keeps only the latest navigation while a seated exit is awaiting its restore frame", async () => {
    await enter(); await choose(); openRoom(5, "interview");
    fireEvent.click(screen.getByRole("button", { name: "Call subject to room" }));
    fireEvent.click(screen.getByRole("button", { name: "Sit at interview table" }));
    fireEvent.keyDown(window, { code: "Digit7", key: "7" });
    fireEvent.keyDown(window, { code: "Digit4", key: "4" });
    expect(canvas().travel.current).toBeNull();
    act(() => { canvas().onPose({ position: STATIONS[5].anchor, yaw: 0, speed: 0, hotspot: "interview" }); });
    expect(canvas().travel.current?.position).toEqual(STATIONS[3].anchor);
  });
  it("expands screens inside one modal, closes the expansion first, and restores its exact button", async () => {
    await enter(); openRoom(6, "observation");
    const button = screen.getByRole("button", { name: "Expand Agent office" }); button.focus();
    fireEvent.click(button);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Agent office" })).toBeTruthy();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Agent office expanded");
    const cancellation = new Event("cancel", { cancelable: true }); fireEvent(screen.getByRole("dialog"), cancellation);
    expect(cancellation.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Observation room" })).toBeTruthy();
    expect(document.activeElement).toBe(button);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("withholds stale practice cast and monitor work throughout pending assessment start", async () => {
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    for (const frame of new LogBuilder().ask().frames) state = trialReducer(state, { type: "frame", frame });
    const world = deriveWorld({ view: state.view, arrivals: new Map(), nowMs: 0, subjectName: "Public subject", investigatorActive: false, reducedMotion: true, paused: false });
    harness.patch = { source: "live", assessmentActive: true, view: state.view, world, selectedCase: CASES[0] ?? null };
    await enter(); openRoom(6, "observation");
    expect(canvas().interview?.work.assessment).toBe(true);
    expect(canvas().interview?.work.cards).toBe(0);
    expect(canvas().interview?.cast?.coaches).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    openRoom(5, "interview");
    expect(screen.queryByRole("tab", { name: "Practice coach" })).toBeNull();
    expect(screen.getByText(/Assessment: coaching is withheld here/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" })); openRoom(7, "debrief_replay");
    expect(screen.getByText(/Recorded runs and review are withheld/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Recorded coached interview · Gemini" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Recorded runs" })).toBeNull();
  });
  it("composes camera capture with the existing cadence instead of owning a second clock", async () => {
    const onCameraSample = vi.fn();
    await enter({ onCameraSample });
    const sample = { mode: "first" as const, position: [1, 2, 3] as const, quaternion: [0, 0, 0, 1] as const, fov: 52 };
    act(() => { canvas().onCameraSample?.(sample); });
    expect(onCameraSample).toHaveBeenCalledWith(sample, { caseId: null, sessionKey: "case:none", t_ms: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("loads the real coached recording explicitly and reveals only its own published debrief", async () => {
    await enter(); openRoom(7, "debrief_replay");
    expect(harness.latest?.source).toBe("idle");
    fireEvent.click(screen.getByRole("button", { name: "Recorded coached interview · Gemini" }));
    await screen.findByText(/Loaded run:/);
    expect(harness.latest?.source).toBe("recording");
    expect(harness.latest?.playback.playing).toBe(false); expect(harness.latest?.sound).toBe(false);
    expect(screen.queryByText("Published debrief from this recorded run")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" })); openRoom(5, "interview");
    const position = screen.getByRole<HTMLInputElement>("slider", { name: "Position in the recording" });
    fireEvent.change(position, { target: { value: position.max } });
    fireEvent.click(screen.getByRole("button", { name: "Close panel" })); openRoom(7, "debrief_replay");
    expect(await screen.findByText("Published debrief from this recorded run")).toBeTruthy();
    expect(screen.getByText(/These scores belong only to the loaded recording/)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
