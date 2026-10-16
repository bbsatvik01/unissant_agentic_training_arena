// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import raw from "../../fixtures/recordings/F01-truthful.json";
import { parseRecording } from "../../lib/world/parseRecording";
import { initialWorldReplayState } from "../../lib/world/worldEvents";
import { ReplayTheaterPanel } from "./ReplayTheaterPanel";
afterEach(cleanup);
it("blocks assessment replacement even for programmatic file changes while retaining current playback", () => {
  const checked = parseRecording(raw); if (!checked.ok) throw new Error("fixture"); const play = vi.fn(); const onImport = vi.fn();
  render(<ReplayTheaterPanel recording={checked.recording} playback={{ clock: { current: 0 }, capturedWorld: initialWorldReplayState(), duration: 200, playing: false, speed: 1, play, pause: vi.fn(), seekTo: vi.fn(), setSpeed: vi.fn() }} paused={false} freeCamera={false} onFreeCamera={vi.fn()} importDisabled onImport={onImport} onExport={null} />);
  const input = screen.getByLabelText<HTMLInputElement>("Import recording"); expect(input.disabled).toBe(true);
  fireEvent.change(input, { target: { files: [new File(["{}"], "other.json")] } }); expect(onImport).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Export recording" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Play replay" })); expect(play).toHaveBeenCalledOnce();
});
