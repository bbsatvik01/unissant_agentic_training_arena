// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorldCapture } from "../../lib/world/worldCapture";
import { useWorldCapture } from "./useWorldCapture";

afterEach(() => { cleanup(); vi.useRealTimers(); });
it("mounting the adapter never captures or enables transport; its timer respects the 250–500ms batch window", async () => {
  vi.useFakeTimers(); const send = vi.fn(() => Promise.resolve());
  const controller = createWorldCapture({ context: () => ({ sessionKey: "s", trialId: "t", clockMs: 0, writable: true, publicEvidenceIds: new Set(), publicTextFields: new Set() }) });
  const { result, unmount } = renderHook(() => useWorldCapture(controller));
  await act(async () => { await vi.advanceTimersByTimeAsync(101); }); expect(result.current.snapshot.status).toBe("empty");
  act(() => { controller.start(); controller.enableSender(send); controller.ui({ action: "panel", panel_id: "case", open: true }); });
  expect(result.current.snapshot.count).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(349); }); expect(send).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(50); }); expect(send).toHaveBeenCalledOnce();
  unmount(); expect(controller.getSnapshot()).toMatchObject({ status: "stopped", transport: "off" }); expect(vi.getTimerCount()).toBe(0);
});
describe("capture hook replacement", () => {
  it("does not implicitly enable a replacement controller", () => {
    vi.useFakeTimers();
    const make = () => createWorldCapture({ context: () => null }); const one = make(); const two = make();
    const { result, rerender } = renderHook((controller) => useWorldCapture(controller), { initialProps: one });
    rerender(two); expect(result.current.controller).toBe(two); expect(result.current.snapshot.status).toBe("empty"); expect(vi.getTimerCount()).toBe(1);
  });
});
