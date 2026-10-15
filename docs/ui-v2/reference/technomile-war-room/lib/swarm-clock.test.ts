import { describe, expect, it } from "vitest";

import { ended, localClock, localNow, nextSpeed, pause, play, seek, setSpeed } from "./swarm-clock";

describe("local clock", () => {
  it("plays, pauses, changes speed and seeks against an injected wall clock", () => {
    let c = localClock(1000, 11_000, 0);
    expect(localNow(c, 500)).toBe(1000);
    c = play(c, 0);
    expect(localNow(c, 2000)).toBe(3000);
    c = setSpeed(c, 4, 2000);
    expect(localNow(c, 3000)).toBe(7000);
    c = pause(c, 3000);
    expect(localNow(c, 9000)).toBe(7000);
    c = seek(c, 50_000, 9000);
    expect(localNow(c, 9000)).toBe(11_000);
    expect(ended(c, 9000)).toBe(true);
    c = play(c, 9000);
    expect(localNow(c, 9000)).toBe(1000);
    expect(localNow(c, 1e9)).toBe(11_000);
    expect(setSpeed(c, 0, 0).speed).toBe(1);
    expect(seek(c, -5, 0).base).toBe(1000);
  });

  it("cycles speeds 1 to 16", () => {
    expect([1, 2, 4, 8, 16, 3].map(nextSpeed)).toEqual([2, 4, 8, 16, 1, 1]);
  });
});
