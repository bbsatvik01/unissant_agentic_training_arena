/** Standard-pad route shortcut edges, without repeat or any world/replay time input. */
export type PrecinctShortcut = "pause" | "map" | "camera";
export interface ShortcutInput { readonly key: string; readonly pause: boolean; readonly map: boolean; readonly camera: boolean }
export interface ShortcutState { readonly key: string | null; readonly armed: boolean; readonly pause: boolean; readonly map: boolean; readonly camera: boolean }
export const INITIAL_SHORTCUTS: ShortcutState = { key: null, armed: false, pause: false, map: false, camera: false };
export function stepPrecinctShortcuts(state: ShortcutState, input: ShortcutInput | null, enabled: boolean): { readonly state: ShortcutState; readonly action: PrecinctShortcut | null } {
  if (!enabled || input === null) return { state: INITIAL_SHORTCUTS, action: null };
  const neutral = !input.pause && !input.map && !input.camera;
  if (state.key !== input.key || !state.armed) return { state: { ...input, armed: neutral }, action: null };
  const action = input.pause && !state.pause ? "pause" : input.map && !state.map ? "map" : input.camera && !state.camera ? "camera" : null;
  return { state: { ...input, armed: true }, action };
}
export function standardPrecinctShortcuts(pad: Pick<Gamepad, "id" | "index" | "connected" | "mapping" | "buttons"> | null): ShortcutInput | null {
  if (pad === null || !pad.connected || pad.mapping !== "standard") return null;
  const pressed = (index: number) => pad.buttons[index]?.pressed === true || (pad.buttons[index]?.value ?? 0) > 0.5;
  return { key: `${String(pad.index)}:${pad.id}`, pause: pressed(9), map: pressed(8), camera: pressed(11) };
}
