import { describe, expect, it } from "vitest";

import { buildRows, X, type Row, type TowerLayout } from "./layout";
import { cabinAt, cutPath, DOOR_MS, easeInOut, GATHER_MS, LIFT_UNITS_PER_MS, planLift, tubePath, walkMs, WALK_MAX_MS, WALK_MIN_MS, WALK_UNITS_PER_MS, type RideRequest } from "./route";

// R, 5F, four rival floors (4F to 1F), G, B1
const rows: Row[] = buildRows(["A", "B", "C", "D"], 4);
const travel = (a: number, b: number) => Math.round(Math.abs((rows[b]?.floor ?? 0) - (rows[a]?.floor ?? 0)) / LIFT_UNITS_PER_MS);
const req = (rider: string, from: number, to: number, event: number, ready = event): RideRequest => ({ rider, from, to, event, ready });

describe("walking", () => {
  it("takes no time to stand still, at least WALK_MIN_MS to move, and never longer than WALK_MAX_MS to cross a room", () => {
    expect(walkMs(0)).toBe(0);
    expect(walkMs(0.5)).toBe(0);
    expect(walkMs(5)).toBe(WALK_MIN_MS);
    expect(walkMs(150)).toBe(Math.round(150 / WALK_UNITS_PER_MS));
    expect(walkMs(-150)).toBe(walkMs(150));
    expect(walkMs(10_000)).toBe(WALK_MAX_MS);
  });
});

describe("the lift", () => {
  it("ignores requests that go nowhere or have no time", () => {
    expect(planLift([req("a", 2, 2, 0), req("b", 2, 7, NaN), req("c", 2, 7, 0, Infinity)], rows, 6)).toEqual({ rides: [], rest: 6 });
  });

  it("comes to a rider, waits for it at the door, and drops it", () => {
    const plan = planLift([req("a", 2, 7, 1000, 1500)], rows, 6);
    const [ride] = plan.rides;
    expect(ride?.stops.map((s) => s.row)).toEqual([6, 2, 7]);
    expect(ride?.start).toBe(1000);
    const pickup = ride?.stops[1];
    expect(pickup?.arrive).toBe(1000 + travel(6, 2));
    // not ready at the door yet: the cabin waits, then the doors take DOOR_MS
    expect(pickup?.depart).toBe(Math.max(1000 + travel(6, 2), 1500) + DOOR_MS);
    expect(ride?.board.a).toBe(Math.max(1000 + travel(6, 2), 1500));
    expect(ride?.alight.a).toBe((pickup?.depart ?? 0) + travel(2, 7) + Math.round(DOOR_MS / 2));
    expect(ride?.end).toBe(ride?.stops.at(-1)?.depart);
  });

  it("gathers riders going the same way within GATHER_MS, collecting top to bottom on the way down", () => {
    const plan = planLift([req("low", 4, 7, 0), req("high", 2, 7, GATHER_MS)], rows, 6);
    expect(plan.rides).toHaveLength(1);
    expect(plan.rides[0]?.stops.map((s) => s.row)).toEqual([6, 2, 4, 7]);
    // one drop floor for both
    expect(plan.rides[0]?.alight.low).toBe(plan.rides[0]?.alight.high);
  });

  it("collects bottom first on the way up, and opens its doors where it already stands", () => {
    const plan = planLift([req("g", 6, 0, 0), req("f", 4, 0, 10)], rows, 6);
    const ride = plan.rides[0];
    // the cabin is on the ground floor already: its first stop is that same floor, its doors open
    expect(ride?.stops.map((s) => s.row)).toEqual([6, 4, 0]);
    expect(ride?.stops[0]?.depart).toBe(DOOR_MS);
    expect(ride?.board.g).toBe(0);
  });

  it("makes a request in the other direction, or too late, wait for the next ride", () => {
    const plan = planLift([req("down", 2, 7, 0), req("up", 7, 2, 10), req("late", 3, 7, GATHER_MS + 1)], rows, 6);
    expect(plan.rides.map((r) => r.riders)).toEqual([["down"], ["up"], ["late"]]);
    // a busy cabin: the next ride starts when the last ends, from where it ended
    expect(plan.rides[1]?.start).toBe(plan.rides[0]?.end);
    expect(plan.rides[1]?.stops[0]?.row).toBe(7);
    expect(plan.rides[2]?.stops[0]?.row).toBe(2);
  });

  it("places the cabin at rest, at a stop with its doors open, between floors on the ease, and where its last ride ended", () => {
    const plan = planLift([req("a", 2, 7, 1000)], rows, 6);
    const ride = plan.rides[0];
    if (!ride) throw new Error("no ride");
    expect(cabinAt(plan, rows, 0)).toEqual({ y: rows[6]?.floor, doorsOpen: false, ride: null });
    const pickup = ride.stops[1];
    if (!pickup) throw new Error("no pickup");
    expect(cabinAt(plan, rows, pickup.arrive)).toEqual({ y: rows[2]?.floor, doorsOpen: true, ride });
    const mid = (1000 + pickup.arrive) / 2;
    const y = cabinAt(plan, rows, mid).y;
    expect(y).toBeCloseTo((rows[6]?.floor ?? 0) + ((rows[2]?.floor ?? 0) - (rows[6]?.floor ?? 0)) * easeInOut(0.5), 6);
    expect(cabinAt(plan, rows, mid).doorsOpen).toBe(false);
    expect(cabinAt(plan, rows, ride.end + 1)).toEqual({ y: rows[7]?.floor, doorsOpen: false, ride: null });
  });

  it("eases in and out, clamped to the journey", () => {
    expect([-1, 0, 0.25, 0.5, 0.75, 1, 2].map(easeInOut)).toEqual([0, 0, 0.125, 0.5, 0.875, 1, 1]);
  });
});

describe("the tubes", () => {
  const seat = (row: number, x: number) => ({ id: `s${row}:${x}`, row, x, furniture: "desk" as const, station: { x: x + 30, y: (rows[row]?.floor ?? 0) - 34 } });
  const layout = {
    rows,
    roof: 0,
    seats: { a: seat(2, 300), b: seat(2, 500), c: seat(5, 200) },
    table: { x: 382, y: 102 },
  } as unknown as TowerLayout;

  it("stays under one floor's ceiling between desks on the same floor", () => {
    const pipe = rows[2]?.pipe ?? 0;
    const desk = (rows[2]?.floor ?? 0) - 34;
    expect(tubePath(layout, "a", "b")).toEqual([
      { x: 330, y: desk },
      { x: 330, y: pipe },
      { x: 530, y: pipe },
      { x: 530, y: desk },
    ]);
  });

  it("goes along the trunk between floors, and to the penthouse table for the board", () => {
    const path = tubePath(layout, "a", "c");
    expect(path?.map((p) => p.x)).toEqual([330, 330, X.trunk, X.trunk, 230, 230]);
    expect(path?.[2]?.y).toBe(rows[2]?.pipe);
    expect(path?.[3]?.y).toBe(rows[5]?.pipe);
    expect(tubePath(layout, "c", "board")?.at(-1)).toEqual({ x: 382, y: 102 });
    expect(tubePath(layout, "c", "board")?.[3]?.y).toBe(rows[0]?.pipe);
  });

  it("has no way to or from a desk the building does not have", () => {
    expect(tubePath(layout, "nobody", "a")).toBeNull();
    expect(tubePath(layout, "a", "nobody")).toBeNull();
  });

  it("cuts a path by length, for a jammed capsule", () => {
    const path = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 30, y: 10 },
    ];
    expect(cutPath(path, 0.5)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }]);
    expect(cutPath(path, 0.1)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 4 }]);
    expect(cutPath(path, 1)).toEqual(path);
    expect(cutPath(path, 2)).toEqual(path);
    expect(cutPath(path, -1)).toEqual([{ x: 0, y: 0 }]);
    expect(cutPath([{ x: 1, y: 1 }], 0.5)).toEqual([{ x: 1, y: 1 }]);
    expect(cutPath([], 0.5)).toEqual([]);
    // a zero-length leg is passed over, never divided by
    expect(cutPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }], 0.5)).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
  });
});
