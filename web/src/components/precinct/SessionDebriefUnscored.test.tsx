// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Debrief } from "../../lib/contracts/generated/types";
import { SessionDebriefPanel } from "./SessionDebriefPanel";

const authored: Debrief = {
  schema_version: "debrief.v1", session_id: "00000000-0000-4000-8000-000000000001", scored: false,
  outcome: { role: "truthful", correct_finding: "truthful", committed_label: "insufficient_evidence", resolution: "Authored fictional resolution; no model or referee graded this run." },
};
afterEach(cleanup);
describe("channel-neutral unscored debrief", () => {
  it("labels an unscored text exercise without calling it voice or showing a numeric grade", () => {
    render(<SessionDebriefPanel debrief={authored} view={null} recorded={false} />);
    expect(screen.getByText("This session is not scored.")).toBeTruthy();
    expect(screen.getByText(authored.outcome.resolution)).toBeTruthy();
    expect(screen.queryByText(/Voice practice/)).toBeNull();
    expect(screen.queryByText(/\/ 100/)).toBeNull();
    expect(screen.queryByText(/\/ 4/)).toBeNull();
    expect(screen.getByText("Insufficient evidence")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download this debrief JSON" })).toBeTruthy();
  });
});
