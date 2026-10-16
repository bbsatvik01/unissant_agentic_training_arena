/** One input-only poll while the native modal exists. Independent of the Canvas and replay clock. */
import { useEffect, type RefObject } from "react";
import { INITIAL_DIALOG_PAD, standardDialogPad, stepDialogPad } from "../lib/precinct/dialogGamepad";
import { applyDialogPadAction, dialogOwnsController } from "../lib/precinct/dialogNavigation";

export function useDialogGamepad(dialog: RefObject<HTMLDialogElement | null>, onClose: () => void, scope: string): void {
  useEffect(() => {
    let state = INITIAL_DIALOG_PAD; let frame = 0; let stopped = false; let lastFocus: Element | null = null;
    const isStopped = () => stopped;
    const reset = () => { state = INITIAL_DIALOG_PAD; lastFocus = null; };
    const poll = (nowMs: number) => {
      if (stopped) return;
      const element = dialog.current;
      let pad: Gamepad | null = null;
      if (element !== null && dialogOwnsController(element)) {
        try { pad = navigator.getGamepads().find((candidate) => candidate !== null && candidate.connected && candidate.mapping === "standard") ?? null; }
        catch { /* An unavailable/denied Gamepad API leaves native keyboard and focus untouched. */ }
      }
      const next = stepDialogPad(state, standardDialogPad(pad), nowMs, element !== null && dialogOwnsController(element)); state = next.state;
      const stableFocus = document.activeElement === lastFocus;
      if (element !== null) for (const action of next.actions) {
        if (action.type !== "activate" || stableFocus) applyDialogPadAction(element, action, onClose);
      }
      lastFocus = document.activeElement;
      if (!isStopped()) frame = requestAnimationFrame(poll);
    };
    window.addEventListener("blur", reset); document.addEventListener("visibilitychange", reset); window.addEventListener("gamepaddisconnected", reset);
    frame = requestAnimationFrame(poll);
    return () => { stopped = true; cancelAnimationFrame(frame); window.removeEventListener("blur", reset); document.removeEventListener("visibilitychange", reset); window.removeEventListener("gamepaddisconnected", reset); };
    // Each panel/expanded-monitor scope must require a fresh neutral pad before an action.
  }, [dialog, onClose, scope]);
}
