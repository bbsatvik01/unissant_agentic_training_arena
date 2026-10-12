// @vitest-environment jsdom
/**
 * The arena view (S6 4.9, 4.10): the eligibility gates come before any rank, an ineligible candidate is listed
 * unranked with its failing gate (FE-LB-1), the full inclusion-manifest hash is shown (FE-LB-3), EX-4 and the
 * EVL-10 sentence are present (FE-LB-4), and each track has its own matrix.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import boards from "../../fixtures/leaderboard.example.json";
import tournamentExample from "../../fixtures/tournament.example.json";
import { parseBoard } from "../../lib/arena/leaderboard";
import { EMPTY_TOURNAMENT, foldPoll } from "../../lib/arena/tournament";
import type { TournamentPoll } from "../../lib/contracts/generated/types";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { ArenaView, NOT_CERTIFICATION } from "./ArenaView";

afterEach(() => {
  cleanup();
});

const assistantBoard = parseBoard(boards.assistant);

function show() {
  render(
    <ArenaView
      name="Arena"
      boards={{ kind: "example" }}
      assistant={parseBoard(boards.assistant)}
      subject={parseBoard(boards.subject)}
      tournament={foldPoll(EMPTY_TOURNAMENT, tournamentExample.poll as TournamentPoll)}
      matrix="example"
      tournaments={{ state: "idle" }}
      notice={null}
      onReplay={() => undefined}
      motionOff
      onClose={() => undefined}
    />,
  );
}

describe("ArenaView", () => {
  it("shows the gates before any rank, the ineligible candidate unranked with its gate, and the full manifest hash", () => {
    show();
    const gates = document.querySelector(".gates");
    const table = document.querySelector("table.board");
    expect(gates).not.toBeNull();
    expect(table).not.toBeNull();
    expect((gates?.compareDocumentPosition(table as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rankedIds = [...(table?.querySelectorAll("tbody tr") ?? [])].map((tr) => tr.querySelector(".mono.fine")?.textContent);
    expect(rankedIds).toEqual(["A1", "A3"]);
    expect(document.querySelector(".ineligible")?.textContent).toContain("A2");
    expect(document.querySelector(".ineligible")?.textContent).toContain("FPR above 5%");
    expect(document.querySelector(".binding .hash")?.textContent).toBe(boards.assistant.binding.manifest_sha256);
    expect(document.querySelector('.gates [data-gate="failed"]')?.textContent).toContain("A2");
  });

  it("carries EX-4 and the EVL-10 sentence", () => {
    show();
    expect(document.body.textContent).toContain(EX4_TEXT);
    expect(document.body.textContent).toContain(NOT_CERTIFICATION);
  });

  it("gives each track its own matrix, replay first", () => {
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Tournament" }));
    const trackTabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(trackTabs).toContain("Replay track");
    expect(trackTabs.indexOf("Replay track")).toBeLessThan(trackTabs.indexOf("Interactive track"));
    expect(screen.getByRole("table", { name: "Replay track: trials by pairing" }).querySelectorAll('[role="cell"]')).toHaveLength(9);
    fireEvent.click(screen.getByRole("tab", { name: "Interactive track" }));
    expect(screen.getByRole("table", { name: "Interactive track: trials by pairing" }).querySelectorAll('[role="cell"]')).toHaveLength(27);
    // The example's trials are not real runs: nothing in it replays.
    expect(screen.queryAllByRole("button", { name: /^Replay / })).toHaveLength(0);
    expect(screen.getAllByText("Example data: no tournament is selected. Not a result.").length).toBeGreaterThan(0);
  });

  it("replays any visible trial of a selected tournament in the room, and says why there is no matrix", () => {
    const onReplay = vi.fn();
    const poll = tournamentExample.poll as Extract<TournamentPoll, { visibility: "events" }>;
    const view = (matrix: "ready" | "missing" | "error" | "loading", notice: string | null = null) => (
      <ArenaView name="Arena" boards={{ kind: "published", tournamentId: "t-1", label: null }} assistant={null} subject={null} tournament={foldPoll(EMPTY_TOURNAMENT, poll)} matrix={matrix} tournaments={{ state: "idle" }} notice={notice} onReplay={onReplay} motionOff onClose={() => undefined} />
    );
    const { rerender } = render(view("ready"));
    fireEvent.click(screen.getByRole("tab", { name: "Tournament" }));
    const started = poll.frames.find((f) => f.type === "trial.started" && f.data.track === "replay");
    const trialId = started?.type === "trial.started" ? started.data.trial_id : "";
    const ref = started?.type === "trial.started" ? started.data.trial_ref : 0;
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^Replay Trial ${String(ref)}:`) }));
    expect(onReplay).toHaveBeenCalledWith(trialId);
    expect(screen.getByText(/Choose a finished trial to replay it in the interview room/)).toBeTruthy();
    // A running trial (no execution record, no commitment yet) does not replay until it ends.
    const running = foldPoll(EMPTY_TOURNAMENT, { ...poll, frames: poll.frames.filter((f) => f.type === "trial.started" || f.type === "tournament.status") });
    rerender(<ArenaView name="Arena" boards={{ kind: "published", tournamentId: "t-1", label: null }} assistant={null} subject={null} tournament={running} matrix="ready" tournaments={{ state: "idle" }} notice={null} onReplay={onReplay} motionOff onClose={() => undefined} />);
    expect(screen.queryAllByRole("button", { name: /^Replay / })).toHaveLength(0);
    expect(screen.getAllByText("running").length).toBeGreaterThan(0);
    rerender(view("ready", "The server does not offer this run's recording."));
    expect(screen.getByRole("alert").textContent).toBe("The server does not offer this run's recording.");
    rerender(view("missing"));
    expect(screen.getByText(/does not offer the tournament routes yet/)).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^Replay / })).toHaveLength(0);
    rerender(view("error"));
    expect(screen.getByText("The tournament could not be read. Try again later.")).toBeTruthy();
  });

  it("shows a candidate id once when the board publishes it as the name", () => {
    if (assistantBoard === null) throw new Error("fixture");
    const ids = { ...assistantBoard, rows: assistantBoard.rows.map((r) => ({ ...r, display_name: r.candidate_id })) };
    render(<ArenaView name="Arena" boards={{ kind: "published", tournamentId: "t-1", label: null }} assistant={ids} subject={null} tournament={EMPTY_TOURNAMENT} matrix="ready" tournaments={{ state: "idle" }} notice={null} onReplay={() => undefined} motionOff onClose={() => undefined} />);
    const ranked = document.querySelector("table.board tbody tr");
    expect(ranked?.querySelectorAll("td")[1]?.textContent).toBe("A1");
  });

  it("lists the tournaments to choose from when none is selected", () => {
    render(
      <ArenaView name="Arena" boards={{ kind: "example" }} assistant={null} subject={null} tournament={EMPTY_TOURNAMENT} matrix="example" tournaments={{ state: "ready", list: [{ id: "t 1", name: "dev-demo", split: "dev", status: "revealed", seed: 20261011, rosterHash: "ab".repeat(32) }] }} notice={null} onReplay={() => undefined} motionOff onClose={() => undefined} />,
    );
    expect(screen.getByRole("link", { name: "dev-demo" }).getAttribute("href")).toBe("?tournament=t%201");
    expect(screen.getByText(/dev split, revealed, seed 20261011, roster/)).toBeTruthy();
    expect(screen.getByTitle("ab".repeat(32)).textContent).toBe("abababababab");
    cleanup();
    for (const [state, text] of [["missing", "The server does not offer the tournament list yet."], ["error", "The tournament list could not be read."]] as const) {
      render(<ArenaView name="Arena" boards={{ kind: "example" }} assistant={null} subject={null} tournament={EMPTY_TOURNAMENT} matrix="example" tournaments={{ state }} notice={null} onReplay={() => undefined} motionOff onClose={() => undefined} />);
      expect(screen.getByText(text)).toBeTruthy();
      cleanup();
    }
    render(<ArenaView name="Arena" boards={{ kind: "example" }} assistant={null} subject={null} tournament={EMPTY_TOURNAMENT} matrix="example" tournaments={{ state: "ready", list: [] }} notice={null} onReplay={() => undefined} motionOff onClose={() => undefined} />);
    expect(screen.getByText("No tournaments yet.")).toBeTruthy();
  });

  it("shows the sealed state with no numbers before reveal (FE-LB-5), never the example", () => {
    render(<ArenaView name="Arena" boards={{ kind: "sealed" }} assistant={null} subject={null} tournament={EMPTY_TOURNAMENT} matrix="loading" tournaments={{ state: "idle" }} notice={null} onReplay={() => undefined} motionOff onClose={() => undefined} />);
    expect(screen.getByText("Results are sealed until reveal.")).toBeTruthy();
    expect(document.querySelector("table.board")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+%|Example data/);
  });

  it("labels a corrected board and links to its original", () => {
    const corrected = parseBoard({ ...boards.assistant, binding: { ...boards.assistant.binding, manifest_version: 2 } });
    render(<ArenaView name="Arena" boards={{ kind: "published", tournamentId: "t-1", label: null }} assistant={corrected} subject={null} tournament={EMPTY_TOURNAMENT} matrix="ready" tournaments={{ state: "idle" }} notice={null} onReplay={() => undefined} motionOff onClose={() => undefined} />);
    expect(screen.getByText("Corrected leaderboard")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the original leaderboard" }).getAttribute("href")).toBe("?tournament=t-1&label=original");
    expect(document.body.textContent).not.toMatch(/Example data/);
  });
});
