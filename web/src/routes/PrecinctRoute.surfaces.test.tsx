// @vitest-environment jsdom
/** Route projection boundaries only. Authored placement and texture rasterization require WebGL acceptance. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import raw from "../fixtures/recordings/F01-truthful.json";
import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import { CASES, RECORDED_CASE_ID } from "../lib/world/cases";
import { parseRecording } from "../lib/world/parseRecording";
import { seek, startCursor } from "../lib/world/recording";
import type { PrecinctSession, PrecinctSessionOptions } from "./precinct/usePrecinctSession";
import { PrecinctRoute } from "./PrecinctRoute";
const noNetwork = vi.fn();

const harness = vi.hoisted((): { patch: Partial<PrecinctSession> } => ({ patch: {} }));
vi.mock("./precinct/usePrecinctSession", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctSession")>("./precinct/usePrecinctSession");
  return { usePrecinctSession(options: PrecinctSessionOptions) { return { ...original.usePrecinctSession(options), ...harness.patch }; } };
});
vi.mock("../components/precinct/PrecinctCanvas", () => ({ default: vi.fn((props: ComponentProps<typeof PrecinctCanvas>) => <div data-testid="surface-canvas" data-active={props.active} />) }));
const parsed = parseRecording(structuredClone(raw));
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const recording = parsed.recording;
const published = recording.debrief;
const ended = seek(recording, startCursor(recording), recording.durationMs).state.view;
if (published === null || !published.scored || ended === null) throw new Error("Expected fixture publication");
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"), originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  harness.patch = {}; vi.clearAllMocks(); vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("fetch", noNetwork);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [name, descriptor] of [["showModal", originalShow], ["close", originalClose]] as const) { if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name); else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor); }
});
function canvas() { const props = vi.mocked(PrecinctCanvas).mock.lastCall?.[0]; if (props === undefined) throw new Error("Missing canvas"); return props; }
async function enter() {
  const result = render(<MemoryRouter><PrecinctRoute /></MemoryRouter>); await screen.findByTestId("surface-canvas");
  act(() => { canvas().onReady(); }); fireEvent.click(screen.getByRole("button", { name: "Skip arrival" })); return result;
}
function refresh() { act(() => { canvas().onPose({ position: [0, 0, -4], yaw: 0, speed: 0, hotspot: null }); }); }

describe("physical station projections in the existing route", () => {
  it("shows genuine offline offers versus previews, with no manufactured publication or extra player", async () => {
    await enter(); const original = screen.getByTestId("surface-canvas"); const boards = canvas().boardSurfaces;
    if (boards == null) throw new Error("Missing public projections");
    expect(boards.cases).toHaveLength(3);
    for (const [index, surface] of boards.cases.entries()) {
      const card = CASES[index]; if (card === undefined) throw new Error("Expected supplied case metadata");
      expect(surface.heading).toBe(card.title); expect(surface.eyebrow).toContain(card.case_id);
      expect(surface.lines).toContain(card.case_id === RECORDED_CASE_ID ? "Available public case" : "Preview only · session unavailable");
    }
    expect(boards.recognition.heading).toBe("No connected publication"); expect(canvas().debriefWall?.published).toBe(false);
    act(() => { canvas().onInteract(boards.cases[0]?.target ?? "case_board"); });
    expect(screen.getByRole("dialog", { name: "Case board" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    act(() => { canvas().onInteract(boards.recognition.target); }); expect(screen.getByRole("dialog", { name: "Trophy wall" })).toBeTruthy();
    expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(screen.getByTestId("surface-canvas")).toBe(original); expect(noNetwork).not.toHaveBeenCalled();
  });
  it("replaces public case texture keys immediately for a pending packet or accepted assessment", async () => {
    await enter(); const before = canvas().boardSurfaces; if (before == null) throw new Error("Missing public projections");
    harness.patch = { packetState: "loading" }; refresh();
    expect(canvas().boardSurfaces?.cases.every((surface) => surface.heading === "Public source pending")).toBe(true);
    expect(canvas().boardSurfaces?.cases[0]?.key).not.toBe(before.cases[0]?.key);
    harness.patch = { assessmentActive: true, source: "live", debrief: published, view: ended }; refresh();
    expect(canvas().boardSurfaces?.cases.every((surface) => surface.heading === "Assessment in progress")).toBe(true);
    expect(canvas().boardSurfaces?.recognition.heading).toBe("Assessment in progress");
    expect(canvas().debriefWall?.published).toBe(false); expect(canvas().debriefWall?.total).toBe("No published score");
    expect(canvas().interview?.assessmentActive).toBe(true); expect(canvas().interview?.reviewer).toBeNull();
    act(() => { canvas().onInteract("debrief_replay"); });
    expect(screen.queryByRole("button", { name: "Load bundled example run" })).toBeNull();
    expect(screen.queryByText("Choose a recorded run")).toBeNull(); expect(screen.queryByRole("region", { name: "Session debrief" })).toBeNull();
    expect(noNetwork).not.toHaveBeenCalled();
  });
  it("projects the reviewer from actual public work and withholds pending assessment over stale publication", async () => {
    harness.patch = { source: "recording", sessionKey: "reviewer-assessment", recording, view: { ...ended, mode: "assessment" }, debrief: published, referee: published, assessmentActive: false };
    await enter();
    expect(canvas().interview?.work.refereeState).toBe("ready");
    // A late publication has no invented handover time, but its ended matching run may show the reviewer.
    expect(canvas().interview?.reviewer).toEqual({ phase: "published", publishedAtMs: null });
    harness.patch = { ...harness.patch, view: { ...ended, mode: "assessment", debriefReady: null } }; refresh();
    expect(canvas().interview?.reviewer).toBeNull();
    harness.patch = { ...harness.patch, source: "live", sessionKey: "pending-assessment", assessmentActive: true, view: ended }; refresh();
    expect(canvas().interview?.reviewer).toBeNull();
    expect(canvas().interview?.assessmentActive).toBe(true); expect(canvas().interview?.cast?.coaches ?? []).toEqual([]);
    expect(noNetwork).not.toHaveBeenCalled();
  });
  it("shows only the current recording's matching publication and clears it on rewind and source change", async () => {
    harness.patch = { source: "recording", sessionKey: "first-recording", recording, debrief: published, view: ended };
    await enter(); const first = canvas().debriefWall;
    expect(first?.published).toBe(true); expect(first?.total).toBe(`${String(published.rubric.total)} / 100`);
    expect(first?.origin).toBe("PUBLISHED RECORDING · ITS OWN RESULT");
    harness.patch = { ...harness.patch, view: { ...ended, debriefReady: null } }; refresh();
    expect(canvas().debriefWall?.published).toBe(false); expect(canvas().debriefWall?.key).not.toBe(first?.key);
    harness.patch = { ...harness.patch, sessionKey: "next-recording", debrief: null, view: null }; refresh();
    expect(canvas().debriefWall?.published).toBe(false); expect(canvas().debriefWall?.key).toContain("next-recording");
    harness.patch = { source: "idle", sessionKey: "idle", debrief: null, view: null, recording: null }; refresh();
    expect(canvas().debriefWall?.published).toBe(false); expect(canvas().boardSurfaces?.recognition.heading).toBe("No connected publication"); expect(noNetwork).not.toHaveBeenCalled();
  });
});
