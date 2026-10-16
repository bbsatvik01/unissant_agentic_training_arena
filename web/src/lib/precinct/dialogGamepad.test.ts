import { describe, expect, it } from "vitest";
import { DIALOG_REPEAT_DELAY_MS, DIALOG_REPEAT_INTERVAL_MS, INITIAL_DIALOG_PAD, standardDialogPad, stepDialogPad, type DialogPadInput } from "./dialogGamepad";
const neutral: DialogPadInput = { key: "pad:1", x: 0, y: 0, up: false, down: false, left: false, right: false, activate: false, close: false };
const armed = () => stepDialogPad(INITIAL_DIALOG_PAD, neutral, 0, true).state;
describe("dialog pad edge/repeat model", () => {
  it("requires neutral after mount, disconnect, replacement or inactive page", () => {
    const held = { ...neutral, activate: true, y: 1 };
    const first = stepDialogPad(INITIAL_DIALOG_PAD, held, 0, true); expect(first.actions).toEqual([]); expect(first.state.armed).toBe(false);
    expect(stepDialogPad(first.state, held, 10_000, true).actions).toEqual([]);
    const ready = stepDialogPad(first.state, neutral, 10_001, true); expect(ready.state.armed).toBe(true);
    expect(stepDialogPad(ready.state, held, 10_002, true).actions).toEqual([{ type: "activate" }]);
    for (const next of [stepDialogPad(ready.state, null, 10_003, true), stepDialogPad(ready.state, neutral, 10_003, false)]) expect(next.state).toBe(INITIAL_DIALOG_PAD);
    expect(stepDialogPad(ready.state, { ...held, key: "other" }, 10_003, true).actions).toEqual([]);
  });
  it("never repeats A or B and gives simultaneous B priority", () => {
    let state = armed();
    const a = stepDialogPad(state, { ...neutral, activate: true }, 1, true); expect(a.actions).toEqual([{ type: "activate" }]); state = a.state;
    expect(stepDialogPad(state, { ...neutral, activate: true }, 10_000, true).actions).toEqual([]);
    const both = stepDialogPad(state, { ...neutral, activate: true, close: true }, 10_001, true); expect(both.actions).toEqual([{ type: "close" }]);
    expect(stepDialogPad(both.state, { ...neutral, activate: true, close: true }, 20_000, true).actions).toEqual([]);
    const release = stepDialogPad(both.state, neutral, 20_001, true);
    expect(stepDialogPad(release.state, { ...neutral, activate: true, close: true }, 20_002, true).actions).toEqual([{ type: "close" }]);
  });
  it("delays directional repeat, emits at most once per frame and never catches up after a stall", () => {
    const held = { ...neutral, down: true };
    const first = stepDialogPad(armed(), held, 1, true); expect(first.actions).toEqual([{ type: "move", direction: "down" }]);
    expect(stepDialogPad(first.state, held, DIALOG_REPEAT_DELAY_MS, true).actions).toEqual([]);
    const repeat = stepDialogPad(first.state, held, 1 + DIALOG_REPEAT_DELAY_MS, true); expect(repeat.actions).toHaveLength(1);
    expect(repeat.state.nextRepeatMs).toBe(1 + DIALOG_REPEAT_DELAY_MS + DIALOG_REPEAT_INTERVAL_MS);
    const stalled = stepDialogPad(repeat.state, held, 100_000, true); expect(stalled.actions).toHaveLength(1); expect(stalled.state.nextRepeatMs).toBe(100_000 + DIALOG_REPEAT_INTERVAL_MS);
    expect(stepDialogPad(stalled.state, held, 100_001, true).actions).toEqual([]);
  });
  it.each([[-1, 0, "left"], [1, 0, "right"], [0, -1, "up"], [0, 1, "down"]] as const)("maps analog %s,%s to %s", (x, y, direction) => {
    expect(stepDialogPad(armed(), { ...neutral, x, y }, 1, true).actions).toEqual([{ type: "move", direction }]);
  });
  it("uses digital precedence, cancellation and deterministic diagonal choice", () => {
    expect(stepDialogPad(armed(), { ...neutral, up: true, x: 1 }, 1, true).actions).toEqual([{ type: "move", direction: "up" }]);
    expect(stepDialogPad(armed(), { ...neutral, up: true, down: true, x: 1 }, 1, true).actions).toEqual([]);
    expect(stepDialogPad(armed(), { ...neutral, down: true, right: true }, 1, true).actions).toEqual([{ type: "move", direction: "down" }]);
    expect(stepDialogPad(armed(), { ...neutral, x: 1, y: -1 }, 1, true).actions).toEqual([{ type: "move", direction: "up" }]);
  });
  it("uses analog hysteresis without turning noise into fresh actions", () => {
    const first = stepDialogPad(armed(), { ...neutral, x: 0.56 }, 1, true);
    const near = stepDialogPad(first.state, { ...neutral, x: 0.4 }, 100, true); expect(near.actions).toEqual([]); expect(near.state.direction).toBe("right");
    const released = stepDialogPad(near.state, { ...neutral, x: 0.2 }, 110, true); expect(released.state.direction).toBeNull();
    expect(stepDialogPad(released.state, { ...neutral, x: 0.4 }, 120, true).actions).toEqual([]);
    expect(stepDialogPad(released.state, { ...neutral, x: -0.56 }, 121, true).actions).toEqual([{ type: "move", direction: "left" }]);
  });
  it("ignores malformed axes/time and requires neutral after a backwards timestamp", () => {
    expect(stepDialogPad(armed(), { ...neutral, x: NaN, y: Infinity }, 1, true).actions).toEqual([]);
    for (const time of [-1, NaN, Infinity]) expect(stepDialogPad(armed(), neutral, time, true).state).toBe(INITIAL_DIALOG_PAD);
    const future = stepDialogPad(armed(), neutral, 100, true); expect(stepDialogPad(future.state, { ...neutral, activate: true }, 99, true).state).toBe(INITIAL_DIALOG_PAD);
  });
  it("only translates connected standard mappings and documented buttons", () => {
    const buttons = Array.from({ length: 16 }, (_, i) => ({ pressed: i === 0 || i === 12, touched: false, value: i === 15 ? 1 : 0 }));
    const pad = { id: "test", index: 2, connected: true, mapping: "standard" as const, buttons, axes: [0.25, -0.5] };
    expect(standardDialogPad(pad)).toEqual({ key: "2:test", x: 0.25, y: -0.5, activate: true, close: false, up: true, down: false, left: false, right: true });
    expect(standardDialogPad({ ...pad, connected: false })).toBeNull(); expect(standardDialogPad({ ...pad, mapping: "" })).toBeNull(); expect(standardDialogPad(null)).toBeNull();
    expect(standardDialogPad({ ...pad, buttons: [], axes: [] })).toEqual({ ...neutral, key: "2:test" });
  });
});
