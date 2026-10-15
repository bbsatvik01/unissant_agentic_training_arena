import { describe, expect, it, vi } from "vitest";
import { createWorldEventSender, type WorldWriteGate } from "./worldEventSender";
import type { WorldEvent } from "../world/worldEvents";
const sample: WorldEvent = { t_ms: 0, kind: "ui", data: { action: "panel", panel_id: "notebook", open: true } };
const gate: WorldWriteGate = { localSessionEnabled: () => true, activeTrialId: () => "trial-1", origin: () => ({ protocol: "http:", hostname: "127.0.0.1" }) };

describe("world-event transport seam", () => {
  it("does nothing on construction and sends only the exact POST body through the existing client", async () => {
    const post = vi.fn(() => Promise.resolve(null)); const sender = createWorldEventSender({ post }, gate);
    expect(post).not.toHaveBeenCalled(); await sender("trial-1", { events: [sample] });
    expect(post).toHaveBeenCalledExactlyOnceWith("/api/trials/trial-1/world-events", { events: [sample] });
    await sender("trial-1", { events: [] }); expect(post).toHaveBeenCalledOnce();
  });
  it.each([
    { ...gate, localSessionEnabled: () => false }, { ...gate, activeTrialId: () => null }, { ...gate, activeTrialId: () => "other" },
    { ...gate, origin: () => ({ protocol: "https:", hostname: "hosted.example" }) }, { ...gate, origin: () => ({ protocol: "file:", hostname: "localhost" }) },
  ])("checks matching explicit local permission on every call %#", async (permission) => {
    const post = vi.fn(() => Promise.resolve(null)); const sender = createWorldEventSender({ post }, permission);
    await expect(sender("trial-1", { events: [sample] })).rejects.toThrow("Explicit matching local session"); expect(post).not.toHaveBeenCalled();
  });
  it.each(["localhost", "127.0.0.1", "[::1]", "::1"])("accepts HTTP(S) loopback %s only after enable", async (hostname) => {
    const post = vi.fn(() => Promise.resolve(null)); const sender = createWorldEventSender({ post }, { ...gate, origin: () => ({ protocol: "https:", hostname }) });
    await sender("trial-1", { events: [sample] }); expect(post).toHaveBeenCalledOnce();
  });
  it.each(["../elsewhere", "a/b", "?next=evil", "", "a".repeat(161)])("refuses path-like or invalid trial identifiers %s", async (id) => {
    const post = vi.fn(() => Promise.resolve(null)); const sender = createWorldEventSender({ post }, { ...gate, activeTrialId: () => id });
    await expect(sender(id, { events: [sample] })).rejects.toThrow(); expect(post).not.toHaveBeenCalled();
  });
  it("refuses oversized bodies and invalid events before any transport, and preserves server failures", async () => {
    const post = vi.fn(() => Promise.resolve(null)); const sender = createWorldEventSender({ post }, gate);
    const note: WorldEvent = { t_ms: 0, kind: "input", data: { action: "notebook", operation: "upsert", note_id: "n", text: "x".repeat(16_000) } };
    await expect(sender("trial-1", { events: [note, note, note, note] })).rejects.toThrow(RangeError);
    await expect(sender("trial-1", { events: [{ ...sample, t_ms: -1 }] })).rejects.toThrow(TypeError); expect(post).not.toHaveBeenCalled();
    post.mockRejectedValueOnce(new Error("failed")); await expect(sender("trial-1", { events: [sample] })).rejects.toThrow("failed");
  });
});
