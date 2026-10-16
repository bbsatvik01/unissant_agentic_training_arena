// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { parseRecording } from "../../lib/world/parseRecording";
import { seek, startCursor } from "../../lib/world/recording";
import { initialWorldReplayState, type WorldEvent } from "../../lib/world/worldEvents";
import { createLocalWorldCapture } from "../../lib/world/localWorldCapture";
import { createWorldCapture } from "../../lib/world/worldCapture";
import { useWorldCapture } from "../../routes/precinct/useWorldCapture";
import { ReplayTheaterPanel, type ReplayTheaterProps } from "./ReplayTheaterPanel";

function props(): ReplayTheaterProps {
  const parsed = parseRecording(raw); if (!parsed.ok) throw new Error("fixture");
  return { recording: parsed.recording, playback: { clock: { current: 0 }, capturedWorld: initialWorldReplayState(), duration: parsed.recording.durationMs,
    playing: false, speed: 1, play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), setSpeed: vi.fn() }, paused: false, freeCamera: false,
    onFreeCamera: vi.fn(), onImport: vi.fn(), onExport: vi.fn() };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Replay Theater content panel", () => {
  it("has honest v1/audio limits and EX4 verbatim, without its own dialog, world, autoplay or import", () => {
    const value = props(); const { container } = render(<ReplayTheaterPanel {...value} />);
    expect(screen.getByText(EX4_TEXT)).toBeTruthy(); expect(screen.getByText(/V1 includes trial text/)).toBeTruthy();
    expect(screen.getByText(/Exact audio replay needs/)).toBeTruthy(); expect(container.querySelector("canvas, dialog, iframe")).toBeNull();
    expect(value.playback.play).not.toHaveBeenCalled(); expect(value.onImport).not.toHaveBeenCalled(); expect(value.onExport).not.toHaveBeenCalled();
  });
  it("delegates replay, speed, free camera and same-file reload to the parent without firing live actions", () => {
    const value = props(); const { rerender } = render(<ReplayTheaterPanel {...value} />);
    fireEvent.click(screen.getByRole("button", { name: "Play replay" })); expect(value.playback.play).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Replay position"), { target: { value: "123" } }); expect(value.playback.seekTo).toHaveBeenCalledWith(123);
    fireEvent.change(screen.getByLabelText("Replay speed"), { target: { value: "4" } }); expect(value.playback.setSpeed).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByLabelText("Explore with free camera")); expect(value.onFreeCamera).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to start" })); expect(value.playback.pause).toHaveBeenCalledOnce(); expect(value.playback.seekTo).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "Export recording" })); expect(value.onExport).toHaveBeenCalledOnce();
    const file = new File(["{}"], "run.json", { type: "application/json" }); const input = screen.getByLabelText("Import recording");
    fireEvent.change(input, { target: { files: [file] } }); fireEvent.change(input, { target: { files: [file] } }); expect(value.onImport).toHaveBeenCalledTimes(2);
    fireEvent.change(input, { target: { files: [] } }); expect(value.onImport).toHaveBeenCalledTimes(2);
    rerender(<ReplayTheaterPanel {...value} playback={{ ...value.playback, playing: true }} freeCamera />);
    fireEvent.click(screen.getByRole("button", { name: "Pause replay" })); expect(value.playback.pause).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Your viewing camera is free/)).toBeTruthy();
  });
  it("renders only captured notes/drafts/evidence/pages at the supplied canonical cursor", () => {
    const samples: WorldEvent[] = [
      { t_ms: 1, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "Read dated source" } },
      { t_ms: 2, kind: "input", data: { action: "evidence", operation: "pin", record_id: "rec-1" } },
      { t_ms: 3, kind: "ui", data: { action: "file_page", file_id: "f", page: 2 } },
      { t_ms: 4, kind: "input", data: { action: "text", field_id: "question", value: "<script>literal</script>" } },
    ];
    const result = parseRecording({ ...raw, format: "arena.recording.v2", world_events: samples }); if (!result.ok) throw new Error("fixture");
    const value = props(); const world = seek(result.recording, startCursor(result.recording), 5).world;
    const { container, rerender } = render(<ReplayTheaterPanel {...value} recording={result.recording} playback={{ ...value.playback, capturedWorld: world }} />);
    expect(screen.getByText("Read dated source")).toBeTruthy(); expect(screen.getByText("<script>literal</script>")).toBeTruthy(); expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("Pinned evidence: rec-1")).toBeTruthy(); expect(screen.getByText("File pages: f: 2")).toBeTruthy(); expect(screen.getByText(/V2 provides sampled world replay/)).toBeTruthy();
    rerender(<ReplayTheaterPanel {...value} recording={result.recording} />); expect(screen.queryByText("Read dated source")).toBeNull();
  });
  it("shows captured note kinds/citations/source times and draft metadata without inferring a finding", () => {
    const value = props(); const source = value.recording?.case.initial_documents[0]; if (source === undefined) throw new Error("fixture");
    const samples: WorldEvent[] = [
      { t_ms: 4, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "Possibility", metadata: { kind: "contradiction", citations: [{ kind: "document", id: source.doc_id }], createdAtMs: 100, updatedAtMs: 200 } } },
      { t_ms: 5, kind: "input", data: { action: "notebook", operation: "draft", draft: { kind: "question", text: "Draft question", citations: [{ kind: "document", id: source.doc_id }], editingId: "n" } } },
    ];
    const result = parseRecording({ ...raw, format: "arena.recording.v2", world_events: samples }); if (!result.ok) throw new Error("fixture");
    render(<ReplayTheaterPanel {...value} recording={result.recording} playback={{ ...value.playback, capturedWorld: seek(result.recording, startCursor(result.recording), 5).world }} />);
    expect(screen.getByText("Possible contradiction · trainee note, not a finding")).toBeTruthy();
    expect(screen.getByText("Original note times (ms): created 100; updated 200")).toBeTruthy();
    expect(screen.getAllByText(`Sources: document: ${source.doc_id}`)).toHaveLength(2);
    expect(screen.getByText("Draft question")).toBeTruthy(); expect(screen.getByText("Editing n")).toBeTruthy();
  });
  it("labels a new local world capture without pretending it was an interview or score", () => {
    const value = props(); if (value.recording === null) throw new Error("fixture");
    const local = createLocalWorldCapture({ packet: value.recording.case, isActive: () => true }); local.controller.start();
    local.controller.ui({ action: "panel", panel_id: "dossier", open: true }); local.controller.stop();
    const result = local.exportRecording(); if (!result.ok) throw new Error("export");
    render(<ReplayTheaterPanel {...value} recording={result.recording} />);
    expect(screen.getByText("Local world capture · no interview or score")).toBeTruthy();
  });
  it("handles empty, loading, failed import and global pause states", () => {
    const value = props(); const { rerender } = render(<ReplayTheaterPanel {...value} recording={null} onExport={null} loading error="Refused whole recording" />);
    expect(screen.getByText("Review a recorded interview")).toBeTruthy(); expect(screen.getByRole("status").textContent).toContain("Checking"); expect(screen.getByRole("alert").textContent).toBe("Refused whole recording");
    expect(screen.getByLabelText<HTMLInputElement>("Import recording").disabled).toBe(true); expect(screen.getByRole<HTMLButtonElement>("button", { name: "Export recording" }).disabled).toBe(true);
    rerender(<ReplayTheaterPanel {...value} paused />); expect(screen.getByRole<HTMLButtonElement>("button", { name: "Play replay" }).disabled).toBe(true);
  });
  it("reads the existing replay clock without starting or advancing it", async () => {
    vi.useFakeTimers(); const value = props(); render(<ReplayTheaterPanel {...value} />);
    value.playback.clock.current = 61_000; await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText(/^01:01 \/ /)).toBeTruthy(); expect(value.playback.play).not.toHaveBeenCalled(); expect(value.playback.seekTo).not.toHaveBeenCalled();
  });
  it("records only after an explicit start, exports, stops and requires explicit clear confirmation", () => {
    const controller = createWorldCapture({ context: () => ({ sessionKey: "s", trialId: "t", clockMs: 0, writable: true, publicEvidenceIds: new Set(), publicTextFields: new Set() }) });
    const exportSamples = vi.fn(); const value = props();
    function Harness() { const capture = useWorldCapture(controller); return <ReplayTheaterPanel {...value} capture={{ ...capture, onExport: exportSamples }} />; }
    render(<Harness />); expect(controller.getSnapshot().status).toBe("empty");
    fireEvent.click(screen.getByRole("button", { name: "Start local capture" })); expect(controller.getSnapshot().status).toBe("recording");
    act(() => { controller.ui({ action: "panel", panel_id: "notebook", open: true }); });
    fireEvent.click(screen.getByRole("button", { name: "Export captured samples" })); expect(exportSamples).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Stop capture" })); fireEvent.click(screen.getByRole("button", { name: "Clear local capture" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep samples" })); expect(controller.getSnapshot().count).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear local capture" })); fireEvent.click(screen.getByRole("button", { name: "Yes, clear samples" })); expect(controller.getSnapshot().count).toBe(0);
  });
});
