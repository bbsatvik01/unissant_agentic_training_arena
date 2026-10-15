// @vitest-environment jsdom
/** Route callback integration only; physical gamepad/WebGL acceptance remains separate. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import { useDialogGamepad } from "../hooks/useDialogGamepad";
import type { PrecinctSession, PrecinctSessionOptions } from "./precinct/usePrecinctSession";
import raw from "../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../lib/world/parseRecording";
import { PrecinctRoute } from "./PrecinctRoute";
const noNetwork = vi.fn();
const controls = vi.hoisted((): { enabled: boolean; recording: boolean; patch: Partial<PrecinctSession>; latest: PrecinctSession | null; pause: () => void; camera: () => void; map: () => void } => ({ enabled: false, recording: false, patch: {}, latest: null, pause: () => undefined, camera: () => undefined, map: () => undefined }));
vi.mock("../hooks/usePrecinctGamepadShortcuts", () => ({ usePrecinctGamepadShortcuts(enabled: boolean, pause: () => void, camera: () => void, map: () => void) { controls.enabled = enabled; controls.pause = pause; controls.camera = camera; controls.map = map; } }));
vi.mock("../hooks/useDialogGamepad", () => ({ useDialogGamepad: vi.fn() }));
vi.mock("./precinct/usePrecinctSession", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctSession")>("./precinct/usePrecinctSession");
  return { usePrecinctSession(options: PrecinctSessionOptions) { const session = original.usePrecinctSession(options); controls.latest = session; return { ...session, ...(controls.recording ? { source: "recording" as const } : {}), ...controls.patch }; } };
});
vi.mock("../components/precinct/PrecinctCanvas", () => ({ default: vi.fn((props: ComponentProps<typeof PrecinctCanvas>) => <div data-testid="controller-canvas" data-active={props.active} />) }));
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"), originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  vi.clearAllMocks(); controls.enabled = false; controls.recording = false; controls.patch = {}; controls.latest = null; vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("fetch", noNetwork);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [name, descriptor] of [["showModal", originalShow], ["close", originalClose]] as const) { if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name); else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor); }
});
function canvas() { const props = vi.mocked(PrecinctCanvas).mock.lastCall?.[0]; if (props === undefined) throw new Error("Missing canvas"); return props; }
async function enter() {
  render(<MemoryRouter><PrecinctRoute /></MemoryRouter>); await screen.findByTestId("controller-canvas"); expect(controls.enabled).toBe(false);
  act(() => { canvas().onReady(); }); fireEvent.click(screen.getByRole("button", { name: "Skip arrival" })); expect(controls.enabled).toBe(true);
}
describe("precinct route controller callbacks", () => {
  it("reuses pause, allowed camera cycle, map and current native modal close", async () => {
    await enter(); expect(canvas().cameraMode).toBe("first"); act(() => { controls.camera(); }); expect(canvas().cameraMode).toBe("third");
    act(() => { controls.pause(); }); expect(canvas().paused).toBe(true); act(() => { controls.pause(); }); expect(canvas().paused).toBe(false);
    act(() => { controls.map(); }); expect(screen.getByRole("dialog", { name: "Find your way." })).toBeTruthy(); expect(controls.enabled).toBe(false);
    expect(vi.mocked(useDialogGamepad).mock.lastCall?.[2]).toBe("Find your way.");
    const close = vi.mocked(useDialogGamepad).mock.lastCall?.[1]; if (close === undefined) throw new Error("Missing existing Modal close callback");
    act(() => { close(); }); expect(screen.queryByRole("dialog")).toBeNull(); expect(controls.enabled).toBe(true); expect(noNetwork).not.toHaveBeenCalled();
  });
  it("toggles only the existing scoped v2 replay camera authority without advancing playback", async () => {
    const parsed = parseRecording({ ...structuredClone(raw), format: "arena.recording.v2", world_events: [] });
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    controls.patch = { source: "recording", sessionKey: "recording-one", recording: parsed.recording };
    await enter(); const original = screen.getByTestId("controller-canvas"); const mode = canvas().cameraMode; const time = controls.latest?.clock.current;
    expect(canvas().replayCamera?.ownership).toBe("recorded");
    act(() => { controls.camera(); }); expect(canvas().replayCamera?.ownership).toBe("free");
    expect(canvas().cameraMode).toBe(mode); expect(controls.latest?.clock.current).toBe(time);
    act(() => { controls.camera(); }); expect(canvas().replayCamera?.ownership).toBe("recorded");
    act(() => { controls.camera(); }); expect(canvas().replayCamera?.ownership).toBe("free");
    controls.patch = { ...controls.patch, sessionKey: "recording-two" };
    act(() => { canvas().onPose({ position: [0, 0, -4], yaw: 0, speed: 0, hotspot: null }); });
    expect(canvas().replayCamera?.ownership).toBe("recorded"); expect(canvas().cameraMode).toBe(mode);
    expect(screen.getByTestId("controller-canvas")).toBe(original); expect(noNetwork).not.toHaveBeenCalled();
  });
  it("does not repurpose live cameraMode as recording camera ownership", async () => {
    controls.recording = true; await enter(); const before = canvas().cameraMode;
    act(() => { controls.camera(); }); expect(canvas().cameraMode).toBe(before); expect(noNetwork).not.toHaveBeenCalled();
  });
});
