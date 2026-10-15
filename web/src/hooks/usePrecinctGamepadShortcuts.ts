/** Route-only menu shortcuts. Dialogs/editors/links own input instead, and Canvas retains all movement. */
import { useEffect } from "react";
import { INITIAL_SHORTCUTS, standardPrecinctShortcuts, stepPrecinctShortcuts } from "../lib/precinct/precinctGamepadShortcuts";
export function precinctOwnsShortcuts(): boolean {
  const active = document.activeElement;
  return document.visibilityState === "visible" && document.hasFocus() && document.querySelector("dialog[open]") === null
    && !(active instanceof HTMLElement && active.closest('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"]),[role="dialog"],[role="textbox"],[role="combobox"],[role="slider"]') !== null);
}
export function usePrecinctGamepadShortcuts(enabled: boolean, onPause: () => void, onCamera: () => void, onMap: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    let state = INITIAL_SHORTCUTS; let frame = 0; let stopped = false;
    const isStopped = () => stopped;
    const reset = () => { state = INITIAL_SHORTCUTS; };
    const poll = () => {
      if (stopped) return;
      const active = precinctOwnsShortcuts(); let pad: Gamepad | null = null;
      if (active) {
        try { pad = navigator.getGamepads().find((candidate) => candidate !== null && candidate.connected && candidate.mapping === "standard") ?? null; }
        catch { /* Standard keyboard/UI remain available when controller access is unavailable. */ }
      }
      const next = stepPrecinctShortcuts(state, standardPrecinctShortcuts(pad), active); state = next.state;
      if (next.action === "pause") onPause(); else if (next.action === "map") onMap(); else if (next.action === "camera") onCamera();
      if (!isStopped()) frame = requestAnimationFrame(poll);
    };
    window.addEventListener("blur", reset); document.addEventListener("visibilitychange", reset); window.addEventListener("gamepaddisconnected", reset);
    frame = requestAnimationFrame(poll);
    return () => { stopped = true; cancelAnimationFrame(frame); window.removeEventListener("blur", reset); document.removeEventListener("visibilitychange", reset); window.removeEventListener("gamepaddisconnected", reset); };
  }, [enabled, onPause, onCamera, onMap]);
}
