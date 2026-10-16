// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrecinctCanvas, { type PrecinctCanvasProps } from "./PrecinctCanvas";

vi.mock("@react-three/fiber", async () => {
  const { Children, isValidElement } = await import("react");
  return { Canvas: ({ children }: { children: import("react").ReactNode }) => Children.toArray(children)
    .filter((child) => isValidElement<{ enabled?: boolean }>(child) && typeof child.props.enabled === "boolean"),
  useThree: vi.fn(), useFrame: vi.fn(), useLoader: vi.fn() };
});
vi.mock("./PrecinctRenderPolicy", () => ({ usePrecinctDpr: () => 0.75, precinctDiagnosticsEnabled: () => true, PrecinctRenderPolicy: () => null }));
vi.mock("./PrecinctEnvironment", () => ({ PrecinctEnvironment: ({ enabled }: { enabled: boolean }) => <output data-testid="environment">{String(enabled)}</output> }));

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
function props(): PrecinctCanvasProps {
  return { manifest: { colliders: [], hotspots: [], navigationNodes: [] }, active: true, paused: false, reducedMotion: true,
    cameraMode: "first", tier: "low", travel: { current: null }, onTierChange: vi.fn(), onPose: vi.fn(), onInteract: vi.fn(), onReady: vi.fn() };
}
describe("Canvas environment experiment wiring", () => {
  it("keeps the default Low environment and omits it only with the explicit diagnostic switch", () => {
    const p = props(), view = render(<PrecinctCanvas {...p} />);
    expect(screen.getByTestId("environment").textContent).toBe("true");
    window.history.replaceState(null, "", "/?precinctPerf=1&precinctLowEnvironment=omit");
    view.rerender(<PrecinctCanvas {...p} />); expect(screen.getByTestId("environment").textContent).toBe("false");
    for (const tier of ["medium", "high"] as const) {
      view.rerender(<PrecinctCanvas {...p} tier={tier} />); expect(screen.getByTestId("environment").textContent).toBe("true");
    }
  });
  it("retains canonical lighting for capture, empty sampled replay, legacy replay and route ownership", () => {
    window.history.replaceState(null, "", "/?precinctPerf=1&precinctLowEnvironment=omit");
    const p = props(), view = render(<PrecinctCanvas {...p} />);
    const modes: Partial<PrecinctCanvasProps>[] = [{ actorCapture: { scope: "test", onActorSample: vi.fn() } },
      { replayActors: new Map() }, { legacyReplay: true }, { standardEnvironment: true }];
    for (const mode of modes) {
      view.rerender(<PrecinctCanvas {...p} {...mode} />); expect(screen.getByTestId("environment").textContent).toBe("true");
      view.rerender(<PrecinctCanvas {...p} />); expect(screen.getByTestId("environment").textContent).toBe("false");
    }
  });
});
