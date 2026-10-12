import { describe, expect, it } from "vitest";

import { modeBadge } from "./badge";

describe("the room's mode badge", () => {
  it("names a tournament trial as such, practice and assessment as before", () => {
    expect(modeBadge("practice", "harness")).toBe("Tournament trial");
    expect(modeBadge("practice", "practice")).toBe("Practice");
    expect(modeBadge("practice", null)).toBe("Practice");
    expect(modeBadge("assessment", "assessment")).toBe("Assessment: coaching is saved for your debrief");
  });
});
