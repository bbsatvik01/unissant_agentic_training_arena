import { describe, expect, it } from "vitest";

import { killSwitchOf, nextAction, parseBudget, parsePreconditions, parseTournaments, revealAllowed } from "./admin";

describe("admin console data (S6 4.13)", () => {
  it("reads the budget rows from ops.v_budget_status, numbers or decimal strings", () => {
    const budget = parseBudget([{ bucket: "global", parent: null, ceiling_usd: "75.00", liability_usd: 12.5, open_usd: "0.4", headroom_usd: "62.5", kill_switch: false }]);
    expect(budget).toEqual([{ bucket: "global", ceiling: "$75.00", liability: "$12.50", open: "$0.40", headroom: "$62.50", killSwitch: false }]);
    expect(killSwitchOf(budget ?? [])).toBe(false);
    expect(parseBudget({ buckets: [] })).toEqual([]);
    expect(killSwitchOf([])).toBe(null);
    expect(parseBudget([{ bucket: "global", ceiling_usd: "lots" }])).toBe(null);
    expect(parseBudget("x")).toBe(null);
  });

  it("reads tournaments and the one transition each state allows", () => {
    const t = parseTournaments({ tournaments: [{ id: "t1", name: "dev-1", split: "dev", status: "scoring", seed: 7 }] });
    expect(t).toEqual([{ id: "t1", name: "dev-1", split: "dev", status: "scoring" }]);
    expect(parseTournaments([{ id: "t1", name: "x", split: "dev", status: "paused" }])).toBe(null);
    expect(["draft", "frozen", "running", "sealed", "scoring", "revealed"].map((s) => nextAction(s as never)?.action ?? null)).toEqual(["freeze", "open", "close", "scoring", "reveal", null]);
  });

  it("allows reveal only when every reported precondition passes (FE-ADM-2)", () => {
    const pre = parsePreconditions({ preconditions: [{ name: "Roster frozen", passed: true }, { name: "Commitments verified", passed: false }] });
    expect(revealAllowed(pre)).toBe(false);
    expect(revealAllowed(pre?.map((p) => ({ ...p, passed: true })) ?? null)).toBe(true);
    expect(revealAllowed(null)).toBe(false);
    expect(revealAllowed([])).toBe(false);
    expect(parsePreconditions({})).toBe(null);
    expect(parsePreconditions({ preconditions: [{ name: 1, passed: true }] })).toBe(null);
  });
});
