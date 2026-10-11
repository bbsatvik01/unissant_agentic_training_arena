// @vitest-environment jsdom
/**
 * The arena view (S6 4.9, 4.10): the eligibility gates come before any rank, an ineligible candidate is listed
 * unranked with its failing gate (FE-LB-1), the full inclusion-manifest hash is shown (FE-LB-3), EX-4 and the
 * EVL-10 sentence are present (FE-LB-4), and each track has its own matrix.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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

function show() {
  render(
    <ArenaView
      name="Arena"
      example
      assistant={parseBoard(boards.assistant)}
      subject={parseBoard(boards.subject)}
      tournament={foldPoll(EMPTY_TOURNAMENT, tournamentExample.poll as TournamentPoll)}
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
  });
});
