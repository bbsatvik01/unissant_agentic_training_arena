// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../../lib/world/parseRecording";
import { initialWorldReplayState } from "../../lib/world/worldEvents";
import { ReplayTheaterPanel, type ReplayTheaterProps } from "./ReplayTheaterPanel";
function props(): ReplayTheaterProps {
  const result = parseRecording({ ...raw, format: "arena.recording.v2", world_events: [{ t_ms: 0, kind: "pose", data: { actor: "subject", mood: "opaque sentinel" } }],
    annotations: [{ t_ms: 1000, text: "Recorded instructor note", created_at: "2026-10-15T10:00:00Z" }] });
  if (!result.ok) throw new Error(result.errors.join(";"));
  return { recording: result.recording, playback: { clock: { current: 0 }, capturedWorld: initialWorldReplayState(), duration: result.recording.durationMs, playing: false,
    speed: 1, play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setSpeed: vi.fn() }, paused: false, freeCamera: false, onFreeCamera: vi.fn(), onImport: vi.fn(), onExport: vi.fn() };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("generic recording telemetry disclosure", () => {
  it("discloses unsupported samples without exposing arbitrary data or inventing state", () => {
    render(<ReplayTheaterPanel {...props()} />);
    expect(screen.getByText(/1 world events have an unsupported rendering format/)).toBeTruthy();
    expect(screen.getByText(/0 captured actors/)).toBeTruthy(); expect(screen.queryByText(/opaque sentinel/)).toBeNull();
  });
  it("reveals recorded notes only by their timestamp and removes them on backward seek", () => {
    const value = props(); render(<ReplayTheaterPanel {...value} />);
    expect(screen.queryByText("Recorded instructor note")).toBeNull();
    fireEvent.change(screen.getByRole("slider", { name: "Replay position" }), { target: { value: "1000" } });
    expect(screen.getByText("Recorded instructor note")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Replay position" }), { target: { value: "0" } });
    expect(screen.queryByText("Recorded instructor note")).toBeNull(); expect(value.playback.seekTo).toHaveBeenCalledWith(0);
  });
  it("withholds annotations during the assessment replacement gate even after clock advancement", () => {
    vi.useFakeTimers(); const value = props(); const { rerender } = render(<ReplayTheaterPanel {...value} importDisabled />);
    value.playback.clock.current = 2000; act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByText("Recorded instructor note")).toBeNull(); expect(screen.queryByRole("region", { name: "Recorded instructor annotations" })).toBeNull();
    rerender(<ReplayTheaterPanel {...value} />); expect(screen.getByText("Recorded instructor note")).toBeTruthy();
    rerender(<ReplayTheaterPanel {...value} importDisabled />); expect(screen.queryByText("Recorded instructor note")).toBeNull();
  });
});
