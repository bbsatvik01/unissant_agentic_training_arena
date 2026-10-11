import { describe, expect, it } from "vitest";

import { CASE_BOARD, caseSlot, EVIDENCE_WALL, evidenceSlot, FLIGHT_TO_HUB, FLIGHT_TO_ROOM, inRoom, ROOM, SHOTS } from "./layout";

describe("world layout", () => {
  it("lays the case files out on the board, row by row, inside its face", () => {
    const first = caseSlot(0);
    const second = caseSlot(1);
    const fourth = caseSlot(CASE_BOARD.columns);
    expect(second[0]).toBeGreaterThan(first[0]);
    expect(fourth[1]).toBeLessThan(first[1]);
    for (let i = 0; i < 6; i += 1) {
      const [x, y] = caseSlot(i);
      expect(Math.abs(x - CASE_BOARD.center[0])).toBeLessThan(CASE_BOARD.width / 2);
      expect(Math.abs(y - CASE_BOARD.center[1])).toBeLessThan(CASE_BOARD.height / 2);
    }
  });

  it("pins papers in a grid and stacks overflow on the last slot", () => {
    const last = EVIDENCE_WALL.columns * EVIDENCE_WALL.rows - 1;
    expect(evidenceSlot(last + 3)).toEqual(evidenceSlot(last));
    expect(evidenceSlot(1)[0]).toBeGreaterThan(evidenceSlot(0)[0]);
    expect(evidenceSlot(EVIDENCE_WALL.columns)[1]).toBeLessThan(evidenceSlot(0)[1]);
  });

  it("places room points relative to the room and flies from the hub into the room shot", () => {
    expect(inRoom([1, 2, 3])).toEqual([ROOM[0] + 1, ROOM[1] + 2, ROOM[2] + 3]);
    expect(FLIGHT_TO_ROOM.at(-1)).toBe("room");
    expect(FLIGHT_TO_HUB.at(-1)).toBe("hub");
    for (const shot of Object.values(SHOTS)) expect(shot.position).not.toEqual(shot.target);
  });
});
