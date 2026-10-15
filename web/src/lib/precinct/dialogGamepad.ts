/** Input-only standard-pad edges and bounded focus repeat. No browser, world or replay clock access. */
export type DialogDirection = "up" | "down" | "left" | "right";
export type DialogPadAction = { readonly type: "move"; readonly direction: DialogDirection } | { readonly type: "activate" | "close" };
export interface DialogPadInput {
  readonly key: string; readonly x: number; readonly y: number;
  readonly up: boolean; readonly down: boolean; readonly left: boolean; readonly right: boolean;
  readonly activate: boolean; readonly close: boolean;
}
export interface DialogPadState {
  readonly key: string | null; readonly armed: boolean; readonly activate: boolean; readonly close: boolean;
  readonly direction: DialogDirection | null; readonly nextRepeatMs: number; readonly lastMs: number | null;
}
export const INITIAL_DIALOG_PAD: DialogPadState = { key: null, armed: false, activate: false, close: false, direction: null, nextRepeatMs: 0, lastMs: null };
export const DIALOG_REPEAT_DELAY_MS = 420;
export const DIALOG_REPEAT_INTERVAL_MS = 140;
const finiteAxis = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0;
function direction(input: DialogPadInput, previous: DialogDirection | null): DialogDirection | null {
  // Opposing digital directions cancel; any digital input takes priority over analog drift.
  if (input.up || input.down || input.left || input.right) {
    const y = Number(input.down) - Number(input.up), x = Number(input.right) - Number(input.left);
    return y < 0 ? "up" : y > 0 ? "down" : x < 0 ? "left" : x > 0 ? "right" : null;
  }
  const x = finiteAxis(input.x), y = finiteAxis(input.y);
  if (Math.max(Math.abs(x), Math.abs(y)) >= 0.55) return Math.abs(y) >= Math.abs(x) ? y < 0 ? "up" : "down" : x < 0 ? "left" : "right";
  // Hysteresis prevents a held direction near the threshold from becoming repeated fresh presses.
  if (previous === "up" && y <= -0.35) return "up";
  if (previous === "down" && y >= 0.35) return "down";
  if (previous === "left" && x <= -0.35) return "left";
  if (previous === "right" && x >= 0.35) return "right";
  return null;
}
export function stepDialogPad(state: DialogPadState, input: DialogPadInput | null, nowMs: number, enabled: boolean): { readonly state: DialogPadState; readonly actions: readonly DialogPadAction[] } {
  if (!enabled || input === null || !Number.isFinite(nowMs) || nowMs < 0 || (state.lastMs !== null && nowMs < state.lastMs)) return { state: INITIAL_DIALOG_PAD, actions: [] };
  const current = direction(input, state.key === input.key ? state.direction : null);
  const neutral = current === null && Math.abs(finiteAxis(input.x)) < 0.35 && Math.abs(finiteAxis(input.y)) < 0.35 && !input.up && !input.down && !input.left && !input.right && !input.activate && !input.close;
  if (state.key !== input.key || !state.armed) return { state: { key: input.key, armed: neutral, activate: input.activate, close: input.close, direction: current, nextRepeatMs: nowMs + DIALOG_REPEAT_DELAY_MS, lastMs: nowMs }, actions: [] };
  let action: DialogPadAction | null = null;
  let nextRepeatMs = state.nextRepeatMs;
  if (input.close && !state.close) action = { type: "close" };
  else if (input.activate && !state.activate) action = { type: "activate" };
  else if (current !== null && !input.activate && !input.close && (current !== state.direction || nowMs >= state.nextRepeatMs)) action = { type: "move", direction: current };
  if (current !== state.direction || action?.type === "activate" || action?.type === "close") nextRepeatMs = nowMs + DIALOG_REPEAT_DELAY_MS;
  else if (action?.type === "move") nextRepeatMs = nowMs + DIALOG_REPEAT_INTERVAL_MS;
  return { state: { key: input.key, armed: true, activate: input.activate, close: input.close, direction: current, nextRepeatMs, lastMs: nowMs }, actions: action === null ? [] : [action] };
}

/** Unknown controller mappings are ignored rather than assigning potentially wrong A/B meanings. */
export function standardDialogPad(pad: Pick<Gamepad, "id" | "index" | "connected" | "mapping" | "buttons" | "axes"> | null): DialogPadInput | null {
  if (pad === null || !pad.connected || pad.mapping !== "standard") return null;
  const pressed = (index: number) => pad.buttons[index]?.pressed === true || (pad.buttons[index]?.value ?? 0) > 0.5;
  return { key: `${String(pad.index)}:${pad.id}`, x: pad.axes[0] ?? 0, y: pad.axes[1] ?? 0, up: pressed(12), down: pressed(13), left: pressed(14), right: pressed(15), activate: pressed(0), close: pressed(1) };
}
