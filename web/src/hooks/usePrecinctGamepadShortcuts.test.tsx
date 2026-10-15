// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { precinctOwnsShortcuts, usePrecinctGamepadShortcuts } from "./usePrecinctGamepadShortcuts";
let frames: Map<number, FrameRequestCallback>, serial: number, button: number | null;
const gamepadDescriptor = Object.getOwnPropertyDescriptor(navigator, "getGamepads"), visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
function Harness({ enabled = true, pause, camera, map }: { readonly enabled?: boolean; readonly pause: () => void; readonly camera: () => void; readonly map: () => void }) { usePrecinctGamepadShortcuts(enabled, pause, camera, map); return <canvas tabIndex={0} />; }
beforeEach(() => {
  frames = new Map(); serial = 0; button = null; vi.spyOn(document, "hasFocus").mockReturnValue(true); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++serial; frames.set(id, callback); return id; }); vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [{ id: "test", index: 0, connected: true, mapping: "standard", buttons: Array.from({ length: 12 }, (_, index) => ({ pressed: index === button, touched: false, value: 0 })) }] });
});
afterEach(() => {
  cleanup(); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (gamepadDescriptor === undefined) Reflect.deleteProperty(navigator, "getGamepads"); else Object.defineProperty(navigator, "getGamepads", gamepadDescriptor);
  if (visibilityDescriptor === undefined) Reflect.deleteProperty(document, "visibilityState"); else Object.defineProperty(document, "visibilityState", visibilityDescriptor);
});
function tick() { const callbacks = [...frames.values()]; frames.clear(); act(() => { for (const callback of callbacks) callback(0); }); }
describe("route shortcut ownership", () => {
  it("calls only existing callbacks on fresh edges and does not poll while a panel owns the route", () => {
    const pause = vi.fn(), camera = vi.fn(), map = vi.fn(); const view = render(<Harness pause={pause} camera={camera} map={map} />); tick();
    button = 9; tick(); tick(); expect(pause).toHaveBeenCalledOnce(); button = null; tick(); button = 11; tick(); expect(camera).toHaveBeenCalledOnce(); button = null; tick(); button = 8; tick(); expect(map).toHaveBeenCalledOnce();
    view.rerender(<Harness enabled={false} pause={pause} camera={camera} map={map} />); expect(frames.size).toBe(0); view.unmount();
  });
  it("protects native dialogs, focused links/inputs, hidden pages and unfocused windows", () => {
    expect(precinctOwnsShortcuts()).toBe(true);
    for (const html of ['<input>', '<textarea></textarea>', '<a href="/trust">Trust</a>', '<button>Action</button>', '<div tabindex="0" contenteditable="true">Editor</div>']) {
      document.body.innerHTML = html; (document.body.firstElementChild as HTMLElement).focus(); expect(precinctOwnsShortcuts()).toBe(false);
    }
    document.body.innerHTML = '<dialog open></dialog>'; expect(precinctOwnsShortcuts()).toBe(false); document.body.innerHTML = "";
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); expect(precinctOwnsShortcuts()).toBe(false); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    vi.spyOn(document, "hasFocus").mockReturnValue(false); expect(precinctOwnsShortcuts()).toBe(false);
  });
  it("re-arms after blur and tolerates unavailable controller APIs", () => {
    const pause = vi.fn(), camera = vi.fn(), map = vi.fn(); render(<Harness pause={pause} camera={camera} map={map} />); tick();
    act(() => { window.dispatchEvent(new Event("blur")); }); button = 9; tick(); expect(pause).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => { throw new Error("Denied"); } }); tick(); expect(pause).not.toHaveBeenCalled();
  });
});
