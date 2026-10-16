import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/precinct-theme.css", import.meta.url), "utf8");

/** Read shipped tokens, rather than maintaining an independent palette in this test. */
function tokens(selector: string) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing theme selector ${selector}`);
  const block = css.slice(start, css.indexOf("}", start));
  return (name: string): string => {
    const value = new RegExp(`--studio-${name}:\\s*(#[a-f0-9]+)\\s*;`, "i").exec(block)?.[1];
    if (value === undefined) throw new Error(`Missing color token ${name}`);
    return value;
  };
}
function luminance(hex: string) {
  const full = hex.length === 4 ? `#${[1, 2, 3].map((index) => hex.charAt(index).repeat(2)).join("")}` : hex;
  const channels = [1, 3, 5].map((index) => {
    const value = Number.parseInt(full.slice(index, index + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return (channels[0] ?? 0) * .2126 + (channels[1] ?? 0) * .7152 + (channels[2] ?? 0) * .0722;
}
function contrast(first: string, second: string) {
  const a = luminance(first); const b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

describe("Studio theme color contracts", () => {
  it.each([
    '.precinct-root[data-theme="studio"]',
    '.precinct-root[data-theme="studio"].high-contrast',
  ])("keeps body text and controls readable in %s", (selector) => {
    const color = tokens(selector);
    for (const surface of ["canvas", "surface", "raised", "hover"]) {
      expect(contrast(color("ink"), color(surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color("muted"), color(surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color("control-line"), color(surface))).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(color("ink"), color("canvas"))).toBeGreaterThanOrEqual(7);
  });

  it("uses a distinct blue focus outline on each interactive surface", () => {
    const color = tokens('.precinct-root[data-theme="studio"]');
    // White pills use a four-pixel offset, so their outline is read against the surrounding dark surface.
    for (const surface of ["canvas", "surface", "raised", "hover"]) {
      expect(contrast(color("focus"), color(surface))).toBeGreaterThanOrEqual(3);
    }
  });
});
