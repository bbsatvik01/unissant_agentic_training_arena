/** Native-dialog adapter. Never synthesizes Enter, submit, text input, or a world/replay tick. */
import type { DialogDirection, DialogPadAction } from "./dialogGamepad";

const CONTROLS = "button,a[href],input:not([type=hidden]),select,textarea,summary,[tabindex],[contenteditable=true]";
export function visibleDialogControl(element: HTMLElement): boolean {
  if (element.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]') !== null || element.matches(":disabled")) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && element.getClientRects().length > 0;
}
export function dialogControls(dialog: HTMLDialogElement): readonly HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(CONTROLS)].filter((element) => element.tabIndex >= 0 && visibleDialogControl(element));
}
export function editingDialogText(element: HTMLElement): boolean {
  return element.closest('textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]') !== null
    || element instanceof HTMLInputElement && !["checkbox", "radio", "range", "button", "submit", "reset", "file", "hidden"].includes(element.type);
}
/** Fresh A uses the existing click/submit/confirmation path; no Enter or submit is synthesized on focus. */
export function activateDialogControl(element: HTMLElement): boolean {
  if (!visibleDialogControl(element) || editingDialogText(element) || element.closest('[data-gamepad-activate="false"]') !== null) return false;
  if (element instanceof HTMLButtonElement) {
    // Deliberate focused activation includes normal form/session buttons. Existing confirmations still own consent.
  } else if (element instanceof HTMLInputElement) {
    if (!["checkbox", "radio", "button", "submit", "reset"].includes(element.type)) return false;
  } else if (element instanceof HTMLAnchorElement) {
    const url = new URL(element.href, document.baseURI);
    if (url.origin !== location.origin || !["http:", "https:"].includes(url.protocol) || element.hasAttribute("download") || (element.target !== "" && element.target !== "_self")) return false;
  } else if (element.tagName !== "SUMMARY") return false;
  element.click(); return true;
}
function arrowKey(direction: DialogDirection): string { return { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[direction]; }
function widgetArrow(element: HTMLElement, direction: DialogDirection): boolean {
  const horizontal = direction === "left" || direction === "right";
  const role = element.getAttribute("role");
  const tabVertical = element.closest('[role="tablist"]')?.getAttribute("aria-orientation") === "vertical";
  const tabArrow = role === "tab" && (tabVertical ? !horizontal : horizontal);
  const rangeArrow = element instanceof HTMLInputElement && element.type === "range" && horizontal;
  if (!tabArrow && !rangeArrow && role !== "slider") return false;
  const event = new KeyboardEvent("keydown", { key: arrowKey(direction), code: arrowKey(direction), bubbles: true, cancelable: true });
  if (!element.dispatchEvent(event)) return true; // Respect the widget's existing React keyboard semantics.
  if (!rangeArrow || !(element instanceof HTMLInputElement) || element.readOnly || element.getAttribute("aria-readonly") === "true") return false;
  const value = Number(element.value), min = element.min === "" ? 0 : Number(element.min), max = element.max === "" ? 100 : Number(element.max), step = element.step === "" ? 1 : Number(element.step);
  if (![value, min, max, step].every(Number.isFinite) || step <= 0 || max < min) return false;
  const next = Math.min(max, Math.max(min, value + (direction === "right" ? step : -step)));
  if (next !== value) {
    // Use the native setter so React observes this value change through its existing input/change handler.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (descriptor?.set === undefined) return false;
    descriptor.set.call(element, String(next));
    element.dispatchEvent(new Event("input", { bubbles: true })); element.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
}
export function moveDialogFocus(dialog: HTMLDialogElement, direction: DialogDirection): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLElement && dialog.contains(active)) {
    if (editingDialogText(active)) return false;
    if (visibleDialogControl(active) && widgetArrow(active, direction)) return true;
  }
  const controls = dialogControls(dialog); if (controls.length === 0) return false;
  const index = controls.findIndex((element) => element === active), backwards = direction === "up" || direction === "left";
  const next = index < 0 ? backwards ? controls.length - 1 : 0 : (index + (backwards ? -1 : 1) + controls.length) % controls.length;
  controls[next]?.focus(); return true;
}
export function dialogOwnsController(dialog: HTMLDialogElement): boolean {
  return dialog.open && visibleDialogControl(dialog) && document.visibilityState === "visible" && document.hasFocus()
    && document.querySelectorAll("dialog[open]").length === 1 && dialog.contains(document.activeElement);
}
export function applyDialogPadAction(dialog: HTMLDialogElement, action: DialogPadAction, close: () => void): boolean {
  if (!dialogOwnsController(dialog)) return false;
  if (action.type === "close") { close(); return true; }
  if (action.type === "move") return moveDialogFocus(dialog, action.direction);
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== dialog && dialog.contains(active) ? activateDialogControl(active) : false;
}
