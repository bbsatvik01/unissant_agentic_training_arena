// @vitest-environment jsdom
/** Real route/session ownership; only WebGL is substituted. Generated bundles are required. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import rawRecording from "../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../lib/world/parseRecording";
import { COURTYARD_SCENE_CONTEXT } from "../lib/world/sceneContext";
import * as navigation from "../lib/precinct/knownWorldNavigation";
import type { PrecinctSession, PrecinctSessionOptions } from "./precinct/usePrecinctSession";
import { PrecinctRoute } from "./PrecinctRoute";

type CanvasProps = ComponentProps<typeof PrecinctCanvas>;
const harness = vi.hoisted((): { session: PrecinctSession | null } => ({ session: null }));
vi.mock("./precinct/usePrecinctSession", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctSession")>("./precinct/usePrecinctSession");
  return { usePrecinctSession(options: PrecinctSessionOptions) { const session = original.usePrecinctSession(options); harness.session = session; return session; } };
});
vi.mock("../components/precinct/PrecinctCanvas", () => ({ default: vi.fn((props: CanvasProps) => <div data-testid="navigation-canvas" data-active={props.active} />) }));
const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const transport = vi.fn();
beforeEach(() => {
  harness.session = null; vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("fetch", transport);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const [name, original] of [["showModal", show], ["close", close]] as const) {
    if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, original);
  }
});
function canvas() { const value = vi.mocked(PrecinctCanvas).mock.lastCall?.[0]; if (value === undefined) throw new Error("Missing Canvas"); return value; }
async function enter() {
  render(<MemoryRouter><PrecinctRoute /></MemoryRouter>); await screen.findByTestId("navigation-canvas");
  act(() => { canvas().onReady(); }); fireEvent.click(screen.getByRole("button", { name: "Skip arrival" }));
}
function settings() { fireEvent.click(screen.getByRole("button", { name: "Comfort and accessibility settings" })); }
function install(value: unknown) {
  const parsed = parseRecording(value); if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  act(() => { if (harness.session === null) throw new Error("Missing session"); harness.session.loadCaptureRecording(parsed.recording); });
}

describe("selected-world navigation route seam", () => {
  it("discloses active player/staff meshes for each architecture without replacing the authored manifest", async () => {
    await enter(); expect(canvas().legacyReplay).toBe(false); expect(canvas().manifest.playerNavigationMesh).toBeUndefined();
    expect(screen.queryByRole("status", { name: "Navigation status" })).toBeNull(); settings();
    expect(screen.getByRole("status", { name: "Navigation status" }).textContent).toContain("Polygon navigation is active");
    fireEvent.change(screen.getByRole("combobox", { name: /Architecture/ }), { target: { value: "courtyard" } });
    expect(canvas().manifest.asset).toBe("precinct-courtyard.glb"); expect(canvas().manifest.playerNavigationMesh).toBeUndefined();
    expect(screen.getByRole("status", { name: "Navigation status" }).textContent).toContain("Polygon navigation is active");
    expect(transport).not.toHaveBeenCalled();
  });
  it("derives legacy compatibility only from validated v1 playback and clears it on return", async () => {
    await enter(); install(rawRecording); settings();
    expect(canvas().legacyReplay).toBe(true); expect(canvas().replayActors).toBeUndefined();
    expect(screen.getByRole("status", { name: "Navigation status" }).textContent).toContain("Legacy replay retains");
    act(() => { harness.session?.stopSession(); });
    expect(canvas().legacyReplay).toBe(false);
    expect(screen.getByRole("status", { name: "Navigation status" }).textContent).toContain("Polygon navigation is active");
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps validated v2 captured roots separate from live and legacy planning", async () => {
    await enter(); install({ ...rawRecording, format: "arena.recording.v2", world_events: [], scene_context: COURTYARD_SCENE_CONTEXT }); settings();
    expect(canvas().legacyReplay).toBe(false); expect(canvas().replayActors).toBeDefined();
    expect(canvas().manifest.asset).toBe("precinct-courtyard.glb");
    expect(screen.getByRole("status", { name: "Navigation status" }).textContent).toContain("live navigation planning is paused");
    expect(transport).not.toHaveBeenCalled();
  });
  it("makes degraded navigation visible while walking and moves the single disclosure into settings", async () => {
    const original = navigation.navigatedPrecinctManifest;
    vi.spyOn(navigation, "navigatedPrecinctManifest").mockImplementation((manifest, context) => ({ ...original(manifest, context),
      playerNavigationMesh: null, navigationMesh: null, navigationStatus: { context: "live", player: { mode: "graph", reason: "invalid" }, staff: { mode: "graph", reason: "missing" } } }));
    await enter(); const notice = screen.getByRole("status", { name: "Navigation status" });
    expect(notice.textContent).toContain("player (invalid mesh)"); expect(notice.textContent).toContain("staff (missing mesh)");
    expect(notice.closest("dialog")).toBeNull(); settings();
    expect(screen.getAllByRole("status", { name: "Navigation status" })).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Navigation status" }).closest("dialog")).not.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
});
