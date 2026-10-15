// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PrecinctNavigationStatus } from "./PrecinctNavigationStatus";

afterEach(cleanup);
describe("explicit navigation availability disclosure", () => {
  it("identifies a degraded profile without claiming polygon navigation", () => {
    render(<PrecinctNavigationStatus status={{ context: "live", player: { mode: "graph", reason: "invalid" }, staff: { mode: "mesh", reason: "ready" } }} />);
    expect(screen.getByRole("status", { name: "Navigation status" }).textContent).toContain("Waypoint fallback for player (invalid mesh)");
  });
  it("distinguishes legacy compatibility from captured movement", () => {
    const view = render(<PrecinctNavigationStatus status={{ context: "legacy-replay", player: { mode: "graph", reason: "legacy-compatibility" }, staff: { mode: "graph", reason: "legacy-compatibility" } }} />);
    expect(screen.getByRole("status").textContent).toContain("original waypoint");
    view.rerender(<PrecinctNavigationStatus status={{ context: "sampled-replay", player: { mode: "graph", reason: "replay-owned" }, staff: { mode: "graph", reason: "replay-owned" } }} />);
    expect(screen.getByRole("status").textContent).toContain("live navigation planning is paused");
  });
});
