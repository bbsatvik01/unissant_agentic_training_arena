import { describe, expect, it } from "vitest";
import { INITIAL_SHORTCUTS, standardPrecinctShortcuts, stepPrecinctShortcuts } from "./precinctGamepadShortcuts";
const neutral = { key: "pad:1", pause: false, map: false, camera: false };
describe("route gamepad shortcuts", () => {
  it.each(["pause", "map", "camera"] as const)("requires a released then fresh %s press and never repeats", (action) => {
    const held = { ...neutral, [action]: true };
    const blocked = stepPrecinctShortcuts(INITIAL_SHORTCUTS, held, true); expect(blocked.action).toBeNull();
    const neutralized = stepPrecinctShortcuts(blocked.state, neutral, true); const press = stepPrecinctShortcuts(neutralized.state, held, true);
    expect(press.action).toBe(action); expect(stepPrecinctShortcuts(press.state, held, true).action).toBeNull();
    expect(stepPrecinctShortcuts(press.state, held, false).state).toBe(INITIAL_SHORTCUTS); expect(stepPrecinctShortcuts(press.state, null, true).state).toBe(INITIAL_SHORTCUTS);
    expect(stepPrecinctShortcuts(press.state, { ...held, key: "other" }, true).action).toBeNull();
  });
  it("consumes simultaneous presses with deterministic pause, then map priority", () => {
    const ready = stepPrecinctShortcuts(INITIAL_SHORTCUTS, neutral, true).state;
    const all = { ...neutral, pause: true, map: true, camera: true }, pressed = stepPrecinctShortcuts(ready, all, true);
    expect(pressed.action).toBe("pause"); expect(stepPrecinctShortcuts(pressed.state, all, true).action).toBeNull();
    expect(stepPrecinctShortcuts(ready, { ...neutral, map: true, camera: true }, true).action).toBe("map");
  });
  it("uses only standard buttons 9, 8 and 11; movement/speed/height inputs stay untouched", () => {
    const buttons = Array.from({ length: 12 }, (_, index) => ({ pressed: [4, 5, 8, 9, 10, 11].includes(index), touched: false, value: 0 }));
    const pad = { id: "test", index: 0, mapping: "standard" as const, connected: true, buttons };
    expect(standardPrecinctShortcuts(pad)).toEqual({ key: "0:test", pause: true, map: true, camera: true });
    expect(standardPrecinctShortcuts({ ...pad, buttons: [] })).toEqual({ ...neutral, key: "0:test" });
    expect(standardPrecinctShortcuts({ ...pad, mapping: "" })).toBeNull(); expect(standardPrecinctShortcuts({ ...pad, connected: false })).toBeNull(); expect(standardPrecinctShortcuts(null)).toBeNull();
  });
});
