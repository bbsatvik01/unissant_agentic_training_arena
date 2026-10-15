// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { BoardSurface } from "../../lib/precinct/boardSurfaces";
import { boardSurfaceSvg } from "./boardSurfaceSvg";

const surface: BoardSurface = { key: "test", target: "case_board", eyebrow: "Actual <source> & label", heading: '</text><script>alert("test")</script>', lines: ['<image href="https://example.invalid/pixel" />', "Actual interval 2–8", "A & B's case"], footer: "Supplied metadata only" };
describe("self-contained board SVG", () => {
  it("escapes supplied titles, names and reasons as text with no external resources", () => {
    const svg = boardSurfaceSvg(surface), doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll("script,image,foreignObject,a")).toHaveLength(0);
    expect(doc.querySelectorAll("[href],[src],[style]")).toHaveLength(0);
    expect(doc.documentElement.textContent).toContain(surface.heading);
    expect(doc.documentElement.textContent).toContain(surface.lines[0]);
    expect(doc.documentElement.textContent).toContain("A & B's case");
    expect(svg).toContain("&lt;source&gt; &amp; label");
    expect(svg).not.toContain("<script");
  });
  it("uses bounded typography and fixed card/header dimensions without images or fonts", () => {
    const long = boardSurfaceSvg({ ...surface, heading: "🗂".repeat(80), lines: Array.from({ length: 7 }, (_, index) => `Line ${String(index)}`) });
    const doc = new DOMParser().parseFromString(long, "image/svg+xml");
    expect(doc.documentElement.getAttribute("viewBox")).toBe("0 0 1536 864");
    expect(doc.documentElement.textContent).toContain(`${"🗂".repeat(49)}…`);
    expect(doc.documentElement.textContent).toContain("Line 3"); expect(doc.documentElement.textContent).not.toContain("Line 4");
    expect(doc.documentElement.textContent).not.toContain("�");
    const recognition = new DOMParser().parseFromString(boardSurfaceSvg({ ...surface, target: "trophies" }), "image/svg+xml");
    expect(recognition.documentElement.getAttribute("viewBox")).toBe("0 0 2048 628");
  });
});
