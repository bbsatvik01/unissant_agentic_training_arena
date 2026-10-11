import { describe, expect, it } from "vitest";

import example from "../../fixtures/tournament.example.json";
import type { TournamentPoll } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { fixture } from "../../test/wire-fixtures";
import { cellState, EMPTY_TOURNAMENT, foldPoll, matrix } from "./tournament";

describe("tournament arena state", () => {
  it("the example poll passes the tournament-poll wire schema", () => {
    expect(isWire("tournament-poll", example.poll)).toBe(true);
  });

  it("folds events into a matrix of pairings, order-independent and duplicate-safe", () => {
    const poll = example.poll as Extract<TournamentPoll, { visibility: "events" }>;
    const once = foldPoll(EMPTY_TOURNAMENT, poll);
    expect(once.state).toBe("revealed");
    expect(matrix(once).map((r) => r.pairing)).toHaveLength(9);
    expect(matrix(once)[0]?.cells).toHaveLength(3);
    const reversed = foldPoll(EMPTY_TOURNAMENT, { ...poll, frames: [...poll.frames].reverse() });
    expect([...reversed.trials.values()]).toEqual([...once.trials.values()]);
    const twice = foldPoll(once, poll);
    expect([...twice.trials.values()]).toEqual([...once.trials.values()]);
    const cells = [...once.trials.values()];
    expect(cells.find((c) => c.trial_ref === 8)?.execution).toBe("budget_skipped");
    const quarantined = cells.find((c) => c.trial_ref === 20);
    expect(quarantined === undefined ? null : cellState(quarantined)).toBe("subject quarantined");
  });

  it("holds only progress rows for a hidden tournament before reveal (FE-SSE-4), then restarts on events", () => {
    const counts = fixture("poll:counts") as TournamentPoll;
    const hidden = foldPoll(foldPoll(EMPTY_TOURNAMENT, example.poll as TournamentPoll), counts);
    expect(hidden.visibility).toBe("counts");
    expect(hidden.trials.size).toBe(0);
    expect(JSON.stringify(hidden)).not.toMatch(/trial_id|trial_ref|text|card/);
    const events = foldPoll(hidden, fixture("poll:events") as TournamentPoll);
    expect(events.visibility).toBe("events");
    expect(events.trials.size).toBe(1);
  });

  it("names a cell's state", () => {
    const base = { trial_ref: 1, trial_id: "t", pairing: "A1 x S1", track: "interactive" as const, block: 1 };
    expect(cellState({ ...base, execution: null, commitment_hash: null })).toBe("running");
    expect(cellState({ ...base, execution: null, commitment_hash: "h" })).toBe("sealed");
  });
});
