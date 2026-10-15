import { describe, expect, it } from "vitest";

import { OFFICE_STYLES } from "./office-styles";

describe("the office style registry", () => {
  it("offers Case Board, Playhouse and Bid Tower beside Classic, each with its own loadable view", async () => {
    expect(OFFICE_STYLES.map((s) => s.label)).toEqual(["Case Board", "Playhouse", "Bid Tower"]);
    expect(new Set(OFFICE_STYLES.map((s) => s.id)).size).toBe(OFFICE_STYLES.length);
    for (const s of OFFICE_STYLES) expect(typeof (await s.load()).default).toBe("function");
  }, 30_000);
});
