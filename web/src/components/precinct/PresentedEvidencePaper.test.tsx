import { describe, expect, it } from "vitest";
import { paperTitleLines, presentedEvidenceSvg, PRESENTED_PAPER } from "./PresentedEvidencePaper";

describe("presented public evidence cover", () => {
  it("prints only the explicit public ref/title and labels itself as a cover", () => {
    const svg = presentedEvidenceSvg({ ref: { kind: "record", id: "rec-04" }, title: "Maintenance work order" }).svg;
    expect(svg).toContain("RELEASED RECORD");
    expect(svg).toContain("rec-04");
    expect(svg).toContain('font-size="100"');
    expect(svg).toContain("Maintenance work order");
    expect(svg).toContain("full original text");
    expect(svg).not.toContain("OPENING DOCUMENT");
  });
  it("retains kind-aware identity and escapes unsafe-looking labels without linked resources", () => {
    const svg = presentedEvidenceSvg({ ref: { kind: "document", id: "same-id" }, title: '<script src="https://invalid.test"> & <image/>' }).svg;
    expect(svg).toContain("OPENING DOCUMENT");
    expect(svg).toContain("same-id");
    expect(svg).toContain("&lt;script");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<image");
    expect(svg).not.toContain("<foreignObject");
    expect(svg).not.toContain("href=");
  });
  it("bounds display-only title wrapping without losing short words or splitting surrogate pairs", () => {
    expect(paperTitleLines("  Door   access register  ")).toEqual(["Door access register"]);
    expect(paperTitleLines("")).toEqual([]);
    expect(paperTitleLines("A".repeat(150)).join("")).toBe(`${"A".repeat(140)}…`);
    expect(paperTitleLines("🗂".repeat(150)).join("")).toBe(`${"🗂".repeat(140)}…`);
    expect(paperTitleLines("word ".repeat(100)).length).toBeLessThanOrEqual(7);
    expect(paperTitleLines("word ".repeat(100)).every((line) => Array.from(line).length <= 28)).toBe(true);
  });
  it("keeps a long source ID intact instead of truncating the citation", () => {
    const id = `record-${"x".repeat(180)}`;
    expect(presentedEvidenceSvg({ ref: { kind: "record", id }, title: "Record" }).svg).toContain(id);
    expect(presentedEvidenceSvg({ ref: { kind: "document", id: "" }, title: "" }).svg).not.toContain("Infinity");
  });
  it("fits above the authored interview tabletop without covering the original notepad", () => {
    const [x, y, z] = PRESENTED_PAPER.position;
    const [width, depth] = PRESENTED_PAPER.size;
    expect(x - width / 2).toBeGreaterThan(8.7 - 2.45 / 2);
    expect(x + width / 2).toBeLessThan(8.7 + 2.45 / 2);
    expect(z - depth / 2).toBeGreaterThan(-13.2 - 1.05 / 2);
    expect(z + depth / 2).toBeLessThan(-12.95 - 0.3 / 2);
    expect(y).toBeGreaterThan(0.76 + 0.075 / 2);
    expect(y).toBeLessThan(0.82);
  });
});
