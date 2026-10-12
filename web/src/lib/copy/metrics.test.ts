import { describe, expect, it } from "vitest";

import spec from "../../../../docs/spec/S3-scoring-rubrics-metrics.md?raw";
import { METRICS } from "./metrics";

const esc = (s: string) => s.replaceAll("|", "\\|");

describe("metric catalog (S3 5.2, verbatim)", () => {
  it("has M01 to M25 in order", () => {
    expect(METRICS.map((m) => m.id)).toEqual(Array.from({ length: 25 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`));
  });

  it("matches every row of the spec's table cell for cell", () => {
    for (const m of METRICS) {
      const cells = [m.id, m.metric, m.req, m.estimand, m.unit, m.interval, m.tracks, m.edge].map(esc);
      const row = `|${cells.map((c) => (c === "" ? " " : ` ${c} `)).join("|")}|`;
      expect(spec).toContain(row);
    }
  });
});
