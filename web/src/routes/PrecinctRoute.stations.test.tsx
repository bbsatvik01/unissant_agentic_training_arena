// @vitest-environment jsdom
/** Route integration regressions. The existing single renderer is mocked; station controllers stay real. */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import { STATIONS } from "../components/precinct/sceneTypes";
import { CASES, RECORDED_CASE_ID } from "../lib/world/cases";
import { EX4_TEXT } from "../lib/copy/ex4";
import type { PrecinctSession, PrecinctSessionOptions } from "./precinct/usePrecinctSession";
import type { PrecinctStationsOptions } from "./precinct/usePrecinctStations";
import { PrecinctRoute } from "./PrecinctRoute";
const noNetwork = vi.fn();

type CanvasProps = ComponentProps<typeof PrecinctCanvas>;
const harness = vi.hoisted((): { patch: Partial<PrecinctSession>; latest: PrecinctSession | null; discard: ReturnType<typeof vi.fn<() => void>>; pauseDrill: ReturnType<typeof vi.fn<() => void>> } => ({ patch: {}, latest: null, discard: vi.fn<() => void>(), pauseDrill: vi.fn<() => void>() }));
vi.mock("./precinct/usePrecinctSession", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctSession")>("./precinct/usePrecinctSession");
  return { usePrecinctSession(options: PrecinctSessionOptions) { const session = original.usePrecinctSession(options); harness.latest = session; return { ...session, ...harness.patch }; } };
});
vi.mock("./precinct/usePrecinctStations", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctStations")>("./precinct/usePrecinctStations");
  return { usePrecinctStations(options: PrecinctStationsOptions) { const stations = original.usePrecinctStations(options); return { ...stations, pauseDrill: () => { harness.pauseDrill(); stations.pauseDrill(); } }; } };
});
vi.mock("./precinct/usePrecinctNotebook", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctNotebook")>("./precinct/usePrecinctNotebook");
  return { usePrecinctNotebook(options: Parameters<typeof original.usePrecinctNotebook>[0]) { const notebook = original.usePrecinctNotebook(options); return { ...notebook, discardPreparation: () => { harness.discard(); notebook.discardPreparation(); } }; } };
});
vi.mock("../components/precinct/PrecinctCanvas", () => ({ default: vi.fn((props: CanvasProps) => <div data-testid="station-renderer" data-active={props.active} />) }));
const showModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  harness.patch = {}; harness.latest = null; vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("fetch", noNetwork);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  for (const [name, original] of [["showModal", showModal], ["close", close]] as const) { if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name); else Object.defineProperty(HTMLDialogElement.prototype, name, original); }
});
function canvas() { const props = vi.mocked(PrecinctCanvas).mock.lastCall?.[0]; if (props === undefined) throw new Error("Renderer not mounted"); return props; }
async function enter() {
  render(<MemoryRouter><PrecinctRoute /></MemoryRouter>); await screen.findByTestId("station-renderer");
  act(() => { canvas().onReady(); }); fireEvent.click(screen.getByRole("button", { name: "Skip arrival" }));
}
function open(panel: string) { act(() => { canvas().onInteract(panel); }); }
async function choose() {
  open("case_board"); fireEvent.click(screen.getByRole("button", { name: "Select case" }));
  await screen.findByText("Your public packet is ready at your desk."); fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
}
function refresh(patch: Partial<PrecinctSession>) {
  harness.patch = { ...harness.patch, ...patch };
  const interview = STATIONS[5];
  act(() => { canvas().onPose({ position: interview.anchor, yaw: 0, speed: 0, hotspot: "interview" }); });
}
const profile: NonNullable<PrecinctSession["me"]> = { user_id: "station-route-user", display_name: "Trainee", roles: [], ex4_acknowledged: "2026-10-15T09:00:00Z", study: null, console: false, csrf_token: "test-token" };

describe("training stations inside the precinct route", () => {
  it("uses exact hotspots before room fallbacks, one session/canvas/dialog, and no offline probes", async () => {
    await enter();
    for (const [panel, title, expected] of [
      ["case_board", "Case board", "PUBLIC CASE FILES"],
      ["instructor", "Instructor workspace", "Instructor access is not connected"],
      ["coach_lab", "Coach Lab", "Coach Lab is not connected"],
      ["trophies", "Trophy wall", "No local tournament source is connected."],
      ["archive", "Training archive", "Bundled demonstration tapes"],
      ["training_progress", "Your five skills", "FIVE SKILLS · ONE EVIDENCE-LED PRACTICE"],
      ["daily_drill", "Three-minute warm-up", "Choose a public case before beginning"],
      ["methodology", "Trust & methodology", "Know what the measures mean."],
    ]) {
      if (panel === undefined || title === undefined || expected === undefined) throw new Error("Invalid route test row");
      open(panel); expect(screen.getByRole("dialog", { name: title })).toBeTruthy();
      expect(screen.getByText(expected, { exact: false })).toBeTruthy();
      expect(screen.getAllByTestId("station-renderer")).toHaveLength(1); expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(canvas().active).toBe(false); expect(screen.queryByRole("link", { name: /Open training session/ })).toBeNull();
      expect(screen.getAllByText(EX4_TEXT).length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: "Close panel" })); expect(canvas().active).toBe(true);
    }
    expect(noNetwork).not.toHaveBeenCalled(); expect(harness.latest?.source).toBe("idle");
  });
  it("keeps offline metadata as previews and uses the existing explicit case selection wrapper", async () => {
    await enter(); open("case_board");
    expect(screen.getAllByRole("button", { name: "Select case" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Session unavailable" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Session unavailable" })[0] as HTMLButtonElement);
    expect(harness.latest?.selectedCase).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select case" })); await screen.findByText("Your public packet is ready at your desk.");
    expect(harness.latest?.selectedCase?.case_id).toBe(RECORDED_CASE_ID); expect(harness.latest?.source).toBe("idle");
    expect(screen.getByRole("progressbar", { name: "Orientation progress" }).getAttribute("aria-valuenow")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Go to your desk" }));
    expect(canvas().travel.current?.position).toEqual(STATIONS[3].anchor); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens the requested primer through records without granting a score or another modal", async () => {
    await enter(); open("archive");
    fireEvent.click(screen.getByRole("button", { name: "Your five skills" }));
    expect(screen.getByRole("dialog", { name: "Your five skills" })).toBeTruthy(); expect(screen.getAllByText("Not measured")).toHaveLength(5);
    fireEvent.click(screen.getAllByRole("button", { name: /Read the technique primer/ })[3] as HTMLButtonElement);
    expect(screen.getByRole("dialog", { name: "Training archive" })).toBeTruthy();
    expect(screen.getByText("testing alternative explanations").closest("details")?.open).toBe(true);
    expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(noNetwork).not.toHaveBeenCalled();
  });
  it("keeps warm-up notes across close/reopen, excludes paused time, and pauses on visibility loss", async () => {
    await enter(); await choose();
    vi.useFakeTimers(); let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    open("daily_drill");
    fireEvent.change(screen.getByLabelText("Your neutral opening question"), { target: { value: "What record can check the time?" } });
    fireEvent.click(screen.getByRole("button", { name: "Start 3-minute warm-up" }));
    now = 1000; act(() => { vi.advanceTimersByTime(250); });
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    now = 10_000; act(() => { vi.advanceTimersByTime(5000); }); open("daily_drill");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your neutral opening question" }).value).toBe("What record can check the time?");
    expect(screen.getByLabelText("2:59 remaining")).toBeTruthy(); expect(screen.getByRole("button", { name: "Resume timer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume timer" })); now = 11_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.getByRole("button", { name: "Resume timer" })).toBeTruthy(); expect(screen.getByLabelText("2:58 remaining")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Orientation progress" }).getAttribute("aria-valuenow")).toBe("0");
  });
  it("pauses the drill only after canonical start guards accept an assessment, before the session call", async () => {
    const startInterview = vi.fn(); harness.patch = { backend: "connected", me: profile, canStart: false, modes: ["assessment"], startInterview };
    await enter(); await choose(); open("interview");
    fireEvent.click(screen.getByRole("button", { name: "Start assessment" })); expect(startInterview).not.toHaveBeenCalled(); expect(harness.pauseDrill).not.toHaveBeenCalled();
    refresh({ canStart: true }); fireEvent.click(screen.getByRole("button", { name: "Start assessment" }));
    expect(startInterview).toHaveBeenCalledWith("assessment"); expect(harness.pauseDrill).toHaveBeenCalledOnce();
    expect(harness.pauseDrill.mock.invocationCallOrder[0]).toBeLessThan(startInterview.mock.invocationCallOrder[0] ?? 0);
  });
  it("uses the guarded recording handoff before explicit archive playback and opens the existing theater", async () => {
    const load = vi.fn(() => Promise.resolve()); harness.patch = { loadCoachedRecording: load };
    await enter(); await choose(); open("archive");
    expect(load).not.toHaveBeenCalled(); expect(harness.discard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load Recorded coached interview · Gemini" }));
    expect(load).toHaveBeenCalledOnce(); expect(harness.discard).toHaveBeenCalledOnce(); expect(harness.pauseDrill).toHaveBeenCalledOnce();
    expect(harness.discard.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0] ?? 0);
    expect(screen.getByRole("dialog", { name: "Replay theater" })).toBeTruthy(); expect(screen.getAllByTestId("station-renderer")).toHaveLength(1);
    expect(harness.latest?.playback.playing).toBe(false); expect(noNetwork).not.toHaveBeenCalled();
  });
  it("uses only the centralized assessment flag to block prior resources and case changes", async () => {
    const load = vi.fn(() => Promise.resolve()); harness.patch = { assessmentActive: true, loadCoachedRecording: load, selectedCase: CASES[0] ?? null };
    await enter();
    for (const id of ["archive", "instructor", "coach_lab", "training_progress", "trophies", "daily_drill"]) {
      open(id); expect(screen.getByText("Training resources and prior-session feedback are unavailable during an assessment. They return after the published debrief.").getAttribute("role")).toBe("status");
      expect(screen.queryByRole("button", { name: /Load Recorded coached interview/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    }
    open("case_board"); expect(screen.getByText("Case changes are unavailable during an assessment.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Selected case|Select case|Session unavailable/ }).every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(load).not.toHaveBeenCalled(); expect(noNetwork).not.toHaveBeenCalled();
  });
  it("clears local time and drafts on an actual new case instead of reattaching another case's answer", async () => {
    await enter(); await choose(); open("daily_drill");
    fireEvent.change(screen.getByLabelText("Your neutral opening question"), { target: { value: "For this case only" } });
    refresh({ selectedCase: CASES.find((card) => card.case_id !== RECORDED_CASE_ID) ?? null });
    await waitFor(() => { expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Your neutral opening question" }).value).toBe(""); });
    expect(screen.getByLabelText("3:00 remaining")).toBeTruthy();
  });
});
