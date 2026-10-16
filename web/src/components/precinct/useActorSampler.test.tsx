// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { Group } from "three";
import { describe, expect, it, vi } from "vitest";
import { ABSENT_CLIP, staffClip, type ActorCapture } from "../../lib/precinct/proceduralActors";
import { useActorSampler } from "./useActorSampler";
describe("capture hook scope ownership", () => {
  it("has no sampler without opt-in, isolates replacement scopes, and cleans actual roots once", () => {
    const old = vi.fn(); const next = vi.fn();
    const { result, rerender, unmount } = renderHook(({ capture }: { capture: ActorCapture | undefined }) => useActorSampler(capture, "staff:patrol"), { initialProps: { capture: undefined as ActorCapture | undefined } });
    expect(result.current.current).toBeNull();
    rerender({ capture: { scope: "a", onActorSample: old } });
    const root = new Group(); root.position.set(1, 2, 3);
    act(() => { result.current.current?.sample(root, staffClip("patrol", false), 12, 0.1); });
    rerender({ capture: { scope: "b", onActorSample: next } });
    expect(old).toHaveBeenLastCalledWith(expect.objectContaining({ animation: { clip: ABSENT_CLIP, time: 12 } }));
    expect(next).not.toHaveBeenCalled();
    act(() => { result.current.current?.sample(root, staffClip("patrol", true), 12, 0.1); });
    rerender({ capture: undefined });
    expect(result.current.current).toBeNull(); expect(next).toHaveBeenCalledTimes(2);
    unmount(); expect(next).toHaveBeenCalledTimes(2);
  });
});
