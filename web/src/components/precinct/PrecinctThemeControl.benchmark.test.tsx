// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PrecinctThemeControl } from "./PrecinctThemeControl";
import { benchmarkThemeOption, selectBenchmarkTheme, verifyBenchmarkTheme, type BenchmarkTheme } from "../../../tools/precinct-performance-theme";

afterEach(cleanup);

function Settings({ initialTheme }: { readonly initialTheme: BenchmarkTheme }) {
  const [theme, setTheme] = useState(initialTheme);
  return createElement("div", { className: "precinct-root", "data-theme": theme },
    createElement(PrecinctThemeControl, { value: theme, onChange: setTheme }));
}

/** Browser-free adapter: dispatch to the real native radio and its React onChange handler. */
function settingsPage() {
  const selections: { role: string; name: string; exact: boolean }[] = [];
  const page: Parameters<typeof selectBenchmarkTheme>[0] = {
    getByRole(role, options) {
      selections.push({ role, ...options });
      return { check() { fireEvent.click(screen.getByRole(role, { name: options.name })); return Promise.resolve(); } };
    },
  };
  return { page, selections };
}

function observedTheme() { return document.querySelector(".precinct-root")?.getAttribute("data-theme") ?? null; }

describe("benchmark normal-settings theme selection", () => {
  it.each(["office", "studio"] as const)("selects %s through the actual labeled control", async (theme) => {
    render(createElement(Settings, { initialTheme: theme === "office" ? "studio" : "office" }));
    const { page, selections } = settingsPage();
    await selectBenchmarkTheme(page, theme);
    const label = theme === "studio" ? "Studio" : "Office (original)";
    expect(selections).toEqual([{ role: "radio", name: label, exact: true }]);
    expect(screen.getByRole("radio", { name: label })).toHaveProperty("checked", true);
    expect(verifyBenchmarkTheme(observedTheme(), theme)).toBe(theme);
  });
  it("keeps the default Office choice explicit even after Studio was selected", async () => {
    render(createElement(Settings, { initialTheme: "office" }));
    const { page, selections } = settingsPage();
    await selectBenchmarkTheme(page, "studio");
    expect(verifyBenchmarkTheme(observedTheme(), "studio")).toBe("studio");
    const defaultTheme = benchmarkThemeOption();
    await selectBenchmarkTheme(page, defaultTheme);
    await selectBenchmarkTheme(page, defaultTheme);
    expect(verifyBenchmarkTheme(observedTheme(), "office")).toBe("office");
    expect(selections.map(({ name }) => name)).toEqual(["Studio", "Office (original)", "Office (original)"]);
  });
  it("fails if the requested radio is absent instead of silently retaining Office", async () => {
    render(createElement("div", { className: "precinct-root", "data-theme": "office" }));
    const { page } = settingsPage();
    await expect(selectBenchmarkTheme(page, "studio")).rejects.toThrow();
    expect(observedTheme()).toBe("office");
    expect(() => verifyBenchmarkTheme(observedTheme(), "studio")).toThrow("was not applied");
  });
  it("rejects a selected radio whose parent did not apply the requested theme", async () => {
    render(createElement("div", { className: "precinct-root", "data-theme": "office" },
      createElement(PrecinctThemeControl, { value: "office", onChange: () => undefined })));
    const { page } = settingsPage();
    await selectBenchmarkTheme(page, "studio");
    expect(() => verifyBenchmarkTheme(observedTheme(), "studio")).toThrow("was not applied");
  });
});
