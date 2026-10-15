// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { Group } from "three";
import { useActorSampler } from "../components/precinct/useActorSampler";
import { ABSENT_CLIP, staffClip, type ActorCapture } from "../lib/precinct/proceduralActors";
import type { FreshCaptureBinding } from "../lib/world/freshClientCapture";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import { RenderBoundary } from "../components/precinct/RenderBoundary";
import rawRecording from "../fixtures/recordings/F01-truthful.json";
import { localStaffPlaybackActivity } from "../lib/precinct/localStaffPlaybackActivity";
import { SILENT_CAPTURE_AUDIO_REASON } from "../lib/world/captureAudioBoundary";
import { uiWorldSamples } from "../lib/world/recordingTelemetry";
import { parseRecording } from "../lib/world/parseRecording";
import { COURTYARD_SCENE_CONTEXT, OFFICE_SCENE_CONTEXT } from "../lib/world/sceneContext";
import { STATIONS } from "../components/precinct/sceneTypes";
import type { PrecinctSession, PrecinctSessionOptions } from "./precinct/usePrecinctSession";
import { CASES, RECORDED_CASE_ID } from "../lib/world/cases";
import { PrecinctRoute } from "./PrecinctRoute";

type CanvasProps = ComponentProps<typeof PrecinctCanvas>;
const harness = vi.hoisted((): { patch: Partial<PrecinctSession>; latest: PrecinctSession | null } => ({ patch: {}, latest: null }));
const transport = vi.fn();
vi.mock("./precinct/usePrecinctSession", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctSession")>("./precinct/usePrecinctSession");
  return { usePrecinctSession(options: PrecinctSessionOptions) { const session = original.usePrecinctSession(options); harness.latest = session; return { ...session, ...harness.patch }; } };
});
vi.mock("../components/precinct/PrecinctCanvas", () => ({ default: vi.fn((props: CanvasProps) => <div data-testid="precinct-canvas" data-active={props.active} />) }));
vi.mock("../components/precinct/RenderBoundary", () => ({ RenderBoundary: vi.fn((props: ComponentProps<typeof RenderBoundary>) => <>{props.children}</>) }));
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  harness.patch = {}; harness.latest = null; vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("fetch", transport);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup(); localStaffPlaybackActivity.set(false); vi.unstubAllGlobals(); vi.restoreAllMocks();
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
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Select case" }));
    await vi.dynamicImportSettled();
  });
  await screen.findByText("Your public packet is ready at your desk.");
  fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
}
function openRoom(index: number, hotspot: string) {
  const station = STATIONS[index]; if (station === undefined) throw new Error("Missing station");
  act(() => { canvas().onPose({ position: station.anchor, yaw: station.yaw, speed: 0, hotspot }); canvas().onInteract(hotspot); });
}


describe("merged sampled replay route", () => {
  it("captures only after explicit Start and reviews its own local run through one existing Canvas", async () => {
    await enter(); await choose(); const original = screen.getByTestId("precinct-canvas");
    expect(canvas().actorCapture).toBeUndefined(); expect(canvas().replayActors).toBeUndefined();
    openRoom(7, "debrief_replay");
    fireEvent.click(screen.getByRole("button", { name: "Start local capture" }));
    expect(canvas().actorCapture?.scope).toMatch(/^office:local-world:/);
    act(() => { canvas().onBeforeFrame?.(0.1); canvas().onCameraSample?.({ mode: "first", position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: 60 }); });
    fireEvent.click(screen.getByRole("button", { name: "Review this local capture" }));
    expect(harness.latest?.recordingTrialId).toMatch(/^local-world:/); expect(harness.latest?.recording?.events).toEqual([]);
    expect(harness.latest?.recording?.scene_context).toEqual(OFFICE_SCENE_CONTEXT);
    expect(harness.latest?.recording?.debrief).toBeNull(); expect(harness.latest?.playback.playing).toBe(false);
    expect(canvas().actorCapture).toBeUndefined(); expect(canvas().replayActors).toBeDefined();
    expect(screen.getByTestId("precinct-canvas")).toBe(original); expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText("Local world capture · no interview or score")).toBeTruthy();
    expect(transport).not.toHaveBeenCalled();
  });
  it("records notebook actions after an idle demand-modal interval at their actual local-clock time", async () => {
    await enter(); await choose(); openRoom(7, "debrief_replay");
    let now = 1_000; vi.spyOn(performance, "now").mockImplementation(() => now);
    fireEvent.click(screen.getByRole("button", { name: "Start local capture" }));
    now = 6_000; openRoom(3, "personal_dossier");
    now = 6_500; fireEvent.click(screen.getByRole("tab", { name: /Notebook/ }));
    now = 7_000; fireEvent.change(screen.getByRole("textbox", { name: "New note" }), { target: { value: "Written after the idle wait" } });
    now = 8_000; fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    // This mocked demand Canvas has issued no onBeforeFrame callback during the wait or edits.
    now = 8_100; openRoom(7, "debrief_replay");
    fireEvent.click(screen.getByRole("button", { name: "Review this local capture" }));
    const events = uiWorldSamples(readSession().recording?.world_events ?? []);
    expect(events.find((event) => event.kind === "ui" && event.data.action === "panel" && event.data.panel_id === "personal_dossier" && event.data.open)?.t_ms).toBe(5_000);
    expect(events.find((event) => event.kind === "input" && event.data.action === "notebook" && event.data.operation === "draft" && event.data.draft.text === "Written after the idle wait")?.t_ms).toBe(6_000);
    expect(events.find((event) => event.kind === "input" && event.data.action === "notebook" && event.data.operation === "upsert" && event.data.text === "Written after the idle wait")?.t_ms).toBe(7_000);
    expect(readSession().recording?.events).toEqual([]); expect(transport).not.toHaveBeenCalled();
  });
  it("keeps local actor sampling stable through capture counts, camera, pose and comfort rerenders", async () => {
    await enter(); await choose(); openRoom(7, "debrief_replay");
    fireEvent.click(screen.getByRole("button", { name: "Start local capture" }));
    const owner = canvas().actorCapture; if (owner === undefined) throw new Error("missing local capture");
    const sampler = renderHook<ReturnType<typeof useActorSampler>, { capture: ActorCapture | undefined }>(({ capture }) => useActorSampler(capture, "staff:patrol"), { initialProps: { capture: owner } });
    const root = new Group(); root.position.set(1, 0, 2);
    act(() => { sampler.result.current.current?.sample(root, staffClip("patrol", false), 1, 0.1); });
    expect(canvas().actorCapture).toBe(owner);
    sampler.rerender({ capture: canvas().actorCapture });
    act(() => { canvas().onCameraSample?.(cameraSample); });
    expect(canvas().actorCapture?.onActorSample).toBe(owner.onActorSample);
    act(() => { canvas().onPose({ position: [0, 0, -4], yaw: 1, speed: 1, hotspot: null }); });
    expect(canvas().actorCapture).toBe(owner);
    openSettings(); fireEvent.click(screen.getByRole("checkbox", { name: /Larger text/ }));
    expect(canvas().actorCapture).toBe(owner);
    sampler.rerender({ capture: canvas().actorCapture });
    // A real actor unmount still records one absence, rather than suppressing lifecycle cleanup.
    sampler.unmount();
    openRoom(7, "debrief_replay"); fireEvent.click(screen.getByRole("button", { name: "Review this local capture" }));
    const poses = uiWorldSamples(readSession().recording?.world_events ?? []).filter((event) => event.kind === "pose");
    expect(poses.map((event) => event.data.animation.clip)).toEqual([staffClip("patrol", false), ABSENT_CLIP]);
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps a fresh actor writer stable for the same run and closes only the replaced run's sampler", async () => {
    await enter(); const session = readSession();
    const pose = vi.fn(() => true); const nextPose = vi.fn(() => true);
    const binding: FreshCaptureBinding = { observer: { observe: vi.fn(), failed: vi.fn() }, pose,
      camera: vi.fn(() => true), input: vi.fn(() => true), inputs: vi.fn(() => true), ui: vi.fn(() => true) };
    const state = { ...session.freshCapture.state, phase: "recording" as const, captureId: "capture-a", sessionId: "run-a", trialId: "trial-a" };
    harness.patch = { source: "live", sessionKey: "run-a", freshCapture: { ...session.freshCapture, state, binding } };
    act(() => { canvas().onPose({ position: [0, 0, -4], yaw: 0, speed: 0, hotspot: null }); });
    const owner = canvas().actorCapture; if (owner === undefined) throw new Error("missing fresh capture");
    const sampler = renderHook<ReturnType<typeof useActorSampler>, { capture: ActorCapture | undefined }>(({ capture }) => useActorSampler(capture, "staff:patrol"), { initialProps: { capture: owner } });
    act(() => { sampler.result.current.current?.sample(new Group(), staffClip("patrol", false), 1, 0.1); });
    harness.patch = { ...harness.patch, freshCapture: { ...session.freshCapture, state: { ...state, worldSamples: 1 }, binding } };
    act(() => { canvas().onCameraSample?.(cameraSample); canvas().onPose({ position: [0, 0, -5], yaw: 1, speed: 1, hotspot: null }); });
    expect(canvas().actorCapture).toBe(owner);
    openSettings(); fireEvent.click(screen.getByRole("checkbox", { name: /Larger text/ }));
    expect(canvas().actorCapture?.onActorSample).toBe(owner.onActorSample);
    sampler.rerender({ capture: canvas().actorCapture }); expect(pose).toHaveBeenCalledOnce();
    harness.patch = { ...harness.patch, sessionKey: "run-b", freshCapture: { ...session.freshCapture,
      state: { ...state, captureId: "capture-b", sessionId: "run-b", trialId: "trial-b" }, binding: { ...binding, pose: nextPose } } };
    act(() => { canvas().onPose({ position: [0, 0, -6], yaw: 1, speed: 1, hotspot: null }); });
    expect(canvas().actorCapture).not.toBe(owner);
    sampler.rerender({ capture: canvas().actorCapture });
    expect(pose).toHaveBeenLastCalledWith(expect.objectContaining({ animation: { clip: ABSENT_CLIP, time: 1 } }));
    expect(pose).toHaveBeenCalledTimes(2); expect(nextPose).not.toHaveBeenCalled();
    act(() => { sampler.result.current.current?.sample(new Group(), staffClip("patrol", true), 2, 0.1); });
    sampler.unmount(); expect(nextPose).toHaveBeenCalledTimes(2);
    expect(nextPose).toHaveBeenLastCalledWith(expect.objectContaining({ animation: { clip: ABSENT_CLIP, time: 2 } }));
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps one finite capture status visible while walking and accessible inside every modal", async () => {
    await enter(); const current = harness.latest; if (current === null) throw new Error("missing session");
    harness.patch = { freshCapture: { ...current.freshCapture, state: { ...current.freshCapture.state, phase: "incomplete", reason: "bounds", frames: 800, worldSamples: 4_000, captureId: "do-not-show-id" } } };
    act(() => { canvas().onPose({ position: [0, 0, -4], yaw: 0, speed: 0, hotspot: null }); });
    const walking = screen.getByRole("status", { name: "Capture status" });
    expect(walking.textContent).toContain("incomplete (bounds)"); expect(walking.closest("dialog")).toBeNull();
    expect(walking.textContent).not.toContain("do-not-show-id"); expect(walking.textContent).not.toContain("4000");
    for (const hotspot of ["debrief_replay", "map", "settings"]) {
      act(() => { canvas().onInteract(hotspot); });
      expect(screen.getAllByRole("status", { name: "Capture status" })).toHaveLength(1);
      expect(screen.getByRole("status", { name: "Capture status" }).closest("dialog")).toBe(screen.getByRole("dialog"));
      fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
      expect(screen.getByRole("status", { name: "Capture status" }).closest("dialog")).toBeNull();
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("blocks direct recording replacement in a pending assessment without exposing past coaching", async () => {
    const loadBundledRecording = vi.fn(() => Promise.resolve()); const importRecording = vi.fn(() => Promise.resolve());
    harness.patch = { assessmentActive: true, source: "live", loadBundledRecording, importRecording };
    await enter(); openRoom(7, "debrief_replay");
    expect(screen.getByText(/Recorded runs and review are withheld during assessment/)).toBeTruthy();
    const input = screen.getByLabelText<HTMLInputElement>("Import recording"); expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { files: [new File(["{}"], "another.json")] } });
    expect(screen.queryByRole("button", { name: "Load bundled example run" })).toBeNull();
    expect(importRecording).not.toHaveBeenCalled(); expect(loadBundledRecording).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Session debrief" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start local capture" })).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
});

function architecture(value: "office" | "courtyard") {
  fireEvent.change(screen.getByRole("combobox", { name: /Architecture/ }), { target: { value } });
}
function openSettings() { fireEvent.click(screen.getByRole("button", { name: "Comfort and accessibility settings" })); }
function unavailable() {
  const props = vi.mocked(RenderBoundary).mock.lastCall?.[0]; if (props === undefined) throw new Error("missing boundary"); return props.onUnavailable;
}
function readSession() { const value = harness.latest; if (value === null) throw new Error("missing session"); return value; }
function installScene(context: typeof OFFICE_SCENE_CONTEXT | undefined) {
  const parsed = parseRecording(context === undefined ? rawRecording : { ...rawRecording, format: "arena.recording.v2", world_events: [], scene_context: context });
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  act(() => { readSession().loadCaptureRecording(parsed.recording); });
}
const cameraSample = { mode: "first" as const, position: [1, 2, 3] as const, quaternion: [0, 0, 0, 1] as const, fov: 60 };

describe("combined recorded architecture ownership", () => {
  it("explains active staff audio and retains a silent local prefix when playback starts later", async () => {
    await enter(); await choose(); openRoom(7, "debrief_replay");
    act(() => { localStaffPlaybackActivity.set(true); });
    fireEvent.click(screen.getByRole("button", { name: "Start local capture" }));
    expect(screen.getByRole("alert").textContent).toBe(SILENT_CAPTURE_AUDIO_REASON); expect(canvas().actorCapture).toBeUndefined();
    act(() => { localStaffPlaybackActivity.set(false); });
    fireEvent.click(screen.getByRole("button", { name: "Start local capture" }));
    act(() => { canvas().onCameraSample?.(cameraSample); localStaffPlaybackActivity.set(true); });
    expect(screen.getByRole("status", { name: "Capture status" }).textContent).toContain("audio-enabled");
    expect(canvas().actorCapture).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Review this local capture" }));
    expect(readSession().recording?.world_events.filter((event) => event.kind === "camera")).toHaveLength(1);
    expect(readSession().recording?.scene_context).toEqual(OFFICE_SCENE_CONTEXT);
    expect(transport).not.toHaveBeenCalled();
  });
  it("selects matching geometry and minimap, preserves common stations and restores Office", async () => {
    await enter(); const hotspots = canvas().manifest.hotspots; const old = canvas(); const oldUnavailable = unavailable();
    openSettings(); architecture("courtyard");
    expect(canvas().manifest.asset).toBe("precinct-courtyard.glb"); expect(canvas().manifest.hotspots).toEqual(hotspots);
    expect(document.querySelector(".precinct-minimap svg")?.getAttribute("viewBox")).toBe("-15 -37 30 58");
    act(() => { old.onReady(); oldUnavailable(); old.onPose({ position: [99, 0, 99], yaw: 1, speed: 1, hotspot: null }); });
    expect(screen.queryByRole("status", { name: "Rendering status" })).toBeNull();
    act(() => { canvas().onReady(); }); architecture("office");
    expect(canvas().manifest.asset).toBe("precinct.glb");
    expect(document.querySelector(".precinct-minimap svg")?.getAttribute("viewBox")).toBe("-15 -37 30 38");
    expect(canvas().cameraMode).toBe("first"); expect(canvas().travel.current).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects old and pre-ready samples, then binds actual Courtyard capture and enforces the lock in handlers", async () => {
    const onCameraSample = vi.fn(); await enter({ onCameraSample }); await choose();
    const old = canvas(); openSettings(); architecture("courtyard");
    act(() => { old.onReady(); old.onCameraSample?.(cameraSample); canvas().onCameraSample?.(cameraSample); canvas().onBeforeFrame?.(1); });
    expect(onCameraSample).not.toHaveBeenCalled();
    openRoom(7, "debrief_replay"); fireEvent.click(screen.getByRole("button", { name: "Start local capture" }));
    expect(screen.getByRole("alert").textContent).toContain("Wait for a verified, rendered scene");
    expect(canvas().actorCapture).toBeUndefined();
    act(() => { canvas().onReady(); });
    fireEvent.click(screen.getByRole("button", { name: "Start local capture" }));
    expect(canvas().actorCapture?.scope).toMatch(/^courtyard:local-world:/);
    act(() => { canvas().onBeforeFrame?.(0.1); canvas().onCameraSample?.(cameraSample); });
    expect(onCameraSample).toHaveBeenCalledOnce();
    openSettings(); const choice = screen.getByRole<HTMLSelectElement>("combobox", { name: /Architecture/ }); expect(choice.disabled).toBe(true);
    architecture("office"); expect(canvas().manifest.asset).toBe("precinct-courtyard.glb");
    openRoom(7, "debrief_replay"); fireEvent.click(screen.getByRole("button", { name: "Review this local capture" }));
    expect(readSession().recording?.scene_context).toEqual(COURTYARD_SCENE_CONTEXT);
    expect(readSession().recording?.world_events.filter((event) => event.kind === "camera")).toHaveLength(1);
    expect(transport).not.toHaveBeenCalled();
  });
  it("lets a validated recording own geometry separately from preference and legacy absence always selects Office", async () => {
    await enter(); openSettings(); architecture("courtyard"); act(() => { canvas().onReady(); });
    installScene(undefined); expect(canvas().manifest.asset).toBe("precinct.glb");
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: /Architecture/ }).disabled).toBe(true);
    architecture("office"); // A synthetic change cannot rewrite the saved Courtyard preference.
    act(() => { readSession().stopSession(); }); expect(canvas().manifest.asset).toBe("precinct-courtyard.glb");
    act(() => { canvas().onReady(); }); architecture("office"); act(() => { canvas().onReady(); });
    installScene(COURTYARD_SCENE_CONTEXT); expect(canvas().manifest.asset).toBe("precinct-courtyard.glb");
    expect(canvas().replayActors).toBeDefined(); expect(canvas().actorCapture).toBeUndefined();
    act(() => { readSession().stopSession(); }); expect(canvas().manifest.asset).toBe("precinct.glb");
    expect(transport).not.toHaveBeenCalled();
  });
  it("retains the original sampled prefix on renderer loss and keeps accessible station navigation usable", async () => {
    await enter(); await choose(); openRoom(7, "debrief_replay");
    fireEvent.click(screen.getByRole("button", { name: "Start local capture" }));
    const old = canvas(); act(() => { old.onCameraSample?.(cameraSample); });
    act(() => { unavailable()(); old.onReady(); old.onCameraSample?.(cameraSample); old.onBeforeFrame?.(1); });
    expect(screen.getByRole("status", { name: "Capture status" }).textContent).toContain("scene-changed");
    expect(screen.getByRole("status", { name: "Rendering status" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review this local capture" }));
    expect(readSession().recording?.scene_context).toEqual(OFFICE_SCENE_CONTEXT);
    expect(readSession().recording?.world_events.filter((event) => event.kind === "camera")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open precinct map and fast travel" }));
    fireEvent.click(screen.getByRole("button", { name: /^6\s*Interview room/ }));
    expect(screen.getByRole("button", { name: /Enter interview/ })).toBeTruthy();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects unknown imported scene identity atomically without changing the current world", async () => {
    await enter(); installScene(COURTYARD_SCENE_CONTEXT); const trial = readSession().recordingTrialId;
    const file = new File([], "unknown.json"); Object.defineProperty(file, "text", { value: () => Promise.resolve(JSON.stringify({ ...rawRecording,
      format: "arena.recording.v2", world_events: [], scene_context: { ...COURTYARD_SCENE_CONTEXT, build_sha256: "0".repeat(64) } })) });
    await act(async () => { await readSession().importRecording(file); });
    expect(readSession().recordingState).toBe("error"); expect(readSession().recordingTrialId).toBe(trial);
    expect(canvas().manifest.asset).toBe("precinct-courtyard.glb"); expect(transport).not.toHaveBeenCalled();
  });
});
