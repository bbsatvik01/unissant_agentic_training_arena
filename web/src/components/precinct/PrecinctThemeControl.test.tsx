// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrecinctThemeControl } from "./PrecinctThemeControl";

afterEach(cleanup);

describe("PrecinctThemeControl", () => {
  it("offers two labeled native radios with visible descriptions and a clear lifetime", () => {
    render(<PrecinctThemeControl value="office" onChange={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Interface theme" });
    const office = within(group).getByRole("radio", { name: "Office (original)" });
    const studio = within(group).getByRole("radio", { name: "Studio" });
    expect(office).toHaveProperty("checked", true);
    expect(studio).toHaveProperty("checked", false);
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    for (const radio of [office, studio]) {
      const description = radio.getAttribute("aria-describedby");
      expect(description).not.toBeNull();
      expect(description === null ? null : document.getElementById(description)?.textContent).toBeTruthy();
    }
    expect(screen.getByText("Applies throughout this precinct visit. Reloading restores Office.")).toBeTruthy();
  });

  it("reports only an explicit choice and renders the parent-controlled value", () => {
    const onChange = vi.fn();
    const view = render(<PrecinctThemeControl value="office" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Studio" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("studio");
    view.rerender(<PrecinctThemeControl value="studio" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Studio" })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: "Office (original)" })).toHaveProperty("checked", false);
    fireEvent.click(screen.getByRole("radio", { name: "Office (original)" }));
    expect(onChange.mock.calls).toEqual([["studio"], ["office"]]);
  });

  it("does not cross-wire separate controlled picker instances", () => {
    render(<><PrecinctThemeControl value="office" onChange={vi.fn()} /><PrecinctThemeControl value="studio" onChange={vi.fn()} /></>);
    const groups = screen.getAllByRole("group", { name: "Interface theme" });
    const first = groups[0]; const second = groups[1];
    if (first === undefined || second === undefined) throw new Error("Expected two picker instances");
    const firstRadio = within(first).getByRole("radio", { name: "Office (original)" });
    const secondRadio = within(second).getByRole("radio", { name: "Studio" });
    expect(firstRadio).toHaveProperty("checked", true);
    expect(secondRadio).toHaveProperty("checked", true);
    expect(firstRadio.getAttribute("name")).not.toBe(secondRadio.getAttribute("name"));
    expect(firstRadio.getAttribute("aria-describedby")).not.toBe(secondRadio.getAttribute("aria-describedby"));
  });
});
