// @vitest-environment jsdom
import { useEffect, useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogGamepad } from "./useDialogGamepad";
let frames: Map<number, FrameRequestCallback>, serial: number, heldA: boolean, heldB: boolean, down: boolean;
const padDescriptor = Object.getOwnPropertyDescriptor(navigator, "getGamepads"), visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
function Harness({ close, scope = "Panel" }: { readonly close: () => void; readonly scope?: string }) {
  const dialog = useRef<HTMLDialogElement>(null); useDialogGamepad(dialog, close, scope);
  useEffect(() => { dialog.current?.querySelector("button")?.focus(); }, []);
  return <dialog ref={dialog} open><button type="button" data-gamepad-activate="true">First</button><button type="button" data-gamepad-activate="true">Second</button></dialog>;
}
beforeEach(() => {
  frames = new Map(); serial = 0; heldA = false; heldB = false; down = false;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++serial; frames.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const rects = [new DOMRect(0, 0, 10, 10)]; vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(Object.assign(rects, { item: (index: number) => rects[index] ?? null }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [{ id: "test", index: 0, connected: true, mapping: "standard", axes: [0, 0], buttons: Array.from({ length: 16 }, (_, index) => ({ pressed: index === 0 ? heldA : index === 1 ? heldB : index === 13 && down, touched: false, value: 0 })) }] });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (padDescriptor === undefined) Reflect.deleteProperty(navigator, "getGamepads"); else Object.defineProperty(navigator, "getGamepads", padDescriptor);
  if (visibilityDescriptor === undefined) Reflect.deleteProperty(document, "visibilityState"); else Object.defineProperty(document, "visibilityState", visibilityDescriptor);
});
function frame(time: number) { const callbacks = [...frames.values()]; frames.clear(); act(() => { for (const callback of callbacks) callback(time); }); }
describe("input-only dialog gamepad hook", () => {
  it("ignores the opening held A, then navigates/activates once and cleans up its own poll", () => {
    heldA = true; const close = vi.fn(); const view = render(<Harness close={close} />), click = vi.fn(); screen.getByRole("button", { name: "Second" }).addEventListener("click", click);
    frame(0); frame(1000); expect(click).not.toHaveBeenCalled(); heldA = false; frame(1001);
    down = true; frame(1002); expect(document.activeElement).toBe(screen.getByRole("button", { name: "Second" })); down = false; frame(1003);
    heldA = true; frame(1004); frame(5000); expect(click).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    view.unmount(); expect(frames.size).toBe(0);
  });
  it("does not activate a control whose focus changed between input samples", () => {
    render(<Harness close={vi.fn()} />); frame(0); const button = screen.getByRole("button", { name: "Second" }), click = vi.fn(); button.addEventListener("click", click);
    button.focus(); heldA = true; frame(1); frame(1000); expect(click).not.toHaveBeenCalled();
    heldA = false; frame(1001); heldA = true; frame(1002); expect(click).toHaveBeenCalledOnce();
  });
  it("routes B through the current expansion close and requires neutral before closing the parent dialog", () => {
    const expandedClose = vi.fn(), parentClose = vi.fn(); const view = render(<Harness close={expandedClose} scope="Expanded" />); frame(0); heldB = true; frame(1); expect(expandedClose).toHaveBeenCalledOnce();
    view.rerender(<Harness close={parentClose} scope="Observation" />); frame(2); frame(1000); expect(parentClose).not.toHaveBeenCalled();
    heldB = false; frame(1001); heldB = true; frame(1002); expect(parentClose).toHaveBeenCalledOnce();
  });
  it("resets on blur/visibility and ignores a denied API without changing native keyboard handling", () => {
    const close = vi.fn(); render(<Harness close={close} />); frame(0); act(() => { window.dispatchEvent(new Event("blur")); }); heldB = true; frame(1); expect(close).not.toHaveBeenCalled();
    heldB = false; frame(2); Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); frame(3); heldB = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); frame(4); expect(close).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => { throw new Error("Unavailable"); } }); frame(5); expect(close).not.toHaveBeenCalled();
    const key = vi.fn(); screen.getByRole("button", { name: "First" }).addEventListener("keydown", key); screen.getByRole("button", { name: "First" }).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(key).toHaveBeenCalledOnce();
  });
});
