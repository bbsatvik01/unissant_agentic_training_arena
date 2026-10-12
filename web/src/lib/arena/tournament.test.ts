import { describe, expect, it } from "vitest";

import example from "../../fixtures/tournament.example.json";
import type { TournamentPoll } from "../contracts/generated/types";
import { isWire } from "../contracts/validate";
import { fixture } from "../../test/wire-fixtures";
import { cellState, EMPTY_TOURNAMENT, foldPoll, matrix, tracks } from "./tournament";

describe("tournament arena state", () => {
  it("the example poll passes the tournament-poll wire schema", () => {
    expect(isWire("tournament-poll", example.poll)).toBe(true);
  });

  it("folds events into a matrix of pairings, order-independent and duplicate-safe", () => {
    const poll = example.poll as Extract<TournamentPoll, { visibility: "events" }>;
    const once = foldPoll(EMPTY_TOURNAMENT, poll);
    expect(once.state).toBe("revealed");
    expect(matrix(once, "interactive").map((r) => r.pairing)).toHaveLength(9);
    expect(matrix(once, "interactive")[0]?.cells).toHaveLength(3);
    const reversed = foldPoll(EMPTY_TOURNAMENT, { ...poll, frames: [...poll.frames].reverse() });
    expect([...reversed.trials.values()]).toEqual([...once.trials.values()]);
    const twice = foldPoll(once, poll);
    expect([...twice.trials.values()]).toEqual([...once.trials.values()]);
    const cells = [...once.trials.values()];
    expect(cells.find((c) => c.trial_ref === 8)?.execution).toBe("budget_skipped");
    const quarantined = cells.find((c) => c.trial_ref === 20);
    expect(quarantined === undefined ? null : cellState(quarantined)).toBe("subject quarantined");
  });

  it("keeps each track's trials apart, the tracks in the sponsor's order", () => {
    const once = foldPoll(EMPTY_TOURNAMENT, example.poll as TournamentPoll);
    expect(tracks(once)).toEqual(["replay", "interactive"]);
    const replay = matrix(once, "replay");
    const interactive = matrix(once, "interactive");
    expect(replay.find((r) => r.pairing === "A1 x S1")?.cells.map((c) => c.trial_ref)).toEqual([28]);
    expect(interactive.find((r) => r.pairing === "A1 x S1")?.cells.map((c) => c.trial_ref)).toEqual([1, 2, 3]);
    expect([...replay, ...interactive].every((r) => r.cells.every((c) => c.track === (replay.includes(r) ? "replay" : "interactive")))).toBe(true);
    const unavailable = replay.find((r) => r.pairing === "A2 x S3")?.cells[0];
    expect(unavailable === undefined ? null : cellState(unavailable)).toBe("source unavailable");
    expect(matrix(once, "replay_corpus")).toEqual([]);
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

  it("a retried trial (same trial_ref, new attempt) starts clean: the failed attempt's state never sticks to it", () => {
    const T = "7a1c2e3d-4b5f-4a6e-8d9c-0b1a2c3d4e5f";
    const A1 = "11111111-1111-4111-8111-111111111111";
    const A2 = "22222222-2222-4222-8222-222222222222";
    const f = (seq: number, type: string, data: object) => ({ v: 1, seq, scope: "tournament", scope_id: T, ts: "2026-10-11T12:00:00Z", type, data });
    const started = (seq: number, id: string) => f(seq, "trial.started", { trial_ref: 4, trial_id: id, pairing: "A1 x S1", track: "interactive", block: 1 });
    const frames = [
      started(10, A1),
      f(11, "trial.execution", { trial_ref: 4, state: "infra_failed" }),
      started(20, A2),
    ];
    const poll = { visibility: "events", last: 20, frames } as TournamentPoll;
    const once = foldPoll(EMPTY_TOURNAMENT, poll);
    const cell = once.trials.get(4);
    expect(cell?.trial_id).toBe(A2);
    expect(cell?.execution).toBe(null);
    expect(cell === undefined ? null : cellState(cell)).toBe("running");
    // Across polls, and with the whole history folded again (duplicates), the retry stays current.
    const split = foldPoll(foldPoll(EMPTY_TOURNAMENT, { ...poll, frames: frames.slice(0, 2), last: 11 } as TournamentPoll), { ...poll, frames: frames.slice(2) } as TournamentPoll);
    expect(split.trials.get(4)).toEqual(cell);
    const again = foldPoll(once, poll);
    expect(again.trials.get(4)).toEqual(cell);
    // The first attempt's start arriving alone again (a re-read page) does not bring the old attempt back.
    expect(foldPoll(once, { ...poll, frames: [started(10, A1)] } as TournamentPoll).trials.get(4)).toEqual(cell);
    // The retry's own end lands on it; a late duplicate of the first attempt's end does not.
    const done = foldPoll(again, { ...poll, last: 31, frames: [f(30, "trial.execution", { trial_ref: 4, state: "completed" }), f(31, "trial.finalized", { trial_ref: 4, commitment_hash: "c".repeat(64) }), f(11, "trial.execution", { trial_ref: 4, state: "infra_failed" })] } as TournamentPoll);
    expect(done.trials.get(4)).toMatchObject({ trial_id: A2, execution: "completed", commitment_hash: "c".repeat(64) });
    // A re-folded older status frame never reverts the tournament's state.
    const revealed = foldPoll(done, { ...poll, last: 40, frames: [f(40, "tournament.status", { state: "revealed" })] } as TournamentPoll);
    const stale = foldPoll(revealed, { ...poll, last: 40, frames: [f(5, "tournament.status", { state: "running" })] } as TournamentPoll);
    expect(stale.state).toBe("revealed");
  });

  it("names a cell's state", () => {
    const base = { trial_ref: 1, trial_id: "t", pairing: "A1 x S1", track: "interactive" as const, block: 1 };
    expect(cellState({ ...base, execution: null, commitment_hash: null, since: 1 })).toBe("running");
    expect(cellState({ ...base, execution: null, commitment_hash: "h", since: 1 })).toBe("sealed");
  });
});
