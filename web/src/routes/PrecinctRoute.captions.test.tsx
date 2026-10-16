// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import { STATIONS } from "../components/precinct/sceneTypes";
import type { PrecinctSession, PrecinctSessionOptions } from "./precinct/usePrecinctSession";
import { PrecinctRoute } from "./PrecinctRoute";

type CanvasProps = ComponentProps<typeof PrecinctCanvas>;
const harness = vi.hoisted((): { patch: Partial<PrecinctSession> } => ({ patch: {} }));
vi.mock("./precinct/usePrecinctSession", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctSession")>("./precinct/usePrecinctSession");
  return { usePrecinctSession(options: PrecinctSessionOptions) { return { ...original.usePrecinctSession(options), ...harness.patch }; } };
});
vi.mock("../components/precinct/PrecinctCanvas", () => ({ default: vi.fn((props: CanvasProps) => <div data-testid="precinct-canvas" data-active={props.active} />) }));
const fetchSpy = vi.fn();
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  harness.patch = {}; vi.clearAllMocks(); vi.stubGlobal("matchMedia", () => ({ matches: true })); vi.stubGlobal("fetch", fetchSpy);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const [name, original] of [["showModal", originalShow], ["close", originalClose]] as const) {
    if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, original);
  }
});
function canvas() { const value = vi.mocked(PrecinctCanvas).mock.lastCall?.[0]; if (value === undefined) throw new Error("Missing canvas"); return value; }
async function enter() {
  render(<MemoryRouter><PrecinctRoute /></MemoryRouter>); await screen.findByTestId("precinct-canvas");
  act(() => { canvas().onReady(); }); fireEvent.click(screen.getByRole("button", { name: "Skip arrival" }));
}
function openInterview() { act(() => { canvas().onPose({ position: STATIONS[5].anchor, yaw: 0, speed: 0, hotspot: "interview" }); canvas().onInteract("interview"); }); }
const publicCaption = { role: "subject" as const, speaker: "Jordan Pell", text: "Exact public read-aloud text.", label: "Read-aloud · synthesized speech" };

describe("precinct caption placement", () => {
  it("keeps one readable caption on the evidence tab, in other modals, and while controls are closed", async () => {
    harness.patch = { speechCaption: publicCaption }; await enter();
    const caption = screen.getByRole("status", { name: "Speech caption" });
    expect(caption.closest(".precinct-conversation-hud")).not.toBeNull();
    expect(screen.getByRole("status", { name: "Capture status" }).closest(".precinct-conversation-hud")).not.toBeNull();
    openInterview();
    expect(screen.getByRole("group", { name: "Speech caption" })).toBe(caption);
    expect(caption.closest("dialog")).toBe(screen.getByRole("dialog"));
    expect(screen.getAllByRole("status", { name: "Capture status" })).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Capture status" }).closest("dialog")).toBe(screen.getByRole("dialog"));
    expect(screen.queryByRole("status", { name: "Speech caption" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Evidence table" }));
    expect(screen.getAllByRole("status", { name: "Speech caption" })).toEqual([caption]);
    expect(screen.queryByRole("log")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.getByRole("status", { name: "Speech caption" })).toBe(caption);
    fireEvent.click(screen.getByRole("button", { name: "Comfort and accessibility settings" }));
    expect(screen.getByRole("status", { name: "Speech caption" })).toBe(caption);
    expect(caption.closest("dialog")).toBe(screen.getByRole("dialog"));
    expect(screen.getAllByRole("status", { name: "Capture status" })).toHaveLength(1);
    expect(screen.getByRole("status", { name: "Capture status" }).closest("dialog")).toBe(screen.getByRole("dialog"));
    fireEvent.click(screen.getByLabelText(/Larger text/));
    expect(screen.getAllByRole("status", { name: "Speech caption" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Open precinct map and fast travel" }));
    expect(screen.getByRole("status", { name: "Speech caption" })).toBe(caption);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("withholds a stale coach even during pending assessment and never turns draft text into speech", async () => {
    harness.patch = { assessmentActive: true, speechCaption: { ...publicCaption, role: "coach", text: "Old private practice suggestion." }, draft: "Arbitrary unsent trainee draft." };
    await enter();
    expect(screen.queryByText("Old private practice suggestion.")).toBeNull();
    expect(screen.queryByRole("status", { name: "Speech caption" })).toBeNull();
    openInterview(); fireEvent.click(screen.getByRole("tab", { name: "Evidence table" }));
    expect(screen.queryByText("Old private practice suggestion.")).toBeNull();
    expect(document.querySelector(".precinct-speech-caption")?.textContent).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
