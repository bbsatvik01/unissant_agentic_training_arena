// @vitest-environment jsdom
/** Real route/state tests with only WebGL substituted; CSS pixels need separate browser QA. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import type { PrecinctTheme } from "../components/precinct/PrecinctThemeControl";
import { EX4_TEXT } from "../lib/copy/ex4";
import { CASES, RECORDED_CASE_ID } from "../lib/world/cases";
import { initialTrialState, trialReducer } from "../lib/trial/trialReducer";
import { deriveWorld } from "../lib/world/worldState";
import { LogBuilder, snapshot } from "../test/trial-log";
import type { PrecinctSession, PrecinctSessionOptions } from "./precinct/usePrecinctSession";
import { PrecinctRoute } from "./PrecinctRoute";

type CanvasProps = ComponentProps<typeof PrecinctCanvas>;
const harness = vi.hoisted((): { patch: Partial<PrecinctSession> } => ({ patch: {} }));
vi.mock("./precinct/usePrecinctSession", async () => {
  const original = await vi.importActual<typeof import("./precinct/usePrecinctSession")>("./precinct/usePrecinctSession");
  return { usePrecinctSession(options: PrecinctSessionOptions) { return { ...original.usePrecinctSession(options), ...harness.patch }; } };
});
vi.mock("../components/precinct/PrecinctCanvas", () => ({ default: vi.fn((props: CanvasProps) => <div data-testid="theme-canvas" data-active={props.active} />) }));
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const fetchSpy = vi.fn();

beforeEach(() => {
  harness.patch = {}; vi.clearAllMocks();
  vi.mocked(PrecinctCanvas).mockImplementation((props) => <div data-testid="theme-canvas" data-active={props.active} />);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("fetch", fetchSpy);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (originalScroll === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  for (const [name, original] of [["showModal", originalShow], ["close", originalClose]] as const) {
    if (original === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, original);
  }
});
function canvas(): CanvasProps {
  const value = vi.mocked(PrecinctCanvas).mock.lastCall?.[0];
  if (value === undefined) throw new Error("Expected the existing precinct canvas");
  return value;
}
function root() { const value = document.querySelector(".precinct-root"); if (value === null) throw new Error("Missing precinct root"); return value; }
async function mount() {
  const view = render(<MemoryRouter><PrecinctRoute /></MemoryRouter>);
  await screen.findByTestId("theme-canvas");
  return view;
}
function settings() { fireEvent.click(screen.getByRole("button", { name: "Comfort and accessibility settings" })); }
function close() { fireEvent.click(screen.getByRole("button", { name: "Close panel" })); }
function chooseTheme(theme: PrecinctTheme) { fireEvent.click(screen.getByRole("radio", { name: theme === "studio" ? "Studio" : "Office (original)" })); }
async function enter(theme: PrecinctTheme) {
  await mount(); settings(); chooseTheme(theme); close();
  act(() => { canvas().onReady(); }); fireEvent.click(screen.getByRole("button", { name: "Skip arrival" }));
}
function openStation(hotspot: string) { act(() => { canvas().onInteract(hotspot); }); }

describe("precinct themes", () => {
  it("defaults to Office and changes only presentation before the renderer is ready", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    await mount();
    const renderer = screen.getByTestId("theme-canvas");
    const clock = canvas().interview?.clock;
    const manifest = canvas().manifest;
    expect(root().getAttribute("data-theme")).toBe("office");
    settings(); chooseTheme("studio");
    expect(root().getAttribute("data-theme")).toBe("studio");
    expect(screen.getByTestId("theme-canvas")).toBe(renderer);
    expect(canvas().interview?.clock).toBe(clock);
    expect(canvas().manifest).toBe(manifest);
    expect(canvas().cameraMode).toBe("first");
    expect(canvas().travel.current).toBeNull();
    close();
    expect(screen.getByRole("button", { name: "Preparing the precinct…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Skip arrival" })).toHaveProperty("disabled", true);
    expect(canvas().active).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled(); expect(setItem).not.toHaveBeenCalled(); expect(removeItem).not.toHaveBeenCalled();
  });

  it("retains the choice and earned progress across close, cancel, travel and public-case changes", async () => {
    await enter("studio");
    openStation("reception"); fireEvent.click(screen.getByRole("button", { name: "Check in for this shift" })); close();
    const renderer = screen.getByTestId("theme-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Open precinct map and fast travel" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Case board/ }));
    openStation("case_board");
    const card = CASES.find((item) => item.case_id === RECORDED_CASE_ID);
    if (card === undefined) throw new Error("Expected an existing public case");
    fireEvent.click(screen.getByRole("button", { name: "Select case" }));
    await screen.findByText("Your public packet is ready at your desk."); close();
    const opener = screen.getByRole("button", { name: "Comfort and accessibility settings" }); opener.focus(); settings();
    expect(screen.getByRole("radio", { name: "Studio" })).toHaveProperty("checked", true);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(document.activeElement).toBe(opener);
    expect(screen.queryByRole("dialog")).toBeNull();
    settings(); chooseTheme("office"); close();
    expect(root().getAttribute("data-theme")).toBe("office");
    expect(screen.getByRole("progressbar", { name: "Orientation progress" }).getAttribute("aria-valuenow")).toBe("1");
    openStation("case_board");
    expect(screen.getByRole("button", { name: "Selected case" }).closest("article")?.getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("theme-canvas")).toBe(renderer);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resets to Office only for a new route visit, with no persisted preference", async () => {
    const view = await mount(); settings(); chooseTheme("studio"); close();
    view.unmount(); await mount();
    expect(root().getAttribute("data-theme")).toBe("office"); settings();
    expect(screen.getByRole("radio", { name: "Office (original)" })).toHaveProperty("checked", true);
  });

  it.each(["office", "studio"] as const)("keeps %s navigation, exact safety copy and independent comfort settings", async (theme) => {
    await enter(theme); settings();
    fireEvent.click(screen.getByRole("checkbox", { name: /Larger text/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /High contrast/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Reduced motion/ }));
    const other = theme === "studio" ? "office" : "studio"; chooseTheme(other); chooseTheme(theme);
    expect(root().classList.contains("large-text")).toBe(true);
    expect(root().classList.contains("high-contrast")).toBe(true);
    expect(canvas().reducedMotion).toBe(true); close();
    fireEvent.keyDown(window, { code: "KeyM", key: "m" });
    expect(screen.getByRole("dialog", { name: "Find your way." })).toBeTruthy(); close();
    openStation("reception");
    const dialog = screen.getByRole("dialog", { name: "Reception" });
    expect(within(dialog).getByText(EX4_TEXT)).toBeTruthy();
    expect(within(dialog).getByText("Nervousness, demeanor, accent and stress are never evidence.")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Trust & methodology" }).getAttribute("href")).toBe("/trust/methodology");
    expect(document.querySelector(".precinct-ground-rule")?.textContent).toBe(EX4_TEXT);
    close(); fireEvent.click(screen.getByRole("button", { name: /^Pause/ }));
    expect(canvas().paused).toBe(true); fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(canvas().paused).toBe(false); expect(canvas().active).toBe(true);
    expect(root().getAttribute("data-theme")).toBe(theme);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["office", "studio"] as const)("keeps pending-assessment coaching and recording guards in %s", async (theme) => {
    let state = trialReducer(initialTrialState(), { type: "snapshot", snapshot: snapshot() });
    for (const frame of new LogBuilder().ask().frames) state = trialReducer(state, { type: "frame", frame });
    const world = deriveWorld({ view: state.view, arrivals: new Map(), nowMs: 0, subjectName: "Public subject", investigatorActive: false, reducedMotion: true, paused: false });
    harness.patch = { source: "live", assessmentActive: true, view: state.view, world, selectedCase: CASES[0] ?? null };
    await enter(theme); openStation("observation");
    expect(canvas().interview?.work.assessment).toBe(true); expect(canvas().interview?.work.cards).toBe(0);
    expect(canvas().interview?.cast?.coaches).toEqual([]);
    expect(screen.getByText("Assessment: coaching activity and content are withheld.")).toBeTruthy(); close();
    openStation("interview");
    expect(screen.queryByRole("tab", { name: "Practice coach" })).toBeNull();
    expect(screen.getByText(/Assessment: coaching is withheld here/)).toBeTruthy(); close();
    openStation("debrief_replay");
    expect(screen.getByText(/Recorded runs and review are withheld/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Recorded coached interview · Gemini" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["office", "studio"] as const)("keeps the accessible station fallback and truthful renderer notice in %s", async (theme) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(PrecinctCanvas).mockImplementation(() => { throw new Error("Expected theme test WebGL failure"); });
    render(<MemoryRouter><PrecinctRoute /></MemoryRouter>);
    await screen.findByText("3D rendering is unavailable on this device. Use the map or number keys to visit each station.");
    settings(); chooseTheme(theme); close();
    fireEvent.click(screen.getByRole("button", { name: "Enter the precinct" }));
    fireEvent.keyDown(window, { code: "Digit2", key: "2" }); fireEvent.keyDown(window, { code: "KeyE", key: "e" });
    expect(screen.getByRole("dialog", { name: "Case board" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Original precinct lobby preview" })).toBeTruthy();
    expect(screen.queryByTestId("theme-canvas")).toBeNull();
    expect(document.querySelector(".precinct-ground-rule")?.textContent).toBe(EX4_TEXT);
    expect(root().getAttribute("data-theme")).toBe(theme);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
