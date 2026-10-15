import { describe, expect, it } from "vitest";

import type { OfficePlan, Seat } from "../office";
import { navseaTower } from "../__fixtures__/tower-runs";

import { BASE_H, BOARD_X, buildRows, buildTower, CARREL_X, FOOT_H, GROUND_H, MAX_FLOORS, pct, RACK_X, RED_X, RIVAL_EXTRA_X, RIVAL_X, ROOF_H, roomOf, ROW_H, SLAB, VERIFIER_X, ANALYST_X, HOME_LANE_X } from "./layout";

function seat(id: string, over: Partial<Seat>): Seat {
  return { id, role: "pricing", zone: "pod", pod: null, team: 0, at: { x: 0, y: 0 }, agentId: null, ...over };
}

function planOf(pods: string[], extra: Seat[] = []): OfficePlan {
  const seats: Record<string, Seat> = {};
  for (const key of pods) {
    seats[`${key}:lane`] = seat(`${key}:lane`, { role: "researcher", pod: key });
    seats[`${key}:capture_lead`] = seat(`${key}:capture_lead`, { role: "capture_lead", pod: key });
  }
  for (const s of extra) seats[s.id] = s;
  return {
    pods: pods.map((key, i) => ({ key, label: key, groupId: null, team: i, center: { x: 0, y: 0 }, seats: [] })),
    seats,
    order: Object.keys(seats),
    byAgent: {},
  } as unknown as OfficePlan;
}

describe("the building's rows", () => {
  it("stacks the roof, the upper floor, the rival floors, the ground floor and B1, each slab under the last", () => {
    const rows = buildRows(["A", "B"], 4);
    expect(rows.map((r) => [r.kind, r.label, r.pod])).toEqual([
      ["roof", "R", null],
      ["upper", "5F", null],
      ["rival", "4F", "A"],
      ["rival", "3F", "B"],
      ["rival", "2F", null],
      ["rival", "1F", null],
      ["ground", "G", null],
      ["basement", "B1", null],
    ]);
    rows.forEach((r, i) => {
      expect(r.index).toBe(i);
      expect(r.top).toBe(i === 0 ? 0 : rows[i - 1]?.bottom);
      expect(r.floor).toBe(r.bottom - SLAB);
      expect(r.pipe).toBe(r.kind === "roof" ? 58 : r.top + 7);
    });
    expect(rows.map((r) => r.bottom - r.top)).toEqual([ROOF_H, ROW_H, ROW_H, ROW_H, ROW_H, ROW_H, GROUND_H, BASE_H]);
  });
});

describe("the NAVSEA building", () => {
  const { layout, plan } = navseaTower();

  it("is built for six rivals whatever the plan holds, so five rivals leave one floor vacant", () => {
    expect(layout.rivalRows).toHaveLength(6);
    expect(layout.rooms.filter((r) => r.id.startsWith("floor:")).map((r) => r.label)).toEqual([...plan.pods.map((p) => p.key), "Vacant"]);
    expect(layout.h).toBe((layout.rows.at(-1)?.bottom ?? 0) + FOOT_H);
    expect(layout.carrels.map((c) => c.x)).toEqual(CARREL_X);
    expect(layout.racks.map((c) => c.x)).toEqual(RACK_X);
  });

  it("seats every rival's desks by role on its own floor, the capture lead in its office", () => {
    for (const pod of plan.pods) {
      const row = layout.podRow[pod.key];
      for (const id of pod.seats) {
        const spot = layout.seats[id];
        const s = plan.seats[id];
        expect(spot?.row).toBe(row);
        if (!s || !spot) continue;
        const role = id.endsWith(":lane") ? "researcher" : s.role;
        if (!/:x\d$/.test(id)) expect(spot.x).toBe(RIVAL_X[role]);
        expect(spot.furniture).toBe(s.role === "capture_lead" ? "office" : "desk");
        expect(spot.station).toEqual({ x: spot.x + 30, y: (layout.rows[spot.row]?.floor ?? 0) - 34 });
      }
    }
  });

  it("puts the red team and the home office upstairs, the board on the roof, and the verifier in the notary booth", () => {
    expect(layout.seats.red_team).toMatchObject({ row: layout.upper, x: RED_X[0] });
    expect(layout.seats.analyst).toMatchObject({ row: layout.upper, x: ANALYST_X });
    expect(["board:0", "board:1", "board:2"].map((id) => [layout.seats[id]?.row, layout.seats[id]?.x, layout.seats[id]?.furniture])).toEqual(BOARD_X.map((x) => [layout.roof, x, "chair"]));
    expect(layout.seats.verifier).toMatchObject({ row: layout.ground, x: VERIFIER_X, furniture: "booth" });
  });

  it("finds the room at a point on a row, and none off the building", () => {
    expect(roomOf(layout, layout.basement, 200)?.id).toBe("archive");
    expect(roomOf(layout, layout.basement, 900)?.id).toBe("machine");
    expect(roomOf(layout, layout.ground, 700)?.id).toBe("notary");
    expect(roomOf(layout, layout.roof, 900)?.id).toBe("deck");
    expect(roomOf(layout, layout.rivalRows[0] ?? -1, 500)?.id).toBe(`floor:${plan.pods[0]?.key}`);
    expect(roomOf(layout, layout.ground, 5)).toBeNull();
    expect(roomOf(layout, 99, 500)).toBeNull();
  });

  it("turns scene points into percentages of its box, to two places", () => {
    expect(pct(layout, 600, layout.h / 2)).toEqual({ left: "50%", top: "50%" });
    expect(pct({ w: 3, h: 3 }, 1, 2)).toEqual({ left: "33.33%", top: "66.67%" });
  });
});

describe("a building with more than it has room for", () => {
  it("adds floors past six rivals up to MAX_FLOORS, and leaves the rest of the rivals out", () => {
    const pods = Array.from({ length: MAX_FLOORS + 1 }, (_, i) => `P${i}`);
    const layout = buildTower(planOf(pods));
    expect(layout.rivalRows).toHaveLength(MAX_FLOORS);
    const last = `P${MAX_FLOORS}`;
    expect(layout.podRow[last]).toBeUndefined();
    expect(layout.overflow).toEqual([`${last}:lane`, `${last}:capture_lead`]);
  });

  it("gives extra rival roles the extra desks, the home lane its desk by the analyst, and overflows a fourth red-teamer", () => {
    const layout = buildTower(
      planOf(["A"], [
        seat("A:x0", { role: "analyst", pod: "A" }),
        seat("A:x2", { role: "analyst", pod: "A" }),
        seat("A:x7", { role: "analyst", pod: "A" }),
        seat("HOME:lane", { role: "researcher", zone: "analyst", pod: "HOME" }),
        seat("red_team", { role: "red_team", zone: "red_team" }),
        seat("red_team:2", { role: "red_team", zone: "red_team" }),
        seat("red_team:3", { role: "red_team", zone: "red_team" }),
        seat("board:3", { role: "evaluator", zone: "board" }),
        seat("lost", { role: "pricing", zone: "pod", pod: "NOWHERE" }),
      ]),
    );
    expect(layout.seats["A:x0"]).toMatchObject({ x: RIVAL_EXTRA_X[0], furniture: "desk" });
    expect(layout.seats["A:x2"]?.x).toBe(RIVAL_EXTRA_X[2]);
    expect(layout.seats["HOME:lane"]).toMatchObject({ row: layout.upper, x: HOME_LANE_X });
    expect(layout.seats["red_team:2"]?.x).toBe(RED_X[2]);
    expect(layout.overflow.sort()).toEqual(["A:x7", "board:3", "lost", "red_team:3"]);
  });
});
