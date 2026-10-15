// @vitest-environment jsdom
import { Children, isValidElement, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas, { type PrecinctCanvasProps } from "./PrecinctCanvas";
import { localStaffPlaybackActivity } from "../../lib/precinct/localStaffPlaybackActivity";
const invalidate = vi.hoisted(() => vi.fn());
vi.mock("@react-three/fiber", () => ({
  Canvas: ({ frameloop, children }: { frameloop: string; children: ReactNode }) => <div data-testid="canvas" data-frameloop={frameloop}>{Children.toArray(children).filter((child) => isValidElement(child) && typeof child.type === "function" && child.type.name === "StaffSpeechFrameInvalidation")}</div>,
  useThree: (selector: (state: { invalidate: () => void }) => unknown) => selector({ invalidate }),
  useFrame: vi.fn(), useLoader: vi.fn(),
}));
afterEach(() => { cleanup(); localStaffPlaybackActivity.set(false); invalidate.mockClear(); });
const props = {
  manifest: { colliders: [], hotspots: [], navigationNodes: [] } as unknown as PrecinctCanvasProps["manifest"],
  active: false, paused: false, reducedMotion: false, cameraMode: "first" as const, tier: "low" as const,
  onTierChange: vi.fn(), travel: { current: null }, onPose: vi.fn(), onInteract: vi.fn(), onReady: vi.fn(),
};
describe("staff dialog demand-render transition", () => {
  it("keeps the existing Canvas live only during explicit speech, then invalidates a closing frame", () => {
    render(<PrecinctCanvas {...props} />);
    expect(screen.getByTestId("canvas").getAttribute("data-frameloop")).toBe("demand"); const initial = invalidate.mock.calls.length;
    act(() => { localStaffPlaybackActivity.set(true); }); expect(screen.getByTestId("canvas").getAttribute("data-frameloop")).toBe("always");
    act(() => { localStaffPlaybackActivity.set(false); }); expect(screen.getByTestId("canvas").getAttribute("data-frameloop")).toBe("demand");
    expect(invalidate).toHaveBeenCalledTimes(initial + 2);
  });
  it("keeps paused and reduced-motion staff dialogs demand-rendered and preserves replay's pre-existing renderer", () => {
    const view = render(<PrecinctCanvas {...props} />);
    act(() => { localStaffPlaybackActivity.set(true); });
    view.rerender(<PrecinctCanvas {...props} paused />); expect(screen.getByTestId("canvas").getAttribute("data-frameloop")).toBe("demand");
    view.rerender(<PrecinctCanvas {...props} reducedMotion />); expect(screen.getByTestId("canvas").getAttribute("data-frameloop")).toBe("demand");
    view.rerender(<PrecinctCanvas {...props} replayActors={new Map()} />); expect(screen.getByTestId("canvas").getAttribute("data-frameloop")).toBe("always");
    const previous = invalidate.mock.calls.length; act(() => { localStaffPlaybackActivity.set(false); });
    expect(invalidate).toHaveBeenCalledTimes(previous);
  });
});
