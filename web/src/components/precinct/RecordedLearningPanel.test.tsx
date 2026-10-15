// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../../lib/world/parseRecording";
import { recordedLearningTimeline, type LearningTimeline } from "../../lib/world/learningTimeline";
import { seek, startCursor } from "../../lib/world/recording";
import { RecordedLearningPanel } from "./RecordedLearningPanel";
import { SessionDebriefPanel } from "./SessionDebriefPanel";

const loaded = parseRecording(raw); if (!loaded.ok) throw new Error("fixture");
const recording = loaded.recording; const view = seek(recording, startCursor(recording), recording.durationMs).state.view;
const result = recordedLearningTimeline(recording, recording.debrief, view); if (result === null) throw new Error("timeline");
const timeline = result;
afterEach(cleanup);

describe("published learning review content", () => {
  it("uses exact replay moments and only explicit optional comparison/setup callbacks", () => {
    const replay = vi.fn(); const setup = vi.fn(); const { container } = render(<RecordedLearningPanel timeline={timeline} onReplayFromTurn={replay} onOpenFreshPractice={setup} />);
    expect(replay).not.toHaveBeenCalled(); expect(setup).not.toHaveBeenCalled(); expect(container.querySelector("canvas,dialog,iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Replay from turn 1" })); expect(replay).toHaveBeenCalledExactlyOnceWith(timeline.turns[0]?.atMs);
    expect(screen.queryByText(/^Recorded coach suggestion:/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox")); expect(screen.getByText(/not a verified winning-expert trace/)).toBeTruthy();
    expect(screen.getAllByText(/^Recorded coach suggestion:/)).toHaveLength(timeline.turns.length);
    expect(screen.getAllByText(/^Actually asked next:/)).toHaveLength(timeline.turns.length);
    fireEvent.click(screen.getByRole("button", { name: "Open fresh practice setup" })); expect(setup).toHaveBeenCalledOnce();
    expect(screen.getByText(/Retry or fork from a turn is unsupported/)).toBeTruthy();
  });
  it("shows published failures/citations as attributed judgments without inventing missing locations or answers", () => {
    const turn = timeline.turns[0]; if (turn === undefined) throw new Error("fixture");
    const data: LearningTimeline = { ...timeline, turns: [{ ...turn, atMs: null, answer: null, suggested: null, askedNext: null,
      checks: [{ dimension: "D1", id: "1a", result: "fail", turns: [1] }], neutralityIssues: ["Recorded issue"], flags: [{ flag: { kind: "evidence_conflict", turn_id: "t01", quote: "Recorded quote", missing_fact: null, conflict_turn_id: "t02", conflict_quote: null, conflict_record_id: "rec-01", conflict_record_quote: null, flag_ref: "f" }, validation: null }] }],
      unlocatedChecks: [{ dimension: "D2", id: "2b", result: "na", turns: [] }], unlocatedLearning: [{ intent: "Unaddressed intent", addressed_turns: [] }] };
    render(<RecordedLearningPanel timeline={data} />);
    expect(screen.getByText(/exact replay time unavailable/)).toBeTruthy(); expect(screen.getByRole<HTMLButtonElement>("button", { name: "Replay from turn 1" }).disabled).toBe(true);
    expect(screen.getByText("Published fail")).toBeTruthy(); expect(screen.getByText("Not applicable")).toBeTruthy(); expect(screen.getByText("Citation validation was not recorded.")).toBeTruthy();
    expect(screen.getByText("Cited record: rec-01 · No quote recorded")).toBeTruthy(); expect(screen.getByText(/unaddressed intent is not assigned an invented mistake timestamp/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox")); expect(screen.getByText("Recorded coach suggestion: No suggestion recorded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open fresh practice setup" })).toBeNull();
  });
  it("preserves unscored records and recorded citation validation flags", () => {
    const turn = timeline.turns[0]; if (turn === undefined || turn.flags[0] === undefined) throw new Error("fixture");
    render(<RecordedLearningPanel timeline={{ ...timeline, scored: false, evidenceCoverage: null, unsupported: null, turns: [{ ...turn, flags: [{ ...turn.flags[0], validation: { citation_ok: false, demeanor_based: true, duplicate: true } }] }] }} />);
    expect(screen.getByText(/This recording is unscored/)).toBeTruthy(); expect(screen.getByText("Recorded validation: citation rejected; demeanor-based yes; duplicate yes.")).toBeTruthy();
  });
  it("integrates only behind SessionDebriefPanel's own published run gate and disappears on rewind", () => {
    const replay = vi.fn(); const { rerender } = render(<SessionDebriefPanel debrief={recording.debrief} view={view} recorded recording={recording} onReplayFromTurn={replay} />);
    expect(screen.getByRole("region", { name: "Recorded learning timeline" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replay from turn 1" })); expect(replay).toHaveBeenCalledOnce();
    rerender(<SessionDebriefPanel debrief={null} view={seek(recording, startCursor(recording), 0).state.view} recorded recording={recording} onReplayFromTurn={replay} />);
    expect(screen.queryByRole("region", { name: "Recorded learning timeline" })).toBeNull();
    rerender(<SessionDebriefPanel debrief={recording.debrief} view={view} recorded={false} recording={recording} />);
    expect(screen.queryByRole("region", { name: "Recorded learning timeline" })).toBeNull();
  });
});
