import { describe, expect, it } from "vitest";

import { recording } from "./recording";

describe("recording", () => {
  it("serves the gold run and caches it", () => {
    const a = recording("nccs-2-gold");
    expect(a?.events.length).toBeGreaterThan(500);
    expect(a?.offsets).toHaveLength(a?.events.length ?? 0);
    expect(recording("nccs-2-gold")).toBe(a);
  });

  it("knows no other run", () => {
    expect(recording("other")).toBeNull();
  });
});
