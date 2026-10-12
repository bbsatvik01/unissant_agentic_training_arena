import { describe, expect, it } from "vitest";

import { EMPTY_TOURNAMENT, foldPoll } from "./tournament";
import { nextPoll, parseTournamentList, parseTournamentStatus, POLL_MS } from "./tournamentPoll";

describe("tournament poll lifecycle (S6 4.9, S5 6.2)", () => {
  it("polls every 2 s while running, sealed or scoring and the tab is visible; reads draft, frozen and revealed once", () => {
    expect(POLL_MS).toBe(2000);
    for (const s of ["running", "sealed", "scoring"] as const) expect(nextPoll(s, true)).toBe(POLL_MS);
    for (const s of ["draft", "frozen", "revealed"] as const) expect(nextPoll(s, true)).toBe("stop");
    expect(nextPoll("running", false)).toBe("hidden");
    expect(nextPoll("revealed", false)).toBe("stop");
    // A state no response has reported yet (a hidden tournament's counts carry none): keep polling while visible.
    expect(nextPoll(null, true)).toBe(POLL_MS);
  });

  it("restarts at after=0 when a hidden tournament's counts switch to events at reveal", () => {
    const counts = foldPoll(EMPTY_TOURNAMENT, { visibility: "counts", progress: [{ track: "interactive", block: 1, planned: 4, counts_by_state: { completed: 2 } }] });
    expect(counts.last).toBe(0);
    expect(counts.trials.size).toBe(0);
  });

  it("reads the tournament list and a tournament's status, nothing more", () => {
    const list = parseTournamentList({ tournaments: [{ id: "t1", name: "dev-demo", split: "dev", status: "revealed", seed: 7 }, { id: "t2", name: "x", split: "hidden", status: "paused" }, "x"] });
    expect(list).toEqual([{ id: "t1", name: "dev-demo", split: "dev", status: "revealed" }]);
    expect(parseTournamentList([{ id: "t3", name: "h", split: "hidden", status: "running" }])).toEqual([{ id: "t3", name: "h", split: "hidden", status: "running" }]);
    expect(parseTournamentList({})).toBe(null);
    expect(parseTournamentStatus({ id: "t1", status: "scoring", progress: [] })).toBe("scoring");
    expect(parseTournamentStatus({ tournament: { status: "sealed" } })).toBe("sealed");
    expect(parseTournamentStatus({ status: "paused" })).toBe(null);
    expect(parseTournamentStatus(null)).toBe(null);
  });
});
