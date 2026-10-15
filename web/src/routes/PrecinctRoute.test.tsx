// @vitest-environment jsdom
/** Route/UI contract tests. WebGL is mocked here; real renderer smoke tests are separate. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import PrecinctCanvas from "../components/precinct/PrecinctCanvas";
import { STATIONS } from "../components/precinct/sceneTypes";
import { EX4_TEXT } from "../lib/copy/ex4";
import { PrecinctRoute } from "./PrecinctRoute";

type CanvasProps = ComponentProps<typeof PrecinctCanvas>;
vi.mock("../components/precinct/PrecinctCanvas", () => ({
  default: vi.fn((props: CanvasProps) => <div data-testid="precinct-renderer" data-active={props.active} />),
}));

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
let prefersReducedMotion = false;

beforeEach(() => {
  prefersReducedMotion = false;
  vi.clearAllMocks();
  vi.mocked(PrecinctCanvas).mockImplementation((props) => <div data-testid="precinct-renderer" data-active={props.active} />);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: prefersReducedMotion, media: query }));
  // JSDOM does not implement the browser's dialog top layer. Keep its open/accessible contract.
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalShowModal === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  else Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
});

function canvas(): CanvasProps {
  const props = vi.mocked(PrecinctCanvas).mock.lastCall?.[0];
  if (props === undefined) throw new Error("The lazy precinct renderer has not mounted");
  return props;
}

async function mount() {
  render(<MemoryRouter><PrecinctRoute /></MemoryRouter>);
  await screen.findByTestId("precinct-renderer");
}

async function enter(skip = false) {
  await mount();
  act(() => { canvas().onReady(); });
  fireEvent.click(screen.getByRole("button", { name: skip ? "Skip arrival" : "Enter the precinct" }));
  expect(screen.getByRole("heading", { name: "Check in at reception" })).toBeTruthy();
}

function key(code: string, value?: string, target: HTMLElement | Window = window) {
  fireEvent.keyDown(target, { code, key: value ?? code });
}

function pauseInFreeCamera() {
  fireEvent.click(screen.getByRole("button", { name: /^Pause/ }));
  key("KeyV"); key("KeyV");
  expect(canvas().paused).toBe(true);
  expect(canvas().cameraMode).toBe("free");
}

describe("PrecinctRoute orientation", () => {
  it("keeps arrival disabled until the actual renderer reports readiness", async () => {
    await mount();
    expect(screen.getByRole("heading", { name: "Start your shift." })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Preparing the precinct/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Skip arrival" }).hasAttribute("disabled")).toBe(true);
    expect(canvas().active).toBe(false);
    expect(canvas().travel.current).toBeNull();
    key("KeyM"); key("KeyV"); key("Digit2", "2");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(canvas().cameraMode).toBe("first");
    act(() => { canvas().onReady(); });
    expect(screen.getByRole("button", { name: "Enter the precinct" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Skip arrival" }).hasAttribute("disabled")).toBe(false);
  });

  it("starts normal arrival as a walking command and preserves the exact ground rule", async () => {
    await enter();
    expect(canvas().active).toBe(true);
    expect(canvas().travel.current).toEqual({ position: [0, 0, -4.2], yaw: 0, instant: false });
    expect(screen.queryByRole("heading", { name: "Start your shift." })).toBeNull();
    expect(document.querySelector(".precinct-ground-rule")?.textContent).toBe(EX4_TEXT);
    expect(screen.getByRole("button", { name: "Open precinct map and fast travel" })).toBeTruthy();
  });

  it("respects reduced-motion preference by entering instantly", async () => {
    prefersReducedMotion = true;
    await enter();
    expect(canvas().reducedMotion).toBe(true);
    expect(canvas().travel.current?.instant).toBe(true);
  });

  it("can skip arrival without queuing a movement command", async () => {
    await enter(true);
    expect(canvas().travel.current).toBeNull();
    expect(canvas().active).toBe(true);
  });
});

describe("PrecinctRoute map and travel", () => {
  it("lists every authored station, fast-travels, and supports repeated map open/close", async () => {
    await enter(true);
    fireEvent.click(screen.getByRole("button", { name: "Open precinct map and fast travel" }));
    const dialog = screen.getByRole("dialog", { name: "Find your way." });
    expect(canvas().active).toBe(false);
    for (const station of STATIONS) expect(within(dialog).getByText(station.label)).toBeTruthy();
    const destination = STATIONS[8];
    fireEvent.click(within(dialog).getByRole("button", { name: /Coach Lab/ }));
    expect(canvas().travel.current).toEqual({ position: destination.anchor, yaw: destination.yaw, instant: true });
    expect(canvas().active).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    key("KeyM");
    expect(screen.getByRole("dialog", { name: "Find your way." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    key("KeyM");
    const reopened = screen.getByRole("dialog", { name: "Find your way." });
    fireEvent(reopened, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(canvas().active).toBe(true);
  });

  it.each(STATIONS)("number key $key travels to $label", async (station) => {
    await enter(true);
    key(`Digit${station.key}`, station.key);
    expect(canvas().travel.current).toEqual({ position: station.anchor, yaw: station.yaw, instant: true });
    expect(canvas().paused).toBe(false);
  });

  it("ignores repeated shortcuts and keys originating inside a settings input", async () => {
    await enter(true);
    fireEvent.keyDown(window, { code: "KeyM", repeat: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Comfort and accessibility settings" }));
    const input = screen.getByRole("checkbox", { name: /Reduced motion/ });
    key("KeyV", "v", input); key("Digit2", "2", input); key("KeyM", "m", input);
    expect(canvas().cameraMode).toBe("first");
    expect(canvas().travel.current).toBeNull();
    expect(screen.getByRole("dialog", { name: "Make yourself comfortable." })).toBeTruthy();
  });
});

describe("PrecinctRoute accessibility and cameras", () => {
  it("applies comfort controls to the renderer and readable interface", async () => {
    await enter(true);
    fireEvent.click(screen.getByRole("button", { name: "Comfort and accessibility settings" }));
    expect(canvas().active).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /Reduced motion/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Larger text/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /High contrast/ }));
    fireEvent.change(screen.getByRole("combobox", { name: /Rendering quality/ }), { target: { value: "low" } });
    expect(canvas().reducedMotion).toBe(true);
    expect(canvas().tier).toBe("low");
    expect(document.querySelector(".precinct-root")?.classList.contains("large-text")).toBe(true);
    expect(document.querySelector(".precinct-root")?.classList.contains("high-contrast")).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: /Rendering quality/ }), { target: { value: "high" } });
    expect(canvas().tier).toBe("high");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(canvas().active).toBe(true);
    expect(document.querySelector(".precinct-ground-rule")?.textContent).toBe(EX4_TEXT);
  });

  it("cycles first/third during play and adds free camera only while paused", async () => {
    await enter(true);
    key("KeyV"); expect(canvas().cameraMode).toBe("third");
    key("KeyV"); expect(canvas().cameraMode).toBe("first");
    pauseInFreeCamera();
    expect(screen.getByText("EXPLORATION PAUSED")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(canvas().paused).toBe(false);
    expect(canvas().cameraMode).toBe("first");
    expect(screen.queryByText("EXPLORATION PAUSED")).toBeNull();
  });

  it.each(["pause button", "Escape", "fast travel"] as const)("normalizes paused free camera when resuming with %s", async (method) => {
    await enter(true);
    pauseInFreeCamera();
    if (method === "pause button") fireEvent.click(screen.getByRole("button", { name: /^Resume exploration/ }));
    else if (method === "Escape") key("Escape");
    else key("Digit1", "1");
    expect(canvas().paused).toBe(false);
    expect(canvas().cameraMode).toBe("first");
  });
});

describe("PrecinctRoute stations", () => {
  it("shows proximity interaction, pauses it in panels, and preserves safe tool links", async () => {
    await enter(true);
    act(() => { canvas().onPose({ position: [-6.2, 0, -5.7], yaw: 0, speed: 0, hotspot: "reception" }); });
    fireEvent.click(screen.getByRole("button", { name: /E\s*Reception/ }));
    const dialog = screen.getByRole("dialog", { name: "Reception" });
    expect(canvas().active).toBe(false);
    expect(within(dialog).getByRole("link", { name: /Open training session/ }).getAttribute("href")).toBe("/session");
    expect(within(dialog).getByRole("link", { name: "Trust & methodology" }).getAttribute("href")).toBe("/trust/methodology");
    expect(within(dialog).getByText("Nervousness, demeanor, accent and stress are never evidence.")).toBeTruthy();
    expect(within(dialog).getByText(EX4_TEXT)).toBeTruthy();
    expect(document.querySelector(".precinct-ground-rule")?.textContent).toBe(EX4_TEXT);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close panel" }));
    expect(canvas().active).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Pause/ }));
    expect(screen.queryByRole("button", { name: /E\s*Reception/ })).toBeNull();
  });

  it("opens a station from the renderer callback and closes it without stale modal state", async () => {
    await enter(true);
    act(() => { canvas().onInteract("case_board"); });
    expect(screen.getByRole("dialog", { name: "Case board" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    act(() => { canvas().onInteract("reception"); });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Reception" })).toBeTruthy();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(canvas().active).toBe(true);
  });
});

describe("PrecinctRoute renderer fallback", () => {
  it("keeps the directory and stations usable after WebGL failure without pretending 3D is running", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(PrecinctCanvas).mockImplementation(() => { throw new Error("Simulated unavailable WebGL context"); });
    try {
      render(<MemoryRouter><PrecinctRoute /></MemoryRouter>);
      expect(await screen.findByRole("status")).toHaveProperty("textContent", "3D rendering is unavailable on this device. Use the map or number keys to visit each station.");
      expect(screen.getByRole("img", { name: "Original precinct lobby preview" })).toBeTruthy();
      expect(screen.queryByTestId("precinct-renderer")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Enter the precinct" }));
      expect(screen.getByText("Visit a station")).toBeTruthy();
      key("Digit2", "2");
      key("KeyE");
      expect(screen.getByRole("dialog", { name: "Case board" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
      fireEvent.click(screen.getByRole("button", { name: /^Pause/ }));
      key("KeyE");
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      fireEvent.click(screen.getByRole("button", { name: "Open precinct map and fast travel" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Reception/ }));
      expect(screen.getByRole("button", { name: /E\s*Reception/ })).toBeTruthy();
      expect(document.querySelector(".precinct-ground-rule")?.textContent).toBe(EX4_TEXT);
    } finally {
      consoleError.mockRestore();
    }
  });
});
