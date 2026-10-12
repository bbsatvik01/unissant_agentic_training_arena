// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MoreMenu } from "./MoreMenu";

afterEach(() => {
  cleanup();
});

describe("MoreMenu", () => {
  it("opens on its button, runs an item and closes, and closes on Escape or a click elsewhere", () => {
    const pause = vi.fn();
    render(
      <div>
        <p>outside</p>
        <MoreMenu items={[{ id: "pause", label: "Pause motion", onSelect: pause, pressed: false }, { id: "trust", label: "Trust center", href: "/trust/methodology" }]} />
      </div>,
    );
    const more = screen.getByRole("button", { name: "More" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Pause motion" })).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("link", { name: "Trust center" }).getAttribute("href")).toBe("/trust/methodology");
    fireEvent.click(screen.getByRole("button", { name: "Pause motion" }));
    expect(pause).toHaveBeenCalled();
    expect(document.activeElement).toBe(more);
    expect(screen.queryByRole("button", { name: "Pause motion" })).toBeNull();
    fireEvent.click(more);
    screen.getByRole("link", { name: "Trust center" }).focus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("link", { name: "Trust center" })).toBeNull();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.pointerDown(screen.getByText("outside"));
    expect(screen.queryByRole("link", { name: "Trust center" })).toBeNull();
  });

  it("shows nothing without items", () => {
    const { container } = render(<MoreMenu items={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
