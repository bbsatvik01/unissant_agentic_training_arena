import { describe, expect, it } from "vitest";

import { nearestInDirection, readingOrder, type NavItem } from "./nav";

// two floors: row 0 has a (x 10) and b (x 100); row 2 has c (x 40), d (x 90) and e (x 300)
const items: NavItem[] = [
  { id: "e", row: 2, x: 300 },
  { id: "c", row: 2, x: 40 },
  { id: "b", row: 0, x: 100 },
  { id: "d", row: 2, x: 90 },
  { id: "a", row: 0, x: 10 },
];

describe("the tower's roving tab stop", () => {
  it("reads top floor first, left to right, ties by id", () => {
    expect(readingOrder(items).map((i) => i.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(readingOrder([{ id: "y", row: 0, x: 0 }, { id: "x", row: 0, x: 0 }]).map((i) => i.id)).toEqual(["x", "y"]);
    // the input is never reordered in place
    expect(items[0]?.id).toBe("e");
  });

  it("moves left and right in reading order, across floors, and stops at either end", () => {
    expect(nearestInDirection(items, "b", "right")).toBe("c");
    expect(nearestInDirection(items, "c", "left")).toBe("b");
    expect(nearestInDirection(items, "a", "left")).toBeNull();
    expect(nearestInDirection(items, "e", "right")).toBeNull();
  });

  it("moves up and down to the nearest floor with an agent, to the one closest in x", () => {
    expect(nearestInDirection(items, "b", "down")).toBe("d");
    expect(nearestInDirection(items, "a", "down")).toBe("c");
    expect(nearestInDirection(items, "e", "up")).toBe("b");
    expect(nearestInDirection(items, "a", "up")).toBeNull();
    expect(nearestInDirection(items, "d", "down")).toBeNull();
  });

  it("starts from the first agent when the focus is on no one, and has nowhere to go with no agents", () => {
    expect(nearestInDirection(items, "gone", "right")).toBe("a");
    expect(nearestInDirection([], "gone", "down")).toBeNull();
  });
});
