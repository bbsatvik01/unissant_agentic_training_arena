import { describe, expect, it } from "vitest";

import { latestOnly } from "./latest";

describe("latestOnly", () => {
  it("keeps only the newest request current, so an older answer arriving last is ignored", () => {
    const next = latestOnly();
    const a = next();
    const b = next();
    expect(a()).toBe(false);
    expect(b()).toBe(true);
    const c = next();
    expect(b()).toBe(false);
    expect(c()).toBe(true);
    // Separate sequences do not interfere.
    const other = latestOnly()();
    expect(other()).toBe(true);
    expect(c()).toBe(true);
  });
});
