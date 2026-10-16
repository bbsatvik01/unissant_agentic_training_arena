// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateDialogControl, applyDialogPadAction, dialogControls, dialogOwnsController, editingDialogText, moveDialogFocus } from "./dialogNavigation";
let dialog: HTMLDialogElement;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
beforeEach(() => {
  document.body.innerHTML = '<dialog open tabindex="-1"><button id="first" data-gamepad-activate="true">First</button><button id="last" type="button">Last</button></dialog>';
  const found = document.querySelector("dialog"); if (found === null) throw new Error("Missing test dialog"); dialog = found;
  const rects = [new DOMRect(0, 0, 10, 10)]; vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(Object.assign(rects, { item: (index: number) => rects[index] ?? null }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  control("first").focus();
});
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); if (originalVisibility === undefined) Reflect.deleteProperty(document, "visibilityState"); else Object.defineProperty(document, "visibilityState", originalVisibility); });
function control(id: string): HTMLElement { const value = document.getElementById(id); if (value === null) throw new Error(`Missing ${id}`); return value; }
describe("native dialog controller actions", () => {
  it("traverses enabled visible controls and wraps without including roving inactive tabs", () => {
    dialog.insertAdjacentHTML("beforeend", '<button hidden>Hidden</button><div inert><button>Inert</button></div><button disabled>Disabled</button><button aria-disabled="true">ARIA</button><button style="display:none">None</button><button tabindex="-1">Roving</button><fieldset disabled><button>Fieldset</button></fieldset>');
    expect(dialogControls(dialog).map((node) => node.id)).toEqual(["first", "last"]);
    expect(moveDialogFocus(dialog, "down")).toBe(true); expect(document.activeElement).toBe(control("last"));
    moveDialogFocus(dialog, "right"); expect(document.activeElement).toBe(control("first"));
    moveDialogFocus(dialog, "up"); expect(document.activeElement).toBe(control("last"));
    dialog.focus(); moveDialogFocus(dialog, "left"); expect(document.activeElement).toBe(control("last"));
    dialog.replaceChildren(); expect(moveDialogFocus(dialog, "down")).toBe(false);
  });
  it("uses explicit focused click for ordinary and form buttons, preserving native confirmation handlers", () => {
    const clicked = vi.fn(); control("first").addEventListener("click", clicked); expect(activateDialogControl(control("first"))).toBe(true); expect(clicked).toHaveBeenCalledOnce();
    dialog.insertAdjacentHTML("beforeend", '<input id="check" type="checkbox"><form id="form"><button id="submit">Submit</button></form><button id="connect" type="button">Connect local backend</button>');
    const submit = vi.fn((event: SubmitEvent) => { event.preventDefault(); }); control("form").addEventListener("submit", submit);
    expect(activateDialogControl(control("submit"))).toBe(true); expect(submit).toHaveBeenCalledOnce();
    expect(activateDialogControl(control("check"))).toBe(true); expect((control("check") as HTMLInputElement).checked).toBe(true);
    const confirmation = vi.fn((event: MouseEvent) => { event.preventDefault(); }); control("connect").addEventListener("click", confirmation);
    expect(activateDialogControl(control("connect"))).toBe(true); expect(confirmation).toHaveBeenCalledOnce();
  });
  it("leaves native file, external-window/download and explicitly blocked controls alone", () => {
    dialog.insertAdjacentHTML("beforeend", '<button id="blocked" data-gamepad-activate="false">Blocked action</button><input id="file" type="file"><a id="download" download href="/file.json">Download</a><a id="external" href="https://example.com">External</a><a id="new-tab" target="_blank" href="/trust/methodology">New tab</a>');
    for (const id of ["blocked", "file", "download", "external", "new-tab"]) expect(activateDialogControl(control(id))).toBe(false);
  });
  it("never edits focused text/select/contenteditable fields or synthesizes Enter", () => {
    dialog.insertAdjacentHTML("beforeend", '<textarea id="text">Keep this draft</textarea><input id="password" type="password" value="unchanged"><select id="select"><option>First</option></select><div id="editor" contenteditable="true" tabindex="0">Draft</div>');
    for (const id of ["text", "password", "select", "editor"]) {
      const element = control(id), key = vi.fn(); element.addEventListener("keydown", key); element.focus();
      expect(editingDialogText(element)).toBe(true); expect(moveDialogFocus(dialog, "right")).toBe(false); expect(activateDialogControl(element)).toBe(false); expect(key).not.toHaveBeenCalled();
    }
    expect((control("text") as HTMLTextAreaElement).value).toBe("Keep this draft");
  });
  it("delegates tab arrows to the existing handler and leaves native keyboard listeners intact", () => {
    dialog.insertAdjacentHTML("beforeend", '<div role="tablist"><button id="tab" role="tab">Tab</button></div>'); const tab = control("tab");
    const key = vi.fn((event: KeyboardEvent) => { event.preventDefault(); }); tab.addEventListener("keydown", key); tab.focus();
    expect(moveDialogFocus(dialog, "right")).toBe(true); expect(key.mock.calls[0]?.[0].key).toBe("ArrowRight"); expect(document.activeElement).toBe(tab);
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); expect(key).toHaveBeenCalledTimes(2);
    moveDialogFocus(dialog, "down"); expect(document.activeElement).toBe(control("first"));
  });
  it("changes a native range by its supplied step through input events and preserves bounds", () => {
    dialog.insertAdjacentHTML("beforeend", '<input id="range" type="range" min="0" max="1000" step="250" value="0">'); const range = control("range") as HTMLInputElement; const input = vi.fn(); range.addEventListener("input", input); range.focus();
    expect(moveDialogFocus(dialog, "right")).toBe(true); expect(range.value).toBe("250"); expect(input).toHaveBeenCalledOnce();
    moveDialogFocus(dialog, "left"); expect(range.value).toBe("0"); moveDialogFocus(dialog, "left"); expect(range.value).toBe("0"); expect(input).toHaveBeenCalledTimes(2);
    moveDialogFocus(dialog, "down"); expect(document.activeElement).toBe(control("first"));
  });
  it("ignores hidden/background/unfocused and multiple dialogs, and B uses only existing close", () => {
    const close = vi.fn(); expect(dialogOwnsController(dialog)).toBe(true); expect(applyDialogPadAction(dialog, { type: "close" }, close)).toBe(true); expect(close).toHaveBeenCalledOnce();
    vi.spyOn(document, "hasFocus").mockReturnValue(false); expect(applyDialogPadAction(dialog, { type: "close" }, close)).toBe(false); vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); expect(dialogOwnsController(dialog)).toBe(false); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.body.insertAdjacentHTML("beforeend", '<dialog open></dialog>'); expect(dialogOwnsController(dialog)).toBe(false); document.body.lastElementChild?.remove();
    dialog.close = () => { dialog.removeAttribute("open"); }; dialog.close(); expect(dialogOwnsController(dialog)).toBe(false); expect(close).toHaveBeenCalledOnce();
  });
  it("can close an editor without submitting or modifying its draft, as native Escape would", () => {
    dialog.insertAdjacentHTML("beforeend", '<textarea id="draft">Unsubmitted</textarea>'); control("draft").focus(); const close = vi.fn();
    expect(applyDialogPadAction(dialog, { type: "activate" }, close)).toBe(false); expect(applyDialogPadAction(dialog, { type: "move", direction: "up" }, close)).toBe(false);
    expect(applyDialogPadAction(dialog, { type: "close" }, close)).toBe(true); expect(close).toHaveBeenCalledOnce(); expect((control("draft") as HTMLTextAreaElement).value).toBe("Unsubmitted");
  });
});
