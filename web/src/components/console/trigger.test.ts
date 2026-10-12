import { describe, expect, it } from "vitest";

import { triggerText } from "./TrainerConsole";

describe("trigger entries for raters (S3 7.3)", () => {
  it("shows the trigger turns and record together, and the questions to look at", () => {
    expect(triggerText({ subcheck_id: "3e", trigger_turns: [1], trigger_record: "doc-01", question_turns: [2, 3] })).toBe("3e: triggered by T1, doc-01; questions to look at: T2, T3");
    expect(triggerText({ subcheck_id: "2a", trigger_turns: [], trigger_record: null, question_turns: [] })).toBe("2a: triggered by nothing listed; questions to look at: none");
  });
});
