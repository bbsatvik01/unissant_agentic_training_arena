// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrecinctWorldSelector } from "./PrecinctWorldSelector";

afterEach(cleanup);

const IDLE = { captureActive: false, replayActive: false, sessionActive: false, seated: false };

describe("precinct architecture selector", () => {
  it("offers the recoverable Office and Courtyard layouts", () => {
    const changed = vi.fn();
    render(<PrecinctWorldSelector value="office" state={IDLE} onChange={changed} />);
    fireEvent.change(screen.getByRole("combobox", { name: /Architecture/ }), { target: { value: "courtyard" } });
    expect(changed).toHaveBeenCalledWith("courtyard");
    expect(screen.getByRole("option", { name: "Office" })).toBeTruthy();
  });
  it.each(["captureActive", "replayActive", "sessionActive", "seated"] as const)("cannot change during %s even via a synthetic change event", (key) => {
    const changed = vi.fn();
    render(<PrecinctWorldSelector value="office" state={{ ...IDLE, [key]: true }} onChange={changed} />);
    const select = screen.getByRole("combobox", { name: /Architecture/ });
    expect(select.hasAttribute("disabled")).toBe(true);
    fireEvent.change(select, { target: { value: "courtyard" } });
    expect(changed).not.toHaveBeenCalled();
  });
});
