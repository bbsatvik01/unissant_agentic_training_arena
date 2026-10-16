import { describe, expect, it, vi } from "vitest";
import { createWorldEventSender, type WorldWriteGate } from "./worldEventSender";
import type { WorldEvent } from "../world/worldEvents";
const gate: WorldWriteGate = { localSessionEnabled: () => true, activeTrialId: () => "trial-1", origin: () => ({ protocol: "http:", hostname: "127.0.0.1" }) };
const sample: WorldEvent = { t_ms: 0, kind: "ui", data: { action: "panel", panel_id: "notebook", open: true } };
describe("direct transport local-finding boundary", () => {
  it.each(["submitted", "failed"] as const)("rejects %s with valid loopback and matching enable gates", async (operation) => {
    const post = vi.fn(() => Promise.resolve(null)); const sender = createWorldEventSender({ post }, gate);
    const finding: WorldEvent = { t_ms: 0, kind: "input", data: { action: "finding", operation, after_frames: 0 } };
    for (const events of [[finding], [sample, finding], [finding, sample]]) {
      await expect(sender("trial-1", { events })).rejects.toThrow("UI-local finding");
      expect(post).not.toHaveBeenCalled();
    }
    // A refused mixed batch cannot partially post, and ordinary allowed traffic still works afterward.
    await sender("trial-1", { events: [sample] });
    expect(post).toHaveBeenCalledExactlyOnceWith("/api/trials/trial-1/world-events", { events: [sample] });
  });
});
