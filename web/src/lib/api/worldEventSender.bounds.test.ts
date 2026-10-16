import { describe, expect, it, vi } from "vitest";
import { createWorldEventSender } from "./worldEventSender";
import { WORLD_TRANSPORT_MAX_TIME_MS } from "../world/recordingTelemetry";
import type { WorldEvent } from "../world/worldEvents";
const gate = { localSessionEnabled: () => true, activeTrialId: () => "trial-1", origin: () => ({ protocol: "http:", hostname: "localhost" }) };
const sample: WorldEvent = { t_ms: 0, kind: "ui", data: { action: "panel", panel_id: "file", open: true } };
describe("upstream world sender transport bounds", () => {
  it.each([0.1, -1, NaN, Infinity, WORLD_TRANSPORT_MAX_TIME_MS + 1])("refuses timestamp %s before transport", async (t_ms) => {
    const post = vi.fn(() => Promise.resolve(null)); await expect(createWorldEventSender({ post }, gate)("trial-1", { events: [{ ...sample, t_ms }] })).rejects.toThrow(TypeError);
    expect(post).not.toHaveBeenCalled();
  });
  it("preserves exact integer times through the endpoint boundary", async () => {
    const post = vi.fn(() => Promise.resolve(null)); const events = [sample, { ...sample, t_ms: WORLD_TRANSPORT_MAX_TIME_MS }];
    await createWorldEventSender({ post }, gate)("trial-1", { events }); expect(post).toHaveBeenCalledExactlyOnceWith("/api/trials/trial-1/world-events", { events });
  });
  it("refuses excessive count and UI-local finding actions before posting", async () => {
    const post = vi.fn(() => Promise.resolve(null)); const send = createWorldEventSender({ post }, gate);
    await expect(send("trial-1", { events: Array.from({ length: 2001 }, () => sample) })).rejects.toThrow(TypeError);
    await expect(send("trial-1", { events: [{ t_ms: 0, kind: "input", data: { action: "finding", operation: "submitted", after_frames: 0 } }] })).rejects.toThrow("UI-local");
    expect(post).not.toHaveBeenCalled();
  });
});
